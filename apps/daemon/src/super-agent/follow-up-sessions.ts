import { randomUUID } from "node:crypto"
import type { AgentActor, AgentElicitation, AgentEvent, AgentPermission, AgentReceipt, AgentSessionRecord, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import {
  classifyAuthorizeError,
  classifyJournalReadError,
  extractCommitShas,
  extractVerifiedPrRefs,
  evaluateWorkerProgress,
  inspectTurnOwnership,
  matchCrossWorkerEvidence,
  readSessionControlEvents,
  readTurnAssistantOutput,
  type CrossWorkerCandidate,
} from "./follow-up-evidence.ts"
import type { FollowUpEvidenceAvailability, FollowUpPrRef, FollowUpProvenance, FollowUpSourceState } from "@deskfleet/protocol/super-agent-follow-up"
import { deliverToMainChat, type FollowUpProcessorContext } from "./follow-up-schedules.ts"
import { isDeepStrictEqual } from "node:util"
import { bumpVisibleSeq, note, roomFor } from "./state.ts"
import { ownedByActor } from "./target.ts"
import { computeEvidenceVersion, triageFollowUpEvent } from "./triage.ts"
import { activeTurn } from "./worker.ts"

type CrossWorkerCandidateMatch = ReturnType<typeof matchCrossWorkerEvidence>["compatible"][number]

function mergePrRefs(existing: FollowUpPrRef[], incoming: FollowUpPrRef[]): FollowUpPrRef[] {
  const map = new Map(existing.map(ref => [`${ref.owner}/${ref.repo}#${ref.number}`, ref]))
  for (const ref of incoming) map.set(`${ref.owner}/${ref.repo}#${ref.number}`, { ...map.get(`${ref.owner}/${ref.repo}#${ref.number}`), ...ref })
  return [...map.values()].slice(0, 12)
}

export function isSaTicketBoundSession(
  ctx: FollowUpProcessorContext,
  userId: string,
  sessionId: string,
  createOperationId?: string,
): boolean {
  const superState = ctx.deps.superStore.get(userId)
  if (!superState) return false
  if (superState.rooms.some(room => room.tickets.some(ticket => ticket.sessionId === sessionId))) return true
  if (superState.intents.some(intent =>
    intent.phase !== "withdrawn"
    && (intent.sessionId === sessionId || (!!createOperationId && intent.createId === createOperationId)))) {
    return true
  }
  return false
}

export function isNewScheduleSession(ctx: FollowUpProcessorContext, sessionId: string, createOperationId?: string): boolean {
  if (ctx.deps.schedules?.isScheduleSession?.(sessionId, createOperationId)) return true
  return (ctx.deps.schedules?.snapshot() ?? []).some(task =>
    task.target.kind === "new" && task.runs.some(run => run.sessionId === sessionId))
}

async function isScheduleRunTurn(
  ctx: FollowUpProcessorContext,
  sessionId: string,
  snapshot: AgentSnapshot,
  turnId: string,
): Promise<boolean> {
  const turn = snapshot.turns.find(t => t.id === turnId)
  const inputIds = new Set<string>()
  if (turn?.initialInputId) inputIds.add(turn.initialInputId)
  for (const input of snapshot.inputs) {
    if (input.turnId === turnId) inputIds.add(input.id)
  }
  if (!inputIds.size) return false
  for (const inputId of inputIds) {
    if (ctx.deps.schedules?.isScheduleRunInput?.(sessionId, inputId)) return true
    if ((ctx.deps.schedules?.snapshot() ?? []).some(task => task.runs.some(run => run.sessionId === sessionId && run.inputId === inputId))) {
      return true
    }
  }
  if (ctx.deps.schedules?.isScheduleRunInput) {
    try {
      const commands = await ctx.deps.agents.journal.commands(sessionId)
      for (const cmd of commands) {
        if (cmd.method !== "_deskfleet/input/submit") continue
        const receipt = cmd.result as AgentReceipt | undefined
        if (receipt?.inputId && inputIds.has(receipt.inputId) && ctx.deps.schedules.isScheduleRunInput(sessionId, receipt.inputId, cmd.operationId)) {
          return true
        }
      }
    } catch { /* ignore command read error */ }
  }
  return false
}

export function clearSessionPendingRequests(ctx: FollowUpProcessorContext, userId: string, workspaceId: string, sessionId: string): void {
  const key = JSON.stringify([userId, workspaceId])
  const previous = ctx.pendingRequests.get(key) ?? []
  const remaining = previous.filter(req => req.item.sessionId !== sessionId)
  if (remaining.length === previous.length) return
  if (remaining.length) ctx.pendingRequests.set(key, remaining)
  else ctx.pendingRequests.delete(key)
  ctx.deps.onRoomChanged?.(userId, workspaceId)
}

export async function refreshSessionPendingRequests(
  ctx: FollowUpProcessorContext,
  userId: string,
  workspaceId: string,
  sessionId: string,
  snapshot: AgentSnapshot,
): Promise<void> {
  if (!ctx.isTakeoverActive(userId) || isSaTicketBoundSession(ctx, userId, sessionId) || isNewScheduleSession(ctx, sessionId)) {
    clearSessionPendingRequests(ctx, userId, workspaceId, sessionId)
    return
  }
  const key = JSON.stringify([userId, workspaceId])
  const previous = ctx.pendingRequests.get(key) ?? []
  const current = previous.filter(req => req.item.sessionId !== sessionId)
  if (snapshot.session.archiveState === "active" && snapshot.session.lifecycle === "ready") {
    // Only expose requests belonging to turns owned by this user.
    const isOwnedRequest = (turnId?: string) => !turnId || inspectTurnOwnership(snapshot, turnId, userId).readable
    const permissions = snapshot.permissions
      .filter(item => item.state === "pending" && isOwnedRequest(item.turnId))
      .map(item => ({ kind: "permission" as const, item, ticketId: `session:${sessionId}`, sourceKind: "session" as const, sourceId: sessionId, sourceTitle: snapshot.session.title }))
    const elicitations = snapshot.elicitations
      .filter(item => item.state === "pending" && isOwnedRequest(item.turnId))
      .map(item => ({ kind: "elicitation" as const, item, ticketId: `session:${sessionId}`, sourceKind: "session" as const, sourceId: sessionId, sourceTitle: snapshot.session.title }))
    current.push(...permissions, ...elicitations)
  }
  if (!isDeepStrictEqual(previous, current)) {
    if (current.length) ctx.pendingRequests.set(key, current)
    else ctx.pendingRequests.delete(key)
    ctx.deps.onRoomChanged?.(userId, workspaceId)
  }
}

export async function maybeAutoEnrollOrdinarySession(ctx: FollowUpProcessorContext, snapshot: AgentSnapshot): Promise<void> {
  const commands = await ctx.deps.agents.journal.commands(snapshot.session.id)
  const creation = commands.find(cmd => cmd.isCanonical && (cmd.method === "_deskfleet/session/create" || cmd.method === "_deskfleet/session/fork"))
  // Legacy or unattributed sessions lacking canonical creation author NEVER auto-enroll.
  if (!creation || creation.actor.kind !== "user" || !creation.actor.userId) return
  const uid = creation.actor.userId
  const auth = ctx.deps.followUpStore.getAuth(uid)
  // Unified takeover MUST be explicitly enabled AND authorized.
  if (!ctx.isTakeoverActive(uid) || auth?.autoEnrollOrdinarySessions === false) return

  // Attribute by workspaceId or project directory (including unassigned "New Conversation" sessions).
  // Projects without an SA return undefined and stay untouched (never auto-create a Workspace/SA).
  const workspaceId = await ctx.resolveSessionWorkspace(uid, snapshot)
  if (!workspaceId) return

  // Skip if already subscribed or explicitly opted out by user.
  const existing = ctx.deps.followUpStore.listSources(uid)
    .find(src => src.sourceKind === "session" && src.sourceId === snapshot.session.id)
  if (existing) return

  // Skip sessions already bound to an SA ticket (including in-flight creation intent) or provisioned by a new-session schedule run.
  if (isSaTicketBoundSession(ctx, uid, snapshot.session.id, creation.operationId)) return
  if (isNewScheduleSession(ctx, snapshot.session.id, creation.operationId)) return

  const createdAfterTakeover = !!auth?.takeoverAllSessionsSince
    && snapshot.session.createdAt >= auth.takeoverAllSessionsSince
    && snapshot.turns.every(t => activeTurn(t))
  const initialCursorSeq = createdAfterTakeover ? "0" : snapshot.session.lastEventSeq

  await ctx.deps.followUpStore.updateSource(
    uid, workspaceId, "session", snapshot.session.id,
    () => ({
      enabled: true,
      deliveryPolicy: "exceptions_only",
      cursorSeq: initialCursorSeq,
      ownerUserId: uid,
      scheduleTitle: snapshot.session.title,
      lastProgressSeq: snapshot.session.lastEventSeq,
      lastProgressAt: ctx.nowIso(),
    }),
    state => { state.scheduleTitle = snapshot.session.title },
  )
}

function clearSchedulePendingRequests(ctx: FollowUpProcessorContext, userId: string, workspaceId: string, sessionId: string, scheduleId?: string): void {
  const key = JSON.stringify([userId, workspaceId])
  const previous = ctx.pendingRequests.get(key) ?? []
  const remaining = previous.filter(req =>
    req.item.sessionId !== sessionId || (scheduleId !== undefined && (req.sourceKind !== "schedule" || req.sourceId !== scheduleId)))
  if (remaining.length === previous.length) return
  if (remaining.length) ctx.pendingRequests.set(key, remaining)
  else ctx.pendingRequests.delete(key)
  ctx.deps.onRoomChanged?.(userId, workspaceId)
}

function findScheduleRunsForSession(
  ctx: FollowUpProcessorContext,
  sessionId: string,
): Array<{ task: ScheduledTask; run: ScheduleRun; inspected: NonNullable<ReturnType<NonNullable<FollowUpProcessorContext["deps"]["schedules"]>["inspectTask"]>> }> {
  const schedules = ctx.deps.schedules
  if (!schedules) return []
  const matches: Array<{ task: ScheduledTask; run: ScheduleRun; inspected: NonNullable<ReturnType<NonNullable<FollowUpProcessorContext["deps"]["schedules"]>["inspectTask"]>> }> = []
  for (const task of schedules.snapshot()) {
    const run = task.runs.findLast(item => item.sessionId === sessionId)
    if (!run) continue
    const inspected = schedules.inspectTask(task.id)
    if (!inspected) continue
    matches.push({ task, run, inspected })
  }
  return matches
}

function isTurnOwnedByRun(snapshot: AgentSnapshot, run: ScheduleRun, turnId: string | undefined): boolean {
  if (!turnId) return false
  if (!run.inputId) return true
  const turn = snapshot.turns.find(t => t.id === turnId)
  if (!turn) return false
  if (turn.initialInputId === run.inputId) return true
  return snapshot.inputs.some(input => input.id === run.inputId && input.turnId === turnId)
}

/**
 * Sync pending/resolved approval and question requests for a scheduled task execution session
 * (covering `directory` and `worktree` new-session schedules, as well as unsubscribed `existing`
 * schedule runs) into the owning project SA's `pendingRequests` tray and main-chat timeline.
 * Never delivers terminal turn results — final schedule reports are delivered exclusively by
 * `processSchedulePrivateEvent`.
 */
export async function syncScheduleSessionRequests(
  ctx: FollowUpProcessorContext,
  sessionId: string,
  preloadedSnapshot?: AgentSnapshot,
): Promise<void> {
  const matches = findScheduleRunsForSession(ctx, sessionId)
  if (!matches.length) return
  let snapshot = preloadedSnapshot
  if (!snapshot) {
    try { snapshot = await ctx.deps.agents.journal.read(sessionId) }
    catch {
      for (const { task, run, inspected } of matches) {
        const uid = inspected.runMeta[run.id]?.ownerUserId ?? inspected.ownerUserId
        if (uid) clearSchedulePendingRequests(ctx, uid, task.workspaceId, sessionId, task.id)
      }
      return
    }
  }

  const now = ctx.nowIso()
  for (const { task, run, inspected } of matches) {
    const uid = inspected.runMeta[run.id]?.ownerUserId ?? inspected.ownerUserId
    if (!uid) continue
    const manualBy = inspected.runMeta[run.id]?.manualRunByUserId
    if (manualBy && manualBy !== uid) {
      clearSchedulePendingRequests(ctx, uid, task.workspaceId, sessionId, task.id)
      continue
    }
    const existingSessionSub = ctx.deps.followUpStore.getSource(uid, task.workspaceId, "session", sessionId)
    // When an `existing` target session already has an active ordinary-session subscription,
    // `processSubscribedSession` already syncs its permission/question cards & pending tray.
    if (task.target.kind === "existing" && existingSessionSub?.state.enabled && !existingSessionSub.state.pausedReason) {
      continue
    }
    const sub = ctx.deps.followUpStore.getSource(uid, task.workspaceId, "schedule", task.id)
    const takeoverActive = ctx.isTakeoverActive(uid)
    const allowedBySub = sub
      ? (sub.state.enabled && !sub.state.pausedReason && sub.state.optedOut !== true)
      : takeoverActive
    if (!takeoverActive || !allowedBySub || isSaTicketBoundSession(ctx, uid, sessionId)) {
      clearSchedulePendingRequests(ctx, uid, task.workspaceId, sessionId, task.id)
      continue
    }
    if (!sub) {
      // Unmaterialized schedule under master takeover: verify user can see this workspace.
      let allowedWorkspace = false
      try {
        allowedWorkspace = (await ctx.deps.workspaces(uid)).some(ws => ws.id === task.workspaceId)
      } catch {
        allowedWorkspace = false
      }
      if (!allowedWorkspace) continue
    }

    const isEligibleRequest = (turnId?: string) => {
      if (task.target.kind === "existing" && !isTurnOwnedByRun(snapshot!, run, turnId)) return false
      return !turnId || inspectTurnOwnership(snapshot!, turnId, uid).readable
    }

    const key = JSON.stringify([uid, task.workspaceId])
    const previous = ctx.pendingRequests.get(key) ?? []
    const current = previous.filter(req =>
      req.item.sessionId !== sessionId || req.sourceKind !== "schedule" || req.sourceId !== task.id)

    const sessionActive = snapshot.session.archiveState === "active" && snapshot.session.lifecycle === "ready"
    if (sessionActive) {
      const seenKeys = new Set(current.map(r => JSON.stringify([r.item.sessionId, r.kind, r.item.id])))
      for (const item of snapshot.permissions) {
        if (item.state !== "pending" || !isEligibleRequest(item.turnId)) continue
        const dedup = JSON.stringify([item.sessionId, "permission", item.id])
        if (seenKeys.has(dedup)) continue
        seenKeys.add(dedup)
        current.push({
          kind: "permission",
          item,
          ticketId: `schedule:${task.id}`,
          sourceKind: "schedule",
          sourceId: task.id,
          sourceTitle: task.title,
        })
      }
      for (const item of snapshot.elicitations) {
        if (item.state !== "pending" || !isEligibleRequest(item.turnId)) continue
        const dedup = JSON.stringify([item.sessionId, "elicitation", item.id])
        if (seenKeys.has(dedup)) continue
        seenKeys.add(dedup)
        current.push({
          kind: "elicitation",
          item,
          ticketId: `schedule:${task.id}`,
          sourceKind: "schedule",
          sourceId: task.id,
          sourceTitle: task.title,
        })
      }
    }
    if (!isDeepStrictEqual(previous, current)) {
      if (current.length) ctx.pendingRequests.set(key, current)
      else ctx.pendingRequests.delete(key)
      ctx.deps.onRoomChanged?.(uid, task.workspaceId)
    }

    // Sync cross-end resolution on any existing cards first.
    for (const perm of snapshot.permissions) {
      if (perm.state !== "pending") {
        await resolveOrdinaryRequestNotice(ctx, uid, task.workspaceId, sessionId, "permission", perm)
      }
    }
    for (const q of snapshot.elicitations) {
      if (q.state !== "pending") {
        await resolveOrdinaryRequestNotice(ctx, uid, task.workspaceId, sessionId, "question", q)
      }
    }

    if (!sessionActive) continue

    const targetKind = task.target.kind === "existing" ? "existing" : task.target.context
    const postAuthVersion = ctx.authVersion(uid)
    const pendingEntries: Array<{
      kind: "permission" | "elicitation"
      workerEvent: "permission" | "question"
      req: AgentPermission | AgentElicitation
      title: string
    }> = [
      ...snapshot.permissions
        .filter(item => item.state === "pending" && isEligibleRequest(item.turnId))
        .map(req => ({
          kind: "permission" as const,
          workerEvent: "permission" as const,
          req,
          title: req.request.toolCall.title ?? "Permission request",
        })),
      ...snapshot.elicitations
        .filter(item => item.state === "pending" && isEligibleRequest(item.turnId))
        .map(req => ({
          kind: "elicitation" as const,
          workerEvent: "question" as const,
          req,
          title: req.request.message ?? "Structured question",
        })),
    ]

    if (!pendingEntries.length) continue
    const existingActions = await ctx.deps.followUpStore.listActions(uid, undefined, 200)
    for (const entry of pendingEntries) {
      const actionKey = `schedule:${task.id}:session:${sessionId}:${entry.kind}:${entry.req.id}`
      if (existingActions.some(a => a.actionKey === actionKey)) continue
      const evidenceVersion = computeEvidenceVersion([uid, task.workspaceId, "schedule", task.id, sessionId, entry.kind, entry.req.id])
      ctx.metrics.humanQuestions += 1
      const msgId = await postRequestNotice(ctx, uid, task.workspaceId, sessionId, entry.workerEvent, entry.req.id, entry.req.turnId, entry.title, {
        origin: "sa_follow_up",
        sourceKind: "schedule",
        sourceId: task.id,
        scheduleId: task.id,
        scheduleTitle: task.title,
        runId: run.id,
        sessionId,
        ...(run.inputId ? { inputId: run.inputId } : {}),
        ...(entry.req.turnId ? { turnId: entry.req.turnId } : {}),
        targetKind,
        ...(sub?.state.deliveryPolicy ? { deliveryPolicy: sub.state.deliveryPolicy } : {}),
        evidenceAvailability: "available",
      })
      await ctx.deps.followUpStore.upsertAction({
        userId: uid, workspaceId: task.workspaceId, sourceKind: "schedule", sourceId: task.id,
        actionKey, evidenceVersion, authVersion: postAuthVersion, actionKind: "ask_human",
        mode: "active", status: "completed", sessionId,
        ...(run.inputId ? { inputId: run.inputId } : {}),
        turnId: entry.req.turnId, messageId: msgId,
        reason: `Scheduled task "${task.title}" requires ${entry.kind === "permission" ? "approval" : "input"}`,
        createdAt: now, updatedAt: now,
      })
    }
  }
}

/**
 * Migrate an ordinary session subscription when the session's resolved project workspace changes
 * (for example, explicitly reassigning a shared-directory historical session from project A to B).
 * Deactivates the old workspace subscription, clears its pending requests, and activates the target
 * workspace while carrying forward the cursor so no events are lost and old project A never fires again.
 */
export async function migrateSessionSourceWorkspace(
  ctx: FollowUpProcessorContext,
  userId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
  sessionId: string,
  snapshot: AgentSnapshot,
  fromState: FollowUpSourceState,
  options: { advanceCursor?: boolean } = {},
): Promise<void> {
  if (fromWorkspaceId === toWorkspaceId) return
  const now = ctx.nowIso()
  clearSessionPendingRequests(ctx, userId, fromWorkspaceId, sessionId)
  await ctx.deps.followUpStore.updateSource(
    userId, fromWorkspaceId, "session", sessionId,
    () => fromState,
    state => {
      state.enabled = false
      state.pausedReason = "ownership_changed"
      state.optedOut = false
    },
  )
  const carryCursor = options.advanceCursor
    ? snapshot.session.lastEventSeq
    : (fromState.cursorSeq ?? snapshot.session.lastEventSeq)
  const shouldEnable = options.advanceCursor ? true : (fromState.enabled && !fromState.pausedReason && fromState.optedOut !== true)
  await ctx.deps.followUpStore.updateSource(
    userId, toWorkspaceId, "session", sessionId,
    () => ({
      enabled: shouldEnable,
      deliveryPolicy: fromState.deliveryPolicy,
      cursorSeq: carryCursor,
      ownerUserId: fromState.ownerUserId ?? userId,
      scheduleTitle: snapshot.session.title,
      lastProgressSeq: options.advanceCursor ? snapshot.session.lastEventSeq : (fromState.lastProgressSeq ?? carryCursor),
      lastProgressAt: options.advanceCursor ? now : (fromState.lastProgressAt ?? now),
      optedOut: options.advanceCursor ? false : (fromState.optedOut ?? false),
      ...(fromState.prRefs?.length ? { prRefs: structuredClone(fromState.prRefs) } : {}),
      ...(fromState.stoppedIssueKeys?.length ? { stoppedIssueKeys: [...fromState.stoppedIssueKeys] } : {}),
      ...(!shouldEnable && fromState.pausedReason ? { pausedReason: fromState.pausedReason } : {}),
    }),
    state => {
      state.enabled = shouldEnable
      state.deliveryPolicy = fromState.deliveryPolicy
      state.scheduleTitle = snapshot.session.title
      if (options.advanceCursor || !state.cursorSeq || BigInt(carryCursor) > BigInt(state.cursorSeq)) {
        state.cursorSeq = carryCursor
      }
      state.lastProgressSeq = options.advanceCursor ? snapshot.session.lastEventSeq : (fromState.lastProgressSeq ?? state.lastProgressSeq ?? carryCursor)
      state.lastProgressAt = options.advanceCursor ? now : (fromState.lastProgressAt ?? state.lastProgressAt ?? now)
      if (shouldEnable) {
        state.optedOut = false
        delete state.pausedReason
      } else if (fromState.optedOut) {
        state.optedOut = true
        state.pausedReason = "user_stopped"
      }
      if (fromState.prRefs?.length) state.prRefs = mergePrRefs(state.prRefs ?? [], fromState.prRefs)
      if (fromState.stoppedIssueKeys?.length) {
        state.stoppedIssueKeys = [...new Set([...(state.stoppedIssueKeys ?? []), ...fromState.stoppedIssueKeys])]
      }
    },
  )
}

export async function handleOrdinarySessionEvent(ctx: FollowUpProcessorContext, event: AgentEvent): Promise<void> {
  await ctx.waitForTakeoverSync?.()
  let snapshot: AgentSnapshot
  try { snapshot = await ctx.deps.agents.journal.read(event.sessionId) }
  catch { return }

  // 1. Check auto-enrollment for brand-new ordinary sessions created directly by an authorized user
  //    (both workspace-scoped sessions and "New Conversation" sessions matching a project directory).
  if (event.kind === "session") {
    const record = event.payload as AgentSessionRecord
    if (record.archiveState === "active" && record.lifecycle === "ready") {
      await maybeAutoEnrollOrdinarySession(ctx, snapshot)
    }
  }

  // 2. Sync pending approvals / questions for scheduled task execution sessions
  //    (including `directory` and `worktree` new-session schedules excluded from ordinary session follow-up).
  await syncScheduleSessionRequests(ctx, event.sessionId, snapshot)

  // 3. Process for every subscribed user of this session across all project workspaces
  //    (supports directory-attributed "New Conversation" sessions whose snapshot.session.workspaceId is undefined).
  const subs = ctx.deps.followUpStore.listSources()
    .filter(src => src.sourceKind === "session" && src.sourceId === event.sessionId)
  const processedUsers = new Set<string>()
  for (const sub of subs) {
    if (!sub.state.enabled || sub.state.pausedReason || !ctx.isTakeoverActive(sub.userId)) {
      clearSessionPendingRequests(ctx, sub.userId, sub.workspaceId, event.sessionId)
      continue
    }
    if (processedUsers.has(sub.userId)) continue
    processedUsers.add(sub.userId)
    const resolvedWorkspaceId = await ctx.resolveSessionWorkspace(sub.userId, snapshot)
    if (!resolvedWorkspaceId) {
      clearSessionPendingRequests(ctx, sub.userId, sub.workspaceId, event.sessionId)
      continue
    }
    let effectiveWorkspaceId = sub.workspaceId
    if (resolvedWorkspaceId !== sub.workspaceId) {
      await migrateSessionSourceWorkspace(ctx, sub.userId, sub.workspaceId, resolvedWorkspaceId, event.sessionId, snapshot, sub.state)
      effectiveWorkspaceId = resolvedWorkspaceId
    }
    await processSubscribedSession(ctx, sub.userId, effectiveWorkspaceId, event.sessionId, snapshot)
  }
}

export async function processSubscribedSession(
  ctx: FollowUpProcessorContext,
  userId: string,
  workspaceId: string,
  sessionId: string,
  snapshot: AgentSnapshot,
): Promise<void> {
  const sub = ctx.deps.followUpStore.getSource(userId, workspaceId, "session", sessionId)
  if (!sub || !sub.state.enabled || sub.state.pausedReason || !ctx.isTakeoverActive(userId)) return

  // Never duplicate notifications for sessions bound to an SA ticket or created by a new-session schedule.
  if (isSaTicketBoundSession(ctx, userId, sessionId) || isNewScheduleSession(ctx, sessionId)) {
    clearSessionPendingRequests(ctx, userId, workspaceId, sessionId)
    return
  }

  // Double-check ownership: another user's session NEVER enters private SA.
  if (!await ownedByActor(ctx.deps.agents, sessionId, { kind: "user", userId, deviceId: "verify" })) {
    ctx.metrics.crossUserBlocked += 1
    clearSessionPendingRequests(ctx, userId, workspaceId, sessionId)
    return
  }

  await refreshSessionPendingRequests(ctx, userId, workspaceId, sessionId, snapshot)
  const fromSeq = sub.state.cursorSeq ?? "0"
  const throughSeq = snapshot.session.lastEventSeq
  if (BigInt(throughSeq) <= BigInt(fromSeq)) return

  const batch = await readSessionControlEvents(ctx.deps.agents.journal, sessionId, fromSeq, throughSeq, {
    pageSize: ctx.deps.historyPageSize,
    maxPages: ctx.deps.historyMaxPages,
  })
  const events = batch.events
  if (BigInt(batch.lastSeq) <= BigInt(fromSeq)) return

  const auth = ctx.deps.followUpStore.getAuth(userId)
  const ruleMode = auth?.ordinarySessionRuleMode ?? "active"
  const now = ctx.nowIso()
  let latestPrRefs = sub.state.prRefs ?? []

  // Update any resolved permissions/elicitations on existing SA cards immediately (cross-end sync).
  for (const event of events) {
    if (event.kind === "permission" || event.kind === "elicitation") {
      const req = event.payload as AgentPermission | AgentElicitation
      if (req.state !== "pending") {
        await resolveOrdinaryRequestNotice(ctx, userId, workspaceId, sessionId, event.kind === "permission" ? "permission" : "question", req)
      }
    }
  }

  // Track PR references from user-owned inputs.
  for (const input of snapshot.inputs) {
    if (input.author.kind === "user" && input.author.userId === userId) {
      const inputText = input.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
      const found = extractVerifiedPrRefs(inputText, snapshot.session.title)
      if (found.length) latestPrRefs = mergePrRefs(latestPrRefs, found)
    }
  }

  for (const event of events) {
    if (!ctx.isTakeoverActive(userId)) return
    const liveSub = ctx.deps.followUpStore.getSource(userId, workspaceId, "session", sessionId)
    if (!liveSub?.state.enabled || liveSub.state.pausedReason) return

    if (event.kind === "permission" || event.kind === "elicitation") {
      const req = event.payload as AgentPermission | AgentElicitation
      if (req.state !== "pending") continue
      const ownership = inspectTurnOwnership(snapshot, req.turnId, userId)
      if (!ownership.readable) { ctx.metrics.crossUserBlocked += 1; continue }
      const isPermission = event.kind === "permission"
      const title = isPermission
        ? ((req as AgentPermission).request.toolCall.title ?? "Permission request")
        : ((req as AgentElicitation).request.message ?? "Structured question")
      const evidenceVersion = computeEvidenceVersion([userId, workspaceId, "session", sessionId, event.kind, req.id])
      const actionKey = `session:${sessionId}:${event.kind}:${req.id}`
      const existing = await ctx.deps.followUpStore.listActions(userId, undefined, 200)
      if (existing.some(a => a.actionKey === actionKey)) { ctx.metrics.duplicateSuppressed += 1; continue }

      // For elicitation/question (NOT permission), check cross-Worker PR evidence for verified factual answers.
      let crossMatches: { compatible: CrossWorkerCandidateMatch[]; relatedSeparate: CrossWorkerCandidateMatch[] } = { compatible: [], relatedSeparate: [] }
      if (!isPermission && latestPrRefs.length) {
        crossMatches = await findCrossWorkerEvidence(ctx, userId, workspaceId, sessionId, latestPrRefs, snapshot.session.title)
      }

      const prStatusNote = await maybeFetchPrStatus(ctx, userId, latestPrRefs)
      const triage = await ctx.runBoundedTriage(userId, workspaceId, async signal =>
        triageFollowUpEvent({
          userId, workspaceId, sourceKind: "session", sourceId: sessionId, sourceTitle: snapshot.session.title,
          runKey: `${event.kind}:${req.id}`, status: "attention", deliveryPolicy: sub.state.deliveryPolicy,
          ruleMode, outputText: "", pendingQuestionText: title, hasPendingApproval: isPermission,
          crossWorkerMatches: crossMatches.compatible, relatedSeparateRefs: crossMatches.relatedSeparate,
          prStatusNote, stoppedIssueKeys: sub.state.stoppedIssueKeys,
        }, { model: ctx.deps.triageModel?.(userId), signal }),
      )
      if (!triage || !ctx.isTakeoverActive(userId)) return
      const postReqSub = ctx.deps.followUpStore.getSource(userId, workspaceId, "session", sessionId)
      if (!postReqSub?.state.enabled || postReqSub.state.pausedReason) return
      const postReqAuthVersion = ctx.authVersion(userId)

      if (ruleMode === "shadow" && !isPermission) {
        ctx.metrics.shadowDecisions += 1
        await ctx.deps.followUpStore.upsertAction({
          userId, workspaceId, sourceKind: "session", sourceId: sessionId, actionKey, evidenceVersion,
          authVersion: postReqAuthVersion, actionKind: triage.kind, mode: "shadow", status: "shadow",
          sessionId, turnId: req.turnId, reason: triage.reason, createdAt: now, updatedAt: now,
        })
        continue
      }

      if (triage.kind === "supplement_worker" && triage.supplementText) {
        await supplementWorkerWithContext(ctx, userId, workspaceId, sessionId, req.turnId, actionKey, evidenceVersion, postReqAuthVersion, triage.supplementText, triage.reason)
        continue
      }

      ctx.metrics.humanQuestions += 1
      const msgId = await postOrdinaryRequestNotice(ctx, userId, workspaceId, sessionId, snapshot.session.title, isPermission ? "permission" : "question", req.id, req.turnId, triage.summary)
      await ctx.deps.followUpStore.upsertAction({
        userId, workspaceId, sourceKind: "session", sourceId: sessionId, actionKey, evidenceVersion,
        authVersion: postReqAuthVersion, actionKind: "ask_human", mode: ruleMode, status: "completed",
        sessionId, turnId: req.turnId, messageId: msgId, reason: triage.reason, createdAt: now, updatedAt: now,
      })
    }

    if (event.kind === "turn") {
      const turn = event.payload as AgentSnapshot["turns"][number]
      if (activeTurn(turn)) continue
      // Never duplicate reporting for turns triggered by an existing-session scheduled task run.
      if (await isScheduleRunTurn(ctx, sessionId, snapshot, turn.id)) continue
      const ownership = inspectTurnOwnership(snapshot, turn.id, userId)
      // Self-loop guard: never let an SA-originated supplement turn recursively trigger the same follow-up loop.
      if (ownership.isSaOrigin) continue

      const runKey = `turn:${turn.id}`
      if (!ownership.readable) {
        ctx.metrics.crossUserBlocked += 1
        await ctx.deps.followUpStore.upsertRun({
          userId, workspaceId, sourceKind: "session", sourceId: sessionId, runKey,
          sessionId, turnId: turn.id, startedAt: turn.startedAt, finishedAt: turn.endedAt ?? now,
          status: "restricted", delivered: false,
          summary: "Turn includes input from another member or unverified author. Open original session to view.",
          evidenceAvailability: "restricted", createdAt: turn.startedAt, updatedAt: now,
        })
        continue
      }

      const read = await readTurnAssistantOutput(ctx.deps.agents.journal, snapshot, turn.id, {
        pageSize: ctx.deps.historyPageSize,
        maxPages: ctx.deps.historyMaxPages,
      })
      const text = read.text
      const evidenceIncomplete = !read.complete
      const evidenceAvailability: FollowUpEvidenceAvailability = snapshot.session.archiveState !== "active"
        ? "archived"
        : evidenceIncomplete
          ? "partial"
          : "available"
      const foundPrs = extractVerifiedPrRefs(text, snapshot.session.title)
      if (foundPrs.length) latestPrRefs = mergePrRefs(latestPrRefs, foundPrs)
      const commitShas = extractCommitShas(text)

      const progress = evaluateWorkerProgress(snapshot, sub.state, workspaceId, sessionId, ctx.now().getTime())
      const prStatusNote = await maybeFetchPrStatus(ctx, userId, latestPrRefs)

      const status = turn.state === "completed" ? "completed" : turn.state === "interrupted" ? "interrupted" : turn.state === "cancelled" ? "completed" : "failed"
      const evidenceVersion = computeEvidenceVersion([userId, workspaceId, "session", sessionId, turn.id, turn.state, turn.error, progress.issueKey, evidenceIncomplete ? "partial" : "full"])
      const actionKey = `session:${sessionId}:turn:${turn.id}:${evidenceVersion}`
      const existingActions = await ctx.deps.followUpStore.listActions(userId, undefined, 200)
      if (existingActions.some(a => a.actionKey === actionKey)) { ctx.metrics.duplicateSuppressed += 1; continue }

      const triage = await ctx.runBoundedTriage(userId, workspaceId, async signal =>
        triageFollowUpEvent({
          userId, workspaceId, sourceKind: "session", sourceId: sessionId, sourceTitle: snapshot.session.title,
          runKey, status, deliveryPolicy: sub.state.deliveryPolicy, ruleMode, outputText: text,
          error: turn.error, repeatedErrorCount: progress.repeatCount, issueKey: progress.issueKey,
          stoppedIssueKeys: sub.state.stoppedIssueKeys, prStatusNote, evidenceIncomplete,
          outputTruncated: read.outputTruncated === true,
          outputSource: read.outputSource,
        }, { model: ctx.deps.triageModel?.(userId), signal }),
      )
      if (!triage || !ctx.isTakeoverActive(userId)) return
      const postTurnSub = ctx.deps.followUpStore.getSource(userId, workspaceId, "session", sessionId)
      if (!postTurnSub?.state.enabled || postTurnSub.state.pausedReason) return
      const postTurnAuthVersion = ctx.authVersion(userId)

      const runStatus = turn.state === "completed" ? "completed" as const : turn.state === "interrupted" ? "interrupted" as const : "failed" as const
      const finishedAt = turn.endedAt ?? now
      let deliveredMessageId: string | undefined
      let linkedTicketId: string | undefined
      const shouldDeliver = triage.kind !== "record_quietly" && ruleMode !== "shadow"
      if (ruleMode === "shadow" && triage.kind !== "record_quietly") {
        ctx.metrics.shadowDecisions += 1
      } else if (shouldDeliver) {
        const delivery = await deliverToMainChat(ctx, userId, workspaceId, {
          text: triage.summary, sourceKind: "session", sourceId: sessionId,
          scheduleTitle: snapshot.session.title,
          runKey, runStatus,
          ...(snapshot.session.provider ? { provider: snapshot.session.provider } : {}),
          ...(triage.detail ? { detail: triage.detail } : {}),
          startedAt: turn.startedAt, finishedAt,
          sessionId, turnId: turn.id,
          issueKey: triage.issueKey, evidenceAvailability,
        })
        deliveredMessageId = delivery.messageId
        linkedTicketId = delivery.ticketId
        ctx.metrics.deliveredRuns += 1
      } else {
        ctx.metrics.quietRuns += 1
      }

      await ctx.deps.followUpStore.upsertRun({
        userId, workspaceId, sourceKind: "session", sourceId: sessionId, runKey,
        scheduleTitle: snapshot.session.title,
        ...(snapshot.session.provider ? { provider: snapshot.session.provider } : {}),
        sessionId, turnId: turn.id, startedAt: turn.startedAt, finishedAt,
        status: runStatus,
        delivered: shouldDeliver, deliveredMessageId, ticketId: linkedTicketId, issueKey: triage.issueKey,
        summary: triage.summary,
        ...(triage.detail ? { detail: triage.detail } : {}),
        error: turn.error, evidenceAvailability,
        evidenceRefs: { sessionId, turnId: turn.id, ...(latestPrRefs.length ? { prRefs: latestPrRefs } : {}), ...(commitShas.length ? { commitShas } : {}) },
        createdAt: turn.startedAt, updatedAt: now,
      })

      await ctx.deps.followUpStore.upsertAction({
        userId, workspaceId, sourceKind: "session", sourceId: sessionId, actionKey, evidenceVersion,
        authVersion: postTurnAuthVersion, actionKind: triage.kind, mode: ruleMode,
        status: ruleMode === "shadow" && triage.kind !== "record_quietly" ? "shadow" : "completed",
        sessionId, turnId: turn.id, ticketId: linkedTicketId, messageId: deliveredMessageId, reason: triage.reason,
        createdAt: now, updatedAt: now,
      })
      ctx.deps.onRoomChanged?.(userId, workspaceId)

      await ctx.deps.followUpStore.updateSource(userId, workspaceId, "session", sessionId, () => sub.state, state => {
        if (progress.state === "repeated_failure" && progress.issueKey) {
          state.lastErrorKey = progress.issueKey
          state.lastErrorCount = progress.repeatCount
        } else if (turn.state === "completed") {
          delete state.lastErrorKey
          delete state.lastErrorCount
          state.lastSuccessAt = turn.endedAt ?? now
        }
      })
    }
  }

  // Advance durable cursor ONLY through the last sequence actually read!
  await ctx.deps.followUpStore.updateSource(userId, workspaceId, "session", sessionId, () => sub.state, state => {
    state.cursorSeq = batch.lastSeq
    state.lastProgressSeq = batch.lastSeq
    state.lastProgressAt = now
    state.scheduleTitle = snapshot.session.title
    if (state.lastErrorKey?.startsWith("stall:")) {
      delete state.lastErrorKey
      delete state.lastErrorCount
    }
    if (latestPrRefs.length) state.prRefs = latestPrRefs
  })
}

/**
 * Periodically re-check a subscribed ordinary Worker when no new control events have arrived.
 * - Real journal/ACP progress (`lastEventSeq` changed) resets the timer with zero false alarms.
 * - First stall threshold crossing performs a quiet recheck (zero main-chat notifications).
 * - Sustained zero progress across two consecutive thresholds surfaces ONE concrete alert in SA
 *   main chat and suppresses duplicates for the same stuck turn/event sequence.
 */
export async function checkStalledSession(
  ctx: FollowUpProcessorContext,
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  if (!ctx.isTakeoverActive(userId)) return
  const sub = ctx.deps.followUpStore.getSource(userId, workspaceId, "session", sessionId)
  if (!sub || !sub.state.enabled || sub.state.pausedReason) return
  if (isSaTicketBoundSession(ctx, userId, sessionId) || isNewScheduleSession(ctx, sessionId)) {
    clearSessionPendingRequests(ctx, userId, workspaceId, sessionId)
    return
  }
  if (!await ownedByActor(ctx.deps.agents, sessionId, { kind: "user", userId, deviceId: "stall-check" })) {
    return
  }

  let snapshot: AgentSnapshot
  try {
    snapshot = await ctx.deps.agents.journal.read(sessionId)
  } catch (error) {
    if (classifyJournalReadError(error) === "not_found") {
      clearSessionPendingRequests(ctx, userId, workspaceId, sessionId)
    }
    return
  }

  if (snapshot.session.archiveState !== "active" || snapshot.session.lifecycle !== "ready") return
  const resolvedWorkspaceId = await ctx.resolveSessionWorkspace(userId, snapshot)
  if (!resolvedWorkspaceId) {
    clearSessionPendingRequests(ctx, userId, workspaceId, sessionId)
    return
  }
  if (resolvedWorkspaceId !== workspaceId) {
    await migrateSessionSourceWorkspace(ctx, userId, workspaceId, resolvedWorkspaceId, sessionId, snapshot, sub.state)
    workspaceId = resolvedWorkspaceId
  }
  const runningTurn = snapshot.turns.findLast(activeTurn)
  const pendingInput = snapshot.inputs.findLast(input => input.state === "pending" || input.state === "dispatching")
  if (!runningTurn && !pendingInput) return

  // Pending permission/elicitation prompts already have their own dedicated prompt/notice flow.
  if (snapshot.permissions.some(p => p.state === "pending") || snapshot.elicitations.some(e => e.state === "pending")) return
  if (runningTurn && await isScheduleRunTurn(ctx, sessionId, snapshot, runningTurn.id)) return
  if (runningTurn) {
    const ownership = inspectTurnOwnership(snapshot, runningTurn.id, userId)
    if (!ownership.readable || ownership.isSaOrigin) return
  } else if (pendingInput && (pendingInput.author.kind !== "user" || pendingInput.author.userId !== userId)) {
    return
  }

  const nowDate = ctx.now()
  const nowIso = nowDate.toISOString()
  const thresholdMs = ctx.deps.stallThresholdMs ?? 10 * 60_000

  // Any new ACP/journal event OR live streaming preview since the last recorded progress resets the stall timer cleanly.
  const recordedProgressMs = sub.state.lastProgressAt ? Date.parse(sub.state.lastProgressAt) : NaN
  const liveActivityMs = ctx.lastSessionActivityMs?.(sessionId)
  const hasNewLiveActivity = liveActivityMs !== undefined && Number.isFinite(liveActivityMs)
    && (!Number.isFinite(recordedProgressMs) || liveActivityMs > recordedProgressMs)
  if (snapshot.session.lastEventSeq !== sub.state.lastProgressSeq || hasNewLiveActivity) {
    const nextProgressIso = hasNewLiveActivity
      ? new Date(Math.max(liveActivityMs, Number.isFinite(recordedProgressMs) ? recordedProgressMs : 0)).toISOString()
      : nowIso
    await ctx.deps.followUpStore.updateSource(userId, workspaceId, "session", sessionId, () => sub.state, state => {
      state.lastProgressSeq = snapshot.session.lastEventSeq
      state.lastProgressAt = nextProgressIso
      state.scheduleTitle = snapshot.session.title
      if (state.lastErrorKey?.startsWith("stall:")) {
        delete state.lastErrorKey
        delete state.lastErrorCount
      }
    })
    return
  }

  const progress = evaluateWorkerProgress(snapshot, sub.state, workspaceId, sessionId, nowDate.getTime(), thresholdMs)
  if (progress.state !== "stalled" || !progress.issueKey) return

  if (progress.shouldRecheckOnly) {
    // First stall threshold crossing: quiet recheck only (0 chat alerts), then wait one more full window.
    await ctx.deps.followUpStore.updateSource(userId, workspaceId, "session", sessionId, () => sub.state, state => {
      state.lastErrorKey = progress.issueKey
      state.lastErrorCount = 1
      state.lastProgressSeq = snapshot.session.lastEventSeq
      state.lastProgressAt = nowIso
      state.scheduleTitle = snapshot.session.title
    })
    return
  }

  const stallTurnKey = runningTurn?.id ?? pendingInput?.id ?? "active"
  const runKey = `stall:${stallTurnKey}:${snapshot.session.lastEventSeq}`
  const existingRun = await ctx.deps.followUpStore.getRun(userId, workspaceId, "session", sessionId, runKey)
  if (existingRun) {
    ctx.metrics.duplicateSuppressed += 1
    return
  }
  const evidenceVersion = computeEvidenceVersion([userId, workspaceId, "session", sessionId, "stall", stallTurnKey, snapshot.session.lastEventSeq])
  const actionKey = `session:${sessionId}:stall:${stallTurnKey}:${snapshot.session.lastEventSeq}`
  const existingActions = await ctx.deps.followUpStore.listActions(userId, undefined, 200)
  if (existingActions.some(a => a.actionKey === actionKey)) {
    ctx.metrics.duplicateSuppressed += 1
    return
  }

  const auth = ctx.deps.followUpStore.getAuth(userId)
  const ruleMode = auth?.ordinarySessionRuleMode ?? "active"
  const stalledMinutes = Math.max(1, Math.round((thresholdMs * 2) / 60_000))
  const stallDetail = runningTurn
    ? `Turn "${runningTurn.id}" has stayed ${runningTurn.state} with no new progress events across consecutive periodic checks (~${stalledMinutes} min without output). Open the execution session to inspect or cancel.`
    : `Queued input has remained ${pendingInput!.state} with no new progress events across consecutive periodic checks (~${stalledMinutes} min). Open the execution session to inspect.`

  const triage = await ctx.runBoundedTriage(userId, workspaceId, async signal =>
    triageFollowUpEvent({
      userId, workspaceId, sourceKind: "session", sourceId: sessionId, sourceTitle: snapshot.session.title,
      runKey, status: "attention", deliveryPolicy: sub.state.deliveryPolicy, ruleMode,
      outputText: "", error: stallDetail, issueKey: progress.issueKey,
      stoppedIssueKeys: sub.state.stoppedIssueKeys,
    }, { model: ctx.deps.triageModel?.(userId), signal }),
  )
  if (!triage || !ctx.isTakeoverActive(userId)) return
  const postSub = ctx.deps.followUpStore.getSource(userId, workspaceId, "session", sessionId)
  if (!postSub?.state.enabled || postSub.state.pausedReason) return

  // Re-verify the session did not progress or finish while triage was running.
  try {
    const latest = await ctx.deps.agents.journal.read(sessionId)
    if (
      latest.session.lastEventSeq !== snapshot.session.lastEventSeq
      || (!latest.turns.some(activeTurn) && !latest.inputs.some(i => i.state === "pending" || i.state === "dispatching"))
    ) {
      return
    }
  } catch {
    return
  }

  const postAuthVersion = ctx.authVersion(userId)
  const startedAt = runningTurn?.startedAt ?? pendingInput?.createdAt ?? nowIso
  let deliveredMessageId: string | undefined
  let linkedTicketId: string | undefined
  const shouldDeliver = triage.kind !== "record_quietly" && ruleMode !== "shadow"
  if (ruleMode === "shadow" && triage.kind !== "record_quietly") {
    ctx.metrics.shadowDecisions += 1
  } else if (shouldDeliver) {
    const delivery = await deliverToMainChat(ctx, userId, workspaceId, {
      text: triage.summary,
      sourceKind: "session",
      sourceId: sessionId,
      scheduleTitle: snapshot.session.title,
      runKey,
      runStatus: "attention",
      ...(snapshot.session.provider ? { provider: snapshot.session.provider } : {}),
      ...(triage.detail ? { detail: triage.detail } : {}),
      startedAt,
      sessionId,
      turnId: runningTurn?.id,
      issueKey: triage.issueKey ?? progress.issueKey,
      evidenceAvailability: "available",
      options: triage.options,
    })
    deliveredMessageId = delivery.messageId
    linkedTicketId = delivery.ticketId
    ctx.metrics.deliveredRuns += 1
  } else {
    ctx.metrics.quietRuns += 1
  }

  await ctx.deps.followUpStore.upsertRun({
    userId, workspaceId, sourceKind: "session", sourceId: sessionId, runKey,
    scheduleTitle: snapshot.session.title,
    ...(snapshot.session.provider ? { provider: snapshot.session.provider } : {}),
    sessionId, turnId: runningTurn?.id,
    startedAt,
    status: "attention", delivered: shouldDeliver, deliveredMessageId, ticketId: linkedTicketId,
    issueKey: triage.issueKey ?? progress.issueKey,
    summary: triage.summary,
    ...(triage.detail ? { detail: triage.detail } : {}),
    error: stallDetail,
    evidenceAvailability: "available",
    evidenceRefs: { sessionId, ...(runningTurn?.id ? { turnId: runningTurn.id } : {}) },
    createdAt: runningTurn?.startedAt ?? nowIso, updatedAt: nowIso,
  })

  await ctx.deps.followUpStore.upsertAction({
    userId, workspaceId, sourceKind: "session", sourceId: sessionId, actionKey, evidenceVersion,
    authVersion: postAuthVersion, actionKind: triage.kind, mode: ruleMode,
    status: ruleMode === "shadow" && triage.kind !== "record_quietly" ? "shadow" : "completed",
    sessionId, turnId: runningTurn?.id, ticketId: linkedTicketId, messageId: deliveredMessageId, reason: triage.reason,
    createdAt: nowIso, updatedAt: nowIso,
  })
  ctx.deps.onRoomChanged?.(userId, workspaceId)

  await ctx.deps.followUpStore.updateSource(userId, workspaceId, "session", sessionId, () => postSub.state, state => {
    state.lastErrorKey = progress.issueKey
    state.lastErrorCount = (state.lastErrorCount ?? 1) + 1
    state.lastProgressAt = nowIso
    state.lastProgressSeq = snapshot.session.lastEventSeq
  })
}

async function supplementWorkerWithContext(
  ctx: FollowUpProcessorContext,
  userId: string, workspaceId: string, sessionId: string, turnId: string | undefined,
  actionKey: string, evidenceVersion: string, capturedAuthVersion: number,
  supplementText: string, reason: string,
): Promise<void> {
  const now = ctx.nowIso()
  if (!ctx.isTakeoverActive(userId) || ctx.authVersion(userId) !== capturedAuthVersion) return
  let actor: AgentActor
  try { actor = await ctx.deps.authorize({ kind: "user", userId, deviceId: "follow-up-delegation" }) }
  catch (error) {
    if (classifyAuthorizeError(error) === "revoked") ctx.metrics.crossUserBlocked += 1
    return
  }
  const snapshot = await ctx.deps.agents.journal.read(sessionId)
  if (snapshot.session.archiveState !== "active" || snapshot.session.lifecycle !== "ready") return
  const actionId = randomUUID()
  await ctx.deps.followUpStore.upsertAction({
    id: actionId, userId, workspaceId, sourceKind: "session", sourceId: sessionId,
    actionKey, evidenceVersion, authVersion: capturedAuthVersion,
    actionKind: "supplement_worker", mode: "active", status: "pending",
    sessionId, turnId, reason, createdAt: now, updatedAt: now,
  })
  if (!ctx.isTakeoverActive(userId) || ctx.authVersion(userId) !== capturedAuthVersion) {
    await ctx.deps.followUpStore.upsertAction({
      id: actionId, userId, workspaceId, sourceKind: "session", sourceId: sessionId,
      actionKey, evidenceVersion, authVersion: capturedAuthVersion,
      actionKind: "supplement_worker", mode: "active", status: "cancelled",
      sessionId, turnId, reason: "Authorization changed before dispatch", createdAt: now, updatedAt: ctx.nowIso(),
    })
    return
  }
  const receipt = await ctx.deps.agents.handle("_deskfleet/input/submit", {
    sessionId, operationId: randomUUID(), delivery: "backlog",
    content: [{
      type: "text", text: supplementText,
      _meta: { "deskfleet/followUpOrigin": "sa_follow_up", "deskfleet/followUpActionId": actionId },
    }],
  }, actor) as AgentReceipt
  ctx.metrics.autoSupplements += 1
  await ctx.deps.followUpStore.upsertAction({
    id: actionId, userId, workspaceId, sourceKind: "session", sourceId: sessionId,
    actionKey, evidenceVersion, authVersion: capturedAuthVersion,
    actionKind: "supplement_worker", mode: "active", status: "dispatched",
    sessionId, inputId: receipt.inputId, turnId, reason, createdAt: now, updatedAt: ctx.nowIso(),
  })
}

async function findCrossWorkerEvidence(
  ctx: FollowUpProcessorContext,
  userId: string, workspaceId: string, targetSessionId: string, targetPrRefs: FollowUpPrRef[], targetObjective: string,
) {
  const candidates: CrossWorkerCandidate[] = []
  const sources = ctx.deps.followUpStore.listSources(userId, workspaceId)
    .filter(s => s.sourceKind === "session" && s.sourceId !== targetSessionId && s.state.prRefs?.length)
  for (const src of sources) {
    const page = await ctx.deps.followUpStore.listRuns({ userId, workspaceId, sourceKind: "session", sourceId: src.sourceId, limit: 1 })
    const latest = page.runs[0]
    if (!latest || latest.evidenceAvailability === "restricted") continue
    candidates.push({
      sessionId: src.sourceId,
      workspaceId: src.workspaceId,
      ownerUserId: src.state.ownerUserId,
      title: src.state.scheduleTitle ?? src.sourceId,
      objective: src.state.scheduleTitle ?? "",
      prRefs: src.state.prRefs ?? [],
      summary: latest.summary,
      updatedAt: latest.updatedAt,
    })
  }
  return matchCrossWorkerEvidence({
    candidates, targetSessionId, targetWorkspaceId: workspaceId,
    ownerUserId: userId, targetPrRefs, targetObjective,
  })
}

async function maybeFetchPrStatus(ctx: FollowUpProcessorContext, userId: string, prRefs: FollowUpPrRef[]): Promise<string | undefined> {
  if (!ctx.deps.githubPullRequest || !prRefs.length) return undefined
  const ref = prRefs[0]!
  if (!ref.headBranch) return undefined
  try {
    const actor = await ctx.deps.authorize({ kind: "user", userId, deviceId: "follow-up-pr" })
    const result = await ctx.deps.githubPullRequest(actor, { owner: ref.owner, repo: ref.repo, headOwner: ref.owner, branch: ref.headBranch })
    if (!result.pullRequest) return undefined
    return `${ref.owner}/${ref.repo}#${result.pullRequest.number} (${result.pullRequest.state})`
  } catch {
    return undefined
  }
}

async function postRequestNotice(
  ctx: FollowUpProcessorContext,
  userId: string, workspaceId: string, sessionId: string,
  workerEvent: "permission" | "question", requestId: string, turnId: string | undefined, summary: string,
  provenance: FollowUpProvenance,
): Promise<string> {
  const result = await ctx.deps.superStore.update(userId, () => ({ rooms: [], intents: [] }), state => {
    const room = roomFor(state, workspaceId)
    const existing = room.messages.findLast(m => m.sessionId === sessionId && m.workerEvent === workerEvent && m.workerRequestId === requestId)
    if (existing) return { id: existing.id, created: false }
    const msg = note(room, summary, {
      role: "worker",
      sessionId,
      turnId,
      workerEvent,
      workerRequestId: requestId,
      provenance,
    })
    if (workerEvent === "question") bumpVisibleSeq(room, msg)
    return { id: msg.id, created: true }
  })
  if (result.created) ctx.deps.onRoomChanged?.(userId, workspaceId)
  return result.id
}

async function postOrdinaryRequestNotice(
  ctx: FollowUpProcessorContext,
  userId: string, workspaceId: string, sessionId: string, sessionTitle: string,
  workerEvent: "permission" | "question", requestId: string, turnId: string | undefined, summary: string,
): Promise<string> {
  return postRequestNotice(ctx, userId, workspaceId, sessionId, workerEvent, requestId, turnId, summary, {
    origin: "sa_follow_up", sourceKind: "session", sourceId: sessionId,
    scheduleTitle: sessionTitle, sessionId, turnId, evidenceAvailability: "available",
  })
}

async function resolveOrdinaryRequestNotice(
  ctx: FollowUpProcessorContext,
  userId: string, workspaceId: string, sessionId: string,
  workerEvent: "permission" | "question", req: AgentPermission | AgentElicitation,
): Promise<void> {
  const changed = await ctx.deps.superStore.update(userId, () => ({ rooms: [], intents: [] }), state => {
    const room = state.rooms.find(r => r.workspaceId === workspaceId)
    if (!room) return false
    const notice = room.messages.findLast(m => m.sessionId === sessionId && m.workerEvent === workerEvent && m.workerRequestId === req.id)
    if (!notice) return false
    const permission = workerEvent === "permission" ? req as AgentPermission : undefined
    const question = workerEvent === "question" ? req as AgentElicitation : undefined
    const selected = permission?.request.options.find(option => option.optionId === permission.optionId)
    const outcome = req.state === "cancelled" || question?.response?.action === "cancel"
      ? "Cancelled"
      : selected?.name ?? (question?.response?.action === "decline" ? "Declined" : "Answered")
    const title = (permission?.request.toolCall.title ?? question?.request.message ?? "").slice(0, 600)
    const nextText = [outcome, title].filter(Boolean).join(" · ")
    if (notice.text === nextText) return false
    notice.text = nextText
    return true
  })
  if (changed) ctx.deps.onRoomChanged?.(userId, workspaceId)
}
