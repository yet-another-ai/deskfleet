import { superRequestObject, superResourceId, type SuperWorkspaceId } from "./super-agent.ts"

export type FollowUpDeliveryPolicy = "every_run" | "exceptions_only"
export type FollowUpSourceKind = "schedule" | "session"
export type FollowUpRuleMode = "active" | "shadow"
export type FollowUpEvidenceAvailability = "available" | "archived" | "deleted" | "restricted" | "partial"

export interface FollowUpDeviceGrant {
  installationId: string
  deviceLabel?: string
  platform?: string
  enabled: boolean
  authVersion: number
  updatedAt: string
}

export interface FollowUpInactiveWindow {
  from: string
  to: string
  reason: "schedule_paused" | "auth_revoked" | "takeover_stopped"
}

export interface FollowUpAuthState {
  authVersion: number
  globalDisabled: boolean
  autoEnrollOrdinarySessions: boolean
  ordinarySessionRuleMode: FollowUpRuleMode
  /**
   * Independent persisted unified takeover choice ("让super agent 接管所有会话").
   * Default false/undefined on upgrade and fresh install; NEVER inferred from existing device grants
   * or legacy subscriptions. When false, legacy subscriptions cannot bypass and proactively remind.
   */
  takeoverAllSessions?: boolean
  /** ISO timestamp when unified takeover was most recently enabled. */
  takeoverAllSessionsSince?: string
  /** ISO timestamp when unified takeover was most recently turned off (clears on re-enable). */
  takeoverStoppedAt?: string
  /**
   * Legacy / schedule-level flag kept synchronized with `takeoverAllSessions` when toggled.
   */
  adoptAllSchedules?: boolean
  /** ISO timestamp when the user most recently enabled `adoptAllSchedules`. */
  adoptAllSchedulesSince?: string
  grants: Record<string, FollowUpDeviceGrant>
  /** Last observed authVersion revoked globally or per installation, fencing stale offline reconnects. */
  revokedAllAtVersion: number
  /** ISO timestamp when authorization first became active for this user (never overwritten on re-enable). */
  firstAuthorizedAt?: string
  /** ISO timestamp when authorization most recently transitioned from unauthorized -> authorized. */
  authorizedSince?: string
  /** ISO timestamp when authorization most recently dropped to 0 active devices. */
  lastRevokedAt?: string
  /** Closed intervals during which this user had no active SA background authorization or takeover. */
  inactiveWindows?: FollowUpInactiveWindow[]
  updatedAt: string
}

export interface FollowUpAuthSummary {
  authorized: boolean
  authVersion: number
  globalDisabled: boolean
  activeDeviceCount: number
  devices: FollowUpDeviceGrant[]
  autoEnrollOrdinarySessions: boolean
  ordinarySessionRuleMode: FollowUpRuleMode
  /** True ONLY when the user explicitly turned on unified takeover ("让super agent 接管所有会话"). */
  takeoverAllSessions?: boolean
  takeoverAllSessionsSince?: string
  /** True when the user explicitly opted into SA taking over all owned scheduled tasks (old + future). */
  adoptAllSchedules?: boolean
  adoptAllSchedulesSince?: string
  /** Count of owned schedules staged to attach automatically once background authorization is granted. */
  pendingAuthScheduleCount?: number
  /** True when the user has legacy SA history/rooms on this registration but never explicitly authorized background follow-up. */
  needsConsent: boolean
  subscribedScheduleCount: number
  subscribedSessionCount: number
  pendingTriageCount: number
}

export interface AdoptAllSchedulesResult {
  enabled: boolean
  authorized: boolean
  adoptedCount: number
  adoptedSessionCount?: number
  awaitingAuthorizationCount: number
  preservedPreferenceCount: number
  stoppedCount: number
  skippedOtherOwnerCount: number
  summary: FollowUpAuthSummary
}

export interface FollowUpAuthMutation {
  action: "enable" | "disable" | "revoke_all" | "status" | "configure"
  installationId?: string
  deviceLabel?: string
  platform?: string
  expectedAuthVersion?: number
  autoEnrollOrdinarySessions?: boolean
  ordinarySessionRuleMode?: FollowUpRuleMode
  adoptAllSchedules?: boolean
  takeoverAllSessions?: boolean
}

