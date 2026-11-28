import type { SuperWorkspaceId } from "./super-agent.ts"

/** User-visible feedback item category separated from legacy formal messages. */
export type SuperFeedbackKind = "ack" | "activity" | "milestone" | "final_preview"

/** Lifecycle of an individual feedback item; item completion never implies turn completion. */
export type SuperFeedbackStatus = "streaming" | "completed" | "aborted"

/** Safe category for collapsible execution activity rows. */
export type SuperFeedbackActivityKind = "phase" | "tool" | "commentary" | "retry" | "plan"

/** Live status of a collapsible tool/activity step updated in place. */
export type SuperFeedbackActivityStatus = "in_progress" | "completed" | "failed" | "cancelled"

/** Optional structured public feedback carried by a foreground routing pass. */
export interface SuperCoordinatorPublicFeedback {
  ack?: string
  milestone?: string
  activity?: string
}

/** Public message emitted by a foreground coordinator adapter before or during routing. */
export interface SuperCoordinatorPublicMessage {
  purpose: "ack" | "milestone" | "activity"
  itemId?: string
  delta?: boolean
  text: string
  done?: boolean
  dedupeKey?: string
}

export interface SuperFeedbackItem {
  itemId: string
  kind: SuperFeedbackKind
  sourceMessageId: string
  revision: number
  ticketId?: string
  sessionId?: string
  inputId?: string
  turnId?: string
  messageId?: string
  dedupeKey?: string
  /** Shared logical ID connecting a streaming final preview and the formal worker result message. */
  logicalId?: string
  text: string
  activityKind?: SuperFeedbackActivityKind
  activityStatus?: SuperFeedbackActivityStatus
  status: SuperFeedbackStatus
  seq: number
  /** Character offset of the latest applied text length for idempotent delta merging. */
  deltaOffset?: number
  /** True when the rendered text is an excerpt and full content stays in the Worker session. */
  truncated?: boolean
  /**
   * Status-only tool update whose start (title and first position) lies in an earlier process page.
   * Its `text` is empty: clients merge only the status into the item they already loaded.
   */
  updateOnly?: boolean
  createdAt: string
  updatedAt: string
}

export interface SuperFeedbackProcessBranch {
  ticketId: string
  sessionId?: string
  turnId?: string
  inputId?: string
  fromSeq?: string
  throughSeq?: string
  activityCount: number
  unboundedOutcome?: boolean
}

/** Recoverable process summary per user request; drives the collapsible progress/process disclosure. */
export interface SuperFeedbackProcessIndex {
  sourceMessageId: string
  revision: number
  activityCount: number
  branches: SuperFeedbackProcessBranch[]
}

/** Optional snapshot extension; older clients ignore it and keep their existing transcript contract. */
export interface SuperFeedbackSnapshot {
  cursor: number
  previewGeneration: string
  items: SuperFeedbackItem[]
  processes: SuperFeedbackProcessIndex[]
}

export type SuperFeedbackEvent =
  | { type: "item_upsert"; item: SuperFeedbackItem }
  | { type: "item_delta"; itemId: string; sourceMessageId: string; revision: number; kind: SuperFeedbackKind; offset: number; delta: string; status?: SuperFeedbackStatus; updatedAt: string; ticketId?: string; sessionId?: string; turnId?: string; inputId?: string; messageId?: string; logicalId?: string; activityKind?: SuperFeedbackActivityKind; activityStatus?: SuperFeedbackActivityStatus }
  | { type: "item_status"; itemId: string; sourceMessageId: string; revision: number; status: SuperFeedbackStatus; updatedAt: string; truncated?: boolean }
  | { type: "process_update"; process: SuperFeedbackProcessIndex }
  | { type: "snapshot_dirty"; sourceMessageId?: string }

export interface SuperFeedbackSubscribeParams {
  workspaceId: SuperWorkspaceId
  afterCursor?: number
  previewGeneration?: string
}

export interface SuperFeedbackSubscribeResult {
  subscriptionId: string
  workspaceId: SuperWorkspaceId
  cursor: number
  previewGeneration: string
  resyncRequired: boolean
  events: { cursor: number; event: SuperFeedbackEvent }[]
}

export interface SuperFeedbackUnsubscribeParams {
  subscriptionId: string
}

export interface SuperFeedbackPush {
  subscriptionId: string
  workspaceId: SuperWorkspaceId
  cursor: number
  previewGeneration: string
  event: SuperFeedbackEvent
}

