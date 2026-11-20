import { randomUUID } from "node:crypto"
import type { ComposerReference, ComposerSkillReference } from "./composer-reference-protocol.ts"
import type { AgentActor } from "./agent-protocol.ts"
import type { SuperCoordinator, SuperCoordinatorUsage, SuperMessage, SuperModelSelection, SuperSnapshot, SuperStopState, SuperTicket, SuperTicketStatus, SuperWorkerSelection, SuperWorkspaceId } from "./super-agent-protocol.ts"

export interface StoredSuperMessage extends SuperMessage {
  workerRequestId?: string
  attachmentKeys?: string[]
  actor?: AgentActor
  correctedTicketId?: string
  corrections?: { fromTicketId?: string; toTicketId: string; actor: AgentActor; createdAt: string }[]
  options?: string[]
}
export interface StoredSuperTicket extends SuperTicket {
  /** Owning Workspace for the Worker; the default front desk gets a private directory on demand. */
  executionWorkspaceId?: string
  acceptanceMessageId?: string
  lastEventSeq?: string
  output?: { turnId: string; text: string }
}
export interface SuperRoom {
  coordinatorMeasurement?: { coordinator: SuperCoordinator; selection: SuperModelSelection; usage?: SuperCoordinatorUsage }
  workerSelection?: SuperWorkerSelection
  workerAutoApprove?: boolean
  workspaceId: SuperWorkspaceId
  provider: string
  messages: StoredSuperMessage[]
  tickets: StoredSuperTicket[]
  focusTicketId?: string
  recentTicketIds: string[]
  pendingQuestion?: { ticketId: string; options: string[]; optionDisposition?: "continue" }
}
export interface DispatchIntent {
  workerSelection?: SuperWorkerSelection
  id: string
  roomId: SuperWorkspaceId
  messageId: string
  ticketId: string
  actor: AgentActor
  operation: "submit" | "steer" | "stop"
  prompt: string
  /** Only an advertised command may be submitted for this explicit invocation. */
  commandName?: string
  skills?: ComposerSkillReference[]
  references?: ComposerReference[]
  attachmentKeys?: string[]
  provider: string
  sessionId?: string
  workspaceId?: string
  context?: "directory" | "worktree"
  turnId?: string
  inputId?: string
  deliveredTurnId?: string
  sharedTurn?: boolean
  stop?: { state: SuperStopState; requestedAt: number; actor: AgentActor; withdrawId: string; cancelId: string; sharedTurnId?: string }
  adoptHistory?: boolean
  /** null restores an existing ticket with no status; a new ticket has no prior state. */
  priorTicketStatus?: SuperTicketStatus | null
  priorAcceptance?: string
  priorAcceptanceMessageId?: string
  createId: string
  submitId: string
  phase: "planned" | "working" | "sent" | "failed" | "uncertain" | "withdrawn"
  error?: string
}
export interface SuperUserState {
  historyProjects?: Record<string, string>
  coordinatorProviderId?: string
  coordinatorOverrides?: Partial<Record<SuperCoordinator, SuperModelSelection>>
  rooms: SuperRoom[]
  intents: DispatchIntent[]
}
export interface SuperStateStore {
  get(userId: string): SuperUserState | undefined
  update<R>(userId: string, initial: () => SuperUserState, edit: (state: SuperUserState) => R): Promise<R>
  users(): string[]
}
export const emptyState = (): SuperUserState => ({ rooms: [], intents: [] })
export function roomFor(state: SuperUserState, workspaceId: SuperWorkspaceId, defaultProvider = ""): SuperRoom {
  let room = state.rooms.find(item => item.workspaceId === workspaceId)
  if (!room) {
    room = { workspaceId, messages: [], tickets: [], provider: defaultProvider, recentTicketIds: [] }
    state.rooms.push(room)
  }
  return room
}
export const missingCoordinatorProvider = "Choose an available scheduling provider in the project model menu, then retry."
export const missingWorkerProvider = "No configured worker provider is available for this ticket."

/** The workspace checkpoint is persisted before either worker command can run. */
export function missingWorkerDispatch(intent: DispatchIntent): boolean {
  return intent.phase === "failed" && intent.operation === "submit" && intent.error === missingWorkerProvider &&
    !intent.workspaceId && !intent.sessionId && !intent.inputId && !intent.adoptHistory
}

export function dispatchRecovery(room: SuperRoom, intents: DispatchIntent[]) {
  const last = new Map<string, DispatchIntent>()
  const byMessage = new Map<string, DispatchIntent[]>()
  const tickets = new Map(room.tickets.map(ticket => [ticket.id, ticket]))
  for (const intent of intents) {
    if (intent.roomId !== room.workspaceId || intent.phase === "withdrawn") continue
    last.set(intent.ticketId, intent)
    const group = byMessage.get(intent.messageId) || []
    group.push(intent)
    byMessage.set(intent.messageId, group)
  }
  const recoverable = new Map<string, DispatchIntent[]>()
  for (const [messageId, group] of byMessage) {
    const outstanding = group.filter(intent => intent.phase !== "sent")
    if (outstanding.length && outstanding.every(intent => missingWorkerDispatch(intent) &&
        last.get(intent.ticketId) === intent && tickets.has(intent.ticketId) && !tickets.get(intent.ticketId)?.sessionId)) {
      recoverable.set(messageId, outstanding)
    }
  }
  return recoverable
}

