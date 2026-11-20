import { randomUUID } from "node:crypto"
import { turnSteering, type AgentActor, type AgentInput, type AgentSnapshot } from "./agent-protocol.ts"
import type { SuperStop, SuperStopState } from "./super-agent-protocol.ts"
import { visibleStopState, type DispatchIntent, type SuperRoom, type SuperUserState } from "./super-agent-state.ts"
import { activeTurn, type SuperWorkers } from "./super-agent-worker.ts"

/** Withdraw work that is known never to have reached a Worker. Also used by reassignment. */
export function withdrawDispatch(state: SuperUserState, room: SuperRoom, intent: DispatchIntent, snapshot?: AgentSnapshot) {
  intent.phase = "withdrawn"
  const ticket = room.tickets.find(item => item.id === intent.ticketId)
  if (ticket?.acceptanceMessageId === intent.messageId) {
    ticket.latestAcceptance = intent.priorAcceptance
    ticket.acceptanceMessageId = intent.priorAcceptanceMessageId
  }
  if (!ticket || ticket.status !== "queued" || state.intents.some(other => other.ticketId === ticket.id && !other.stop && ["planned", "working"].includes(other.phase))) return
  if (snapshot) {
    if (BigInt(ticket.lastEventSeq ?? "0") > BigInt(snapshot.session.lastEventSeq)) return
    if ([...snapshot.permissions, ...snapshot.elicitations].some(item => item.state === "pending")) { ticket.status = "attention"; return }
    if (snapshot.turns.some(activeTurn)) { ticket.status = "working"; return }
    if (snapshot.inputs.some(item => item.state === "pending" || item.state === "dispatching")) return
  }
  ticket.status = intent.priorTicketStatus === undefined ? "stopped" : intent.priorTicketStatus ?? undefined
  if (ticket.status === "stopped" && room.pendingQuestion?.ticketId === ticket.id) room.pendingQuestion = undefined
}

/** Resolve the user's original message and its branches inside the same committed edit as routing. */
export function requestWorkspaceStop(state: SuperUserState, request: SuperStop, actor: AgentActor) {
  let room = state.rooms.find(item => item.workspaceId === request.workspaceId)
  let source = room?.messages.find(item => item.id === request.messageId && item.role === "user")
  if (!room || !source) throw new Error("Unknown workspace request")
  const intents: DispatchIntent[] = []
  if ((source.revision ?? 0) !== request.revision) return { intents }
  if (source.state === "transferred") {
    const origin = room.workspaceId
    const destination = source.targetWorkspaceId
    room = state.rooms.find(item => item.workspaceId === destination)
    source = room?.messages.find(item => item.role === "user" && item.sourceWorkspaceId === origin && item.sourceMessageId === request.messageId)
    if (!room || !source || source.revision) return { intents }
  }
  if (source.state === "routing" && !request.ticketId) {
    source.state = "stopped"
    return { intents, routeId: source.id }
  }
  const branches = state.intents.filter(item => item.roomId === room.workspaceId && item.messageId === source.id &&
    (!request.ticketId || item.ticketId === request.ticketId) && (item.phase !== "withdrawn" || item.stop))
  if (request.ticketId && !branches.length) throw new Error("Ticket does not belong to this request")
  for (const intent of branches) {
    if (intent.operation === "stop" || intent.phase === "failed" || intent.stop && visibleStopState(intent.stop) !== "unconfirmed") continue
    const prior = intent.stop
    // A slow confirmation reuses the original actor and operation IDs, including across devices.
    intent.stop = prior?.state === "stopping" ? { ...prior, requestedAt: Date.now() } : {
      state: "stopping", requestedAt: Date.now(), actor, withdrawId: randomUUID(), cancelId: randomUUID(),
      sharedTurnId: request.sharedTurns?.find(turn => turn.ticketId === intent.ticketId)?.turnId,
    }
    if (intent.phase === "planned") {
      withdrawDispatch(state, room, intent)
      intent.stop.state = "stopped"
    } else intents.push(intent)
  }
  return { intents }
}

function inputTurn(snapshot: AgentSnapshot, input: AgentInput) {
  // requestedTurnId is a steering *proposal*. Providers may start a new turn instead.
  return input.turnId ? snapshot.turns.find(turn => turn.id === input.turnId) : snapshot.turns.findLast(turn => turn.initialInputId === input.id)
}