export interface SuperFeedbackProcessParams {
  workspaceId: SuperWorkspaceId
  sourceMessageId: string
  afterSeq?: string
  limit?: number
}

export interface SuperFeedbackProcessResult {
  sourceMessageId: string
  revision: number
  items: SuperFeedbackItem[]
  hasMore: boolean
  nextAfterSeq?: string
}

export interface SuperWorkerReportParams {
  kind: "ack" | "activity" | "milestone" | "final_answer"
  text: string
  submissionId?: string
}

export interface SuperWorkerReportReceipt {
  itemId: string
  kind: SuperWorkerReportParams["kind"]
  status: "accepted" | "duplicate"
  sourceMessageId: string
  revision: number
  ticketId: string
  turnId?: string
}

/** Maximum persisted/rendered text length for a single feedback item or worker result excerpt. */
export const SUPER_FEEDBACK_MAX_TEXT = 64_000
export const SUPER_FEEDBACK_ACK_MAX_TEXT = 1_200
export const SUPER_FEEDBACK_ACTIVITY_MAX_TEXT = 2_000

export function feedbackAckId(sourceMessageId: string, revision: number): string {
  return `ack:${sourceMessageId}:${revision}`
}

export function feedbackMilestoneId(sourceMessageId: string, dedupeKey: string): string {
  return `milestone:${sourceMessageId}:${dedupeKey}`
}

export function feedbackFinalLogicalId(sessionId: string, turnId: string): string {
  return `worker-final:${sessionId}:${turnId}`
}

export function feedbackWorkerActivityId(sessionId: string, turnId: string, segmentId: string): string {
  return `activity:${sessionId}:${turnId}:${segmentId}`
}

export function feedbackToolActivityId(sessionId: string, turnId: string, toolCallId: string): string {
  return `tool:${sessionId}:${turnId}:${toolCallId}`
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}

function asIdentifier(value: unknown, label = "resource ID"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f]/u.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

export function parseSuperFeedbackSubscribe(value: unknown): SuperFeedbackSubscribeParams {
  const obj = asObject(value)
  const workspaceId = obj.workspaceId === null ? null : asIdentifier(obj.workspaceId, "workspace ID")
  let afterCursor: number | undefined
  if (obj.afterCursor !== undefined) {
    if (typeof obj.afterCursor !== "number" || !Number.isSafeInteger(obj.afterCursor) || obj.afterCursor < 0) {
      throw new Error("Invalid feedback cursor")
    }
    afterCursor = obj.afterCursor
  }
  let previewGeneration: string | undefined
  if (obj.previewGeneration !== undefined) previewGeneration = asIdentifier(obj.previewGeneration, "preview generation")
  return { workspaceId, ...(afterCursor !== undefined ? { afterCursor } : {}), ...(previewGeneration ? { previewGeneration } : {}) }
}

export function parseSuperFeedbackUnsubscribe(value: unknown): SuperFeedbackUnsubscribeParams {
  const obj = asObject(value)
  return { subscriptionId: asIdentifier(obj.subscriptionId, "subscription ID") }
}

export function parseSuperFeedbackProcess(value: unknown): SuperFeedbackProcessParams {
  const obj = asObject(value)
  const workspaceId = obj.workspaceId === null ? null : asIdentifier(obj.workspaceId, "workspace ID")
  const sourceMessageId = asIdentifier(obj.sourceMessageId, "source message ID")
  let afterSeq: string | undefined
  if (obj.afterSeq !== undefined) {
    if (typeof obj.afterSeq !== "string" || !/^\d{1,22}$/u.test(obj.afterSeq)) throw new Error("Invalid process cursor")
    afterSeq = obj.afterSeq
  }
  let limit: number | undefined
  if (obj.limit !== undefined) {
    if (typeof obj.limit !== "number" || !Number.isSafeInteger(obj.limit) || obj.limit < 1 || obj.limit > 200) {
      throw new Error("Invalid process page limit")
    }
    limit = obj.limit
  }
  return { workspaceId, sourceMessageId, ...(afterSeq ? { afterSeq } : {}), ...(limit ? { limit } : {}) }
}