// A missing acknowledgement is never a terminal result. Keep the durable command available for reconciliation.
export function visibleStopState(stop: NonNullable<DispatchIntent["stop"]>): SuperStopState {
  return stop.state === "stopping" && Date.now() - stop.requestedAt > 15_000 ? "unconfirmed" : stop.state
}

export function publicRoom(room: SuperRoom, coordinator: SuperCoordinator | undefined, provider: string, intents: DispatchIntent[]): SuperSnapshot {
  const recoverable = dispatchRecovery(room, intents)
  const sourceTickets = new Map(room.messages.filter(m => m.role === "user").map(m => [m.id, m.ticketId]))
  const ticketTitles = new Map(room.tickets.map(ticket => [ticket.id, ticket.title]))
  const markerKey = (messageId: string, ticketId: string) => JSON.stringify([messageId, ticketId])
  const markers = new Map<string, SuperMessage>()
  const snapshot: SuperSnapshot = {
    workerAutoApprove: room.workerAutoApprove === true,
    workerSelection: room.provider === provider ? room.workerSelection ?? {} : {},
    coordinator, workspaceId: room.workspaceId, provider, focusTicketId: room.focusTicketId,
    messages: room.messages.map(({ actor, correctedTicketId, corrections, options, attachmentKeys, workerRequestId, ...message }) => {
      if (message.workerEvent === "permission" || message.workerEvent === "question") message.text = withoutWorkerLink(message.text)
      if (message.role === "user" && actor?.userId) {
        message.author = { kind: "user", userId: actor.userId, ...(actor.sourceMachine && { sourceMachine: actor.sourceMachine }) }
      }
      if (message.role === "assistant" && !message.ticketId && message.sourceMessageId) {
        message.ticketId = sourceTickets.get(message.sourceMessageId)
      }
      if (message.role === "assistant" && message.sourceMessageId && message.ticketId && sourceTickets.has(message.sourceMessageId)) {
        const legacyDispatch = !message.kind && message.reason !== undefined && message.text === ticketTitles.get(message.ticketId)
        if (message.kind === "dispatch" || legacyDispatch) markers.set(markerKey(message.sourceMessageId, message.ticketId), message)
      }
      if (message.role === "user" && message.state === "failed" && message.reason === missingWorkerProvider) {
        message.failureCode = "worker_unconfigured"
        message.retryable = recoverable.has(message.id)
      }
      if (message.role === "user" && message.state === "failed" && message.reason === missingCoordinatorProvider) message.failureCode = "coordinator_unconfigured"
      return message
    }),
    tickets: room.tickets.map(({ executionWorkspaceId, acceptanceMessageId, lastEventSeq, output, ...ticket }) => ({ ...ticket, summary: withoutWorkerLink(ticket.summary) })),
  }
  for (const intent of intents) {
    if (intent.roomId !== room.workspaceId || intent.phase === "withdrawn" && !intent.stop) continue
    const marker = markers.get(markerKey(intent.messageId, intent.ticketId))
    if (!marker) continue
    marker.canStop = intent.operation !== "stop" && intent.phase !== "failed" && intent.phase !== "withdrawn"
    if (intent.operation !== "stop" && (intent.phase === "planned" || intent.phase === "working")) marker.dispatching = true
    if (intent.stop) marker.stopState = visibleStopState(intent.stop)
    if (intent.sharedTurn) marker.sharedTurn = true
    if (intent.inputId) marker.inputId = intent.inputId
    // A queued submit can share a session with a running turn belonging to another input.
    if (intent.deliveredTurnId) marker.turnId = intent.deliveredTurnId
    else if (intent.operation !== "submit" && intent.turnId) marker.turnId = intent.turnId
  }
  return snapshot
}
function withoutWorkerLink(text: string): string {
  return /^(Permission requested|The worker has a question)(\n|$)/u.test(text) ? text.replace(/\nOpen the worker session to respond\.$/u, "") : text
}
export function userFocus(room: SuperRoom, ticketId?: string) {
  room.focusTicketId = ticketId
  room.pendingQuestion = undefined
  if (ticketId) room.recentTicketIds = [ticketId, ...room.recentTicketIds.filter(id => id !== ticketId)].slice(0, 5)
}
export function note(room: SuperRoom, text: string, fields: Partial<StoredSuperMessage> = {}): StoredSuperMessage {
  const message: StoredSuperMessage = { id: randomUUID(), createdAt: new Date().toISOString(), role: "assistant", text, ...fields }
  room.messages.push(message)
  return message
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