export interface FollowUpAuthReceipt {
  status: "applied" | "stale_ignored" | "unchanged"
  authVersion: number
  authorized: boolean
  activeDeviceCount: number
  stoppedAllBackground: boolean
  revocationReport?: {
    cancelledPendingActions: number
    abortedAnalyses: number
    withdrawnInputs: number
    cancelledTurns: number
    preservedSharedTurns: number
  }
  summary: FollowUpAuthSummary
}

export interface FollowUpPrRef {
  owner: string
  repo: string
  number: number
  url?: string
  headBranch?: string
  objective?: string
}

/** Terminal schedule run facts needed to deliver a deferred pre-pause report exactly once. */
export interface FollowUpDeferredRunReceipt {
  runId: string
  kind: "run_finished" | "run_skipped"
  runState: "completed" | "failed" | "interrupted" | "skipped"
  scheduleVersion: number
  ownerUserId: string
  manualRunByUserId?: string
  scheduledFor?: string
  startedAt?: string
  finishedAt: string
  sessionId?: string
  inputId?: string
  error?: string
}

export interface FollowUpSourceState {
  enabled: boolean
  deliveryPolicy: FollowUpDeliveryPolicy
  /** Cursor for ordinary session event consumption (durable lastEventSeq processed). */
  cursorSeq?: string
  /** Frozen owner userId verified at subscription time. */
  ownerUserId: string
  /** Last known schedule version (for schedules). */
  scheduleVersion?: number
  scheduleTitle?: string
  targetKind?: "worktree" | "directory" | "existing"
  /** Non-empty when another team member modified scope/owner, user stopped, deleted, reassigned, or waiting for background auth. */
  pausedReason?: "modified_by_other_member" | "user_stopped" | "schedule_deleted" | "awaiting_authorization" | "ownership_changed"
  /** ISO timestamp when this subscription first became active (never overwritten on re-enable). */
  firstSubscribedAt?: string
  /** ISO timestamp when this subscription most recently became active (prevents replaying pre-adoption or paused-period runs). */
  subscribedAt?: string
  /** ISO timestamp when this subscription was most recently paused/stopped by the user. */
  pausedAt?: string
  /** Closed intervals during which this schedule subscription was paused/disabled. */
  inactiveWindows?: FollowUpInactiveWindow[]
  /**
   * Minimal receipts for runs that completed BEFORE pause/revocation while delivery was transiently
   * blocked. Recovery consumes these directly, so delivery does not depend on the native scheduler
   * still retaining the run in its bounded recent history.
   */
  deferredPrePauseRuns?: FollowUpDeferredRunReceipt[]
  /** Last successful run timestamp (used when reporting failures). */
  lastSuccessAt?: string
  /** Consecutive overlap skips counter. */
  consecutiveSkips?: number
  /** Issue keys explicitly stopped/dismissed by the user so duplicate signals respect human decisions. */
  stoppedIssueKeys?: string[]
  /** Verified PR associations for cross-Worker evidence & PR status observation. */
  prRefs?: FollowUpPrRef[]
  /** Last observed progress heartbeat for long-running builds. */
  lastProgressSeq?: string
  lastProgressAt?: string
  lastErrorKey?: string
  lastErrorCount?: number
  /** Whether the user explicitly opted out ("Only view in execution session"). */
  optedOut?: boolean
}

export interface FollowUpSourceRecord {
  id: string
  userId: string
  workspaceId: string
  sourceKind: FollowUpSourceKind
  sourceId: string
  revision: number
  state: FollowUpSourceState
  updatedAt: string
}

export interface FollowUpRunRecord {
  id: string
  userId: string
  workspaceId: string
  sourceKind: FollowUpSourceKind
  sourceId: string
  runKey: string
  scheduleId?: string
  scheduleTitle?: string
  runId?: string
  sessionId?: string
  inputId?: string
  turnId?: string
  provider?: string
  scheduledFor?: string
  startedAt: string
  finishedAt?: string
  status: "claimed" | "running" | "completed" | "failed" | "interrupted" | "skipped" | "attention" | "restricted"
  deliveryPolicy?: FollowUpDeliveryPolicy
  delivered: boolean
  deliveredMessageId?: string
  ticketId?: string
  issueKey?: string
  summary: string
  /** Bounded execution details / output excerpt for this specific run, layered beneath the SA summary. */
  detail?: string
  error?: string
  evidenceAvailability: FollowUpEvidenceAvailability
  evidenceRefs?: {
    sessionId?: string
    inputId?: string
    turnId?: string
    afterSeq?: string
    throughSeq?: string
    prRefs?: FollowUpPrRef[]
    commitShas?: string[]
  }
  createdAt: string
  updatedAt: string
}