export function parseSuperWorkerReport(value: unknown): SuperWorkerReportParams {
  const obj = asObject(value)
  const kind = obj.kind
  if (kind !== "ack" && kind !== "activity" && kind !== "milestone" && kind !== "final_answer") {
    throw new Error("Invalid report kind; expected ack, activity, milestone, or final_answer")
  }
  if (typeof obj.text !== "string" || !obj.text.trim() || obj.text.length > SUPER_FEEDBACK_MAX_TEXT) {
    throw new Error("Report text must be a non-empty string")
  }
  const submissionId = obj.submissionId === undefined ? undefined : asIdentifier(obj.submissionId, "submission ID")
  return { kind, text: obj.text.trim(), ...(submissionId ? { submissionId } : {}) }
}

export function parseCoordinatorPublicFeedback(value: unknown): SuperCoordinatorPublicFeedback | undefined {
  if (value === undefined || value === null) return undefined
  const obj = asObject(value)
  const allowed = new Set(["ack", "milestone", "activity"])
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`Unknown publicFeedback field: ${key}`)
  }
  const read = (field: keyof SuperCoordinatorPublicFeedback, max: number): string | undefined => {
    const raw = obj[field]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== "string") throw new Error(`Invalid publicFeedback.${field}`)
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    if (trimmed.length > max) throw new Error(`publicFeedback.${field} exceeds limit`)
    return trimmed
  }
  const ack = read("ack", SUPER_FEEDBACK_ACK_MAX_TEXT)
  const milestone = read("milestone", SUPER_FEEDBACK_MAX_TEXT)
  const activity = read("activity", SUPER_FEEDBACK_ACTIVITY_MAX_TEXT)
  if (!ack && !milestone && !activity) return undefined
  return { ...(ack ? { ack } : {}), ...(milestone ? { milestone } : {}), ...(activity ? { activity } : {}) }
}

export function detectFeedbackLanguage(sample: string): "zh" | "ja" | "en" {
  if (/[\u3040-\u30ff]/u.test(sample)) return "ja"
  if (/[\u4e00-\u9fff]/u.test(sample)) return "zh"
  return "en"
}

/**
 * Host fallback opening confirmation constructed strictly from verified, user-presentable
 * objectives when a structured coordinator omits `publicFeedback.ack`.
 * Never claims execution has already started or completed.
 */
export function buildFallbackAck(userText: string, targets: readonly { title: string; deliverable?: string }[]): string | undefined {
  const clean = targets
    .map(target => ({
      title: target.title.replace(/\s+/gu, " ").trim().slice(0, 120),
      deliverable: target.deliverable?.replace(/\s+/gu, " ").trim().slice(0, 160),
    }))
    .filter(target => target.title.length > 0)
  if (!clean.length) return undefined
  const lang = detectFeedbackLanguage(userText || clean[0]!.title)
  if (clean.length === 1) {
    const { title, deliverable } = clean[0]!
    const detail = deliverable && deliverable.toLowerCase() !== title.toLowerCase() ? deliverable : undefined
    if (lang === "zh") return detail ? `我会处理「${title}」（${detail}），完成后把结果带回这里。` : `我会处理「${title}」，完成后把结果带回这里。`
    if (lang === "ja") return detail ? `「${title}」（${detail}）を進め、結果をこちらにお返しします。` : `「${title}」を進め、結果をこちらにお返しします。`
    return detail ? `I will work on "${title}" (${detail}) and bring the result back here.` : `I will work on "${title}" and bring the result back here.`
  }
  const names = clean.map(item => lang === "en" ? `"${item.title}"` : `「${item.title}」`)
  if (lang === "zh") return `我会分头推进 ${names.join("、")}，完成后把结果带回这里。`
  if (lang === "ja") return `${names.join("・")}を進めて、結果をこちらにお返しします。`
  return `I will handle ${names.join(", ")} and bring the results back here.`
}

/** Keep the beginning of long output so reports never drop their opening context. */
export function boundFeedbackText(text: string, max = SUPER_FEEDBACK_MAX_TEXT): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/** Placeholder title for a tool whose start event carried no title. */
export const GENERIC_TOOL_TITLE = "Running tool"

/**
 * A tool status update without its own title (or with the generic placeholder) keeps the title already
 * known for that tool, so a later completion never renames it to the placeholder.
 */
export function keepKnownToolTitle(previous: Pick<SuperFeedbackItem, "text"> | undefined, item: Pick<SuperFeedbackItem, "text" | "activityKind" | "updateOnly">): string {
  if (!previous || item.activityKind !== "tool" || !previous.text || previous.text === GENERIC_TOOL_TITLE) return item.text || previous?.text || GENERIC_TOOL_TITLE
  return item.updateOnly || !item.text || item.text === GENERIC_TOOL_TITLE ? previous.text : item.text
}
