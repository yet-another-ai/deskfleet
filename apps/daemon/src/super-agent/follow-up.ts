import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { CatalogSnapshot } from "@deskfleet/native"
import type { AgentActor, AgentEvent, AgentSnapshot } from "@deskfleet/protocol/agent"
import { turnSteering } from "@deskfleet/protocol/agent"
import { classifyJournalReadError, inspectTurnOwnership } from "./follow-up-evidence.ts"
import {
  inferDefaultDeliveryPolicy,
  type AdoptAllSchedulesResult,
  type FollowUpAuthMutation,
  type FollowUpAuthReceipt,
  type FollowUpAuthState,
  type FollowUpAuthSummary,
  type FollowUpDeliveryPolicy,
  type FollowUpInactiveWindow,
  type FollowUpMetricsSnapshot,
  type FollowUpRunRecord,
  type FollowUpRunsPage,
  type FollowUpSourceKind,
  type FollowUpSourceRecord,
  type FollowUpSourceState,
  type FollowUpSourceUpdateRequest,
  type FollowUpSourcesResponse,
} from "@deskfleet/protocol/super-agent-follow-up"
import {
  processSchedulePrivateEvent,
  reconcileSubscribedScheduleStates,
  settleScheduleRunsFinishedWhileDisabled,
  type FollowUpProcessorContext,
  type FollowUpServiceDeps,
  type PendingFollowUpRequest,
} from "./follow-up-schedules.ts"
import {
  checkStalledSession,
  clearSessionPendingRequests,
  handleOrdinarySessionEvent,
  isNewScheduleSession,
  isSaTicketBoundSession,
  migrateSessionSourceWorkspace,
  processSubscribedSession,
  refreshSessionPendingRequests,
  syncScheduleSessionRequests,
} from "./follow-up-sessions.ts"
import type { SuperWorkspace, SuperWorkspaceId } from "@deskfleet/protocol/super-agent"
import { ownedByActor } from "./target.ts"
import { activeTurn } from "./worker.ts"

export type { FollowUpServiceDeps } from "./follow-up-schedules.ts"

function normalizeDirPath(path: string): string {
  const resolved = resolve(path)
  try { return realpathSync(resolved) }
  catch { return resolved }
}

function normalizedDirKey(paths: string[]): string {
  return JSON.stringify(paths.map(normalizeDirPath))
}

function activeGrants(state: FollowUpAuthState | undefined) {
  if (!state || state.globalDisabled) return []
  return Object.values(state.grants).filter(grant => grant.enabled)
}

function isAuthorizedState(state: FollowUpAuthState | undefined): boolean {
  return activeGrants(state).length > 0
}

function isTakeoverActiveState(state: FollowUpAuthState | undefined): boolean {
  return isAuthorizedState(state) && state?.takeoverAllSessions === true
}

/**
 * Manages per-registration background follow-up authorization, durable schedule event consumption,
 * ordinary project session observation, bounded triage, and revocation cleanup.
 */
