import { randomUUID } from "node:crypto"
import type { CatalogSnapshot } from "@deskfleet/native"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { GithubPullRequest, GithubPullRequestQuery } from "@deskfleet/client/central"
import type { SchedulePrivateEvent } from "@deskfleet/protocol/schedule"
import type { ScheduledTasks } from "../schedules/scheduled-tasks.ts"
import {
  classifyAuthorizeError,
  classifyJournalReadError,
  extractCommitShas,
  extractVerifiedPrRefs,
  inspectTurnOwnership,
  readTurnAssistantOutput,
  type TurnOutputSource,
} from "./follow-up-evidence.ts"
import {
  inferDefaultDeliveryPolicy,
  type FollowUpDeferredRunReceipt,
  type FollowUpDeliveryPolicy,
  type FollowUpEvidenceAvailability,
  type FollowUpInactiveWindow,
  type FollowUpMetricsSnapshot,
  type FollowUpPrRef,
  type FollowUpProvenance,
  type FollowUpRunRecord,
  type FollowUpSourceKind,
} from "@deskfleet/protocol/super-agent-follow-up"
import { isTerminalRunStatus, RUN_STATE_RANK, type FollowUpStore } from "./follow-up-store.ts"
import type { SuperWorkerRequest, SuperWorkspace, SuperWorkspaceId } from "@deskfleet/protocol/super-agent"
import { allocateTicketAccent } from "./accent.ts"
import { bumpVisibleSeq, note, roomFor, type SuperStateStore } from "./state.ts"
import { computeEvidenceVersion, triageFollowUpEvent, type TriageModel } from "./triage.ts"
import type { SuperWorkers } from "./worker.ts"

export interface FollowUpServiceDeps {
  followUpStore: FollowUpStore
  superStore: SuperStateStore
  agents: SuperWorkers
  schedules?: Pick<ScheduledTasks, "snapshot" | "inspectTask" | "pendingPrivateEvents" | "ackPrivateEvents" | "onPrivateEvent" | "setSubscriberCheck" | "setAutoAdoptCheck"> & {
    isScheduleSession?: (sessionId: string, createOperationId?: string) => boolean
    isScheduleRunInput?: (sessionId: string, inputId?: string, inputOperationId?: string) => boolean
  }
  authorize: (actor: AgentActor) => Promise<AgentActor>
  workspaces: (userId: string, includeDefaultWorker?: boolean) => Promise<SuperWorkspace[]>
  historyCatalog?: () => Promise<CatalogSnapshot>
  onCatalogChanged?: (listener: () => void) => () => void
  triageModel?: (userId: string) => TriageModel | undefined
  githubPullRequest?: (actor: AgentActor, query: GithubPullRequestQuery) => Promise<{ pullRequest: GithubPullRequest | null }>
  isInteractiveBusy?: (userId: string, workspaceId: SuperWorkspaceId) => boolean
  /** Notifies active room feedback subscribers after durable background follow-up state settles. */
  onRoomChanged?: (userId: string, workspaceId: SuperWorkspaceId, sourceMessageId?: string) => void
  now?: () => Date
  retryBaseMs?: number
  retryMaxMs?: number
  historyPageSize?: number
  historyMaxPages?: number
  /** Idle duration without new journal events before a running ordinary Worker triggers quiet recheck / stall alert (default 10m). */
  stallThresholdMs?: number
  /** Periodic sweep interval for silently stalled ordinary Workers (default 60s; 0 disables background timer). */
  stallCheckIntervalMs?: number
}

export interface DeliverMainChatPayload {
  text: string
  sourceKind: FollowUpSourceKind
  sourceId: string
  scheduleId?: string
  scheduleTitle?: string
  runId?: string
  runKey?: string
  runStatus?: FollowUpRunRecord["status"]
  provider?: string
  detail?: string
  startedAt?: string
  finishedAt?: string
  sessionId?: string
  inputId?: string
  turnId?: string
  targetKind?: "worktree" | "directory" | "existing"
  deliveryPolicy?: FollowUpDeliveryPolicy
  issueKey?: string
  evidenceAvailability: FollowUpEvidenceAvailability
  createTicketTitle?: string
  createTicketScope?: string
  options?: string[]
}

export type PendingFollowUpRequest = SuperWorkerRequest & {
  ticketId: string
  sourceKind?: FollowUpSourceKind
  sourceId?: string
  sourceTitle?: string
}

export interface FollowUpProcessorContext {
  deps: FollowUpServiceDeps
  metrics: FollowUpMetricsSnapshot
  now: () => Date
  nowIso: () => string
  bump: (map: Record<string, number>, key: string) => void
  isAuthorized: (userId: string) => boolean
  isTakeoverActive: (userId: string) => boolean
  resolveSessionWorkspace: (userId: string, snapshot: AgentSnapshot) => Promise<string | undefined>
  syncScheduleSessionRequests?: (sessionId: string) => Promise<void>
  waitForTakeoverSync?: () => Promise<void>
  lastSessionActivityMs?: (sessionId: string) => number | undefined
  authVersion: (userId: string) => number
  runBoundedTriage: <T>(userId: string, workspaceId: string, work: (signal: AbortSignal) => Promise<T>) => Promise<T | undefined>
  pendingRequests: Map<string, PendingFollowUpRequest[]>
}

/**
 * Deliver a proactive message to the user's workspace room without stealing chat focus.
 * Deduplicates against existing Ticket-bound Worker result for the same `(sessionId, turnId/inputId)`
 * and updates an existing open issue card when `issueKey` matches.
 */
