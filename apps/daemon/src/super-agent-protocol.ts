import type { ComposerMention } from "./composer-reference-protocol.ts"
import type { AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { AgentActor, AgentElicitation, AgentInput, AgentPermission } from "./agent-protocol.ts"

/** Wire types for the personal, machine-local workspace front desk. null denotes the default conversation. */
export type SuperWorkspaceId = string | null
/** Configured provider instance ID within this machine registration. */
export type SuperCoordinator = string
export type SuperTicketStatus = "queued" | "working" | "attention" | "stopped" | "blocked"
export type SuperMessageState = "routing" | "assigned" | "answered" | "failed" | "uncertain" | "transferred"

export interface SuperAttachmentInfo { type: "image" | "resource" | "resource_link"; name: string }

export interface SuperAttachmentRequest { messageId: string; index: number }
export type SuperAttachmentPreview =
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; text: string; uri?: string; mimeType?: string | null }
  | { type: "resource_link"; data: string; mimeType: string }
  | { type: "unavailable" | "tooLarge" }

export interface SuperHistorySource { sessionId: string; afterSeq: string; throughSeq: string }

export interface SuperMessage {
  id: string
  role: "user" | "assistant" | "worker"
  author?: Pick<AgentActor, "kind" | "userId" | "sourceMachine">
  text: string
  attachments?: SuperAttachmentInfo[]
  createdAt: string
  state?: SuperMessageState
  replyTo?: string
  /** The execution target chosen when submitting a provider slash command. */
  command?: SuperWorkerCommandTarget
  mentions?: ComposerMention[]
  ticketId?: string
  sessionId?: string
  inputId?: string
  turnId?: string
  workerEvent?: "result" | "permission" | "question" | "error"
  sourceMessageId?: string
  sourceWorkspaceId?: SuperWorkspaceId
  targetWorkspaceId?: string
  context?: string
  reason?: string
  historySources?: SuperHistorySource[]
  kind?: "dispatch" | "delivery"
  failureCode?: "worker_unconfigured" | "coordinator_unconfigured"
  retryable?: boolean
}

export interface SuperTicket {
  id: string
  title: string
  scope: string
  latestAcceptance?: string
  summary: string
  /** Only active work, interruptions and failures have a status. Results remain in the conversation. */
  status?: SuperTicketStatus
  provider: string
  sessionId?: string
  referenceTicketId?: string
  historySources?: SuperHistorySource[]
  updatedAt: string
}

/** Tokens in one foreground model invocation, including its output. The model may omit its capacity. */
export interface SuperCoordinatorUsage { used: number; size?: number }

export interface SuperModelSelection { model?: string; reasoningEffort?: string }
export type SuperWorkerSelection = Pick<AgentConfigurationSelection, "model" | "reasoningEffort" | "mode">

/** Live Worker records for the signed-in user's room. Decisions use the original Session commands. */
export type SuperWorkerRequest = { kind: "permission"; item: AgentPermission } | { kind: "elicitation"; item: AgentElicitation }

/** Capabilities reported by the selected coordinator CLI on this machine. */
export interface SuperCoordinatorOptions {
  models: { id: string; name: string; reasoningEfforts: string[]; defaultReasoningEffort?: string }[]
  defaultModel?: string
  defaultReasoningEfforts: string[]
}

export interface SuperHistoryGroup { paths: string[]; sessionIds: string[]; projects: { id: string; name: string }[] }
export interface SuperHistory { links: Record<string, string>; groups?: SuperHistoryGroup[] }
export type SuperHistoryRequest = { view: "links" } | { view: "groups"; assign?: { workspaceId: string; sessionIds: string[] } }

export interface SuperWorkspace { id: string; name: string; roots: string[] }