export class SuperFollowUpService {
  readonly #deps: FollowUpServiceDeps
  readonly #stop = new AbortController()
  readonly #live = new Set<Promise<void>>()
  readonly #workspaceTriage = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  readonly #pendingRequests = new Map<string, PendingFollowUpRequest[]>()
  readonly #sessionLastSeq = new Map<string, string>()
  readonly #sessionLastActivityAt = new Map<string, number>()
  readonly #sessionQueues = new Map<string, Promise<void>>()
  readonly #takeoverSync = new Map<string, Promise<void>>()
  #catalogSync: Promise<void> = Promise.resolve()
  readonly #unsubscribes: (() => void)[] = []
  #consumerEnabled = true
  #drainPromise?: Promise<void>
  #scheduleDrainDirty = false
  #retryTimer?: ReturnType<typeof setTimeout>
  #retryDelayMs = 0
  #stallTimer?: ReturnType<typeof setTimeout>
  readonly #metrics: FollowUpMetricsSnapshot = {
    deliveredRuns: 0,
    quietRuns: 0,
    duplicateSuppressed: 0,
    crossUserBlocked: 0,
    disabledStateTriageCalls: 0,
    autoSupplements: 0,
    humanQuestions: 0,
    revocationCleanups: 0,
    shadowDecisions: 0,
    byEntry: {},
    byTargetKind: {},
  }
  readonly #ctx: FollowUpProcessorContext

  constructor(deps: FollowUpServiceDeps) {
    this.#deps = deps
    this.#ctx = {
      deps,
      metrics: this.#metrics,
      now: () => this.#now(),
      nowIso: () => this.#nowIso(),
      bump: (map, key) => { map[key] = (map[key] ?? 0) + 1 },
      isAuthorized: userId => this.isAuthorized(userId),
      isTakeoverActive: userId => this.isTakeoverActive(userId),
      resolveSessionWorkspace: (userId, snapshot) => this.#resolveSessionWorkspace(userId, snapshot),
      syncScheduleSessionRequests: sessionId => syncScheduleSessionRequests(this.#ctx, sessionId),
      waitForTakeoverSync: () => this.#waitForTakeoverSync(),
      lastSessionActivityMs: sessionId => this.#sessionLastActivityAt.get(sessionId),
      authVersion: userId => this.authVersion(userId),
      runBoundedTriage: (userId, workspaceId, work) => this.#runBoundedTriage(userId, workspaceId, work),
      pendingRequests: this.#pendingRequests,
    }
  }

  #now(): Date { return this.#deps.now?.() ?? new Date() }
  #nowIso(): string { return this.#now().toISOString() }

  #track(job: Promise<void>): Promise<void> {
    this.#live.add(job)
    void job.catch(error => console.error("Super follow-up:", error instanceof Error ? error.message : String(error))).finally(() => this.#live.delete(job))
    return job
  }

  async init(): Promise<void> {
    await this.#deps.followUpStore.init()
    try {
      for (const session of await this.#deps.agents.journal.list()) {
        this.#sessionLastSeq.set(session.id, session.lastEventSeq)
      }
    } catch { /* ignore startup journal list error */ }
    this.#deps.schedules?.setSubscriberCheck((scheduleId, ownerUserId) => this.hasActiveScheduleSubscriber(scheduleId, ownerUserId))
    this.#deps.schedules?.setAutoAdoptCheck?.(ownerUserId => this.hasAdoptAllSchedules(ownerUserId))
    if (this.#deps.schedules) {
      this.#unsubscribes.push(this.#deps.schedules.onPrivateEvent(() => this.#triggerScheduleDrain()))
    }
    this.#unsubscribes.push(this.#deps.agents.onEvent(event => this.#onAgentEvent(event)))
    if (this.#deps.agents.onPreview) {
      this.#unsubscribes.push(this.#deps.agents.onPreview(preview => {
        if (preview.sessionId) this.#sessionLastActivityAt.set(preview.sessionId, this.#now().getTime())
      }))
    }
    if (this.#deps.onCatalogChanged) {
      this.#unsubscribes.push(this.#deps.onCatalogChanged(() => this.#onCatalogChanged()))
    }
    for (const uid of this.#deps.followUpStore.users()) {
      if (this.isTakeoverActive(uid)) {
        await this.#reconcileTakeoverForUser(uid, this.#nowIso(), { advanceExistingCursors: false })
      }
    }
    await this.drainScheduleEvents()
    await this.#reconcileSubscribedSessions()
    this.#scheduleStallCheck()
  }

  async close(): Promise<void> {
    this.#stop.abort()
    this.#clearDeferredRetry()
    this.#clearStallCheck()
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe()
    for (const entry of this.#workspaceTriage.values()) entry.controller.abort()
    while (this.#live.size) await Promise.allSettled([...this.#live])
    await this.#deps.followUpStore.close()
  }

  /** Independent kill-switch: disables background follow-up consumption while leaving native schedules intact. */
  setConsumerEnabled(enabled: boolean): void {
    this.#consumerEnabled = enabled
    if (!enabled) {
      this.#clearDeferredRetry()
      this.#clearStallCheck()
      for (const entry of this.#workspaceTriage.values()) entry.controller.abort()
    } else {
      this.#triggerScheduleDrain()
      this.#scheduleStallCheck()
    }
  }

  /** Called when central authorization connectivity recovers: resets retry backoff and drains deferred schedule events immediately. */
  notifyAuthorizeRecovered(): void {
    if (this.#stop.signal.aborted || !this.#consumerEnabled) return
    this.#clearDeferredRetry()
    this.#retryDelayMs = 0
    this.#triggerScheduleDrain()
  }

  #clearDeferredRetry(): void {
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = undefined
    }
  }

  #clearStallCheck(): void {
    if (this.#stallTimer) {
      clearTimeout(this.#stallTimer)
      this.#stallTimer = undefined
    }
  }

  #scheduleStallCheck(): void {
    if (this.#stop.signal.aborted || !this.#consumerEnabled || this.#stallTimer) return
    const intervalMs = this.#deps.stallCheckIntervalMs ?? 60_000
    if (intervalMs <= 0) return
    this.#stallTimer = setTimeout(() => {
      this.#stallTimer = undefined
      this.#track(this.checkStalledSessions().finally(() => this.#scheduleStallCheck()))
    }, intervalMs)
    this.#stallTimer.unref()
  }

  /** Run one periodic stall-recheck sweep across all active subscribed ordinary Worker sessions. */
  async checkStalledSessions(): Promise<void> {
    if (this.#stop.signal.aborted || !this.#consumerEnabled) return
    const sources = this.#deps.followUpStore.listSources()
      .filter(src => src.sourceKind === "session" && src.state.enabled && !src.state.pausedReason)
    for (const src of sources) {
      if (this.#stop.signal.aborted || !this.#consumerEnabled) break
      if (!this.isTakeoverActive(src.userId)) continue
      await this.#enqueueSessionWork(src.sourceId, async () => {
        await checkStalledSession(this.#ctx, src.userId, src.workspaceId, src.sourceId)
      })
    }
  }

  #scheduleDeferredRetry(): void {
    if (this.#stop.signal.aborted || !this.#consumerEnabled || this.#retryTimer) return
    const base = Math.max(20, this.#deps.retryBaseMs ?? 2_000)
    const max = Math.max(base, this.#deps.retryMaxMs ?? 60_000)
    const delay = this.#retryDelayMs > 0 ? Math.min(this.#retryDelayMs * 2, max) : base
    this.#retryDelayMs = delay
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      this.#triggerScheduleDrain()
    }, delay)
    this.#retryTimer.unref()
  }

  isConsumerEnabled(): boolean { return this.#consumerEnabled }

  /** Safe downgrade/rollback checkpoint: stops consumer, flushes pending schedule acks, and returns durable cursors. */
  async prepareRollback(): Promise<{ drainedEvents: number; cursors: { userId: string; workspaceId: string; sourceKind: FollowUpSourceKind; sourceId: string; cursorSeq?: string }[] }> {
    this.setConsumerEnabled(false)
    while (this.#live.size) await Promise.allSettled([...this.#live])
    const pending = this.#deps.schedules?.pendingPrivateEvents() ?? []
    if (pending.length && this.#deps.schedules) {
      await this.#deps.schedules.ackPrivateEvents(pending.map(event => event.id))
    }
    const cursors = this.#deps.followUpStore.listSources().map(src => ({
      userId: src.userId, workspaceId: src.workspaceId, sourceKind: src.sourceKind,
      sourceId: src.sourceId, cursorSeq: src.state.cursorSeq,
    }))
    return { drainedEvents: pending.length, cursors }
  }

  metrics(): FollowUpMetricsSnapshot { return structuredClone(this.#metrics) }

  isAuthorized(userId: string): boolean {
    if (!this.#consumerEnabled) return false
    return isAuthorizedState(this.#deps.followUpStore.getAuth(userId))
  }

  isTakeoverEnabled(userId: string): boolean {
    if (!this.#consumerEnabled) return false
    return this.#deps.followUpStore.getAuth(userId)?.takeoverAllSessions === true
  }

  isTakeoverActive(userId: string): boolean {
    if (!this.#consumerEnabled) return false
    return isTakeoverActiveState(this.#deps.followUpStore.getAuth(userId))
  }

  authVersion(userId: string): number {
    return this.#deps.followUpStore.getAuth(userId)?.authVersion ?? 0
  }

  hasAdoptAllSchedules(userId: string): boolean {
    return this.isTakeoverActive(userId)
  }

  hasActiveScheduleSubscriber(scheduleId: string, ownerUserId?: string): boolean {
    if (!this.#consumerEnabled) return false
    const sources = this.#deps.followUpStore.listSources().filter(src =>
      src.sourceKind === "schedule" && src.sourceId === scheduleId)
    if (sources.some(src => src.state.enabled && !src.state.pausedReason && this.isTakeoverActive(src.userId))) {
      return true
    }
    const owner = ownerUserId ?? this.#deps.schedules?.inspectTask(scheduleId)?.ownerUserId
    if (!owner || !this.isTakeoverActive(owner)) return false
    // Respect explicit per-schedule stop/opt-out or awaiting/ownership pause records.
    return !sources.some(src => src.userId === owner)
  }

  getScheduleSubscription(userId: string, workspaceId: string, scheduleId: string): {
    enabled: boolean
    awaitingAuthorization?: boolean
    pausedReason?: FollowUpSourceState["pausedReason"]
    deliveryPolicy: FollowUpDeliveryPolicy
  } | undefined {
    const takeoverActive = this.isTakeoverActive(userId)
    const src = this.#deps.followUpStore.getSource(userId, workspaceId, "schedule", scheduleId)
    if (src) {
      const awaitingAuthorization = src.state.pausedReason === "awaiting_authorization"
      return {
        enabled: takeoverActive && src.state.enabled && !src.state.pausedReason,
        ...(awaitingAuthorization ? { awaitingAuthorization: true } : {}),
        ...(src.state.pausedReason ? { pausedReason: src.state.pausedReason } : {}),
        deliveryPolicy: src.state.deliveryPolicy,
      }
    }
    if (!this.isTakeoverEnabled(userId)) return undefined
    const inspected = this.#deps.schedules?.inspectTask(scheduleId)
    if (!inspected || inspected.task.workspaceId !== workspaceId || inspected.ownerUserId !== userId) return undefined
    return {
      enabled: takeoverActive,
      ...(!takeoverActive ? { awaitingAuthorization: true, pausedReason: "awaiting_authorization" as const } : {}),
      deliveryPolicy: inferDefaultDeliveryPolicy(inspected.task.title, inspected.task.prompt),
    }
  }

  authSummary(userId: string, workspaceId?: SuperWorkspaceId): FollowUpAuthSummary {
    const auth = this.#deps.followUpStore.getAuth(userId)
    const grants = activeGrants(auth)
    const authorized = this.#consumerEnabled && grants.length > 0
    const takeoverAllSessions = auth?.takeoverAllSessions === true
    const takeoverActive = authorized && takeoverAllSessions
    const userState = this.#deps.superStore.get(userId)
    const hasLegacySuperState = !!userState && userState.rooms.some(room => room.messages.length > 0 || room.tickets.length > 0)
    const sources = this.#deps.followUpStore.listSources(userId, workspaceId ?? undefined)
    const subscribedScheduleCount = takeoverActive
      ? sources.filter(s => s.sourceKind === "schedule" && s.state.enabled && !s.state.pausedReason).length
      : 0
    const pendingAuthScheduleCount = sources.filter(s => s.sourceKind === "schedule" && s.state.pausedReason === "awaiting_authorization").length
    const subscribedSessionCount = takeoverActive
      ? sources.filter(s => s.sourceKind === "session" && s.state.enabled && !s.state.pausedReason).length
      : 0
    return {
      authorized,
      authVersion: auth?.authVersion ?? 0,
      globalDisabled: auth?.globalDisabled === true,
      activeDeviceCount: grants.length,
      devices: Object.values(auth?.grants ?? {}),
      autoEnrollOrdinarySessions: auth?.autoEnrollOrdinarySessions ?? true,
      ordinarySessionRuleMode: auth?.ordinarySessionRuleMode ?? "active",
      takeoverAllSessions,
      ...(auth?.takeoverAllSessionsSince ? { takeoverAllSessionsSince: auth.takeoverAllSessionsSince } : {}),
      adoptAllSchedules: takeoverAllSessions || (auth?.adoptAllSchedules === true && pendingAuthScheduleCount > 0),
      ...(auth?.adoptAllSchedulesSince ? { adoptAllSchedulesSince: auth.adoptAllSchedulesSince } : {}),
      pendingAuthScheduleCount,
      needsConsent: auth === undefined && hasLegacySuperState,
      subscribedScheduleCount,
      subscribedSessionCount,
      pendingTriageCount: 0,
    }
  }

  pendingRequestsForWorkspace(userId: string, workspaceId: SuperWorkspaceId): PendingFollowUpRequest[] {
    if (!workspaceId || !this.isTakeoverActive(userId)) return []
    return structuredClone(this.#pendingRequests.get(JSON.stringify([userId, workspaceId])) ?? [])
  }

  /** Wait for any in-flight catalog-triggered takeover reconciliation to complete. */
  async waitForTakeoverSync(): Promise<void> {
    await this.#waitForTakeoverSync()
  }

  async #waitForTakeoverSync(): Promise<void> {
    await this.#catalogSync.catch(() => {})
    if (this.#takeoverSync.size) {
      await Promise.allSettled([...this.#takeoverSync.values()])
    }
  }

  /** Synchronize takeover for a specific project workspace (safety net when a workspace is opened or sent to). */
  async syncWorkspaceTakeover(userId: string, workspaceId: string): Promise<void> {
    if (this.#stop.signal.aborted || !this.isTakeoverActive(userId)) return
    await this.#reconcileTakeoverForUser(userId, this.#nowIso(), { workspaceId, advanceExistingCursors: false })
  }

  #onCatalogChanged(): void {
    if (this.#stop.signal.aborted || !this.#consumerEnabled) return
    const activeUsers = this.#deps.followUpStore.users().filter(uid => this.isTakeoverActive(uid))
    if (!activeUsers.length) return
    // Snapshot every known session's current event seq SYNCHRONOUSLY before any subsequent events arrive.
    const cursorSnapshot = new Map(this.#sessionLastSeq)
    const now = this.#nowIso()
    const next = this.#catalogSync.catch(() => {}).then(async () => {
      for (const uid of activeUsers) {
        if (this.#stop.signal.aborted || !this.isTakeoverActive(uid)) continue
        await this.#reconcileTakeoverForUser(uid, now, { cursorSnapshot, advanceExistingCursors: false })
      }
    })
    this.#catalogSync = next
    this.#track(next)
  }

  #resolveSessionWorkspaceFromData(
    sessionId: string,
    sessionWorkspaceId: string | undefined,
    workspaces: SuperWorkspace[],
    visibleById: Map<string, SuperWorkspace>,
    catalog: CatalogSnapshot | undefined,
    historyProjects: Record<string, string> | undefined,
  ): string | undefined {
    if (sessionWorkspaceId) {
      return visibleById.has(sessionWorkspaceId) ? sessionWorkspaceId : undefined
    }
    if (!catalog) return undefined

    // 1. Check if catalog already owns this session under a visible workspace.
    for (const project of catalog.workspaces) {
      if (!visibleById.has(project.id)) continue
      if (project.worktrees.some(tree => tree.sessionId === sessionId)) return project.id
    }

    // 2. Inspect loose session directories from "New Conversation".
    const looseTree = catalog.sessions.find(tree => tree.sessionId === sessionId)
    if (!looseTree || !looseTree.directories.length) return undefined
    const sessionDirs = looseTree.directories.map(d => normalizeDirPath(d.path))
    const sessionKey = JSON.stringify(sessionDirs)

    // 3. Respect an explicit personal history link if still matching the workspace's roots.
    const explicitLink = historyProjects?.[sessionId]
    if (explicitLink) {
      const linkedWs = visibleById.get(explicitLink)
      if (linkedWs) {
        const wsRoots = linkedWs.roots.map(normalizeDirPath)
        if (JSON.stringify(wsRoots) === sessionKey || (sessionDirs.length === 1 && wsRoots.includes(sessionDirs[0]!))) {
          return linkedWs.id
        }
      }
    }

    // 4. Exact root-set directory match (must be unique).
    const exactMatches = workspaces.filter(ws => normalizedDirKey(ws.roots) === sessionKey)
    if (exactMatches.length === 1) return exactMatches[0]!.id
    if (exactMatches.length > 1) return undefined

    // 5. Single-directory match against a workspace root or subdirectory containment (unique deepest match).
    if (sessionDirs.length === 1) {
      const targetDir = sessionDirs[0]!
      const directRootMatches = workspaces.filter(ws => ws.roots.map(normalizeDirPath).includes(targetDir))
      if (directRootMatches.length === 1) return directRootMatches[0]!.id
      if (directRootMatches.length > 1) return undefined

      let bestLen = -1
      let bestIds: string[] = []
      for (const ws of workspaces) {
        let wsBest = -1
        for (const root of ws.roots.map(normalizeDirPath)) {
          const rel = relative(root, targetDir)
          if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
            if (root.length > wsBest) wsBest = root.length
          }
        }
        if (wsBest > bestLen) {
          bestLen = wsBest
          bestIds = [ws.id]
        } else if (wsBest >= 0 && wsBest === bestLen) {
          bestIds.push(ws.id)
        }
      }
      if (bestIds.length === 1) return bestIds[0]!
    }
    return undefined
  }

  /**
   * Resolve which visible Project SA (`Workspace`) owns `snapshot` by workspaceId or project directory.
   * Supports unassigned "New Conversation" sessions (`workspaceId === undefined`, `catalog.sessions` dirs).
   * Returns `undefined` when no matching Project SA exists (or directory is ambiguous across workspaces)
   * and NEVER auto-creates a workspace.
   */
  async #resolveSessionWorkspace(userId: string, snapshot: AgentSnapshot): Promise<string | undefined> {
    let workspaces
    try { workspaces = await this.#deps.workspaces(userId) }
    catch { return undefined }
    if (!workspaces.length) return undefined
    const visibleById = new Map(workspaces.map(ws => [ws.id, ws]))
    if (snapshot.session.workspaceId) {
      return visibleById.has(snapshot.session.workspaceId) ? snapshot.session.workspaceId : undefined
    }
    if (!this.#deps.historyCatalog) return undefined
    let catalog: CatalogSnapshot | undefined
    try { catalog = await this.#deps.historyCatalog() }
    catch { return undefined }
    const historyProjects = this.#deps.superStore.get(userId)?.historyProjects
    return this.#resolveSessionWorkspaceFromData(snapshot.session.id, snapshot.session.workspaceId, workspaces, visibleById, catalog, historyProjects)
  }

  /**
   * Reconcile all owned schedules AND ordinary sessions (including unassigned "New Conversation"
   * sessions matching a project directory) for `userId` when unified takeover is active.
   * Starts from the actual takeover moment without replaying history, preserves existing reporting
   * preferences, skips SA tickets and schedule execution sessions, and never auto-creates a workspace.
   */
  async #reconcileTakeoverForUser(
    userId: string,
    now: string,
    options: {
      workspaceId?: string
      deliveryPolicy?: FollowUpDeliveryPolicy
      cursorSnapshot?: Map<string, string>
      advanceExistingCursors?: boolean
    } = {},
  ): Promise<{ adoptedScheduleCount: number; adoptedSessionCount: number; preservedPreferenceCount: number; skippedOtherOwnerCount: number }> {
    const run = async () => {
      let adoptedScheduleCount = 0
      let adoptedSessionCount = 0
      let preservedPreferenceCount = 0
      let skippedOtherOwnerCount = 0
      if (this.#stop.signal.aborted || !this.isTakeoverActive(userId)) {
        return { adoptedScheduleCount, adoptedSessionCount, preservedPreferenceCount, skippedOtherOwnerCount }
      }
      let workspaces
      try { workspaces = await this.#deps.workspaces(userId) }
      catch { return { adoptedScheduleCount, adoptedSessionCount, preservedPreferenceCount, skippedOtherOwnerCount } }
      const allowedWorkspaces = new Set(workspaces.map(ws => ws.id))
      if (options.workspaceId && !allowedWorkspaces.has(options.workspaceId)) {
        return { adoptedScheduleCount, adoptedSessionCount, preservedPreferenceCount, skippedOtherOwnerCount }
      }

      // 1. Owned scheduled tasks in matching project workspaces.
      let hasDeferredPrePause = false
      for (const task of this.#deps.schedules?.snapshot() ?? []) {
        if (!allowedWorkspaces.has(task.workspaceId)) continue
        if (options.workspaceId && task.workspaceId !== options.workspaceId) continue
        const inspected = this.#deps.schedules?.inspectTask(task.id)
        if (!inspected) continue
        if (inspected.ownerUserId !== userId) {
          skippedOtherOwnerCount += 1
          continue
        }
        const existing = this.#deps.followUpStore.getSource(userId, task.workspaceId, "schedule", task.id)
        if (existing?.state.pausedReason === "modified_by_other_member" || existing?.state.pausedReason === "schedule_deleted") {
          continue
        }
        if (existing?.state.optedOut === true && !options.advanceExistingCursors) {
          continue
        }
        if (existing?.state.deliveryPolicy) preservedPreferenceCount += 1
        const deliveryPolicy = existing?.state.deliveryPolicy
          ?? options.deliveryPolicy
          ?? inferDefaultDeliveryPolicy(task.title, task.prompt)
        const targetKind = task.target.kind === "existing" ? "existing" : task.target.context

        if (!existing) {
          await this.subscribeSchedule({
            userId,
            workspaceId: task.workspaceId,
            scheduleId: task.id,
            scheduleTitle: task.title,
            targetKind,
            deliveryPolicy,
            enabled: true,
            scheduleVersion: inspected.version,
          })
          adoptedScheduleCount += 1
        } else if (existing.state.pausedReason === "awaiting_authorization" || (options.advanceExistingCursors && (!existing.state.enabled || existing.state.pausedReason === "user_stopped"))) {
          if (existing.state.deferredPrePauseRuns?.length) hasDeferredPrePause = true
          await this.subscribeSchedule({
            userId,
            workspaceId: task.workspaceId,
            scheduleId: task.id,
            scheduleTitle: task.title,
            targetKind,
            deliveryPolicy,
            enabled: true,
            scheduleVersion: inspected.version,
          })
          adoptedScheduleCount += 1
        } else if (existing.state.enabled && !existing.state.pausedReason) {
          if (existing.state.deferredPrePauseRuns?.length) hasDeferredPrePause = true
          if (options.advanceExistingCursors) {
            await this.#deps.followUpStore.updateSource(
              userId, task.workspaceId, "schedule", task.id,
              () => existing.state,
              state => {
                state.firstSubscribedAt ??= state.subscribedAt ?? now
                state.subscribedAt = now
                state.scheduleTitle = task.title
                state.scheduleVersion = inspected.version
              },
            )
          }
          adoptedScheduleCount += 1
        }
      }

      // 2. Owned active ready ordinary sessions (workspace-scoped + unassigned "New Conversation" matched by directory).
      //    Resolve target project BEFORE reading per-session details or command history so polling project A
      //    never scans project B's sessions or commands.
      const sessionsToCatchUp: { workspaceId: string; sessionId: string; snapshot: AgentSnapshot }[] = []
      let sessionRecords: Awaited<ReturnType<FollowUpServiceDeps["agents"]["journal"]["list"]>> = []
      try { sessionRecords = await this.#deps.agents.journal.list() }
      catch { sessionRecords = [] }

      const visibleById = new Map(workspaces.map(ws => [ws.id, ws]))
      const hasUnassignedSession = sessionRecords.some(s => s.archiveState === "active" && s.lifecycle === "ready" && !s.workspaceId)
      let catalog: CatalogSnapshot | undefined
      if (hasUnassignedSession && this.#deps.historyCatalog) {
        try { catalog = await this.#deps.historyCatalog() }
        catch { catalog = undefined }
      }
      const historyProjects = this.#deps.superStore.get(userId)?.historyProjects
      const existingBySession = new Map<string, FollowUpSourceRecord[]>()
      for (const src of this.#deps.followUpStore.listSources(userId)) {
        if (src.sourceKind !== "session") continue
        const list = existingBySession.get(src.sourceId) ?? []
        list.push(src)
        existingBySession.set(src.sourceId, list)
      }

      for (const session of sessionRecords) {
        if (this.#stop.signal.aborted || !this.isTakeoverActive(userId)) break
        if (session.archiveState !== "active" || session.lifecycle !== "ready") continue

        const targetWorkspaceId = this.#resolveSessionWorkspaceFromData(
          session.id, session.workspaceId, workspaces, visibleById, catalog, historyProjects,
        )
        const allForSession = existingBySession.get(session.id) ?? []

        // If polling a specific project A and this session no longer belongs to A, deactivate any stale
        // active subscription on A without scanning project B's snapshot or command history.
        if (options.workspaceId && targetWorkspaceId !== options.workspaceId) {
          const staleInPolledWs = allForSession.find(s => s.workspaceId === options.workspaceId && s.state.enabled && !s.state.pausedReason)
          if (staleInPolledWs) {
            clearSessionPendingRequests(this.#ctx, userId, options.workspaceId, session.id)
            await this.#deps.followUpStore.updateSource(
              userId, options.workspaceId, "session", session.id,
              () => staleInPolledWs.state,
              state => {
                state.enabled = false
                state.pausedReason = "ownership_changed"
                state.optedOut = false
              },
            )
          }
          continue
        }
        if (!targetWorkspaceId) {
          for (const stale of allForSession) {
            if (!stale.state.enabled || stale.state.pausedReason) continue
            clearSessionPendingRequests(this.#ctx, userId, stale.workspaceId, session.id)
            await this.#deps.followUpStore.updateSource(
              userId, stale.workspaceId, "session", session.id,
              () => stale.state,
              state => {
                state.enabled = false
                state.pausedReason = "ownership_changed"
                state.optedOut = false
              },
            )
          }
          continue
        }

        const existingForTarget = allForSession.find(s => s.workspaceId === targetWorkspaceId)
        const staleActiveOthers = allForSession.filter(s => s.workspaceId !== targetWorkspaceId && s.state.enabled && !s.state.pausedReason)
        const staleAnyOther = staleActiveOthers[0] ?? allForSession.find(s => s.workspaceId !== targetWorkspaceId)

        // Fast path: already actively subscribed to this exact workspace with no migration or cursor reset needed.
        if (existingForTarget && !staleActiveOthers.length && !options.advanceExistingCursors) {
          if (existingForTarget.state.optedOut === true) continue
          if (existingForTarget.state.enabled && !existingForTarget.state.pausedReason) {
            if (existingForTarget.state.scheduleTitle !== session.title) {
              await this.#deps.followUpStore.updateSource(
                userId, targetWorkspaceId, "session", session.id,
                () => existingForTarget.state,
                state => { state.scheduleTitle = session.title },
              )
            }
            continue
          }
        }

        if (isSaTicketBoundSession(this.#ctx, userId, session.id)) continue
        if (isNewScheduleSession(this.#ctx, session.id)) continue

        // Read command history AT MOST ONCE to verify both creation operationId and user ownership.
        let creation: { operationId: string; actor: AgentActor } | undefined
        try {
          const commands = await this.#deps.agents.journal.commands(session.id)
          creation = commands.find(cmd => cmd.isCanonical && (cmd.method === "_deskfleet/session/create" || cmd.method === "_deskfleet/session/fork"))
        } catch { continue }
        if (!creation || creation.actor.kind !== "user" || creation.actor.userId !== userId) continue
        if (isSaTicketBoundSession(this.#ctx, userId, session.id, creation.operationId)) continue
        if (isNewScheduleSession(this.#ctx, session.id, creation.operationId)) continue

        let snapshot: AgentSnapshot
        try { snapshot = await this.#deps.agents.journal.read(session.id) }
        catch { continue }

        const desiredCursor = options.cursorSnapshot?.get(session.id) ?? snapshot.session.lastEventSeq

        if (staleActiveOthers.length) {
          const primaryStale = staleActiveOthers[0]!
          for (const extraStale of staleActiveOthers.slice(1)) {
            clearSessionPendingRequests(this.#ctx, userId, extraStale.workspaceId, session.id)
            await this.#deps.followUpStore.updateSource(
              userId, extraStale.workspaceId, "session", session.id,
              () => extraStale.state,
              state => {
                state.enabled = false
                state.pausedReason = "ownership_changed"
                state.optedOut = false
              },
            )
          }
          await migrateSessionSourceWorkspace(
            this.#ctx, userId, primaryStale.workspaceId, targetWorkspaceId, session.id, snapshot, primaryStale.state,
            { advanceCursor: options.advanceExistingCursors },
          )
          adoptedSessionCount += 1
          const migrated = this.#deps.followUpStore.getSource(userId, targetWorkspaceId, "session", session.id)
          if (migrated?.state.enabled && !migrated.state.pausedReason && BigInt(snapshot.session.lastEventSeq) > BigInt(migrated.state.cursorSeq ?? "0")) {
            sessionsToCatchUp.push({ workspaceId: targetWorkspaceId, sessionId: session.id, snapshot })
          }
          continue
        }

        if (!existingForTarget) {
          const inheritedOptOut = staleAnyOther?.state.optedOut === true && !options.advanceExistingCursors
          if (inheritedOptOut) continue
          await this.#deps.followUpStore.updateSource(
            userId, targetWorkspaceId, "session", session.id,
            () => ({
              enabled: true,
              deliveryPolicy: staleAnyOther?.state.deliveryPolicy ?? "exceptions_only",
              cursorSeq: desiredCursor,
              ownerUserId: userId,
              scheduleTitle: snapshot.session.title,
              lastProgressSeq: desiredCursor,
              lastProgressAt: now,
              optedOut: false,
            }),
            state => { state.scheduleTitle = snapshot.session.title },
          )
          adoptedSessionCount += 1
          if (BigInt(snapshot.session.lastEventSeq) > BigInt(desiredCursor)) {
            sessionsToCatchUp.push({ workspaceId: targetWorkspaceId, sessionId: session.id, snapshot })
          }
        } else {
          if (existingForTarget.state.optedOut === true && !options.advanceExistingCursors) continue
          if (options.advanceExistingCursors || existingForTarget.state.pausedReason === "ownership_changed") {
            await this.#deps.followUpStore.updateSource(
              userId, targetWorkspaceId, "session", session.id,
              () => existingForTarget.state,
              state => {
                state.enabled = true
                state.optedOut = false
                delete state.pausedReason
                state.cursorSeq = snapshot.session.lastEventSeq
                state.lastProgressSeq = snapshot.session.lastEventSeq
                state.lastProgressAt = now
                state.scheduleTitle = snapshot.session.title
              },
            )
            adoptedSessionCount += 1
          }
        }
      }

      if (hasDeferredPrePause) this.#triggerScheduleDrain()
      for (const item of sessionsToCatchUp) {
        await processSubscribedSession(this.#ctx, userId, item.workspaceId, item.sessionId, item.snapshot)
      }
      return { adoptedScheduleCount, adoptedSessionCount, preservedPreferenceCount, skippedOtherOwnerCount }
    }

    const previous = this.#takeoverSync.get(userId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(run)
    const tracked = next.then(() => undefined, () => undefined)
    this.#takeoverSync.set(userId, tracked)
    try { return await next } finally {
      if (this.#takeoverSync.get(userId) === tracked) this.#takeoverSync.delete(userId)
    }
  }

  /** Handle authorized device enable / disable / revoke_all / configure / status mutations. */
  async handleAuth(mutation: FollowUpAuthMutation, actor: AgentActor): Promise<FollowUpAuthReceipt> {
    if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and device are required")
    const uid = actor.userId
    if (mutation.action === "status") {
      const summary = this.authSummary(uid)
      return { status: "unchanged", authVersion: summary.authVersion, authorized: summary.authorized, activeDeviceCount: summary.activeDeviceCount, stoppedAllBackground: !summary.authorized, summary }
    }
    const authorizedActor = await this.#deps.authorize(actor)
    const now = this.#nowIso()
    let wasAuthorized = false
    let wasTakeoverActive = false
    let becameUnauthorized = false
    let becameAuthorized = false
    let becameTakeoverInactive = false
    let becameTakeoverActive = false
    let closedRevokedWindow: FollowUpInactiveWindow | undefined
    let closedTakeoverWindow: FollowUpInactiveWindow | undefined
    let outcome: "applied" | "stale_ignored" | "unchanged" = "applied"
    let nextVersion = 0

    await this.#deps.followUpStore.updateAuth(uid, state => {
      wasAuthorized = isAuthorizedState(state)
      wasTakeoverActive = isTakeoverActiveState(state)
      if (mutation.action === "enable") {
        // Stale offline device cannot re-open authorization after a newer global/device revocation.
        if (mutation.expectedAuthVersion !== undefined && mutation.expectedAuthVersion < state.authVersion) {
          outcome = "stale_ignored"
          nextVersion = state.authVersion
          return
        }
        state.authVersion += 1
        state.globalDisabled = false
        state.grants[mutation.installationId!] = {
          installationId: mutation.installationId!,
          ...(mutation.deviceLabel ? { deviceLabel: mutation.deviceLabel } : {}),
          ...(mutation.platform ? { platform: mutation.platform } : {}),
          enabled: true,
          authVersion: state.authVersion,
          updatedAt: now,
        }
        if (mutation.autoEnrollOrdinarySessions !== undefined) state.autoEnrollOrdinarySessions = mutation.autoEnrollOrdinarySessions
        if (mutation.ordinarySessionRuleMode !== undefined) state.ordinarySessionRuleMode = mutation.ordinarySessionRuleMode
        if (mutation.takeoverAllSessions !== undefined) {
          state.takeoverAllSessions = mutation.takeoverAllSessions
          state.adoptAllSchedules = mutation.takeoverAllSessions
          if (mutation.takeoverAllSessions) {
            state.takeoverAllSessionsSince = now
            state.adoptAllSchedulesSince = now
          }
        }
        state.updatedAt = now
        nextVersion = state.authVersion
      } else if (mutation.action === "disable") {
        const existing = state.grants[mutation.installationId!]
        // Strictly idempotent: disabling an unknown or already-disabled installation MUST NOT
        // bump authVersion or create a grant record (prevents classic device interference).
        if (!existing || !existing.enabled) {
          outcome = "unchanged"
          nextVersion = state.authVersion
          return
        }
        state.authVersion += 1
        existing.enabled = false
        existing.authVersion = state.authVersion
        existing.updatedAt = now
        state.updatedAt = now
        nextVersion = state.authVersion
      } else if (mutation.action === "revoke_all") {
        state.authVersion += 1
        state.globalDisabled = true
        state.revokedAllAtVersion = state.authVersion
        state.takeoverAllSessions = false
        state.adoptAllSchedules = false
        for (const grant of Object.values(state.grants)) {
          grant.enabled = false
          grant.authVersion = state.authVersion
          grant.updatedAt = now
        }
        state.updatedAt = now
        nextVersion = state.authVersion
      } else if (mutation.action === "configure") {
        if (mutation.takeoverAllSessions === true && !isAuthorizedState(state)) {
          throw new Error("Background authorization is required before enabling full session takeover")
        }
        if (mutation.autoEnrollOrdinarySessions !== undefined) state.autoEnrollOrdinarySessions = mutation.autoEnrollOrdinarySessions
        if (mutation.ordinarySessionRuleMode !== undefined) state.ordinarySessionRuleMode = mutation.ordinarySessionRuleMode
        if (mutation.takeoverAllSessions !== undefined) {
          const prevFlag = state.takeoverAllSessions === true
          state.takeoverAllSessions = mutation.takeoverAllSessions
          state.adoptAllSchedules = mutation.takeoverAllSessions
          if (mutation.takeoverAllSessions) {
            state.takeoverAllSessionsSince = now
            state.adoptAllSchedulesSince = now
          }
          if (prevFlag !== mutation.takeoverAllSessions) state.authVersion += 1
        }
        state.updatedAt = now
        nextVersion = state.authVersion
      }
      const nowAuthorized = isAuthorizedState(state)
      const nowTakeoverActive = isTakeoverActiveState(state)
      becameUnauthorized = wasAuthorized && !nowAuthorized
      becameAuthorized = !wasAuthorized && nowAuthorized
      becameTakeoverInactive = wasTakeoverActive && !nowTakeoverActive
      becameTakeoverActive = !wasTakeoverActive && nowTakeoverActive
      if (becameUnauthorized || (mutation.action === "revoke_all" && !nowAuthorized)) {
        // Preserve the earliest revocation cutoff when already unauthorized so a second revoke_all
        // never moves the window forward past runs that completed while unauthorized.
        state.lastRevokedAt ??= now
      } else if (becameAuthorized) {
        if (state.lastRevokedAt) {
          closedRevokedWindow = { from: state.lastRevokedAt, to: now, reason: "auth_revoked" }
          state.inactiveWindows = [...(state.inactiveWindows ?? []).slice(-49), closedRevokedWindow]
          delete state.lastRevokedAt
        }
        state.firstAuthorizedAt ??= now
        state.authorizedSince = now
      }
      if (becameTakeoverInactive || (mutation.takeoverAllSessions === false && !nowTakeoverActive) || (mutation.action === "revoke_all" && !nowTakeoverActive)) {
        state.takeoverStoppedAt ??= now
      } else if (becameTakeoverActive) {
        if (state.takeoverStoppedAt) {
          closedTakeoverWindow = { from: state.takeoverStoppedAt, to: now, reason: "takeover_stopped" }
          state.inactiveWindows = [...(state.inactiveWindows ?? []).slice(-49), closedTakeoverWindow]
          delete state.takeoverStoppedAt
        }
      }
    })

    let revocationReport: FollowUpAuthReceipt["revocationReport"]
    if (becameUnauthorized || becameTakeoverInactive || mutation.action === "revoke_all") {
      revocationReport = await this.#cleanupOnLastRevocation(uid, nextVersion, authorizedActor)
    } else if (becameTakeoverActive) {
      if (closedRevokedWindow) {
        await settleScheduleRunsFinishedWhileDisabled(this.#ctx, uid, undefined, closedRevokedWindow, now)
      }
      if (closedTakeoverWindow) {
        await settleScheduleRunsFinishedWhileDisabled(this.#ctx, uid, undefined, closedTakeoverWindow, now)
      }
      await this.#advanceCursorsAndCheckOpenTodosOnReenable(uid, now)
      await this.#reconcileTakeoverForUser(uid, now, { advanceExistingCursors: true })
    } else if (becameAuthorized && !this.isTakeoverEnabled(uid)) {
      // Authorized without unified takeover: keep existing inactive windows closed cleanly, do NOT auto-takeover!
      if (closedRevokedWindow) {
        await settleScheduleRunsFinishedWhileDisabled(this.#ctx, uid, undefined, closedRevokedWindow, now)
      }
    }
    if ((outcome as string) !== "stale_ignored" && mutation.adoptAllSchedules !== undefined && mutation.takeoverAllSessions === undefined && (mutation.action === "configure" || mutation.action === "enable")) {
      await this.setAdoptAllSchedules(mutation.adoptAllSchedules, authorizedActor)
    }
    const summary = this.authSummary(uid)
    return {
      status: outcome,
      authVersion: summary.authVersion,
      authorized: summary.authorized,
      activeDeviceCount: summary.activeDeviceCount,
      stoppedAllBackground: !summary.authorized,
      ...(revocationReport ? { revocationReport } : {}),
      summary,
    }
  }

  /**
   * When the last authorization is revoked:
   * 1. Abort all in-flight read-only analyses (late results are fenced by authVersion).
   * 2. Cancel unstarted/pending automated actions.
   * 3. For already-accepted pure-auto dispatches: withdraw queued input or safely cancel exclusive turn (`requireUnshared: true`).
   * 4. Preserve shared turns, completed actions, and native scheduled tasks untouched.
   */
  async #cleanupOnLastRevocation(userId: string, newAuthVersion: number, actor: AgentActor) {
    this.#metrics.revocationCleanups += 1
    let abortedAnalyses = 0
    let cancelledPendingActions = 0
    let withdrawnInputs = 0
    let cancelledTurns = 0
    let preservedSharedTurns = 0

    for (const [key, entry] of this.#workspaceTriage) {
      if (key.startsWith(`${userId}\0`)) {
        entry.controller.abort()
        abortedAnalyses += 1
      }
    }
    const clearedWorkspaces = new Set<string>()
    for (const key of [...this.#pendingRequests.keys()]) {
      if (key.startsWith(`["${userId}",`)) {
        this.#pendingRequests.delete(key)
        try {
          const parsed = JSON.parse(key) as [string, string]
          if (parsed[1]) clearedWorkspaces.add(parsed[1])
        } catch { /* ignore malformed key */ }
      }
    }
    for (const wid of clearedWorkspaces) this.#deps.onRoomChanged?.(userId, wid)

    const now = this.#nowIso()
    const PAGE_SIZE = 200
    for (const targetStatus of ["pending", "dispatched"] as const) {
      let cursor: { createdAt: string; id: string } | undefined
      const seenIds = new Set<string>()
      for (;;) {
        const page = await this.#deps.followUpStore.listActions(userId, targetStatus, PAGE_SIZE, cursor)
        if (!page.length) break
        for (const action of page) {
          if (seenIds.has(action.id)) continue
          seenIds.add(action.id)
          if (action.status === "pending") {
            await this.#deps.followUpStore.upsertAction({ ...action, status: "cancelled", authVersion: newAuthVersion, reason: "Authorization revoked before dispatch", updatedAt: now })
            cancelledPendingActions += 1
            continue
          }
          if (action.status === "dispatched" && action.sessionId && action.inputId) {
            try {
              const snapshot = await this.#deps.agents.journal.read(action.sessionId)
              const input = snapshot.inputs.find(item => item.id === action.inputId)
              if (input?.state === "pending") {
                await this.#deps.agents.handle("_deskfleet/input/withdraw", { sessionId: action.sessionId, inputId: input.id, operationId: randomUUID() }, actor)
                withdrawnInputs += 1
                await this.#deps.followUpStore.upsertAction({ ...action, status: "cancelled", authVersion: newAuthVersion, reason: "Withdrawn queued automated input on revocation", updatedAt: now })
                continue
              }
              const turn = input?.turnId
                ? snapshot.turns.find(t => t.id === input.turnId)
                : snapshot.turns.findLast(t => t.initialInputId === action.inputId)
              if (turn && activeTurn(turn)) {
                const shared = turnSteering(snapshot.inputs, turn.id)
                const ownership = inspectTurnOwnership(snapshot, turn.id, userId)
                if (shared || !ownership.isSaOrigin || snapshot.inputs.filter(i => i.turnId === turn.id || i.id === turn.initialInputId).length > 1) {
                  preservedSharedTurns += 1
                  await this.#deps.followUpStore.upsertAction({ ...action, status: "superseded", authVersion: newAuthVersion, reason: "Preserved shared turn containing human work", updatedAt: now })
                } else {
                  await this.#deps.agents.handle("_deskfleet/turn/cancel", { sessionId: action.sessionId, turnId: turn.id, operationId: randomUUID(), requireUnshared: true }, actor)
                  cancelledTurns += 1
                  await this.#deps.followUpStore.upsertAction({ ...action, status: "cancelled", authVersion: newAuthVersion, reason: "Cancelled exclusive automated turn on revocation", updatedAt: now })
                }
              } else {
                await this.#deps.followUpStore.upsertAction({ ...action, status: "completed", updatedAt: now })
              }
            } catch {
              // Best-effort cleanup; leave accurate state if session is unavailable.
            }
          }
        }
        if (page.length < PAGE_SIZE) break
        const last = page.at(-1)!
        cursor = { createdAt: last.createdAt, id: last.id }
      }
    }

    return { cancelledPendingActions, abortedAnalyses, withdrawnInputs, cancelledTurns, preservedSharedTurns }
  }

  /** Re-enabling skips historical replay during disabled time and checks once over still-open real pending requests. */
  async #advanceCursorsAndCheckOpenTodosOnReenable(
    userId: string,
    now = this.#nowIso(),
    revokedWindow?: FollowUpInactiveWindow,
  ): Promise<void> {
    if (revokedWindow) {
      await settleScheduleRunsFinishedWhileDisabled(this.#ctx, userId, undefined, revokedWindow, now)
    }
    const auth = this.#deps.followUpStore.getAuth(userId)
    const sources = this.#deps.followUpStore.listSources(userId)
    let hasDeferredPrePause = false
    for (const src of sources) {
      if (src.sourceKind === "schedule" && src.state.pausedReason === "awaiting_authorization" && !src.state.optedOut) {
        const inspected = this.#deps.schedules?.inspectTask(src.sourceId)
        if (!inspected || inspected.ownerUserId !== userId) continue
        if (src.state.deferredPrePauseRuns?.length) hasDeferredPrePause = true
        let closedPausedWindow: FollowUpInactiveWindow | undefined
        await this.#deps.followUpStore.updateSource(
          userId, src.workspaceId, "schedule", src.sourceId,
          () => src.state,
          state => {
            state.enabled = true
            state.optedOut = false
            delete state.pausedReason
            state.scheduleTitle = inspected.task.title
            state.scheduleVersion = inspected.version
            if (state.pausedAt) {
              closedPausedWindow = { from: state.pausedAt, to: now, reason: "schedule_paused" }
              state.inactiveWindows = [...(state.inactiveWindows ?? []).slice(-49), closedPausedWindow]
              delete state.pausedAt
            }
            state.firstSubscribedAt ??= state.subscribedAt ?? now
            state.subscribedAt = now
          },
        )
        if (closedPausedWindow) {
          await settleScheduleRunsFinishedWhileDisabled(this.#ctx, userId, src.sourceId, closedPausedWindow, now)
        }
        continue
      }
      if (src.sourceKind === "schedule" && src.state.enabled && !src.state.pausedReason) {
        if (src.state.deferredPrePauseRuns?.length) hasDeferredPrePause = true
        await this.#deps.followUpStore.updateSource(
          userId, src.workspaceId, "schedule", src.sourceId,
          () => src.state,
          state => {
            state.firstSubscribedAt ??= state.subscribedAt ?? now
            state.subscribedAt = now
          },
        )
        continue
      }
      if (src.sourceKind !== "session" || !src.state.enabled || src.state.pausedReason) continue
      try {
        const snapshot = await this.#deps.agents.journal.read(src.sourceId)
        await this.#deps.followUpStore.updateSource(
          userId, src.workspaceId, "session", src.sourceId,
          () => src.state,
          state => {
            state.cursorSeq = snapshot.session.lastEventSeq
            state.lastProgressSeq = snapshot.session.lastEventSeq
            state.lastProgressAt = now
            if (state.lastErrorKey?.startsWith("stall:")) {
              delete state.lastErrorKey
              delete state.lastErrorCount
            }
          },
        )
        await refreshSessionPendingRequests(this.#ctx, userId, src.workspaceId, src.sourceId, snapshot)
      } catch { /* session may be gone */ }
    }
    // If persistent global schedule takeover is enabled, attach any owned schedules created while unauthorized
    // that have not been explicitly opted out.
    if (auth?.adoptAllSchedules && this.#deps.schedules) {
      let allowedWorkspaces: Set<string> | undefined
      try { allowedWorkspaces = new Set((await this.#deps.workspaces(userId)).map(ws => ws.id)) }
      catch { allowedWorkspaces = undefined }
      for (const task of this.#deps.schedules.snapshot()) {
        if (allowedWorkspaces && !allowedWorkspaces.has(task.workspaceId)) continue
        const inspected = this.#deps.schedules.inspectTask(task.id)
        if (!inspected || inspected.ownerUserId !== userId) continue
        if (this.#deps.followUpStore.getSource(userId, task.workspaceId, "schedule", task.id)) continue
        await this.subscribeSchedule({
          userId,
          workspaceId: task.workspaceId,
          scheduleId: task.id,
          scheduleTitle: task.title,
          targetKind: task.target.kind === "existing" ? "existing" : task.target.context,
          deliveryPolicy: inferDefaultDeliveryPolicy(task.title, task.prompt),
          enabled: true,
          scheduleVersion: inspected.version,
        })
      }
    }
    if (hasDeferredPrePause) this.#triggerScheduleDrain()
  }

  /**
   * Unified persisted "Take over all scheduled tasks" / "Stop all schedule follow-up" mutation shared
   * by both the Settings page and SA main chat. Never touches ordinary sessions or native schedule
   * enabled/trigger/target settings, and strictly enforces per-user ownership and workspace scope.
   */
  async setAdoptAllSchedules(
    enabled: boolean,
    actor: AgentActor,
    options: { deliveryPolicy?: FollowUpDeliveryPolicy } = {},
  ): Promise<AdoptAllSchedulesResult> {
    if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and device are required")
    const uid = actor.userId
    const authorizedActor = await this.#deps.authorize(actor)
    const now = this.#nowIso()
    const authorized = this.isAuthorized(uid)
    let closedTakeoverWindow: FollowUpInactiveWindow | undefined
    let nextVersion = 0
    await this.#deps.followUpStore.updateAuth(uid, state => {
      state.adoptAllSchedules = enabled
      if (enabled) {
        state.adoptAllSchedulesSince = now
        if (isAuthorizedState(state)) {
          state.takeoverAllSessions = true
          state.takeoverAllSessionsSince = now
          if (state.takeoverStoppedAt) {
            closedTakeoverWindow = { from: state.takeoverStoppedAt, to: now, reason: "takeover_stopped" }
            state.inactiveWindows = [...(state.inactiveWindows ?? []).slice(-49), closedTakeoverWindow]
            delete state.takeoverStoppedAt
          }
        }
      } else {
        if (state.takeoverAllSessions === true) {
          state.authVersion += 1
          state.takeoverStoppedAt ??= now
        }
        state.takeoverAllSessions = false
      }
      state.updatedAt = now
      nextVersion = state.authVersion
    })

    let adoptedCount = 0
    let adoptedSessionCount = 0
    let awaitingAuthorizationCount = 0
    let preservedPreferenceCount = 0
    let stoppedCount = 0
    let skippedOtherOwnerCount = 0

    if (enabled) {
      if (closedTakeoverWindow) {
        await settleScheduleRunsFinishedWhileDisabled(this.#ctx, uid, undefined, closedTakeoverWindow, now)
      }
      if (authorized) {
        const reconciled = await this.#reconcileTakeoverForUser(uid, now, {
          deliveryPolicy: options.deliveryPolicy,
          advanceExistingCursors: true,
        })
        adoptedCount = reconciled.adoptedScheduleCount
        adoptedSessionCount = reconciled.adoptedSessionCount
        preservedPreferenceCount = reconciled.preservedPreferenceCount
        skippedOtherOwnerCount = reconciled.skippedOtherOwnerCount
      } else {
        const allowedWorkspaces = new Set((await this.#deps.workspaces(uid)).map(ws => ws.id))
        for (const task of this.#deps.schedules?.snapshot() ?? []) {
          if (!allowedWorkspaces.has(task.workspaceId)) continue
          const inspected = this.#deps.schedules?.inspectTask(task.id)
          if (!inspected) continue
          if (inspected.ownerUserId !== uid) {
            skippedOtherOwnerCount += 1
            continue
          }
          const existing = this.#deps.followUpStore.getSource(uid, task.workspaceId, "schedule", task.id)
          const deliveryPolicy = existing?.state.deliveryPolicy
            ?? options.deliveryPolicy
            ?? inferDefaultDeliveryPolicy(task.title, task.prompt)
          if (existing?.state.deliveryPolicy) preservedPreferenceCount += 1
          const targetKind = task.target.kind === "existing" ? "existing" : task.target.context
          await this.subscribeSchedule({
            userId: uid,
            workspaceId: task.workspaceId,
            scheduleId: task.id,
            scheduleTitle: task.title,
            targetKind,
            deliveryPolicy,
            enabled: false,
            awaitingAuthorization: true,
            scheduleVersion: inspected.version,
          })
          awaitingAuthorizationCount += 1
        }
      }
    } else {
      await this.#cleanupOnLastRevocation(uid, nextVersion, authorizedActor)
      const scheduleSources = this.#deps.followUpStore.listSources(uid).filter(s => s.sourceKind === "schedule")
      for (const src of scheduleSources) {
        if ((src.state.enabled && !src.state.pausedReason) || src.state.pausedReason === "awaiting_authorization") {
          await this.subscribeSchedule({
            userId: uid,
            workspaceId: src.workspaceId,
            scheduleId: src.sourceId,
            scheduleTitle: src.state.scheduleTitle ?? src.sourceId,
            targetKind: src.state.targetKind ?? "directory",
            deliveryPolicy: src.state.deliveryPolicy,
            enabled: false,
            scheduleVersion: src.state.scheduleVersion,
          })
          stoppedCount += 1
        }
      }
    }

    return {
      enabled,
      authorized,
      adoptedCount,
      adoptedSessionCount,
      awaitingAuthorizationCount,
      preservedPreferenceCount,
      stoppedCount,
      skippedOtherOwnerCount,
      summary: this.authSummary(uid),
    }
  }

  async subscribeSchedule(params: {
    userId: string
    workspaceId: string
    scheduleId: string
    scheduleTitle: string
    targetKind: "worktree" | "directory" | "existing"
    deliveryPolicy: FollowUpDeliveryPolicy
    enabled: boolean
    awaitingAuthorization?: boolean
    optOutOnCreate?: boolean
    reconfirmOwnership?: boolean
    scheduleVersion?: number
  }): Promise<FollowUpSourceRecord> {
    const now = this.#nowIso()
    const previous = this.#deps.followUpStore.getSource(params.userId, params.workspaceId, "schedule", params.scheduleId)
    const wasActive = !!previous && previous.state.enabled && !previous.state.pausedReason
    const stageAwaitingAuth = params.awaitingAuthorization === true
    let closedPausedWindow: FollowUpInactiveWindow | undefined
    const { record } = await this.#deps.followUpStore.updateSource(
      params.userId,
      params.workspaceId,
      "schedule",
      params.scheduleId,
      () => ({
        enabled: stageAwaitingAuth ? false : params.enabled,
        deliveryPolicy: params.deliveryPolicy,
        ownerUserId: params.userId,
        scheduleVersion: params.scheduleVersion ?? 1,
        scheduleTitle: params.scheduleTitle,
        targetKind: params.targetKind,
        ...(stageAwaitingAuth
          ? { pausedReason: "awaiting_authorization" as const, optedOut: false }
          : params.enabled
            ? { firstSubscribedAt: now, subscribedAt: now, optedOut: false }
            : { pausedReason: "user_stopped" as const, pausedAt: now, optedOut: true }),
      }),
      state => {
        state.deliveryPolicy = params.deliveryPolicy
        state.scheduleTitle = params.scheduleTitle
        state.targetKind = params.targetKind
        if (params.scheduleVersion !== undefined) state.scheduleVersion = params.scheduleVersion
        if (stageAwaitingAuth) {
          state.enabled = false
          state.pausedReason = "awaiting_authorization"
          state.optedOut = false
          return
        }
        state.enabled = params.enabled
        if (params.enabled) {
          state.optedOut = false
          state.firstSubscribedAt ??= state.subscribedAt ?? now
          if (!wasActive) {
            if (state.pausedAt) {
              closedPausedWindow = { from: state.pausedAt, to: now, reason: "schedule_paused" }
              state.inactiveWindows = [...(state.inactiveWindows ?? []).slice(-49), closedPausedWindow]
              delete state.pausedAt
            }
            state.subscribedAt = now
          } else {
            state.subscribedAt ??= now
          }
          if (params.reconfirmOwnership || state.pausedReason === "user_stopped" || state.pausedReason === "awaiting_authorization") {
            delete state.pausedReason
          }
        } else {
          if (params.optOutOnCreate) {
            state.pausedAt = now
            delete state.firstSubscribedAt
            delete state.subscribedAt
            delete state.deferredPrePauseRuns
          } else if (wasActive || (state.firstSubscribedAt && !state.pausedAt)) {
            state.pausedAt = now
          }
          state.pausedReason = "user_stopped"
          state.optedOut = true
        }
      },
    )
    if (closedPausedWindow && record.state.enabled && !record.state.pausedReason) {
      await settleScheduleRunsFinishedWhileDisabled(this.#ctx, params.userId, params.scheduleId, closedPausedWindow, now)
    }
    if (!wasActive && record.state.enabled && !record.state.pausedReason && record.state.deferredPrePauseRuns?.length) {
      this.#triggerScheduleDrain()
    }
    return record
  }

  async listSources(userId: string, workspaceId: SuperWorkspaceId, actor: AgentActor): Promise<FollowUpSourcesResponse> {
    const sources = this.#deps.followUpStore.listSources(userId, workspaceId ?? undefined)
    const subscribedScheduleIds = new Set(
      sources
        .filter(s => s.sourceKind === "schedule" && ((s.state.enabled && !s.state.pausedReason) || s.state.pausedReason === "awaiting_authorization"))
        .map(s => s.sourceId),
    )
    const subscribedSessionIds = new Set(sources.filter(s => s.sourceKind === "session" && s.state.enabled).map(s => s.sourceId))

    const adoptableSchedules: FollowUpSourcesResponse["adoptableSchedules"] = []
    for (const task of this.#deps.schedules?.snapshot() ?? []) {
      if (workspaceId !== null && task.workspaceId !== workspaceId) continue
      if (subscribedScheduleIds.has(task.id)) continue
      const inspected = this.#deps.schedules?.inspectTask(task.id)
      if (!inspected || inspected.ownerUserId !== userId) continue
      adoptableSchedules.push({
        id: task.id, title: task.title, workspaceId: task.workspaceId, enabled: task.enabled,
        nextRunAt: task.nextRunAt, targetKind: task.target.kind === "existing" ? "existing" : task.target.context,
      })
    }

    const adoptableSessions: FollowUpSourcesResponse["adoptableSessions"] = []
    for (const session of await this.#deps.agents.journal.list()) {
      if (!session.workspaceId) continue
      if (workspaceId !== null && session.workspaceId !== workspaceId) continue
      if (session.archiveState !== "active" || session.lifecycle !== "ready") continue
      if (subscribedSessionIds.has(session.id)) continue
      if (!await ownedByActor(this.#deps.agents, session.id, actor)) continue
      adoptableSessions.push({
        id: session.id, title: session.title, workspaceId: session.workspaceId,
        updatedAt: session.updatedAt, lastEventSeq: session.lastEventSeq,
      })
    }

    return {
      workspaceId,
      auth: this.authSummary(userId, workspaceId),
      sources,
      adoptableSchedules,
      adoptableSessions,
    }
  }

  async updateSource(request: FollowUpSourceUpdateRequest, actor: AgentActor): Promise<FollowUpSourceRecord> {
    if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and device are required")
    const uid = actor.userId
    await this.#deps.authorize(actor)
    const workspaces = await this.#deps.workspaces(uid)
    if (!workspaces.some(ws => ws.id === request.workspaceId)) throw new Error("Workspace not found in this registration")

    if (request.sourceKind === "schedule") {
      const inspected = this.#deps.schedules?.inspectTask(request.sourceId)
      if (!inspected || inspected.task.workspaceId !== request.workspaceId) throw new Error("Scheduled task was not found in this workspace")
      if (inspected.ownerUserId !== uid && inspected.createdByUserId !== uid) {
        this.#metrics.crossUserBlocked += 1
        throw new Error("Cannot subscribe to a schedule whose ownership cannot be verified for this user")
      }
      const existing = this.#deps.followUpStore.getSource(uid, request.workspaceId, "schedule", request.sourceId)
      const wasActive = !!existing && existing.state.enabled && !existing.state.pausedReason
      const enabled = request.enabled ?? (request.adopt ? true : existing?.state.enabled ?? true)
      const deliveryPolicy = request.deliveryPolicy ?? existing?.state.deliveryPolicy ?? inferDefaultDeliveryPolicy(inspected.task.title, inspected.task.prompt)
      const now = this.#nowIso()
      let closedPausedWindow: FollowUpInactiveWindow | undefined
      const { record } = await this.#deps.followUpStore.updateSource(
        uid, request.workspaceId, "schedule", request.sourceId,
        () => ({
          enabled, deliveryPolicy, ownerUserId: uid, scheduleVersion: inspected.version,
          scheduleTitle: inspected.task.title, targetKind: inspected.task.target.kind === "existing" ? "existing" : inspected.task.target.context,
          ...(enabled ? { firstSubscribedAt: now, subscribedAt: now } : { pausedAt: now }),
        }),
        state => {
          state.enabled = enabled
          state.deliveryPolicy = deliveryPolicy
          state.scheduleTitle = inspected.task.title
          state.scheduleVersion = inspected.version
          if (request.reconfirmOwnership || request.adopt) {
            state.ownerUserId = uid
            delete state.pausedReason
          }
          if (request.enabled === false) {
            if (wasActive || (state.firstSubscribedAt && !state.pausedAt)) state.pausedAt = now
            state.pausedReason = "user_stopped"
            state.optedOut = true
          } else if (enabled) {
            state.optedOut = false
            state.firstSubscribedAt ??= state.subscribedAt ?? now
            if (state.pausedReason === "user_stopped" || state.pausedReason === "awaiting_authorization") delete state.pausedReason
            if (!wasActive) {
              if (state.pausedAt) {
                closedPausedWindow = { from: state.pausedAt, to: now, reason: "schedule_paused" }
                state.inactiveWindows = [...(state.inactiveWindows ?? []).slice(-49), closedPausedWindow]
                delete state.pausedAt
              }
              state.subscribedAt = now
            } else {
              state.subscribedAt ??= now
            }
          }
          if (request.stopIssueKey) {
            state.stoppedIssueKeys = [...new Set([...(state.stoppedIssueKeys ?? []), request.stopIssueKey])]
          }
        },
      )
      if (closedPausedWindow && record.state.enabled && !record.state.pausedReason) {
        await settleScheduleRunsFinishedWhileDisabled(this.#ctx, uid, request.sourceId, closedPausedWindow, now)
      }
      if (!wasActive && record.state.enabled && !record.state.pausedReason && record.state.deferredPrePauseRuns?.length) {
        this.#triggerScheduleDrain()
      }
      return record
    }

    // Ordinary session source (supports both workspace-scoped and directory-attributed sessions)
    const snapshot = await this.#deps.agents.journal.read(request.sourceId)
    const matchedWorkspace = snapshot.session.workspaceId ?? await this.#resolveSessionWorkspace(uid, snapshot)
    if (matchedWorkspace !== request.workspaceId) throw new Error("Session does not belong to this workspace")
    if (!await ownedByActor(this.#deps.agents, request.sourceId, actor)) {
      this.#metrics.crossUserBlocked += 1
      throw new Error("Only sessions created or forked by you can be followed in your personal Super Agent")
    }
    const existing = this.#deps.followUpStore.getSource(uid, request.workspaceId, "session", request.sourceId)
    const wasActive = !!existing && existing.state.enabled && !existing.state.pausedReason
    const enabled = request.enabled ?? (request.adopt ? true : existing?.state.enabled ?? true)
    const now = this.#nowIso()
    const { record } = await this.#deps.followUpStore.updateSource(
      uid, request.workspaceId, "session", request.sourceId,
      () => ({
        enabled,
        deliveryPolicy: request.deliveryPolicy ?? "exceptions_only",
        cursorSeq: snapshot.session.lastEventSeq,
        ownerUserId: uid,
        scheduleTitle: snapshot.session.title,
        lastProgressSeq: snapshot.session.lastEventSeq,
        lastProgressAt: now,
      }),
      state => {
        state.enabled = enabled
        if (request.deliveryPolicy) state.deliveryPolicy = request.deliveryPolicy
        state.scheduleTitle = snapshot.session.title
        // When resuming a paused/stopped single ordinary session, advance the cursor past events that
        // happened while paused so old paused-period failures are never replayed on the next turn.
        if (!state.cursorSeq || (!wasActive && enabled)) {
          state.cursorSeq = snapshot.session.lastEventSeq
          state.lastProgressSeq = snapshot.session.lastEventSeq
          state.lastProgressAt = now
          if (state.lastErrorKey?.startsWith("stall:")) {
            delete state.lastErrorKey
            delete state.lastErrorCount
          }
        }
        if (request.enabled === false) { state.pausedReason = "user_stopped"; state.optedOut = true }
        else if (request.enabled === true || request.adopt) { state.optedOut = false; delete state.pausedReason }
        if (request.stopIssueKey) {
          state.stoppedIssueKeys = [...new Set([...(state.stoppedIssueKeys ?? []), request.stopIssueKey])]
        }
      },
    )
    if (record.state.enabled) {
      await refreshSessionPendingRequests(this.#ctx, uid, request.workspaceId, request.sourceId, snapshot)
    } else {
      clearSessionPendingRequests(this.#ctx, uid, request.workspaceId, request.sourceId)
    }
    return record
  }

  async getScheduleRun(userId: string, workspaceId: string, scheduleId: string, runId: string): Promise<FollowUpRunRecord | undefined> {
    const run = await this.#deps.followUpStore.getRun(userId, workspaceId, "schedule", scheduleId, `run:${runId}`)
    if (!run) return undefined
    if (run.sessionId) {
      const liveSessions = new Map((await this.#deps.agents.journal.list()).map(s => [s.id, s]))
      const live = liveSessions.get(run.sessionId)
      if (!live) run.evidenceAvailability = "deleted"
      else if (live.archiveState !== "active") run.evidenceAvailability = "archived"
      else if (run.evidenceAvailability !== "restricted" && run.evidenceAvailability !== "partial") run.evidenceAvailability = "available"
    }
    return run
  }

  async listRuns(params: {
    userId: string
    workspaceId?: string
    sourceKind?: FollowUpSourceKind
    sourceId?: string
    cursor?: { createdAt: string; id: string }
    limit?: number
  }): Promise<FollowUpRunsPage> {
    const page = await this.#deps.followUpStore.listRuns(params)
    const liveSessions = new Map((await this.#deps.agents.journal.list()).map(s => [s.id, s]))
    for (const run of page.runs) {
      if (!run.sessionId) continue
      const live = liveSessions.get(run.sessionId)
      if (!live) run.evidenceAvailability = "deleted"
      else if (live.archiveState !== "active") run.evidenceAvailability = "archived"
      else if (run.evidenceAvailability !== "restricted" && run.evidenceAvailability !== "partial") run.evidenceAvailability = "available"
    }
    return page
  }

  #triggerScheduleDrain(): void {
    if (this.#stop.signal.aborted || !this.#consumerEnabled) return
    if (this.#drainPromise) { this.#scheduleDrainDirty = true; return }
    this.#track(this.drainScheduleEvents())
  }

  /**
   * Two-store commit consumer:
   * 1. Reads unacknowledged private events from ScheduledTasks.
   * 2. Commits run records, source updates, and main-chat deliveries into SQLite.
   * 3. ONLY acknowledges events in ScheduledTasks after SQLite commits succeed.
   */
  async drainScheduleEvents(): Promise<void> {
    if (this.#stop.signal.aborted || !this.#consumerEnabled) return
    if (this.#drainPromise) {
      this.#scheduleDrainDirty = true
      await this.#drainPromise
      return
    }
    const run = this.#drainScheduleLoop()
    this.#drainPromise = run
    try { await run } finally {
      if (this.#drainPromise === run) this.#drainPromise = undefined
    }
  }

  async #drainScheduleLoop(): Promise<void> {
    let deferredAny = false
    do {
      this.#scheduleDrainDirty = false
      const events = this.#deps.schedules?.pendingPrivateEvents() ?? []
      if (!events.length) break
      const ackable: string[] = []
      let passDeferred = false
      for (const event of events) {
        if (this.#stop.signal.aborted || !this.#consumerEnabled) break
        try {
          const outcome = await processSchedulePrivateEvent(this.#ctx, event)
          if (outcome.ack) ackable.push(event.id)
          else passDeferred = true
        } catch (error) {
          passDeferred = true
          console.error("Failed to consume schedule private event:", event.id, error instanceof Error ? error.message : String(error))
        }
      }
      if (ackable.length && this.#deps.schedules) {
        await this.#deps.schedules.ackPrivateEvents(ackable)
      }
      if (passDeferred) {
        deferredAny = true
        // Stop tight-looping during transient outage; bounded backoff timer or reconnect wakeup will retry.
        break
      }
    } while (this.#scheduleDrainDirty && !this.#stop.signal.aborted && this.#consumerEnabled)
    if (!deferredAny) {
      const reconciledDeferred = await this.#reconcileScheduleStates()
      if (reconciledDeferred) deferredAny = true
    }
    if (deferredAny) {
      this.#scheduleDeferredRetry()
    } else {
      this.#clearDeferredRetry()
      this.#retryDelayMs = 0
    }
  }

  async #reconcileScheduleStates(): Promise<boolean> {
    return reconcileSubscribedScheduleStates(this.#ctx, () => this.#stop.signal.aborted || !this.#consumerEnabled)
  }

  async #runBoundedTriage<T>(userId: string, workspaceId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!this.#consumerEnabled || !this.isTakeoverActive(userId)) {
      return undefined
    }
    const key = `${userId}\0${workspaceId}`
    const prior = this.#workspaceTriage.get(key)
    if (prior) await prior.promise.catch(() => {})
    if (this.#stop.signal.aborted || !this.#consumerEnabled || !this.isTakeoverActive(userId)) return undefined
    if (this.#deps.isInteractiveBusy?.(userId, workspaceId)) {
      await new Promise(resolve => setTimeout(resolve, 25))
      if (this.#stop.signal.aborted || !this.#consumerEnabled || !this.isTakeoverActive(userId)) return undefined
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([this.#stop.signal, controller.signal])
    let result: T | undefined
    const promise = (async () => {
      result = await work(signal)
    })()
    this.#workspaceTriage.set(key, { controller, promise })
    try { await promise } finally {
      if (this.#workspaceTriage.get(key)?.controller === controller) this.#workspaceTriage.delete(key)
    }
    return result
  }

  #enqueueSessionWork(sessionId: string, work: () => Promise<void>): Promise<void> {
    const prior = this.#sessionQueues.get(sessionId) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(async () => {
      if (this.#stop.signal.aborted || !this.#consumerEnabled) return
      await work()
    })
    const tracked = next.finally(() => {
      if (this.#sessionQueues.get(sessionId) === tracked) this.#sessionQueues.delete(sessionId)
    })
    this.#sessionQueues.set(sessionId, tracked)
    return this.#track(tracked)
  }

  #onAgentEvent(event: AgentEvent): void {
    this.#sessionLastSeq.set(event.sessionId, event.seq)
    if (event.kind !== "command") {
      this.#sessionLastActivityAt.set(event.sessionId, this.#now().getTime())
    }
    if (this.#stop.signal.aborted || !this.#consumerEnabled) return
    // Ignore streaming token chunks and command audit noise; wake only on meaningful state transitions.
    if (event.kind === "acp" || event.kind === "command") return
    void this.#enqueueSessionWork(event.sessionId, async () => {
      await handleOrdinarySessionEvent(this.#ctx, event)
    })
  }

  async #reconcileSubscribedSessions(): Promise<void> {
    if (!this.#consumerEnabled) return
    const sources = this.#deps.followUpStore.listSources().filter(src => src.sourceKind === "session" && src.state.enabled && !src.state.pausedReason)
    for (const src of sources) {
      if (!this.isTakeoverActive(src.userId)) continue
      try {
        const snapshot = await this.#deps.agents.journal.read(src.sourceId)
        const resolved = await this.#resolveSessionWorkspace(src.userId, snapshot)
        if (!resolved) {
          clearSessionPendingRequests(this.#ctx, src.userId, src.workspaceId, src.sourceId)
          continue
        }
        let effectiveWorkspaceId = src.workspaceId
        if (resolved !== src.workspaceId) {
          await migrateSessionSourceWorkspace(this.#ctx, src.userId, src.workspaceId, resolved, src.sourceId, snapshot, src.state)
          effectiveWorkspaceId = resolved
        }
        await processSubscribedSession(this.#ctx, src.userId, effectiveWorkspaceId, src.sourceId, snapshot)
      } catch (error) {
        if (classifyJournalReadError(error) === "not_found") {
          clearSessionPendingRequests(this.#ctx, src.userId, src.workspaceId, src.sourceId)
        }
      }
    }
    // Also restore pending approval/question cards for active scheduled runs across restarts.
    const activeScheduleSessions = new Set<string>()
    for (const task of this.#deps.schedules?.snapshot() ?? []) {
      for (const run of task.runs) {
        if ((run.state === "running" || run.state === "claimed") && run.sessionId) {
          activeScheduleSessions.add(run.sessionId)
        }
      }
    }
    for (const sessionId of activeScheduleSessions) {
      await syncScheduleSessionRequests(this.#ctx, sessionId)
    }
  }
}