export async function deliverToMainChat(
  ctx: FollowUpProcessorContext,
  userId: string,
  workspaceId: string,
  payload: DeliverMainChatPayload,
): Promise<{ messageId: string; ticketId?: string }> {
  const provenance: FollowUpProvenance = {
    origin: "sa_follow_up",
    sourceKind: payload.sourceKind,
    sourceId: payload.sourceId,
    ...(payload.scheduleId ? { scheduleId: payload.scheduleId } : {}),
    ...(payload.scheduleTitle ? { scheduleTitle: payload.scheduleTitle } : {}),
    ...(payload.runId ? { runId: payload.runId } : {}),
    ...(payload.runKey ? { runKey: payload.runKey } : {}),
    ...(payload.runStatus ? { runStatus: payload.runStatus } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.detail ? { detail: payload.detail } : {}),
    ...(payload.startedAt ? { startedAt: payload.startedAt } : {}),
    ...(payload.finishedAt ? { finishedAt: payload.finishedAt } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.inputId ? { inputId: payload.inputId } : {}),
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
    ...(payload.targetKind ? { targetKind: payload.targetKind } : {}),
    ...(payload.deliveryPolicy ? { deliveryPolicy: payload.deliveryPolicy } : {}),
    ...(payload.issueKey ? { issueKey: payload.issueKey } : {}),
    evidenceAvailability: payload.evidenceAvailability,
  }
  const result = await ctx.deps.superStore.update(userId, () => ({ rooms: [], intents: [] }), state => {
    const room = roomFor(state, workspaceId)
    // 1. Deduplicate ONLY against an existing final Worker/follow-up delivery for the exact same
    //    (sessionId, turnId/inputId). Never let a permission/question card or stall notice swallow
    //    a final scheduled report or a post-approval Worker failure.
    if (payload.sessionId && (payload.turnId || payload.inputId)) {
      const existingFinalMsg = room.messages.findLast(m =>
        m.sessionId === payload.sessionId
        && ((payload.turnId && m.turnId === payload.turnId) || (payload.inputId && m.inputId === payload.inputId))
        && m.workerEvent !== "permission"
        && m.workerEvent !== "question"
        && !m.workerRequestId
        && !m.provenance?.issueKey?.startsWith("stall:")
        && (m.workerEvent === "result" || (m.provenance?.origin === "sa_follow_up" && m.role === "assistant")))
      if (existingFinalMsg) {
        existingFinalMsg.provenance = { ...existingFinalMsg.provenance, ...provenance }
        return { messageId: existingFinalMsg.id, ticketId: existingFinalMsg.ticketId }
      }
    }
    // 2. Merge repeated identical operational issue (consecutive skip / stall / repeated error) or same run
    //    into its existing card rather than spamming chat — NEVER overwrite a different completed schedule run's message!
    if (payload.issueKey) {
      const isOperationalRepeat = payload.issueKey.startsWith("skip:")
        || payload.issueKey.startsWith("stall:")
        || payload.issueKey.startsWith("err:")
      const existingIssue = room.messages.findLast(m =>
        m.provenance?.issueKey === payload.issueKey
        && m.provenance?.sourceId === payload.sourceId
        && (isOperationalRepeat || !payload.runId || !m.provenance?.runId || m.provenance.runId === payload.runId))
      if (existingIssue) {
        existingIssue.text = payload.text
        existingIssue.provenance = { ...existingIssue.provenance, ...provenance }
        bumpVisibleSeq(room, existingIssue)
        return { messageId: existingIssue.id, ticketId: existingIssue.ticketId }
      }
    }
    let ticketId: string | undefined = payload.sessionId
      ? room.tickets.find(t => t.sessionId === payload.sessionId)?.id
      : undefined
    if (!ticketId && payload.createTicketTitle && payload.createTicketScope) {
      const ticket = {
        id: randomUUID(),
        title: payload.createTicketTitle,
        scope: payload.createTicketScope,
        summary: payload.text.slice(0, 700),
        status: "attention" as const,
        provider: payload.provider || room.provider,
        updatedAt: ctx.nowIso(),
      }
      allocateTicketAccent(room, ticket)
      room.tickets.push(ticket)
      ticketId = ticket.id
    }
    // Background deliveries NEVER overwrite `room.focusTicketId`.
    const msg = note(room, payload.text, {
      role: "assistant",
      ticketId,
      sessionId: payload.sessionId,
      inputId: payload.inputId,
      turnId: payload.turnId,
      provenance,
      ...(payload.options?.length ? { options: payload.options } : {}),
    })
    bumpVisibleSeq(room, msg)
    return { messageId: msg.id, ticketId }
  })
  ctx.deps.onRoomChanged?.(userId, workspaceId)
  return result
}

async function preservePrePauseDeferredRun(
  ctx: FollowUpProcessorContext,
  uid: string,
  sub: ReturnType<FollowUpStore["listSources"]>[number],
  event: SchedulePrivateEvent,
  pauseCutoffIso: string | undefined,
): Promise<boolean> {
  if ((event.kind !== "run_finished" && event.kind !== "run_skipped") || !event.runId || !pauseCutoffIso) return false
  if (event.manualRunByUserId && event.manualRunByUserId !== uid) return false
  if (event.ownerUserId !== uid) return false
  const finishedTs = event.finishedAt ?? (event.kind === "run_skipped" ? event.createdAt : undefined)
  if (!finishedTs || finishedTs >= pauseCutoffIso) return false
  const firstActiveAt = sub.state.firstSubscribedAt ?? sub.state.subscribedAt
  if (firstActiveAt && finishedTs < firstActiveAt) return false
  const authState = ctx.deps.followUpStore.getAuth(uid)
  if (authState?.firstAuthorizedAt && finishedTs < authState.firstAuthorizedAt) return false
  const priorInactive = [...(sub.state.inactiveWindows ?? []), ...(authState?.inactiveWindows ?? [])]
  if (priorInactive.some(w => finishedTs >= w.from && finishedTs < w.to)) return false
  const existingRun = await ctx.deps.followUpStore.getRun(uid, event.workspaceId, "schedule", event.scheduleId, `run:${event.runId}`)
  if (existingRun && isTerminalRunStatus(existingRun.status)) return false
  // Persist the minimal terminal receipt rather than only the run ID: the native scheduler keeps a
  // bounded recent history, so recovery must not depend on that run still being listed there.
  const receipt: FollowUpDeferredRunReceipt = {
    runId: event.runId,
    kind: event.kind,
    runState: event.kind === "run_skipped" ? "skipped" : terminalRunState(event.runState),
    scheduleVersion: event.scheduleVersion,
    ownerUserId: event.ownerUserId,
    ...(event.manualRunByUserId ? { manualRunByUserId: event.manualRunByUserId } : {}),
    ...(event.scheduledFor ? { scheduledFor: event.scheduledFor } : {}),
    ...(event.startedAt ? { startedAt: event.startedAt } : {}),
    finishedAt: finishedTs,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.inputId ? { inputId: event.inputId } : {}),
    ...(event.error ? { error: event.error } : {}),
  }
  await ctx.deps.followUpStore.updateSource(uid, event.workspaceId, "schedule", event.scheduleId, () => sub.state, state => {
    const kept = (state.deferredPrePauseRuns ?? []).filter(item => item.runId !== receipt.runId)
    // Bounded only against pathological growth; each entry is a distinct pre-pause run whose delivery was blocked.
    state.deferredPrePauseRuns = [...kept, receipt].slice(-200)
  })
  return true
}