/** Take correlation from the actual Worker journal, including a steer that fell back to a new turn. */
export function observeWorkerInputs(intents: DispatchIntent[], snapshot: AgentSnapshot) {
  const inputs = new Map(snapshot.inputs.map(input => [input.id, input]))
  const shared = new Set(snapshot.inputs.filter(input => input.actualDelivery === "steer").map(input => input.turnId))
  let changed = false
  for (const intent of intents) {
    if (intent.sessionId !== snapshot.session.id) continue
    if (intent.phase === "withdrawn" && !intent.stop && !intent.inputId) {
      // An archive can land after native acceptance but before the front desk records the receipt.
      const accepted = snapshot.inputs.find(input => input.submissionCommandId === intent.submitId)
      if (accepted) { intent.inputId = accepted.id; intent.phase = "sent"; changed = true }
    }
    if (!intent.inputId) continue
    const input = inputs.get(intent.inputId)
    if (!input?.turnId || !input.actualDelivery) continue
    if (intent.deliveredTurnId === input.turnId && !!intent.sharedTurn === shared.has(input.turnId)) continue
    changed = true
    intent.deliveredTurnId = input.turnId
    intent.sharedTurn = shared.has(input.turnId) || undefined
  }
  return changed
}

type Outcome = { state: SuperStopState; undelivered?: boolean; snapshot?: AgentSnapshot }

/** Runs after in-flight dispatch on the ticket. It can withdraw or cancel, never submit or resume. */
export async function stopWorkspaceDispatch(workers: SuperWorkers, intent: DispatchIntent, authorize: (actor: AgentActor) => Promise<AgentActor>): Promise<Outcome> {
  const stop = intent.stop!
  const actor = await authorize(stop.actor)
  const submitted = await workers.journal.command(intent.submitId)
  if (submitted && (submitted.method !== "_deskfleet/input/submit" || submitted.actor.userId !== actor.userId ||
    intent.sessionId && submitted.sessionId !== intent.sessionId)) return { state: "unconfirmed" }
  if (!intent.inputId && !submitted) {
    if (intent.phase !== "working" && intent.phase !== "planned") return { state: "unconfirmed" }
    // A restart can land between native creation and storing the binding in the project.
    const creation = !intent.sessionId && await workers.journal.command(intent.createId)
    if (creation) {
      if (creation.method !== "_deskfleet/session/create" || creation.actor.userId !== actor.userId) return { state: "unconfirmed" }
      if (creation.status === "completed" && creation.sessionId) {
        const snapshot = await workers.journal.read(creation.sessionId)
        if (snapshot.session.workspaceId === intent.workspaceId) return { state: "stopped", undelivered: true, snapshot }
        return { state: "unconfirmed" }
      }
      if (creation.status !== "failed" && creation.status !== "rejected") return { state: "unconfirmed" }
    }
    return { state: "stopped", undelivered: true }
  }
  const sessionId = intent.sessionId ?? submitted?.sessionId
  if (!sessionId || !intent.workspaceId) return { state: "unconfirmed" }
  const read = async () => {
    const snapshot = await workers.journal.read(sessionId)
    if (snapshot.session.workspaceId !== intent.workspaceId) throw new Error("Worker is outside the request's workspace")
    const input = snapshot.inputs.find(item => intent.inputId ? item.id === intent.inputId : item.submissionCommandId === submitted?.id)
    return { snapshot, input }
  }
  let { snapshot, input } = await read()
  if (input?.state === "pending" && stop.state === "stopping") {
    try { await workers.handle("_deskfleet/input/withdraw", { sessionId, inputId: input.id, operationId: stop.withdrawId }, actor) }
    catch { /* It may have left the backlog while processing the click. Re-read this same input. */ }
    const refreshed = await read()
    snapshot = refreshed.snapshot
    input = refreshed.input
  }
  if (!input) return { state: submitted?.status === "rejected" || submitted?.status === "failed" ? "finished" : "unconfirmed" }
  if (input.state === "withdrawn") return { state: "stopped", undelivered: true, snapshot }
  if (input.state === "pending") return { state: "unconfirmed", snapshot }
  const turn = inputTurn(snapshot, input)
  if (!turn) {
    if (input.state === "failed") return { state: "finished", snapshot }
    return { state: input.state === "dispatching" ? stop.state : "unconfirmed", snapshot }
  }
  if (!activeTurn(turn)) return { state: turn.state === "cancelled" ? "stopped" : "finished", snapshot }
  if (stop.state === "unconfirmed") return { state: "unconfirmed", snapshot }
  const requireUnshared = stop.sharedTurnId !== turn.id
  if (requireUnshared) {
    const steering = turnSteering(snapshot.inputs, turn.id)
    if (steering) return { state: steering === "pending" ? "stopping" : "unconfirmed", snapshot }
  }
  const previous = await workers.journal.command(stop.cancelId)
  if (!previous) await workers.handle("_deskfleet/turn/cancel", { sessionId, turnId: turn.id, operationId: stop.cancelId, ...(requireUnshared && { requireUnshared }) }, actor)
  else if (previous.status === "failed" || previous.status === "rejected" || previous.status === "uncertain") return { state: "unconfirmed", snapshot }
  const current = (await read()).snapshot
  const outcome = current.turns.find(item => item.id === turn.id)
  return { state: !outcome ? "unconfirmed" : activeTurn(outcome) ? "stopping" : outcome.state === "cancelled" ? "stopped" : "finished", snapshot: current }
}
