import type { ComposerMention } from "./composer-reference.ts"
import type { AgentConfigurationSelection } from "./agent-configuration.ts"
import type { AgentActor, AgentElicitation, AgentInput, AgentPermission, AgentSessionContext } from "./agent.ts"
import type {
  FollowUpAuthMutation,
  FollowUpAuthReceipt,
  FollowUpAuthSummary,
  FollowUpProvenance,
  FollowUpRunRecord,
  FollowUpRunsPage,
  FollowUpSourceKind,
  FollowUpSourceRecord,
  FollowUpSourceUpdateRequest,
  FollowUpSourcesResponse,
} from "./super-agent-follow-up.ts"

export type {
  AdoptAllSchedulesResult,
  FollowUpAuthMutation,
  FollowUpAuthReceipt,
  FollowUpAuthSummary,
  FollowUpDeliveryPolicy,
  FollowUpProvenance,
  FollowUpRunRecord,
  FollowUpRunsPage,
  FollowUpSourceKind,
  FollowUpSourceRecord,
  FollowUpSourceUpdateRequest,
  FollowUpSourcesResponse,
} from "./super-agent-follow-up.ts"

import type {
  SuperFeedbackProcessParams,
  SuperFeedbackProcessResult,
  SuperFeedbackSnapshot,
  SuperFeedbackSubscribeParams,
  SuperFeedbackSubscribeResult,
  SuperFeedbackUnsubscribeParams,
} from "./super-agent-feedback.ts"

export type {
  SuperCoordinatorPublicFeedback,
  SuperCoordinatorPublicMessage,
  SuperFeedbackActivityKind,
  SuperFeedbackActivityStatus,
  SuperFeedbackEvent,
  SuperFeedbackItem,
  SuperFeedbackKind,
  SuperFeedbackProcessBranch,
  SuperFeedbackProcessIndex,
  SuperFeedbackProcessParams,
  SuperFeedbackProcessResult,
  SuperFeedbackPush,
  SuperFeedbackSnapshot,
  SuperFeedbackStatus,
  SuperFeedbackSubscribeParams,
  SuperFeedbackSubscribeResult,
  SuperFeedbackUnsubscribeParams,
  SuperWorkerReportParams,
  SuperWorkerReportReceipt,
} from "./super-agent-feedback.ts"

import type {
  SaVisibleMarkerRef,
  SuperMachineSummary,
  SuperMarkReadParams,
  SuperWorkspaceSummary,
} from "./super-agent-unread.ts"

export type {
  ComputeSaWorkspaceSummaryInput,
  SaVisibleMarker,
  SaVisibleMarkerRef,
  SuperMachineSummary,
  SuperMarkReadParams,
  SuperWorkspaceActivity,
  SuperWorkspaceSummary,
} from "./super-agent-unread.ts"

export {
  computeSaSummaryFromSnapshot,
  computeSaWorkspaceSummary,
  extractSaVisibleMarkers,
  isSaSummaryUnread,
  mergeSaActivity,
  mergeSaMarkerRef,
  parseSuperMarkRead,
  pickLatestSaMarker,
} from "./super-agent-unread.ts"

export type {
  AccentSlotTicketInput,
  SuperTicketAccentPaletteEntry,
  SuperTicketAccentThemeStyle,
} from "./super-agent-accent.ts"

export {
  createEmptyAccentSlotCounts,
  formatTicketShortLabel,
  hexToOklab,
  isValidAccentSlot,
  oklabDistanceBetweenHex,
  recordRecentAccentSlotValue,
  resolveRoomTicketAccentSlots,
  SA_ACCENT_DISTANCE_THRESHOLD,
  SA_ACCENT_OKLAB_DISTANCE_TABLE,
  SA_ACCENT_PALETTE,
  SA_ACCENT_RECENT_LIMIT,
  SA_ACCENT_SLOT_COUNT,
  selectTicketAccentSlot,
  stableAccentHash,
  wcagContrastRatio,
  wcagRelativeLuminance,
} from "./super-agent-accent.ts"

