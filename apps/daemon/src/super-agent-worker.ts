import type { AgentActor, AgentCommand, AgentElicitation, AgentEvent, AgentInput, AgentPermission, AgentReceipt, AgentRun, AgentSessionRecord, AgentSnapshot, AgentTurn } from "./agent-protocol.ts"
import type { SuperMessage } from "./super-agent-protocol.ts"
import { requireWorkerCommand } from "./super-agent-command.ts"
import type { AgentSessions } from "./agent-sessions.ts"
import { errorText, note, type DispatchIntent, type StoredSuperTicket, type SuperRoom } from "./super-agent-state.ts"

export interface SuperWorkers {
  handle: AgentSessions["handle"]
  onEvent: AgentSessions["onEvent"]
  journal: Pick<AgentSessions["journal"], "list" | "read" | "command" | "commands" | "history">
}
export const activeTurn = (turn: AgentTurn) => turn.state === "starting" || turn.state === "running" || turn.state === "cancelling"

/** A cancelled/failed input can be known. An accepted command without a durable receipt remains uncertain. */
class UnknownDelivery extends Error {}
class RejectedCommand extends Error {}
function checkCommand(command: AgentCommand) {
  if (command.status === "failed" || command.status === "rejected") throw new RejectedCommand(command.error || "Worker command failed")
  if (command.status === "uncertain") throw new UnknownDelivery(command.error || "Worker delivery requires reconciliation")
}
function durableReceipt(command: AgentCommand): AgentReceipt {
  checkCommand(command)
  const result = command.result as AgentReceipt | undefined
  if (result?.sessionId && (result.inputId || command.method === "_deskfleet/turn/cancel") ) return result
  throw new UnknownDelivery("The worker accepted a command without a confirmed delivery receipt. Inspect its session.")
}

interface DispatchContext {
  workers: SuperWorkers
  loadAttachments(keys: string[]): Promise<AgentInput["content"]>
  current(): DispatchIntent | undefined
  autoApproveNewWorker(): boolean
  checkpoint(patch: Partial<DispatchIntent>, boundSession?: AgentSessionRecord): Promise<void>
  suspended?(): boolean
  inspectHistory(sessionId: string, actor: AgentActor): Promise<void>
  authorize(actor: AgentActor): Promise<AgentActor>
  workspace(): Promise<{ id: string; context: "directory" | "worktree" }>
}