export interface FollowUpActionRecord {
  id: string
  userId: string
  workspaceId: string
  sourceKind: FollowUpSourceKind
  sourceId: string
  actionKey: string
  evidenceVersion: string
  authVersion: number
  actionKind: "deliver_result" | "supplement_worker" | "create_ticket" | "ask_human" | "record_quietly" | "triage"
  mode: FollowUpRuleMode
  status: "pending" | "dispatched" | "completed" | "cancelled" | "superseded" | "failed" | "shadow"
  sessionId?: string
  inputId?: string
  turnId?: string
  ticketId?: string
  messageId?: string
  parentActionId?: string
  reason?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export interface FollowUpProvenance {
  sourceKind: FollowUpSourceKind
  sourceId: string
  scheduleId?: string
  scheduleTitle?: string
  runId?: string
  runKey?: string
  runStatus?: FollowUpRunRecord["status"]
  provider?: string
  /** Bounded execution details for this specific run, shown when the SA execution card is expanded. */
  detail?: string
  startedAt?: string
  finishedAt?: string
  sessionId?: string
  inputId?: string
  turnId?: string
  deliveryPolicy?: FollowUpDeliveryPolicy
  nextRunAt?: string
  timeZone?: string
  targetKind?: "worktree" | "directory" | "existing"
  issueKey?: string
  evidenceAvailability?: FollowUpEvidenceAvailability
  origin?: "sa_follow_up" | "schedule_receipt"
}

export interface FollowUpSourcesResponse {
  workspaceId: SuperWorkspaceId
  auth: FollowUpAuthSummary
  sources: FollowUpSourceRecord[]
  adoptableSchedules: { id: string; title: string; workspaceId: string; enabled: boolean; nextRunAt?: string; targetKind: "worktree" | "directory" | "existing" }[]
  adoptableSessions: { id: string; title: string; workspaceId: string; updatedAt: string; lastEventSeq: string }[]
}

export interface FollowUpRunsPage {
  runs: FollowUpRunRecord[]
  nextCursor?: { createdAt: string; id: string }
}

export interface FollowUpSourceUpdateRequest {
  workspaceId: string
  sourceKind: FollowUpSourceKind
  sourceId: string
  enabled?: boolean
  deliveryPolicy?: FollowUpDeliveryPolicy
  reconfirmOwnership?: boolean
  stopIssueKey?: string
  adopt?: boolean
}

export interface FollowUpMetricsSnapshot {
  deliveredRuns: number
  quietRuns: number
  duplicateSuppressed: number
  crossUserBlocked: number
  disabledStateTriageCalls: number
  autoSupplements: number
  humanQuestions: number
  revocationCleanups: number
  shadowDecisions: number
  byEntry: Record<string, number>
  byTargetKind: Record<string, number>
}

export function parseDeliveryPolicy(value: unknown): FollowUpDeliveryPolicy {
  if (value === "every_run" || value === "exceptions_only") return value
  throw new Error("Invalid follow-up delivery policy")
}

/**
 * Infer a transparent default delivery policy when the user did not specify one explicitly:
 * - Explicit "every time / daily report / digest / summary / generate file" -> every_run
 * - Explicit "only if risk / anomaly / issue" or patrol/check/monitor/audit -> exceptions_only
 * - Indeterminate -> every_run (fail-safe so explicit deliverables are never silently dropped)
 */
export function inferDefaultDeliveryPolicy(title: string, prompt: string, explicit?: FollowUpDeliveryPolicy): FollowUpDeliveryPolicy {
  if (explicit) return explicit
  const combined = `${title}\n${prompt}`.trim()
  if (/(?:有风险再|有异常再|有问题再|仅异常|只在.{0,8}(?:异常|风险|失败|变化|需要)|出现.{0,8}(?:异常|风险|问题)再|only\s+(?:notify|alert|tell|report)\s+(?:me\s+)?(?:if|when)|exceptions?\s+only|alert\s+on\s+(?:error|failure|risk|issue))/iu.test(combined)) {
    return "exceptions_only"
  }
  if (/(?:每天发|每次都|每轮都|发我一份|生成(?:日报|周报|摘要|报告|文件)|导出|汇报一份|日报|周报|摘要|报告|\b(?:daily\s+report|digest|summary|briefing|send\s+(?:me\s+)?(?:a\s+)?(?:report|update)|every\s+run|generate\s+(?:a\s+)?(?:report|file|summary))\b)/iu.test(combined)) {
    return "every_run"
  }
  if (/(?:检查|巡检|排查|监控|盯着|关注|看下有没有|有没有风险|\b(?:check|inspect|monitor|watch|audit|scan|verify)\b)/iu.test(combined)) {
    return "exceptions_only"
  }
  return "every_run"
}

export function parseFollowUpAuthMutation(value: unknown): FollowUpAuthMutation {
  const obj = superRequestObject(value)
  const action = obj.action
  if (action !== "enable" && action !== "disable" && action !== "revoke_all" && action !== "status" && action !== "configure") {
    throw new Error("Invalid follow-up authorization action")
  }
  const installationId = obj.installationId === undefined ? undefined : superResourceId(obj.installationId)
  if ((action === "enable" || action === "disable") && !installationId) {
    throw new Error("Client installation ID is required")
  }
  const deviceLabel = obj.deviceLabel === undefined ? undefined : String(obj.deviceLabel).trim().slice(0, 120)
  const platform = obj.platform === undefined ? undefined : String(obj.platform).trim().slice(0, 40)
  const expectedAuthVersion = obj.expectedAuthVersion === undefined ? undefined : Number(obj.expectedAuthVersion)
  if (expectedAuthVersion !== undefined && (!Number.isSafeInteger(expectedAuthVersion) || expectedAuthVersion < 0)) {
    throw new Error("Invalid expected auth version")
  }
  if (obj.autoEnrollOrdinarySessions !== undefined && typeof obj.autoEnrollOrdinarySessions !== "boolean") {
    throw new Error("Invalid ordinary session enrollment flag")
  }
  if (obj.ordinarySessionRuleMode !== undefined && obj.ordinarySessionRuleMode !== "active" && obj.ordinarySessionRuleMode !== "shadow") {
    throw new Error("Invalid ordinary session rule mode")
  }
  if (obj.adoptAllSchedules !== undefined && typeof obj.adoptAllSchedules !== "boolean") {
    throw new Error("Invalid schedule takeover flag")
  }
  if (obj.takeoverAllSessions !== undefined && typeof obj.takeoverAllSessions !== "boolean") {
    throw new Error("Invalid unified takeover flag")
  }
  return {
    action,
    installationId,
    deviceLabel,
    platform,
    expectedAuthVersion,
    autoEnrollOrdinarySessions: obj.autoEnrollOrdinarySessions as boolean | undefined,
    ordinarySessionRuleMode: obj.ordinarySessionRuleMode as FollowUpRuleMode | undefined,
    adoptAllSchedules: obj.adoptAllSchedules as boolean | undefined,
    takeoverAllSessions: obj.takeoverAllSessions as boolean | undefined,
  }
}

export function parseFollowUpSourceUpdate(value: unknown): FollowUpSourceUpdateRequest {
  const obj = superRequestObject(value)
  const workspaceId = superResourceId(obj.workspaceId)
  const sourceKind = obj.sourceKind
  if (sourceKind !== "schedule" && sourceKind !== "session") throw new Error("Invalid follow-up source kind")
  const sourceId = superResourceId(obj.sourceId)
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") throw new Error("Invalid enabled flag")
  const deliveryPolicy = obj.deliveryPolicy === undefined ? undefined : parseDeliveryPolicy(obj.deliveryPolicy)
  if (obj.reconfirmOwnership !== undefined && typeof obj.reconfirmOwnership !== "boolean") throw new Error("Invalid ownership confirmation flag")
  const stopIssueKey = obj.stopIssueKey === undefined ? undefined : superResourceId(obj.stopIssueKey)
  if (obj.adopt !== undefined && typeof obj.adopt !== "boolean") throw new Error("Invalid adopt flag")
  return { workspaceId, sourceKind, sourceId, enabled: obj.enabled as boolean | undefined, deliveryPolicy, reconfirmOwnership: obj.reconfirmOwnership as boolean | undefined, stopIssueKey, adopt: obj.adopt as boolean | undefined }
}