export interface SuperSnapshot {
  pendingRequests?: (SuperWorkerRequest & { ticketId: string })[]
  coordinatorUsage?: SuperCoordinatorUsage
  coordinatorOverrides?: SuperModelSelection
  coordinatorOptions?: SuperCoordinatorOptions
  coordinatorSelection?: SuperModelSelection
  workerSelection?: SuperWorkerSelection
  /** Absent on hosts predating project approval defaults. */
  workerAutoApprove?: boolean
  supportsWorkerReferences?: boolean
  supportsWorkerCommands?: boolean
  supportsComposerMentions?: boolean
  supportsAttachmentPreviews?: boolean
  /** Present only on an explicit read of one attachment in this conversation. */
  attachmentPreview?: SuperAttachmentRequest & { content: SuperAttachmentPreview }
  supportsAttachments?: boolean
  coordinator?: SuperCoordinator
  /** Configured instances that support a restricted coordinator invocation on this host. */
  coordinatorProviders?: { id: string; name: string }[]
  workerProviders?: { id: string; name: string }[]
  workspaceId: SuperWorkspaceId
  messages: SuperMessage[]
  tickets: SuperTicket[]
  provider: string
  focusTicketId?: string
}

export interface SuperWorkerCommandTarget { provider: string; ticketId?: string; sessionId?: string }

/** The command catalog and delivery must refer to the same Worker. A quote takes precedence over focus. */
export function superWorkerCommandTarget(room: Pick<SuperSnapshot, "messages" | "tickets" | "provider" | "focusTicketId">, replyTo?: string): SuperWorkerCommandTarget {
  const quote = replyTo ? room.messages.find(message => message.id === replyTo) : undefined
  const sourceId = quote?.role === "assistant" && !quote.ticketId ? quote.sourceMessageId : undefined
  const ticketId = replyTo ? quote?.ticketId ?? (sourceId && room.messages.find(message => message.id === sourceId)?.ticketId) : room.focusTicketId
  const ticket = ticketId ? room.tickets.find(item => item.id === ticketId) : undefined
  return ticket ? { provider: ticket.provider || room.provider, ticketId: ticket.id, ...(ticket.sessionId && { sessionId: ticket.sessionId }) } : { provider: room.provider }
}

export function superWorkerCommandName(text: string): string | undefined {
  return /^\s*\/([^\s/]+)(?:\s|$)/u.exec(text)?.[1]
}

export interface SuperSend {
  mentions?: ComposerMention[]
  attachments?: AgentInput["content"]
  workspaceId: SuperWorkspaceId
  messageId: string
  text: string
  replyTo?: string
  retry?: boolean
  command?: SuperWorkerCommandTarget
}
export interface SuperCorrection {
  workspaceId: SuperWorkspaceId
  messageId: string
  ticketId: string
}
export interface SuperSettings {
  coordinatorSelection?: SuperModelSelection & { provider: SuperCoordinator }
  workerSelection?: SuperModelSelection & { provider: string }
  workerMode?: { provider: string; mode: string | null }
  workerAutoApprove?: boolean
  workspaceId: SuperWorkspaceId
  coordinator?: SuperCoordinator
  provider?: string
}
export interface SuperMethods {
  "_deskfleet/super-agent/snapshot": { params: { workspaceId: SuperWorkspaceId; attachment?: SuperAttachmentRequest }; result: SuperSnapshot }
  "_deskfleet/super-agent/send": { params: SuperSend; result: SuperSnapshot }
  "_deskfleet/super-agent/correct": { params: SuperCorrection; result: SuperSnapshot }
  "_deskfleet/super-agent/settings": { params: SuperSettings; result: SuperSnapshot }
}

export function superRequestObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}
export function superResourceId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f]/u.test(value)) throw new Error("Invalid resource ID")
  return value
}
export function parseSuperCommandTarget(value: unknown): SuperWorkerCommandTarget | undefined {
  if (value === undefined) return
  const item = superRequestObject(value)
  return {
    provider: superResourceId(item.provider),
    ...(item.ticketId !== undefined && { ticketId: superResourceId(item.ticketId) }),
    ...(item.sessionId !== undefined && { sessionId: superResourceId(item.sessionId) }),
  }
}
export function superMessageText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 100_000) throw new Error("A message of at most 100,000 characters is required")
  return value
}