import type {
  SuperCreateTicketParams,
  SuperLinkMessageParams,
  SuperMessageTicketLinks,
} from "./super-agent-links.ts"

export type {
  CanonicalLinkMessage,
  SuperCreateTicketParams,
  SuperLinkMessageParams,
  SuperMessageTicketLinks,
} from "./super-agent-links.ts"

export {
  dedupeTicketIds,
  messageMatchesTicketFocus,
  parseSuperCreateTicket,
  parseSuperLinkMessage,
  resolveCanonicalMessageTicketIds,
} from "./super-agent-links.ts"

export type { StoppedTurnTicketLike } from "./super-agent-reedit.ts"

export {
  isConfirmedStoppedTurn,
  parseSuperReusedAttachments,
  resolveSupersededStoppedTurns,
} from "./super-agent-reedit.ts"

/** Wire types for the personal, machine-local workspace front desk. null denotes the default conversation. */
export type SuperWorkspaceId = string | null
/** Configured provider instance ID within this machine registration. */
export type SuperCoordinator = string
export type SuperTicketStatus = "queued" | "working" | "attention" | "stopped" | "blocked"
export const archivedTicketError = "This ticket is archived. Restore it in the ticket list before continuing."
export type SuperMessageState = "routing" | "assigned" | "answered" | "failed" | "uncertain" | "transferred" | "stopped"
export type SuperCoordinatorPhase = "waitingForCoordinator" | "matchingTicket" | "processing" | "readingContext" | "replying"
export type SuperStopState = "stopping" | "stopped" | "unconfirmed" | "finished"

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
  adhdModeNotice?: "enabled" | "disabled"
  role: "user" | "assistant" | "worker"
  author?: Pick<AgentActor, "kind" | "userId" | "sourceMachine">
  text: string
  attachments?: SuperAttachmentInfo[]
  createdAt: string
  state?: SuperMessageState
  /** Live activity on the host while the durable message state is routing. */
  coordinatorPhase?: SuperCoordinatorPhase
  revision?: number
  stopState?: SuperStopState
  canStop?: boolean
  /** This dispatch intent has not yet been durably accepted by its Worker. */
  dispatching?: boolean
  /** This input was delivered into an existing turn along with another input. */
  sharedTurn?: boolean
  replyTo?: string
  /** Explicit user message ID of the confirmed-stopped turn revised by this message. */
  reEditOf?: string
  /** The execution target chosen when submitting a provider slash command. */
  command?: SuperWorkerCommandTarget
  mentions?: ComposerMention[]
  ticketId?: string
  /** Canonical ordered list of associated ticket IDs shared by message coloring and focus filtering. */
  ticketIds?: string[]
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
  /** Provenance when this message originates from a schedule command, schedule run, or followed ordinary Worker. */
  provenance?: FollowUpProvenance
  /** Shared logical ID connecting a live streaming final preview to this formal Worker result. */
  logicalId?: string
  /** True when the rendered Worker output is an excerpt and full content stays in the Worker session. */
  truncated?: boolean
  /** True when a Worker turn ended without an identifiable final answer boundary. */
  unboundedOutcome?: boolean
  /** Monotonic room-local visible sequence assigned when this message or error becomes unread-eligible. */
  visibleSeq?: number
}