/**
 * Re-check whether the master switch, background authorization, or per-schedule follow-up turned off
 * while async work (authorization, journal read, or triage) was in flight.
 * When stopped, preserve any eligible pre-pause run receipt BEFORE acknowledging the queue event so
 * recovery never drops it, while runs finished during the off window remain quiet.
 */
async function preserveIfStoppedMidFlight(
  ctx: FollowUpProcessorContext,
  uid: string,
  fallbackSub: ReturnType<FollowUpStore["listSources"]>[number],
  event: SchedulePrivateEvent,
  preservedForUsers: Set<string>,
): Promise<boolean> {
  const freshSub = ctx.deps.followUpStore.getSource(uid, event.workspaceId, "schedule", event.scheduleId) ?? fallbackSub
  if (ctx.isTakeoverActive(uid) && freshSub.state.enabled && !freshSub.state.pausedReason) {
    return false
  }
  const authState = ctx.deps.followUpStore.getAuth(uid)
  const cutoff = deliveryStopCutoff(freshSub, authState, ctx.isAuthorized(uid), authState?.takeoverAllSessions === true)
  if (await preservePrePauseDeferredRun(ctx, uid, freshSub, event, cutoff)) {
    preservedForUsers.add(uid)
  }
  return true
}

function terminalRunState(state: SchedulePrivateEvent["runState"]): FollowUpDeferredRunReceipt["runState"] {
  return state === "failed" || state === "interrupted" || state === "skipped" ? state : "completed"
}

/**
 * Earliest moment the subscriber stopped receiving deliveries for this schedule, across BOTH switches:
 * revocation of the last background grant and a user pause of this one subscription. A report that finished
 * before this moment was eligible for delivery and must be kept for recovery, whichever switch turned off
 * first and however many are still off. Returns undefined when the subscription was disabled for a reason
 * that must not replay (schedule deleted, ownership changed) or when nothing is off.
 */
function deliveryStopCutoff(
  sub: ReturnType<FollowUpStore["listSources"]>[number],
  authState: ReturnType<FollowUpStore["getAuth"]>,
  authorized: boolean,
  takeoverEnabled: boolean,
): string | undefined {
  const subscriptionOff = !sub.state.enabled || !!sub.state.pausedReason
  if (subscriptionOff && sub.state.pausedReason !== "user_stopped") return undefined
  const cutoffs: string[] = []
  if (subscriptionOff) {
    if (!sub.state.pausedAt) return undefined
    cutoffs.push(sub.state.pausedAt)
  }
  if (!authorized) {
    if (!authState?.lastRevokedAt) return undefined
    cutoffs.push(authState.lastRevokedAt)
  }
  if (!takeoverEnabled) {
    if (!authState?.takeoverStoppedAt) return undefined
    cutoffs.push(authState.takeoverStoppedAt)
  }
  return cutoffs.sort()[0]
}