/** Persist intent and operation IDs before entry. Every retry consults the original receipt first. */
export async function deliverSuperIntent(ctx: DispatchContext): Promise<void> {
  const operation = ctx.current()
  if (!operation || (operation.phase !== "planned" && operation.phase !== "working")) return
  const { workers } = ctx
  try {
    const actor = await ctx.authorize(operation.actor)
    const workspace = await ctx.workspace()
    if (ctx.suspended?.() || ctx.current()?.phase === "withdrawn") return
    await ctx.checkpoint({ phase: "working", workspaceId: workspace.id, context: operation.context || workspace.context })
    let sessionId = operation.sessionId
    if (!sessionId) {
      if (operation.operation !== "submit") throw new Error("No worker session to interrupt")
      const saved = await workers.journal.command(operation.createId)
      let snapshot: AgentSnapshot
      if (saved) {
        checkCommand(saved)
        if (saved.status !== "completed" || !saved.sessionId) throw new UnknownDelivery("Session creation has no confirmed outcome. Inspect the original command.")
        snapshot = await workers.journal.read(saved.sessionId)
      } else {
        if (ctx.suspended?.()) return
        snapshot = await workers.handle("_deskfleet/session/create", {
          operationId: operation.createId, workspaceId: workspace.id, provider: operation.provider,
          ...operation.workerSelection, ...(ctx.autoApproveNewWorker() && { yolo: true }),
          title: operation.prompt.split("\n")[0]!.slice(0, 100), context: operation.context || workspace.context,
        }, actor) as AgentSnapshot
      }
      if (snapshot.session.workspaceId !== workspace.id) throw new Error("Worker is outside the ticket workspace")
      await ctx.checkpoint({ sessionId: snapshot.session.id }, snapshot.session)
      sessionId = snapshot.session.id
      if (snapshot.session.lifecycle !== "ready") throw new Error(snapshot.session.error || "Worker provisioning failed")
    }
    const savedSubmission = await workers.journal.command(operation.submitId)
    if (savedSubmission) {
      const result = durableReceipt(savedSubmission)
      if (result.sessionId !== sessionId) throw new UnknownDelivery("The delivery receipt names a different session")
      await ctx.checkpoint({ phase: "sent", inputId: result.inputId })
      return
    }
    const snapshot = await workers.journal.read(sessionId)
    if (snapshot.session.workspaceId !== workspace.id) throw new Error("Worker is outside the ticket workspace")
    if (snapshot.session.archiveState !== "active" || snapshot.session.lifecycle !== "ready") throw new Error("The worker is archived or unavailable. Inspect its session before resuming.")
    const boundInvocation = !!operation.commandName || !!operation.skills?.length
    if (snapshot.session.provider !== operation.provider) {
      if (boundInvocation) throw new Error("The worker provider changed. Select the command or skill again.")
      // A normal follow-up belongs to the Session even when its user switched Agent.
      await ctx.checkpoint({ provider: snapshot.session.provider })
    }
    if (operation.adoptHistory) await ctx.inspectHistory(sessionId, actor)
    let result: AgentReceipt
    if (operation.operation === "stop" || operation.operation === "steer") {
      if (!operation.turnId || !snapshot.turns.some(turn => turn.id === operation.turnId && activeTurn(turn))) {
        throw new Error("The selected turn is no longer active. No other turn was interrupted.")
      }
      if (operation.operation === "steer" && !snapshot.session.capabilities?.steering) throw new Error("This worker cannot be steered in its active turn. Open the session to take over.")
    }
    if (ctx.suspended?.()) return
    if (operation.operation === "stop") {
      result = await workers.handle("_deskfleet/turn/cancel", {
        sessionId, turnId: operation.turnId, operationId: operation.submitId,
      }, actor) as AgentReceipt
    } else {
      if (boundInvocation) await requireWorkerCommand(workers, actor, operation.provider, operation.commandName, operation.skills ?? [], { sessionId })
      const references = operation.references?.length
        ? await workers.handle("_deskfleet/composer/resolve", { sessionId, references: operation.references }, actor) as AgentInput["content"] : []
      const attachments = operation.attachmentKeys?.length ? await ctx.loadAttachments(operation.attachmentKeys) : []
      if (ctx.suspended?.() || ctx.current()?.phase === "withdrawn") return
      result = await workers.handle("_deskfleet/input/submit", {
        sessionId, operationId: operation.submitId, content: [...attachments, { type: "text", text: operation.prompt,
          ...(boundInvocation && { _meta: { "deskfleet/composerProvider": operation.provider } }) }, ...references],
        delivery: operation.operation === "steer" ? "steer" : "backlog",
        ...(operation.operation === "steer" ? { turnId: operation.turnId } : {}),
      }, actor) as AgentReceipt
    }
    await ctx.checkpoint({ phase: "sent", inputId: result.inputId })
  } catch (error) {
    if (ctx.suspended?.() || ctx.current()?.phase === "withdrawn") return
    // A lost RPC reply is reconciled against the journal. Never assign a fresh operation ID.
    try {
      const command = await workers.journal.command(operation.submitId)
      if (command) {
        const receipt = durableReceipt(command)
        if (receipt.sessionId !== ctx.current()?.sessionId) throw new UnknownDelivery("The command receipt is inconsistent")
        await ctx.checkpoint({ phase: "sent", inputId: receipt.inputId })
        return
      }
      const creation = await workers.journal.command(operation.createId)
      if (creation) {
        if (creation.sessionId && !ctx.current()?.sessionId) {
          const snapshot = await workers.journal.read(creation.sessionId)
          if (snapshot.session.workspaceId === ctx.current()?.workspaceId) await ctx.checkpoint({ sessionId: creation.sessionId }, snapshot.session)
        }
        checkCommand(creation)
        if (creation.status === "accepted") throw new UnknownDelivery("Worker creation outcome requires inspection")
      }
      await ctx.checkpoint({ phase: error instanceof UnknownDelivery ? "uncertain" : "failed", error: errorText(error) })
    } catch (checkError) {
      await ctx.checkpoint({ phase: checkError instanceof RejectedCommand ? "failed" : "uncertain", error: errorText(checkError) })
    }
  }
}