export interface SuperTicket {
  id: string
  title: string
  scope: string
  latestAcceptance?: string
  summary: string
  /** Only active work, interruptions and failures have a status. Results remain in the conversation. */
  status?: SuperTicketStatus
  /** Permanent 0..47 accent slot assigned once on ticket creation; absent on legacy records. */
  accentSlot?: number
  provider: string
  sessionId?: string
  referenceTicketId?: string
  /** Bound tickets reflect the native Session lifecycle. Unbound tickets keep only their own archive flag. */
  archiveState?: "archiving" | "archived"
  workerContext?: AgentSessionContext
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
  supportsTicketArchive?: boolean
  supportsTicketLinks?: boolean
  supportsStop?: boolean
  /** Host supports explicit stopped-turn re-edit linkage and attachment reuse. */
  supportsStoppedReEdit?: boolean
  /** Host supports real-time main-conversation feedback (opening ack, milestones, collapsible progress). */
  supportsReplyFeedback?: boolean
  /** Optional feedback snapshot extension; older clients ignore it and keep existing transcript behavior. */
  feedback?: SuperFeedbackSnapshot
  /** Host supports proactive background follow-up for schedules and ordinary project sessions. */
  supportsProactiveFollowUp?: boolean
  /** Host supports native schedule management commands directly from main chat. */
  supportsScheduleCommands?: boolean
  /** Current user's registration-level background follow-up authorization and workspace summary. */
  followUp?: FollowUpAuthSummary
  /** Recent followed run records belonging to this project workspace, surfaced inside project Tickets. */
  followUpRuns?: FollowUpRunRecord[]
  /** Pagination cursor when more historical follow-up runs exist beyond `followUpRuns`. */
  followUpRunsCursor?: { createdAt: string; id: string }
  pendingRequests?: (SuperWorkerRequest & { ticketId: string; sourceKind?: FollowUpSourceKind; sourceId?: string; sourceTitle?: string })[]
  coordinatorUsage?: SuperCoordinatorUsage
  coordinatorOverrides?: SuperModelSelection
  coordinatorOptions?: SuperCoordinatorOptions
  coordinatorSelection?: SuperModelSelection
  workerSelection?: SuperWorkerSelection
  /** Absent on hosts predating project approval defaults. */
  workerAutoApprove?: boolean
  supportsWorkerReferences?: boolean
  supportsWorkerCommands?: boolean
  supportsAdhdSkill?: boolean
  supportsComposerMentions?: boolean
  supportsAttachmentPreviews?: boolean
  /** Present only on an explicit read of one attachment in this conversation. */
  attachmentPreview?: SuperAttachmentRequest & { content: SuperAttachmentPreview }
  supportsAttachments?: boolean
  coordinator?: SuperCoordinator
  /** Mirrors workerProviders. Older hosts may omit this or advertise a subset. */
  coordinatorProviders?: { id: string; name: string }[]
  workerProviders?: { id: string; name: string }[]
  workspaceId: SuperWorkspaceId
  messages: SuperMessage[]
  tickets: SuperTicket[]
  /** Canonical message-to-ticket association map shared by coloring and ticket focus filtering. */
  messageTicketLinks?: SuperMessageTicketLinks
  provider: string
  focusTicketId?: string
  /** Last SA visible message position acknowledged by this user in the viewport. */
  lastRead?: SaVisibleMarkerRef
  /** User-actionable error keys acknowledged by this user in the viewport. */
  readErrorKeys?: string[]
  /** Highest Worker completion sequence already delivered into this SA room, keyed by Worker session ID. */
  delegatedCompletedSeqs?: Record<string, string>
}

export interface SuperWorkerCommandTarget { provider: string; ticketId?: string; sessionId?: string }

/** The command catalog and delivery must refer to the same Worker. A quote takes precedence over focus. */
export function superWorkerCommandTarget(room: Pick<SuperSnapshot, "messages" | "tickets" | "provider" | "focusTicketId" | "feedback" | "messageTicketLinks">, replyTo?: string): SuperWorkerCommandTarget {
  const quote = replyTo ? room.messages.find(message => message.id === replyTo) : undefined
  const quotedFeedback = !quote && replyTo ? room.feedback?.items.find(item => item.itemId === replyTo) : undefined
  const linked = quote ? room.messageTicketLinks?.[quote.id] ?? quote.ticketIds : undefined
  const linkedSingle = linked?.length === 1 ? linked[0] : undefined
  const sourceId = quote?.role === "assistant" && !quote.ticketId ? quote.sourceMessageId : quotedFeedback?.sourceMessageId
  const ticketId = replyTo
    ? (quote?.ticketId ?? linkedSingle ?? quotedFeedback?.ticketId ?? (sourceId && room.messages.find(message => message.id === sourceId)?.ticketId))
    : room.focusTicketId
  const ticket = ticketId ? room.tickets.find(item => item.id === ticketId) : undefined
  if (ticket?.archiveState || !replyTo && ticket?.status === "stopped") return { provider: room.provider }
  return ticket ? { provider: ticket.provider || room.provider, ticketId: ticket.id, ...(ticket.sessionId && { sessionId: ticket.sessionId }) } : { provider: room.provider }
}