export async function processSchedulePrivateEvent(
  ctx: FollowUpProcessorContext,
  event: SchedulePrivateEvent,
): Promise<{ ack: boolean; preservedForUsers?: Set<string> }> {
  // Materialize a follow-up source on the fly when the schedule's owner has explicitly enabled
  // unified takeover (`takeoverAllSessions`) and has not opted out of this schedule.
  if (event.kind !== "schedule_deleted" && event.ownerUserId) {
    const ownerAuth = ctx.deps.followUpStore.getAuth(event.ownerUserId)
    if (ownerAuth?.takeoverAllSessions === true) {
      const existingOwnerSource = ctx.deps.followUpStore.getSource(event.ownerUserId, event.workspaceId, "schedule", event.scheduleId)
      if (!existingOwnerSource) {
        const inspected = ctx.deps.schedules?.inspectTask(event.scheduleId)
        if (!inspected || inspected.ownerUserId === event.ownerUserId) {
          let allowedWorkspace = false
          try {
            const workspaces = await ctx.deps.workspaces(event.ownerUserId)
            allowedWorkspace = workspaces.some(ws => ws.id === event.workspaceId)
          } catch {
            allowedWorkspace = false
          }
          if (allowedWorkspace) {
            const deliveryPolicy = inferDefaultDeliveryPolicy(event.scheduleTitle, inspected?.task.prompt ?? "")
            const active = ctx.isTakeoverActive(event.ownerUserId)
            const initialTs = event.createdAt || ctx.nowIso()
            await ctx.deps.followUpStore.updateSource(
              event.ownerUserId,
              event.workspaceId,
              "schedule",
              event.scheduleId,
              () => active
                ? {
                    enabled: true,
                    deliveryPolicy,
                    ownerUserId: event.ownerUserId,
                    scheduleVersion: event.scheduleVersion,
                    scheduleTitle: event.scheduleTitle,
                    targetKind: event.targetKind,
                    firstSubscribedAt: initialTs,
                    subscribedAt: initialTs,
                    optedOut: false,
                  }
                : {
                    enabled: false,
                    pausedReason: "awaiting_authorization",
                    deliveryPolicy,
                    ownerUserId: event.ownerUserId,
                    scheduleVersion: event.scheduleVersion,
                    scheduleTitle: event.scheduleTitle,
                    targetKind: event.targetKind,
                    optedOut: false,
                  },
              () => {},
            )
          }
        }
      }
    }
  }
  if (event.kind === "schedule_created") return { ack: true }

  const subscribers = ctx.deps.followUpStore.listSources(undefined, event.workspaceId)
    .filter(src => src.sourceKind === "schedule" && src.sourceId === event.scheduleId)
  let deferredTransient = false
  const preservedForUsers = new Set<string>()
  for (const sub of subscribers) {
    const uid = sub.userId
    if (!ctx.isTakeoverActive(uid)) {
      // Unauthorized or unified takeover is off (including upgraded users whose legacy subscriptions
      // MUST NOT bypass the default-off switch): keep any report that finished before the earliest
      // explicit stop/revocation cutoff, before this event is acknowledged and leaves the queue.
      const authState = ctx.deps.followUpStore.getAuth(uid)
      const cutoff = deliveryStopCutoff(sub, authState, ctx.isAuthorized(uid), authState?.takeoverAllSessions === true)
      if (await preservePrePauseDeferredRun(ctx, uid, sub, event, cutoff)) preservedForUsers.add(uid)
      continue
    }

    // Schedule deleted: mark subscription and retain historical run summaries in SQLite.
    if (event.kind === "schedule_deleted") {
      await ctx.deps.followUpStore.updateSource(uid, event.workspaceId, "schedule", event.scheduleId, () => sub.state, state => {
        state.enabled = false
        state.pausedReason = "schedule_deleted"
        delete state.deferredPrePauseRuns
      })
      continue
    }

    // Schedule edited by another member with scope/owner change: pause old private subscription and notify for reconfirmation.
    if (event.kind === "schedule_updated") {
      if (event.editorUserId && event.editorUserId !== uid && event.scopeChanged) {
        ctx.metrics.crossUserBlocked += 1
        await ctx.deps.followUpStore.updateSource(uid, event.workspaceId, "schedule", event.scheduleId, () => sub.state, state => {
          state.enabled = false
          state.pausedReason = "modified_by_other_member"
          state.scheduleVersion = event.scheduleVersion
          delete state.deferredPrePauseRuns
        })
        const added = await ctx.deps.superStore.update(uid, () => ({ rooms: [], intents: [] }), state => {
          const room = roomFor(state, event.workspaceId)
          const dedupId = `schedule-ownership:${event.scheduleId}:${event.scheduleVersion}`
          if (room.messages.some(m => m.id === dedupId)) return false
          const created = note(room, `Scheduled task "${event.scheduleTitle}" was edited by another team member. SA private follow-up has been paused until you review the changes and re-confirm subscription.`, {
            id: dedupId,
            provenance: {
              origin: "sa_follow_up", sourceKind: "schedule", sourceId: event.scheduleId,
              scheduleId: event.scheduleId, scheduleTitle: event.scheduleTitle, targetKind: event.targetKind,
            },
          })
          bumpVisibleSeq(room, created)
          return true
        })
        if (added) ctx.deps.onRoomChanged?.(uid, event.workspaceId)
      } else {
        await ctx.deps.followUpStore.updateSource(uid, event.workspaceId, "schedule", event.scheduleId, () => sub.state, state => {
          state.scheduleTitle = event.scheduleTitle
          state.scheduleVersion = event.scheduleVersion
          state.targetKind = event.targetKind
        })
      }
      continue
    }

    if (!sub.state.enabled || sub.state.pausedReason) {
      const authState = ctx.deps.followUpStore.getAuth(uid)
      if (await preservePrePauseDeferredRun(ctx, uid, sub, event, deliveryStopCutoff(sub, authState, ctx.isAuthorized(uid), authState?.takeoverAllSessions === true))) {
        preservedForUsers.add(uid)
      }
      continue
    }

    // Another team member triggered "Run now" -> never route their manual run into this user's private SA.
    if (event.manualRunByUserId && event.manualRunByUserId !== uid) {
      ctx.metrics.crossUserBlocked += 1
      continue
    }
    // Verify schedule delegation owner matches subscriber.
    if (event.ownerUserId !== uid) {
      ctx.metrics.crossUserBlocked += 1
      continue
    }

    const runId = event.runId ?? event.id
    const runKey = `run:${runId}`
    const now = ctx.nowIso()

    // Revalidate delegation authority BEFORE mutating source state or delivering.
    // Transient outage (5xx/network/timeout) defers this event WITHOUT acking so it retries cleanly on recovery.
    // Explicit revocation (401/403/membership removed) stays quiet and does NOT retry.
    const capturedAuthVersion = ctx.authVersion(uid)
    if (await preserveIfStoppedMidFlight(ctx, uid, sub, event, preservedForUsers)) continue
    try {
      await ctx.deps.authorize({ kind: "user", userId: uid, deviceId: "follow-up-delegation" })
    } catch (error) {
      if (await preserveIfStoppedMidFlight(ctx, uid, sub, event, preservedForUsers)) continue
      if (classifyAuthorizeError(error) === "transient") {
        deferredTransient = true
      } else {
        ctx.metrics.crossUserBlocked += 1
      }
      continue
    }
    if (await preserveIfStoppedMidFlight(ctx, uid, sub, event, preservedForUsers)) continue

    const existingRun = await ctx.deps.followUpStore.getRun(uid, event.workspaceId, "schedule", event.scheduleId, runKey)

    if (event.kind === "run_started") {
      const nextStatus = event.runState ?? "running"
      // Never let a late/retried `claimed` or `running` event overwrite a terminal or more-advanced run record!
      if (existingRun && (isTerminalRunStatus(existingRun.status) || RUN_STATE_RANK[nextStatus] < RUN_STATE_RANK[existingRun.status])) {
        continue
      }
      const inspectedTask = ctx.deps.schedules?.inspectTask(event.scheduleId)?.task
      const startProvider = inspectedTask?.target.kind === "new" ? inspectedTask.target.provider : undefined
      const startTicketId = event.sessionId
        ? ctx.deps.superStore.get(uid)?.rooms.find(r => r.workspaceId === event.workspaceId)?.tickets.find(t => t.sessionId === event.sessionId)?.id
        : undefined
      await ctx.deps.followUpStore.upsertRun({
        userId: uid, workspaceId: event.workspaceId, sourceKind: "schedule", sourceId: event.scheduleId,
        runKey, scheduleId: event.scheduleId, scheduleTitle: event.scheduleTitle, runId,
        sessionId: event.sessionId, inputId: event.inputId,
        ...(startProvider ? { provider: startProvider } : {}),
        ...(startTicketId ? { ticketId: startTicketId } : {}),
        scheduledFor: event.scheduledFor,
        startedAt: event.startedAt ?? now, status: nextStatus,
        deliveryPolicy: sub.state.deliveryPolicy, delivered: false,
        summary: `Running scheduled task "${event.scheduleTitle}"`,
        evidenceAvailability: event.sessionId ? "available" : "restricted",
        createdAt: event.startedAt ?? now, updatedAt: now,
      })
      ctx.deps.onRoomChanged?.(uid, event.workspaceId)
      if (event.sessionId) {
        await ctx.syncScheduleSessionRequests?.(event.sessionId)
      }
      continue
    }

    // If this run was already finalized (delivered, recorded quietly, or settled during a disabled window),
    // suppress duplicate or post-reenable replay cleanly.
    if (existingRun && isTerminalRunStatus(existingRun.status)) {
      ctx.metrics.duplicateSuppressed += 1
      continue
    }

    // If this run finished strictly inside a closed inactive window (paused schedule or revoked SA),
    // calibrate its terminal status quietly without pushing stale reports to main chat.
    // Runs that finished BEFORE the pause/revocation (e.g. deferred by SQLITE_BUSY) or AFTER re-enable
    // fall outside [w.from, w.to) and MUST proceed to deliver normally.
    const finishedTs = event.finishedAt ?? (event.kind === "run_skipped" ? event.createdAt : undefined)
    const authState = ctx.deps.followUpStore.getAuth(uid)
    const inactiveWindow = finishedTs
      ? [...(sub.state.inactiveWindows ?? []), ...(authState?.inactiveWindows ?? [])].find(w =>
          finishedTs >= w.from && finishedTs < w.to && (!event.startedAt || event.startedAt < w.to))
      : undefined
    if (inactiveWindow) {
      const disabledReasonText = inactiveWindow.reason === "schedule_paused"
        ? `"${event.scheduleTitle}" finished (${event.runState ?? "completed"}) while SA follow-up for this schedule was paused; not pushed to main chat. Open original session to view.`
        : `"${event.scheduleTitle}" finished (${event.runState ?? "completed"}) while SA background follow-up was disabled; not pushed to main chat. Open original session to view.`
      await ctx.deps.followUpStore.upsertRun({
        userId: uid, workspaceId: event.workspaceId, sourceKind: "schedule", sourceId: event.scheduleId,
        runKey, scheduleId: event.scheduleId, scheduleTitle: event.scheduleTitle, runId,
        sessionId: event.sessionId, inputId: event.inputId, scheduledFor: event.scheduledFor,
        startedAt: event.startedAt ?? now, finishedAt: finishedTs ?? now,
        status: event.kind === "run_skipped" ? "skipped" : (event.runState ?? "completed"),
        deliveryPolicy: sub.state.deliveryPolicy, delivered: false,
        summary: disabledReasonText, error: event.error,
        evidenceAvailability: event.sessionId ? "available" : "restricted",
        evidenceRefs: {
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.inputId ? { inputId: event.inputId } : {}),
        },
        createdAt: event.startedAt ?? now, updatedAt: now,
      })
      ctx.metrics.quietRuns += 1
      ctx.deps.onRoomChanged?.(uid, event.workspaceId)
      continue
    }

    // run_skipped or run_finished
    let outputText = ""
    let turnId: string | undefined
    const inspectedTask = ctx.deps.schedules?.inspectTask(event.scheduleId)?.task
    let provider: string | undefined = inspectedTask?.target.kind === "new" ? inspectedTask.target.provider : undefined
    let prRefs: FollowUpPrRef[] = []
    let commitShas: string[] = []
    let evidenceAvailability: FollowUpEvidenceAvailability = event.sessionId ? "available" : "restricted"
    let crossUserRestricted = false
    let evidenceIncomplete = false
    let evidenceDeleted = false
    let outputTruncated = false
    let outputSource: TurnOutputSource | undefined

    if (event.sessionId) {
      try {
        const snapshot = await ctx.deps.agents.journal.read(event.sessionId)
        provider = snapshot.session.provider || provider
        if (snapshot.session.archiveState !== "active") evidenceAvailability = "archived"
        const input = event.inputId ? snapshot.inputs.find(i => i.id === event.inputId) : undefined
        const turn = input?.turnId
          ? snapshot.turns.find(t => t.id === input.turnId)
          : snapshot.turns.findLast(t => t.initialInputId === event.inputId)
        turnId = turn?.id
        if (turnId) {
          const ownership = inspectTurnOwnership(snapshot, turnId, uid)
          if (ownership.readable) {
            const read = await readTurnAssistantOutput(ctx.deps.agents.journal, snapshot, turnId, {
              pageSize: ctx.deps.historyPageSize,
              maxPages: ctx.deps.historyMaxPages,
            })
            outputText = read.text
            outputTruncated = read.outputTruncated === true
            outputSource = read.outputSource
            if (!read.complete) {
              evidenceIncomplete = true
              if (evidenceAvailability === "available") evidenceAvailability = "partial"
            }
            prRefs = extractVerifiedPrRefs(outputText, event.scheduleTitle)
            commitShas = extractCommitShas(outputText)
          } else {
            evidenceAvailability = "restricted"
            crossUserRestricted = true
            ctx.metrics.crossUserBlocked += 1
            outputText = "This turn includes input from another member or lacks verified author attribution. Open the original session to inspect."
          }
        }
      } catch (error) {
        if (classifyJournalReadError(error) === "transient") {
          if (await preserveIfStoppedMidFlight(ctx, uid, sub, event, preservedForUsers)) continue
          // Transient DB/IO error (e.g. SQLITE_BUSY): NEVER fabricate deleted/empty output or mark delivered!
          deferredTransient = true
          continue
        }
        evidenceAvailability = "deleted"
        evidenceDeleted = true
      }
    }

    // Mid-flight fence after journal/transcript reads: if master switch or schedule follow-up turned off
    // while reading evidence, persist the deferred pre-pause receipt BEFORE skipping triage and acking.
    if (await preserveIfStoppedMidFlight(ctx, uid, sub, event, preservedForUsers)) continue

    const evidenceVersion = computeEvidenceVersion([
      uid, event.workspaceId, "schedule", event.scheduleId, runId, event.runState, turnId, event.error,
      evidenceDeleted ? "deleted" : evidenceIncomplete ? "partial" : (outputSource ?? "full"),
    ])
    const actionKey = `schedule:${event.scheduleId}:${runId}:${evidenceVersion}`
    const existingActions = await ctx.deps.followUpStore.listActions(uid, undefined, 200)
    if (existingActions.some(a => a.actionKey === actionKey && (a.status === "completed" || a.status === "dispatched"))) {
      ctx.metrics.duplicateSuppressed += 1
      continue
    }

    ctx.bump(ctx.metrics.byTargetKind, event.targetKind)
    ctx.bump(ctx.metrics.byEntry, "schedule")

    const consecutiveSkips = event.kind === "run_skipped" ? (sub.state.consecutiveSkips ?? 0) + 1 : 0
    const isSuccess = event.runState === "completed"
    const lastSuccessAt = isSuccess ? (event.finishedAt ?? now) : sub.state.lastSuccessAt

    await ctx.deps.followUpStore.updateSource(uid, event.workspaceId, "schedule", event.scheduleId, () => sub.state, state => {
      state.consecutiveSkips = consecutiveSkips
      if (lastSuccessAt) state.lastSuccessAt = lastSuccessAt
      if (prRefs.length) state.prRefs = prRefs
    })

    const triage = await ctx.runBoundedTriage(uid, event.workspaceId, async signal =>
      triageFollowUpEvent({
        userId: uid, workspaceId: event.workspaceId, sourceKind: "schedule", sourceId: event.scheduleId,
        sourceTitle: event.scheduleTitle, runKey,
        status: event.kind === "run_skipped" ? "skipped" : (event.runState === "completed" ? "completed" : event.runState === "interrupted" ? "interrupted" : "failed"),
        deliveryPolicy: sub.state.deliveryPolicy, ruleMode: "active",
        outputText, error: event.error, lastSuccessAt: sub.state.lastSuccessAt, consecutiveSkips,
        stoppedIssueKeys: sub.state.stoppedIssueKeys, evidenceIncomplete, evidenceDeleted, outputTruncated, outputSource,
      }, { model: ctx.deps.triageModel?.(uid), signal }),
    )

    // Post-triage fence:
    // - If the user turned off takeover, revoked the last grant, or paused this schedule while triage was
    //   in flight -> preserve any eligible pre-pause deferred receipt BEFORE staying quiet & acking.
    // - If authVersion bumped by another device's change while THIS user is STILL authorized & subscribed -> re-verify
    //   delegation and proceed (or defer if triage was aborted or delegation transiently failed) so reports are never lost!
    if (await preserveIfStoppedMidFlight(ctx, uid, sub, event, preservedForUsers)) continue
    if (!triage) {
      deferredTransient = true
      continue
    }
    let effectiveAuthVersion = capturedAuthVersion
    if (ctx.authVersion(uid) !== capturedAuthVersion) {
      try {
        await ctx.deps.authorize({ kind: "user", userId: uid, deviceId: "follow-up-delegation" })
      } catch (error) {
        if (await preserveIfStoppedMidFlight(ctx, uid, sub, event, preservedForUsers)) continue
        if (classifyAuthorizeError(error) === "transient") deferredTransient = true
        else ctx.metrics.crossUserBlocked += 1
        continue
      }
      if (await preserveIfStoppedMidFlight(ctx, uid, sub, event, preservedForUsers)) continue
      effectiveAuthVersion = ctx.authVersion(uid)
    }

    const runStatus: FollowUpRunRecord["status"] = event.kind === "run_skipped"
      ? "skipped"
      : (crossUserRestricted ? "restricted" : (event.runState ?? "completed"))
    const startedAt = event.startedAt ?? now
    const finishedAt = event.finishedAt ?? now
    const runDetail = crossUserRestricted ? undefined : triage.detail

    let deliveredMessageId: string | undefined
    let linkedTicketId: string | undefined = event.sessionId
      ? ctx.deps.superStore.get(uid)?.rooms.find(r => r.workspaceId === event.workspaceId)?.tickets.find(t => t.sessionId === event.sessionId)?.id
      : undefined
    const shouldPostNotice = triage.kind !== "record_quietly"
    const reportDelivered = shouldPostNotice && triage.reportDelivered !== false

    if (shouldPostNotice) {
      const delivery = await deliverToMainChat(ctx, uid, event.workspaceId, {
        text: triage.summary,
        scheduleId: event.scheduleId,
        scheduleTitle: event.scheduleTitle,
        runId,
        runKey,
        runStatus,
        ...(provider ? { provider } : {}),
        ...(runDetail ? { detail: runDetail } : {}),
        startedAt,
        finishedAt,
        sessionId: event.sessionId,
        inputId: event.inputId,
        turnId,
        targetKind: event.targetKind,
        deliveryPolicy: sub.state.deliveryPolicy,
        issueKey: triage.issueKey,
        evidenceAvailability,
        sourceKind: "schedule",
        sourceId: event.scheduleId,
        createTicketTitle: triage.kind === "create_ticket" ? triage.ticketTitle : undefined,
        createTicketScope: triage.kind === "create_ticket" ? triage.ticketScope : undefined,
        options: triage.options,
      })
      deliveredMessageId = delivery.messageId
      linkedTicketId = delivery.ticketId ?? linkedTicketId
      if (reportDelivered) ctx.metrics.deliveredRuns += 1
      else ctx.metrics.quietRuns += 1
    } else {
      ctx.metrics.quietRuns += 1
    }

    await ctx.deps.followUpStore.upsertRun({
      userId: uid, workspaceId: event.workspaceId, sourceKind: "schedule", sourceId: event.scheduleId,
      runKey, scheduleId: event.scheduleId, scheduleTitle: event.scheduleTitle, runId,
      sessionId: event.sessionId, inputId: event.inputId, turnId,
      ...(provider ? { provider } : {}),
      scheduledFor: event.scheduledFor,
      startedAt, finishedAt,
      status: runStatus,
      deliveryPolicy: sub.state.deliveryPolicy, delivered: reportDelivered, deliveredMessageId, ticketId: linkedTicketId,
      issueKey: triage.issueKey, summary: triage.summary,
      ...(runDetail ? { detail: runDetail } : {}),
      error: event.error, evidenceAvailability,
      evidenceRefs: {
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(event.inputId ? { inputId: event.inputId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(prRefs.length ? { prRefs } : {}),
        ...(commitShas.length ? { commitShas } : {}),
      },
      createdAt: startedAt, updatedAt: now,
    })

    await ctx.deps.followUpStore.upsertAction({
      userId: uid, workspaceId: event.workspaceId, sourceKind: "schedule", sourceId: event.scheduleId,
      actionKey, evidenceVersion, authVersion: effectiveAuthVersion, actionKind: triage.kind,
      mode: "active", status: "completed", sessionId: event.sessionId, inputId: event.inputId, turnId,
      ticketId: linkedTicketId, messageId: deliveredMessageId, reason: triage.reason,
      createdAt: now, updatedAt: now,
    })
    ctx.deps.onRoomChanged?.(uid, event.workspaceId)
    if (event.sessionId) {
      await ctx.syncScheduleSessionRequests?.(event.sessionId)
    }
  }
  return { ack: !deferredTransient, ...(preservedForUsers.size ? { preservedForUsers } : {}) }
}

/**
 * Calibrate ONLY schedule runs whose actual native completion timestamp fell inside the closed
 * inactive window `[window.from, window.to]`.
 * - Runs completed BEFORE `window.from` (e.g. deferred by transient `SQLITE_BUSY` prior to pause)
 *   are left untouched so they deliver normally once reads recover.
 * - Pre-subscription runs from before the user ever subscribed (no prior pause window) are never
 *   imported into SA history.
 */
export async function settleScheduleRunsFinishedWhileDisabled(
  ctx: FollowUpProcessorContext,
  userId: string,
  scheduleIdFilter: string | undefined,
  window: FollowUpInactiveWindow,
  now: string,
): Promise<void> {
  if (!ctx.deps.schedules) return
  const sources = ctx.deps.followUpStore.listSources(userId).filter(src =>
    src.sourceKind === "schedule"
    && src.state.enabled
    && !src.state.pausedReason
    && (scheduleIdFilter === undefined || src.sourceId === scheduleIdFilter))
  for (const src of sources) {
    const inspected = ctx.deps.schedules.inspectTask(src.sourceId)
    if (!inspected) continue
    for (const run of inspected.task.runs) {
      if (run.state !== "completed" && run.state !== "failed" && run.state !== "interrupted" && run.state !== "skipped") continue
      const finishedTs = run.finishedAt ?? run.startedAt
      // Strictly require completion to fall inside the actual inactive window!
      if (finishedTs < window.from || finishedTs > window.to) continue
      const runKey = `run:${run.id}`
      const existing = await ctx.deps.followUpStore.getRun(userId, src.workspaceId, "schedule", src.sourceId, runKey)
      if (existing && isTerminalRunStatus(existing.status)) continue
      const wasTrackedNonTerminal = !!existing && !isTerminalRunStatus(existing.status)
      if (!wasTrackedNonTerminal && run.state !== "interrupted") continue
      const summary = window.reason === "schedule_paused"
        ? `"${inspected.task.title}" finished (${run.state}) while SA follow-up for this schedule was paused; not pushed to main chat. Open original session to view.`
        : `"${inspected.task.title}" finished (${run.state}) while SA background follow-up was disabled; not pushed to main chat. Open original session to view.`
      await ctx.deps.followUpStore.upsertRun({
        userId, workspaceId: src.workspaceId, sourceKind: "schedule", sourceId: src.sourceId,
        runKey, scheduleId: inspected.task.id, scheduleTitle: inspected.task.title, runId: run.id,
        sessionId: run.sessionId, inputId: run.inputId, scheduledFor: run.scheduledFor,
        startedAt: run.startedAt, finishedAt: finishedTs,
        status: run.state, deliveryPolicy: src.state.deliveryPolicy, delivered: false,
        summary, error: run.error,
        evidenceAvailability: run.sessionId ? "available" : "restricted",
        evidenceRefs: { ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(run.inputId ? { inputId: run.inputId } : {}) },
        createdAt: run.startedAt, updatedAt: now,
      })
    }
  }
}

/**
 * Idempotently reconcile subscribed schedules whose native runs transitioned to a terminal state
 * (e.g., `claimed` -> `interrupted` during daemon restart recovery before subscriber callbacks attached),
 * and deliver deferred pre-pause runs from their persisted receipts.
 * Never replays pre-subscription or paused-window runs.
 */
export async function reconcileSubscribedScheduleStates(
  ctx: FollowUpProcessorContext,
  shouldStop: () => boolean,
): Promise<boolean> {
  if (shouldStop() || !ctx.deps.schedules) return false
  const sources = ctx.deps.followUpStore.listSources().filter(src => src.sourceKind === "schedule" && src.state.enabled && !src.state.pausedReason)
  let deferred = false
  for (const sub of sources) {
    if (shouldStop()) break
    if (!ctx.isTakeoverActive(sub.userId)) continue
    const inspected = ctx.deps.schedules.inspectTask(sub.sourceId)
    if (!inspected) continue
    const targetKind = inspected.task.target.kind === "existing" ? "existing" : inspected.task.target.context
    const authState = ctx.deps.followUpStore.getAuth(sub.userId)
    const inactiveWindows = [...(sub.state.inactiveWindows ?? []), ...(authState?.inactiveWindows ?? [])]
    // Deferred receipts are authoritative on their own; the native run may already have rolled out
    // of the scheduler's bounded recent history.
    const candidates: Array<FollowUpDeferredRunReceipt & { deferred: boolean }> = (sub.state.deferredPrePauseRuns ?? [])
      .map(receipt => ({ ...receipt, deferred: true }))
    const deferredIds = new Set(candidates.map(item => item.runId))
    for (const run of inspected.task.runs) {
      if (run.state !== "completed" && run.state !== "failed" && run.state !== "interrupted" && run.state !== "skipped") continue
      if (deferredIds.has(run.id)) continue
      const meta = inspected.runMeta[run.id]
      candidates.push({
        runId: run.id,
        kind: run.state === "skipped" ? "run_skipped" : "run_finished",
        runState: run.state,
        scheduleVersion: meta?.scheduleVersion ?? inspected.version,
        ownerUserId: meta?.ownerUserId ?? inspected.ownerUserId,
        ...(meta?.manualRunByUserId ? { manualRunByUserId: meta.manualRunByUserId } : {}),
        scheduledFor: run.scheduledFor,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? run.startedAt,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(run.inputId ? { inputId: run.inputId } : {}),
        ...(run.error ? { error: run.error } : {}),
        deferred: false,
      })
    }
    const settledDeferredIds = new Set<string>()
    for (const run of candidates) {
      if (shouldStop()) break
      const runKey = `run:${run.runId}`
      const existing = await ctx.deps.followUpStore.getRun(sub.userId, sub.workspaceId, "schedule", sub.sourceId, runKey)
      if (existing && isTerminalRunStatus(existing.status)) {
        if (run.deferred) settledDeferredIds.add(run.runId)
        continue
      }
      if (!run.deferred) {
        const stuckNonTerminal = !!existing
        const crashedInterrupted = !existing && run.runState === "interrupted" && !!sub.state.subscribedAt && (run.startedAt ?? "") >= sub.state.subscribedAt
        if (!stuckNonTerminal && !crashedInterrupted) continue
      }
      const startedAt = run.startedAt ?? run.finishedAt
      const hitInactive = inactiveWindows.find(w => run.finishedAt >= w.from && run.finishedAt < w.to && startedAt < w.to)
      if (hitInactive) {
        const reasonText = hitInactive.reason === "schedule_paused"
          ? `"${inspected.task.title}" finished (${run.runState}) while SA follow-up for this schedule was paused; not pushed to main chat. Open original session to view.`
          : `"${inspected.task.title}" finished (${run.runState}) while SA background follow-up was disabled; not pushed to main chat. Open original session to view.`
        await ctx.deps.followUpStore.upsertRun({
          userId: sub.userId, workspaceId: sub.workspaceId, sourceKind: "schedule", sourceId: sub.sourceId,
          runKey, scheduleId: inspected.task.id, scheduleTitle: inspected.task.title, runId: run.runId,
          sessionId: run.sessionId, inputId: run.inputId, scheduledFor: run.scheduledFor,
          startedAt, finishedAt: run.finishedAt, status: run.runState,
          deliveryPolicy: sub.state.deliveryPolicy, delivered: false, summary: reasonText, error: run.error,
          evidenceAvailability: run.sessionId ? "available" : "restricted",
          evidenceRefs: { ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(run.inputId ? { inputId: run.inputId } : {}) },
          createdAt: startedAt, updatedAt: ctx.nowIso(),
        })
        if (run.deferred) settledDeferredIds.add(run.runId)
        continue
      }
      const synthetic: SchedulePrivateEvent = {
        id: `reconcile:${sub.sourceId}:${run.runId}:${run.runState}`,
        kind: run.kind,
        scheduleId: inspected.task.id,
        scheduleTitle: inspected.task.title,
        scheduleVersion: run.scheduleVersion,
        workspaceId: inspected.task.workspaceId,
        targetKind,
        ...(inspected.task.target.kind === "existing" ? { targetSessionId: inspected.task.target.sessionId } : {}),
        ownerUserId: run.ownerUserId,
        ...(run.manualRunByUserId ? { manualRunByUserId: run.manualRunByUserId } : {}),
        runId: run.runId,
        runState: run.runState,
        ...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
        startedAt,
        finishedAt: run.finishedAt,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(run.inputId ? { inputId: run.inputId } : {}),
        ...(run.error ? { error: run.error } : {}),
        createdAt: run.finishedAt,
      }
      try {
        const outcome = await processSchedulePrivateEvent(ctx, synthetic)
        if (!outcome.ack) deferred = true
        else if (run.deferred && outcome.preservedForUsers?.has(sub.userId)) break
        else if (run.deferred) settledDeferredIds.add(run.runId)
      } catch {
        deferred = true
      }
    }
    if (settledDeferredIds.size) {
      await ctx.deps.followUpStore.updateSource(sub.userId, sub.workspaceId, "schedule", sub.sourceId, () => sub.state, state => {
        const remaining = (state.deferredPrePauseRuns ?? []).filter(item => !settledDeferredIds.has(item.runId))
        if (remaining.length) state.deferredPrePauseRuns = remaining
        else delete state.deferredPrePauseRuns
      })
    }
  }
  return deferred
}