/** Only user-visible parent output enters the workspace timeline; reasoning and tool payloads stay in their Session. */
export function projectSuperEvents(room: SuperRoom, ticket: StoredSuperTicket, events: AgentEvent[], snapshot: AgentSnapshot, intents: DispatchIntent[]) {
  const report = (event: AgentEvent, text: string, workerEvent: SuperMessage["workerEvent"] = "error") => {
    const turnId = event.kind === "turn" ? (event.payload as AgentTurn).id : event.turnId ?? ("turnId" in event.payload ? event.payload.turnId : undefined)
    const turn = event.kind === "turn" ? event.payload as AgentTurn : snapshot.turns.find(t => t.id === turnId)
    const inputId = event.inputId || turn?.initialInputId
    const parent = inputId && intents.find(i => i.ticketId === ticket.id && i.sessionId === ticket.sessionId && i.inputId === inputId)
    if (parent) {
      const user = room.messages.find(m => m.id === parent.messageId)
      if (user && user.ticketId === ticket.id) { user.inputId = inputId; user.turnId = turnId }
    }
    ticket.summary = text.slice(0, 700)
    return note(room, text, { id: `worker:${ticket.id}:${event.seq}`, role: "worker", sessionId: ticket.sessionId, ticketId: ticket.id, workerEvent, sourceMessageId: parent ? parent.messageId : undefined, turnId, inputId, createdAt: event.createdAt })
  }
  for (const event of events) {
    if (BigInt(event.seq) <= BigInt(ticket.lastEventSeq || "0")) continue
    ticket.lastEventSeq = event.seq
    ticket.updatedAt = event.createdAt
    if (event.kind === "acp" && event.turnId && "update" in event.payload && event.payload.sessionId === snapshot.session.providerSessionId) {
      const update = event.payload.update
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        const prior = ticket.output?.turnId === event.turnId ? ticket.output.text : ""
        ticket.output = { turnId: event.turnId, text: (prior + update.content.text).slice(-16000) }
      }
    }
    if (event.kind === "permission" || event.kind === "elicitation") {
      const request = event.payload as AgentPermission | AgentElicitation
      const permission = event.kind === "permission" ? request as AgentPermission : undefined
      const question = event.kind === "elicitation" ? request as AgentElicitation : undefined
      const title = (permission?.request.toolCall.title ?? question?.request.message ?? "").slice(0, 800)
      const kind = permission ? "permission" : "question"
      const heading = [permission ? "Permission requested" : "The worker has a question", title].filter(Boolean).join("\n")
      let notice = room.messages.findLast(message => message.sessionId === ticket.sessionId && message.workerEvent === kind && message.workerRequestId === request.id)
      if (!notice && request.state !== "pending") {
        // Older notices have no request ID. Only replace an unambiguous original notice.
        const legacy = room.messages.filter(message => message.sessionId === ticket.sessionId && message.ticketId === ticket.id &&
          message.workerEvent === kind && !message.workerRequestId && (!message.turnId || message.turnId === request.turnId) &&
          message.text === heading + "\nOpen the worker session to respond.")
        if (legacy.length === 1) { notice = legacy[0]!; notice.workerRequestId = request.id }
      }
      if (request.state === "pending") {
        ticket.status = "attention"
        if (!notice) report(event, heading, kind).workerRequestId = request.id
      } else {
        if (ticket.status === "attention") ticket.status = "working"
        const selected = permission?.request.options.find(option => option.optionId === permission.optionId)
        if (notice) {
          const answer = question?.response?.action
          const outcome = request.state === "cancelled" || answer === "cancel" ? "Cancelled" : selected?.name ?? (answer === "decline" ? "Declined" : "Answered")
          const summary = [outcome, title].filter(Boolean).join(" · ")
          if (ticket.summary === notice.text.slice(0, 700)) ticket.summary = summary.slice(0, 700)
          notice.text = summary
        } else if (selected?.kind.startsWith("reject")) report(event, `Permission declined. ${title || selected.name}`)
      }
    }
    if (event.kind === "turn") {
      const turn = event.payload as AgentTurn
      if (activeTurn(turn)) ticket.status = "working"
      else {
        if (room.messages.some(m => m.workerEvent === "result" && m.sessionId === ticket.sessionId && m.turnId === turn.id)) continue
        ticket.status = turn.state === "completed" ? undefined : turn.state === "cancelled" ? "stopped" : "blocked"
        const output = ticket.output?.turnId === turn.id ? ticket.output.text.trim() : ""
        const message = turn.state === "completed" ? output || "The worker finished its turn. Its session contains the execution details."
          : turn.error || (turn.state === "cancelled" ? "Worker turn stopped." : `Worker turn ${turn.state}.`)
        report(event, message, "result")
        ticket.output = undefined
      }
    }
    if (event.kind === "input") {
      const input = event.payload as AgentInput
      if (input.state === "failed" || input.state === "uncertain" || input.state === "pending" && input.error) {
        ticket.status = "blocked"
        report(event, input.error || `Input delivery is ${input.state}.`)
      }
    }
    if (event.kind === "run") {
      const run = event.payload as AgentRun
      if ((run.state === "interrupted" || run.state === "failed") && (ticket.status === "working" || ticket.status === "queued")) {
        ticket.status = "blocked"; report(event, run.error || `Worker run ${run.state}.`)
      }
    }
  }
}