export function superWorkerCommandName(text: string): string | undefined {
  return /^\s*\/([^\s/]+)(?:\s|$)/u.exec(text)?.[1]
}

export interface SuperSend {
  mentions?: ComposerMention[]
  attachments?: AgentInput["content"]
  /** Preserved attachments copied from an earlier user message in the same workspace conversation. */
  reusedAttachments?: SuperAttachmentRequest[]
  workspaceId: SuperWorkspaceId
  messageId: string
  text: string
  replyTo?: string
  /** Explicit user message ID of the confirmed-stopped turn that this message revises. */
  reEditOf?: string
  retry?: boolean
  command?: SuperWorkerCommandTarget
  /** Valid IANA time zone of the sending device for natural-language schedule commands. */
  timeZone?: string
}
export interface SuperCorrection {
  workspaceId: SuperWorkspaceId
  messageId: string
  ticketId: string
}
export interface SuperStop {
  workspaceId: SuperWorkspaceId
  messageId: string
  revision: number
  /** Omit to stop all unfinished branches of this request. */
  ticketId?: string
  /** Shared turns explicitly shown to the user, keyed by their ticket. */
  sharedTurns?: { ticketId: string; turnId: string }[]
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
  "_deskfleet/super-agent/archiveTicket": { params: { workspaceId: SuperWorkspaceId; ticketId: string; sessionId: string | null; archived: boolean; operationId: string }; result: SuperSnapshot }
  "_deskfleet/super-agent/snapshot": { params: { workspaceId: SuperWorkspaceId; attachment?: SuperAttachmentRequest }; result: SuperSnapshot }
  "_deskfleet/super-agent/send": { params: SuperSend; result: SuperSnapshot }
  "_deskfleet/super-agent/stop": { params: SuperStop; result: SuperSnapshot }
  "_deskfleet/super-agent/correct": { params: SuperCorrection; result: SuperSnapshot }
  "_deskfleet/super-agent/linkMessage": { params: SuperLinkMessageParams; result: SuperSnapshot }
  "_deskfleet/super-agent/createTicket": { params: SuperCreateTicketParams; result: SuperSnapshot }
  "_deskfleet/super-agent/settings": { params: SuperSettings; result: SuperSnapshot }
  "_deskfleet/super-agent/followUpAuth": { params: FollowUpAuthMutation; result: FollowUpAuthReceipt }
  "_deskfleet/super-agent/followUpSources": { params: { workspaceId: SuperWorkspaceId }; result: FollowUpSourcesResponse }
  "_deskfleet/super-agent/followUpUpdateSource": { params: FollowUpSourceUpdateRequest; result: FollowUpSourceRecord }
  "_deskfleet/super-agent/followUpRuns": { params: { workspaceId?: string; sourceKind?: FollowUpSourceKind; sourceId?: string; cursor?: { createdAt: string; id: string }; limit?: number }; result: FollowUpRunsPage }
  "_deskfleet/super-agent/feedbackSubscribe": { params: SuperFeedbackSubscribeParams; result: SuperFeedbackSubscribeResult }
  "_deskfleet/super-agent/feedbackUnsubscribe": { params: SuperFeedbackUnsubscribeParams; result: null }
  "_deskfleet/super-agent/feedbackProcess": { params: SuperFeedbackProcessParams; result: SuperFeedbackProcessResult }
  "_deskfleet/super-agent/summary": { params: Record<string, never>; result: SuperMachineSummary }
  "_deskfleet/super-agent/markRead": { params: SuperMarkReadParams; result: SuperWorkspaceSummary }
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
