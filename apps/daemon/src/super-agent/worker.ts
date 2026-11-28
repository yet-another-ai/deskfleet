import { adhdReplyMarker } from "@deskfleet/protocol/adhd-command"
import type { AgentActor, AgentCommand, AgentElicitation, AgentEvent, AgentInput, AgentPermission, AgentReceipt, AgentRun, AgentSessionRecord, AgentSnapshot, AgentTurn } from "@deskfleet/protocol/agent"
import type { SuperFeedbackItem, SuperFeedbackProcessBranch, SuperMessage, SuperWorkerRequest } from "@deskfleet/protocol/super-agent"
import { requireWorkerCommand } from "./command.ts"
import type { AgentSessions } from "../agent/sessions.ts"
import { bumpVisibleSeq, errorText, note, type DispatchIntent, type StoredSuperTicket, type SuperRoom } from "./state.ts"
import { persistRoomFeedbackItem, persistRoomProcessBranch } from "./feedback.ts"
import { abortOpenTurnPublicSegments, ensureTurnOutput, finalizeWorkerTurnOutput, stepWorkerTurnOutput } from "./worker-projection.ts"

export interface SuperWorkers {
  handle: AgentSessions["handle"]
  onEvent: AgentSessions["onEvent"]
  onPreview?: AgentSessions["onPreview"]
  preview?: AgentSessions["preview"]
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
  if (!operation || operation.stop || (operation.phase !== "planned" && operation.phase !== "working")) return
  const { workers } = ctx
  try {
    const actor = await ctx.authorize(operation.actor)
    const workspace = await ctx.workspace()
    if (ctx.suspended?.() || ctx.current()?.stop || ctx.current()?.phase === "withdrawn") return
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
        if (ctx.suspended?.() || ctx.current()?.stop) return
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
    if (ctx.suspended?.() || ctx.current()?.phase === "withdrawn") return
    if (operation.operation === "stop") {
      result = await workers.handle("_deskfleet/turn/cancel", {
        sessionId, turnId: operation.turnId, operationId: operation.submitId,
      }, actor) as AgentReceipt
    } else {
      if (boundInvocation) await requireWorkerCommand(workers, actor, operation.provider, operation.commandName, operation.skills ?? [], { sessionId })
      const references = operation.references?.length
        ? await workers.handle("_deskfleet/composer/resolve", { sessionId, references: operation.references }, actor) as AgentInput["content"] : []
      const attachments = operation.attachmentKeys?.length ? await ctx.loadAttachments(operation.attachmentKeys) : []
      if (ctx.suspended?.() || ctx.current()?.stop || ctx.current()?.phase === "withdrawn") return
      result = await workers.handle("_deskfleet/input/submit", {
        sessionId, operationId: operation.submitId, content: [...attachments, { type: "text", text: operation.prompt,
          ...(operation.adhdEnabled && { _meta: { [adhdReplyMarker]: true } }),
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

export interface SuperEventProjectionFeedback {
  persisted: SuperFeedbackItem[]
  live: SuperFeedbackItem[]
  processBranch?: { sourceMessageId: string; revision: number; branch: SuperFeedbackProcessBranch }
  abortedTurn?: { sourceMessageId: string; revision: number; ticketId: string; turnId: string }
}

export interface CorrelatedTicketTurn {
  turnId?: string
  turn?: AgentTurn
  inputId?: string
  parent?: DispatchIntent
}

/** Match a Worker turn/input strictly to an active (non-withdrawn, non-stop) SA dispatch intent on this ticket. */
export function correlateTicketTurn(
  ticket: Pick<StoredSuperTicket, "id" | "sessionId">,
  snapshot: AgentSnapshot,
  intents: DispatchIntent[],
  query: { turnId?: string; inputId?: string; turnPayload?: AgentTurn },
): CorrelatedTicketTurn {
  const turn = query.turnPayload ?? (query.turnId ? snapshot.turns.find(t => t.id === query.turnId) : undefined)
  const turnId = query.turnId ?? turn?.id
  const inputId = query.inputId || turn?.initialInputId
  const eligible = intents.filter(i => i.ticketId === ticket.id && i.sessionId === ticket.sessionId && i.phase !== "withdrawn" && i.operation !== "stop")
  const parent = (inputId ? eligible.find(i => i.inputId === inputId) : undefined)
    ?? (turnId ? eligible.find(i => i.deliveredTurnId === turnId) : undefined)
    ?? (turnId ? eligible.find(i => !!i.inputId && snapshot.inputs.some(inp => inp.id === i.inputId && inp.turnId === turnId && !!inp.actualDelivery)) : undefined)
    ?? (turnId ? eligible.find(i => !i.deliveredTurnId && i.operation === "steer" && i.turnId === turnId && snapshot.inputs.some(inp => inp.turnId === turnId && inp.actualDelivery === "steer")) : undefined)
  return { turnId, turn, inputId, parent }
}

/** Extract pending permissions/elicitations belonging strictly to SA-delegated turns on this ticket. */
export function ownedPendingRequests(
  ticket: Pick<StoredSuperTicket, "id" | "sessionId">,
  snapshot: AgentSnapshot,
  intents: DispatchIntent[],
): SuperWorkerRequest[] {
  const ownsTurn = (turnId?: string) => !!turnId && !!correlateTicketTurn(ticket, snapshot, intents, { turnId }).parent
  return [
    ...snapshot.permissions.filter(item => item.state === "pending" && ownsTurn(item.turnId)).map(item => ({ kind: "permission" as const, item })),
    ...snapshot.elicitations.filter(item => ownsTurn(item.turnId) && (item.state === "pending" || (item.request.mode === "url" && item.response?.action === "accept"
      && !item.completedAt && snapshot.turns.some(turn => turn.id === item.turnId && activeTurn(turn))))).map(item => ({ kind: "elicitation" as const, item })),
  ]
}

/** Resolve crossing-receipt `working` intents against journal commands before projecting events. */
export async function resolveWorkingIntentInputs(
  intents: DispatchIntent[],
  sessionId: string,
  snapshot: AgentSnapshot,
  journal: SuperWorkers["journal"],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  for (const intent of intents) {
    if (intent.sessionId !== sessionId || intent.phase !== "working" || intent.inputId || intent.operation === "stop") continue
    const cmd = await journal.command(intent.submitId)
    const matched = cmd ? snapshot.inputs.find(inp => inp.submissionCommandId === cmd.id)?.id ?? (cmd.result as AgentReceipt | undefined)?.inputId : undefined
    if (matched) resolved.set(intent.id, matched)
  }
  return resolved
}

/** Reconcile ticket status against current Worker snapshot using strictly SA-owned turns, inputs, and requests. */
export function syncTicketSnapshotStatus(
  ticket: StoredSuperTicket,
  snapshot: AgentSnapshot,
  intents: DispatchIntent[],
): void {
  if (BigInt(ticket.lastEventSeq || "0") < BigInt(snapshot.session.lastEventSeq)) return
  const eligible = intents.filter(i => i.ticketId === ticket.id && i.sessionId === ticket.sessionId && i.phase !== "withdrawn" && i.operation !== "stop")
  const active = snapshot.turns.some(t => activeTurn(t) && !!correlateTicketTurn(ticket, snapshot, intents, { turnId: t.id, turnPayload: t }).parent)
  const queued = snapshot.inputs.some(input => (input.state === "pending" || input.state === "dispatching") && !input.error && eligible.some(i => i.inputId === input.id))
    || intents.some(i => i.ticketId === ticket.id && i.operation !== "stop" && (i.phase === "planned" || i.phase === "working"))
  if ((ticket.status === undefined || ticket.status === "stopped") && (active || queued)) ticket.status = active ? "working" : "queued"
  if (ownedPendingRequests(ticket, snapshot, intents).some(req => req.item.state === "pending")) ticket.status = "attention"
}

function validPositiveSeq(value?: string): string | undefined {
  return value && /^\d+$/u.test(value) && BigInt(value) > 0n ? value : undefined
}

function steerBoundarySeq(input: AgentInput, eventSeq?: string): string | undefined {
  const accepted = validPositiveSeq(input.acceptedSeq)
  const seq = validPositiveSeq(eventSeq)
  // A delivered steer's own input event is its real delivery receipt, so it wins over the accepted seq.
  if (input.state === "delivered" && input.actualDelivery !== "steer") return accepted ?? seq
  if (accepted && seq) return BigInt(accepted) >= BigInt(seq) ? accepted : seq
  return accepted ?? seq
}

function maxPositiveSeq(a?: string, b?: string): string | undefined {
  const va = validPositiveSeq(a)
  const vb = validPositiveSeq(b)
  if (va && vb) return BigInt(va) >= BigInt(vb) ? va : vb
  return va ?? vb
}

/** Delivered-steer receipts in one projection batch, keyed by input: the Worker received the input at `seq`. */
type SteerDeliveries = ReadonlyMap<string, { seq: string; turnId?: string }>

function collectSteerDeliveries(events: readonly AgentEvent[]): SteerDeliveries {
  const deliveries = new Map<string, { seq: string; turnId?: string }>()
  for (const event of events) {
    if (event.kind !== "input") continue
    const input = event.payload as AgentInput
    if (input.state === "delivered" && input.actualDelivery === "steer" && !deliveries.has(input.id)) {
      deliveries.set(input.id, { seq: event.seq, ...(input.turnId ? { turnId: input.turnId } : {}) })
    }
  }
  return deliveries
}

/**
 * Branch floors normally merge to the earliest seq. A confirmed steer delivery instead raises the appended
 * request's floor: activity between host acceptance and Worker receipt belongs to the original request.
 */
function raiseSteerDeliveryBoundary(room: SuperRoom, sourceMessageId: string, revision: number, ticketId: string, inputId: string, deliveredSeq: string): void {
  const proc = room.feedbackProcesses?.find(p => p.sourceMessageId === sourceMessageId && p.revision === revision)
  for (const branch of proc?.branches ?? []) {
    if (branch.ticketId !== ticketId || branch.inputId !== inputId) continue
    if (!branch.fromSeq || BigInt(branch.fromSeq) < BigInt(deliveredSeq)) branch.fromSeq = deliveredSeq
  }
}

function syncSteeredTurnBranches(params: {
  room: SuperRoom
  ticket: StoredSuperTicket
  snapshot: AgentSnapshot
  intents: DispatchIntent[]
  turnId: string
  excludeSourceMessageId?: string
  eventSeq: string
  addedActivities: number
  steerDeliveries: SteerDeliveries
}): void {
  const { room, ticket, snapshot, intents, turnId, excludeSourceMessageId, eventSeq, addedActivities, steerDeliveries } = params
  if (!ticket.sessionId) return
  const seqNum = validPositiveSeq(eventSeq) ? BigInt(eventSeq) : undefined
  for (const intent of intents) {
    if (intent.ticketId !== ticket.id || intent.sessionId !== ticket.sessionId) continue
    if (intent.phase === "withdrawn" || intent.operation === "stop") continue
    if (excludeSourceMessageId && intent.messageId === excludeSourceMessageId) continue
    const input = intent.inputId ? snapshot.inputs.find(inp => inp.id === intent.inputId) : undefined
    const batchDelivery = intent.inputId ? steerDeliveries.get(intent.inputId) : undefined
    // Until the Worker has actually received the appended input, this turn's activity is the original request's.
    if (input && input.state !== "delivered" && !batchDelivery) continue
    const joinedTurn = (input?.turnId === turnId && input.actualDelivery === "steer")
      || batchDelivery?.turnId === turnId
      || (intent.deliveredTurnId === turnId && (intent.sharedTurn === true || intent.operation === "steer" || input?.actualDelivery === "steer"))
    if (!joinedTurn) continue
    const sourceMessage = room.messages.find(m => m.id === intent.messageId && m.role === "user")
    const revision = sourceMessage?.revision ?? 0
    const existingProc = room.feedbackProcesses?.find(p => p.sourceMessageId === intent.messageId && p.revision === revision)
    const existingBranch = existingProc?.branches.find(b =>
      b.ticketId === ticket.id && (b.turnId === turnId || (intent.inputId && b.inputId === intent.inputId)))
    const fromSeq = maxPositiveSeq(existingBranch?.fromSeq, maxPositiveSeq(batchDelivery?.seq, input ? steerBoundarySeq(input) : undefined))
    if (!fromSeq) continue
    if (seqNum !== undefined && seqNum < BigInt(fromSeq)) continue
    const nextCount = (existingBranch?.activityCount ?? 0) + addedActivities
    persistRoomProcessBranch(room, intent.messageId, revision, {
      ticketId: ticket.id,
      sessionId: ticket.sessionId,
      turnId,
      ...(intent.inputId ? { inputId: intent.inputId } : {}),
      fromSeq,
      throughSeq: eventSeq,
      activityCount: nextCount,
    })
  }
}

/** Only user-visible parent output enters the workspace timeline; reasoning and tool payloads stay in their Session. */
export function projectSuperEvents(
  room: SuperRoom,
  ticket: StoredSuperTicket,
  events: AgentEvent[],
  snapshot: AgentSnapshot,
  intents: DispatchIntent[],
  onFeedback?: (feedback: SuperEventProjectionFeedback) => void,
) {
  const turnsInPage = new Map<string, AgentTurn>()
  for (const ev of events) if (ev.kind === "turn") turnsInPage.set((ev.payload as AgentTurn).id, ev.payload as AgentTurn)
  const steerDeliveries = collectSteerDeliveries(events)
  const correlateTurn = (turnId?: string, explicitInputId?: string, turnPayload?: AgentTurn) => {
    const matched = correlateTicketTurn(ticket, snapshot, intents, { turnId, inputId: explicitInputId, turnPayload: turnPayload ?? (turnId ? turnsInPage.get(turnId) : undefined) })
    const sourceMessage = matched.parent ? room.messages.find(m => m.id === matched.parent!.messageId) : undefined
    return { ...matched, sourceMessage, sourceMessageId: matched.parent?.messageId, revision: sourceMessage?.revision ?? 0 }
  }
  const correlation = (event: AgentEvent) => {
    const turnId = event.kind === "turn" ? (event.payload as AgentTurn).id : event.turnId ?? ("turnId" in event.payload ? event.payload.turnId : undefined)
    const explicitInputId = event.kind === "input" ? (event.payload as AgentInput).id : event.inputId
    return correlateTurn(turnId, explicitInputId, event.kind === "turn" ? event.payload as AgentTurn : undefined)
  }
  const report = (event: AgentEvent, text: string, workerEvent: SuperMessage["workerEvent"] = "error", options: { visible?: boolean } = {}) => {
    const { turnId, inputId, parent, sourceMessage } = correlation(event)
    if (parent && sourceMessage && sourceMessage.ticketId === ticket.id) {
      sourceMessage.inputId = inputId
      sourceMessage.turnId = turnId
    }
    ticket.summary = text.slice(0, 700)
    const created = note(room, text, { id: `worker:${ticket.id}:${event.seq}`, role: "worker", sessionId: ticket.sessionId, ticketId: ticket.id, workerEvent, sourceMessageId: parent ? parent.messageId : undefined, turnId, inputId, createdAt: event.createdAt })
    const shouldBump = options.visible ?? (workerEvent === "result" || workerEvent === "error" || workerEvent === "question")
    if (shouldBump) bumpVisibleSeq(room, created)
    return created
  }
  const persistedBatch: SuperFeedbackItem[] = []
  const liveBatch: SuperFeedbackItem[] = []
  let latestBranch: SuperEventProjectionFeedback["processBranch"]
  let abortedTurn: SuperEventProjectionFeedback["abortedTurn"]
  for (const event of events) {
    if (BigInt(event.seq) <= BigInt(ticket.lastEventSeq || "0")) continue
    ticket.lastEventSeq = event.seq
    const info = correlation(event)
    if (info.parent && info.turnId && ticket.sessionId && (event.kind === "acp" || event.kind === "permission" || event.kind === "elicitation")) {
      ticket.updatedAt = event.createdAt
      const turnState = ensureTurnOutput(ticket.turnOutput, ticket.output, info.turnId, event.seq, event.createdAt)
      ticket.turnOutput = turnState
      const hasRequestAck = !!info.sourceMessageId && (room.feedbackItems ?? []).some(item =>
        item.kind === "ack" && item.sourceMessageId === info.sourceMessageId && item.revision === info.revision)
      const projected = stepWorkerTurnOutput({
        state: turnState,
        event,
        snapshot,
        sourceMessageId: info.sourceMessageId,
        revision: info.revision,
        ticketId: ticket.id,
        sessionId: ticket.sessionId,
        inputId: info.inputId,
        hasRequestAck,
      })
      for (const item of projected.persistedItems) {
        const saved = persistRoomFeedbackItem(room, item)
        if (saved.changed) persistedBatch.push(saved.item)
      }
      liveBatch.push(...projected.liveItems)
      if (projected.liveItems.length) {
        syncSteeredTurnBranches({
          room, ticket, snapshot, intents, turnId: info.turnId,
          excludeSourceMessageId: info.sourceMessageId, eventSeq: event.seq, addedActivities: projected.liveItems.length,
          steerDeliveries,
        })
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
      if (!info.parent && !notice) continue
      ticket.updatedAt = event.createdAt
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
      // Independent manual Worker turns without a matching SA dispatch stay strictly inside their Worker session.
      if (!info.parent) continue
      ticket.updatedAt = event.createdAt
      const turn = event.payload as AgentTurn
      if (activeTurn(turn)) {
        ticket.status = "working"
        if (ticket.sessionId && info.sourceMessageId) {
          persistRoomProcessBranch(room, info.sourceMessageId, info.revision, {
            ticketId: ticket.id,
            sessionId: ticket.sessionId,
            turnId: turn.id,
            ...(info.inputId ? { inputId: info.inputId } : {}),
            fromSeq: event.seq,
            activityCount: ticket.turnOutput?.turnId === turn.id ? ticket.turnOutput.activityCount : 0,
          })
        }
      } else {
        if (room.messages.some(m => m.workerEvent === "result" && m.sessionId === ticket.sessionId && m.turnId === turn.id)) continue
        ticket.status = turn.state === "completed" ? undefined : turn.state === "cancelled" ? "stopped" : "blocked"
        if (ticket.status === "stopped" && room.pendingQuestion?.ticketId === ticket.id) room.pendingQuestion = undefined
        const turnState = ticket.turnOutput?.turnId === turn.id ? ticket.turnOutput : undefined
        const legacyText = ticket.output?.turnId === turn.id ? ticket.output.text : ""
        const finalized = finalizeWorkerTurnOutput({
          state: turnState,
          legacyText,
          turn,
          ticketId: ticket.id,
          sessionId: ticket.sessionId ?? "",
          sourceMessageId: info.sourceMessageId,
          revision: info.revision,
          inputId: info.inputId,
        })
        for (const milestone of finalized.milestones) {
          const saved = persistRoomFeedbackItem(room, milestone)
          if (saved.changed) persistedBatch.push(saved.item)
        }
        if (info.sourceMessageId) {
          persistRoomProcessBranch(room, info.sourceMessageId, info.revision, finalized.processBranch)
          latestBranch = { sourceMessageId: info.sourceMessageId, revision: info.revision, branch: finalized.processBranch }
          if (turn.state !== "completed") {
            abortedTurn = { sourceMessageId: info.sourceMessageId, revision: info.revision, ticketId: ticket.id, turnId: turn.id }
          }
        }
        syncSteeredTurnBranches({
          room, ticket, snapshot, intents, turnId: turn.id,
          excludeSourceMessageId: info.sourceMessageId,
          eventSeq: finalized.processBranch.throughSeq ?? event.seq,
          addedActivities: 0,
          steerDeliveries,
        })
        const result = report(event, finalized.text, "result", { visible: turn.state !== "cancelled" })
        result.logicalId = finalized.logicalId
        if (finalized.truncated) result.truncated = true
        if (finalized.unboundedOutcome) result.unboundedOutcome = true
        if (turn.state === "cancelled") result.stopState = "stopped"
        ticket.lastDeliveredSeq = event.seq
        ticket.output = undefined
        ticket.turnOutput = undefined
      }
    }
    if (event.kind === "input") {
      if (!info.parent) continue
      const input = event.payload as AgentInput
      if (ticket.sessionId && info.sourceMessageId && (input.actualDelivery === "steer" || input.requestedDelivery === "steer" || info.parent.operation === "steer")) {
        const fromSeq = steerBoundarySeq(input, event.seq)
        const confirmedTurnId = input.actualDelivery ? input.turnId : info.parent.deliveredTurnId
        persistRoomProcessBranch(room, info.sourceMessageId, info.revision, {
          ticketId: ticket.id,
          sessionId: ticket.sessionId,
          inputId: input.id,
          ...(confirmedTurnId ? { turnId: confirmedTurnId } : {}),
          ...(fromSeq ? { fromSeq } : {}),
          activityCount: 0,
        })
        if (fromSeq && input.state === "delivered" && input.actualDelivery === "steer") {
          raiseSteerDeliveryBoundary(room, info.sourceMessageId, info.revision, ticket.id, input.id, fromSeq)
        }
      }
      if (input.state === "failed" || input.state === "uncertain" || input.state === "pending" && input.error) {
        ticket.updatedAt = event.createdAt
        ticket.status = "blocked"
        report(event, input.error || `Input delivery is ${input.state}.`)
      }
    }
    if (event.kind === "run") {
      const run = event.payload as AgentRun
      if ((run.state === "interrupted" || run.state === "failed") && (ticket.status === "working" || ticket.status === "queued")) {
        const activeInfo = ticket.turnOutput ? correlateTurn(ticket.turnOutput.turnId) : undefined
        const hasOwnedLiveWork = !!activeInfo?.parent
          || snapshot.turns.some(t => activeTurn(t) && !!correlateTurn(t.id, undefined, t).parent)
          || intents.some(i => i.ticketId === ticket.id && i.sessionId === ticket.sessionId && i.operation !== "stop" && (i.phase === "planned" || i.phase === "working"))
        if (!hasOwnedLiveWork) continue
        ticket.updatedAt = event.createdAt
        if (ticket.turnOutput && ticket.sessionId && activeInfo?.parent) {
          for (const item of abortOpenTurnPublicSegments({
            state: ticket.turnOutput,
            ticketId: ticket.id,
            sessionId: ticket.sessionId,
            sourceMessageId: activeInfo.sourceMessageId,
            revision: activeInfo.revision,
            inputId: activeInfo.inputId,
            updatedAt: event.createdAt,
          })) {
            const saved = persistRoomFeedbackItem(room, item)
            if (saved.changed) persistedBatch.push(saved.item)
          }
          if (activeInfo.sourceMessageId) {
            abortedTurn = { sourceMessageId: activeInfo.sourceMessageId, revision: activeInfo.revision, ticketId: ticket.id, turnId: ticket.turnOutput.turnId }
          }
        }
        ticket.status = "blocked"; report(event, run.error || `Worker run ${run.state}.`)
      }
    }
  }
  if (onFeedback && (persistedBatch.length || liveBatch.length || latestBranch || abortedTurn)) {
    onFeedback({ persisted: persistedBatch, live: liveBatch, ...(latestBranch ? { processBranch: latestBranch } : {}), ...(abortedTurn ? { abortedTurn } : {}) })
  }
}
