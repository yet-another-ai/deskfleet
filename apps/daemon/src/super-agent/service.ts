import { organizeHistory, projectWorkers } from "./history.ts"
import type { CatalogSnapshot } from "@deskfleet/native"
import type { SuperHistory } from "@deskfleet/protocol/super-agent"
import { effectiveCoordinatorProfile, validateCoordinatorProfile } from "./profiles.ts"
import { assertAttachmentBudget, attachmentInfo, previewSuperAttachments, superAttachments, type SuperAttachment, type SuperAttachmentStore } from "./attachments.ts"
import { aborted, isDeepStrictEqual } from "node:util"
import { composerSkillText } from "@deskfleet/protocol/composer-reference"
import { selectedReferences, selectedSkills, workspaceMentions, workspaceReferenceEvidence } from "./mentions.ts"
import { randomUUID } from "node:crypto"
import { executeGit, GitPolicyError } from "../git/execution.ts"
import { parseWorkerReference } from "@deskfleet/client/worker-reference"
import { HistoricalSessionUnavailable, inspectHistoricalWorker, resolveWorkerTarget, type WorkerRegistration } from "./target.ts"
import type { AgentActor, AgentReceipt, AgentSessionRecord } from "@deskfleet/protocol/agent"
import type { AgentConfiguration } from "@deskfleet/protocol/agent-configuration"
import { createSuperEvidence, superHistoryExcerpt } from "./evidence.ts"
import { allowsStoppedResume, attachedKeys, frontendContext, quotedAttachmentSource, stoppedTicketContinuationError, ticketOfQuote, routeSuperMessage, type SuperDecisionModel, type SuperRouteResult } from "./router.ts"
import { computeSaWorkspaceSummary, isConfirmedStoppedTurn, isValidAccentSlot, mergeSaMarkerRef, parseSuperCreateTicket, parseSuperLinkMessage, parseSuperMarkRead, parseSuperReusedAttachments, superRequestObject as object, superResourceId as identifier, parseSuperCommandTarget as commandTarget, superMessageText as text, superWorkerCommandName, superWorkerCommandTarget, type SuperCoordinatorOptions, type SuperCoordinatorPhase, type SuperHistorySource, type SuperMachineSummary, type SuperSend, type SuperSnapshot, type SuperWorkerRequest, type SuperWorkspaceId, type SuperWorkspaceSummary } from "@deskfleet/protocol/super-agent"
import { bumpVisibleSeq, dispatchRecovery, emptyState, errorText, missingCoordinatorProvider, missingWorkerProvider, note, publicRoom, roomFor, STOP_UNCONFIRMED_MS, superTaskText, userFocus, visibleStopState, type DispatchIntent, type StoredSuperTicket, type SuperRoom, type SuperStateStore, type SuperUserState } from "./state.ts"
import { adhdCommand } from "@deskfleet/protocol/adhd-command"
import { activeTurn, deliverSuperIntent, ownedPendingRequests, projectSuperEvents, resolveWorkingIntentInputs, syncTicketSnapshotStatus, type SuperEventProjectionFeedback, type SuperWorkers } from "./worker.ts"
import { routeWorkerCommand, sameCommandTarget } from "./command.ts"
import { observeWorkerInputs, requestWorkspaceStop, stopWorkspaceDispatch, withdrawDispatch } from "./stop.ts"
import { leaveArchivedTicket, roomWithArchives, ticketLifecycle } from "./archive.ts"
import { allocateTicketAccent, backfillRoomTicketAccents, recordRoomRecentTicketAccent, releaseTicketAccentOccupancy, restoreTicketAccentOccupancy, roomNeedsTicketAccentBackfill, syncRoomAccentOccupancy } from "./accent.ts"
import { appendMessageTicketLinks, expandEditableMessageGroup, isFoldedOperationMessage, resolveCreateDiscussionLinks, resolveRoomMessageLinks, setMessageTicketLinks } from "./message-links.ts"
import { archivedTicketError, type FollowUpAuthReceipt, type FollowUpRunsPage, type FollowUpSourceRecord, type FollowUpSourcesResponse, type SuperFeedbackItem, type SuperFeedbackProcessResult, type SuperFeedbackPush, type SuperFeedbackSubscribeResult, type SuperWorkerReportReceipt } from "@deskfleet/protocol/super-agent"
import { parseFollowUpAuthMutation, parseFollowUpSourceUpdate, type FollowUpAuthMutation, type FollowUpAuthSummary, type FollowUpSourceKind, type FollowUpSourceUpdateRequest } from "@deskfleet/protocol/super-agent-follow-up"
export interface SuperFollowUpHost {
  pendingRequestsForWorkspace(userId: string, workspaceId: SuperWorkspaceId): (SuperWorkerRequest & { ticketId: string; sourceKind?: FollowUpSourceKind; sourceId?: string; sourceTitle?: string })[]
  authSummary(userId: string, workspaceId?: SuperWorkspaceId): FollowUpAuthSummary
  isTakeoverActive(userId: string): boolean
  syncWorkspaceTakeover(userId: string, workspaceId: SuperWorkspaceId): Promise<void>
  handleAuth(mutation: FollowUpAuthMutation, actor: AgentActor): Promise<FollowUpAuthReceipt>
  listSources(userId: string, workspaceId: SuperWorkspaceId, actor: AgentActor): Promise<FollowUpSourcesResponse>
  updateSource(update: FollowUpSourceUpdateRequest, actor: AgentActor): Promise<FollowUpSourceRecord>
  listRuns(params: { userId: string; workspaceId?: SuperWorkspaceId; sourceKind?: FollowUpSourceKind; sourceId?: string; cursor?: { createdAt: string; id: string }; limit?: number }): Promise<FollowUpRunsPage>
}
import { executeSuperScheduleAction, validTimeZone, type ScheduleCommandHost, type ScheduleExecutionResult } from "./schedule.ts"
import { inspectScheduleRunsWithEvidence } from "./schedule-evidence.ts"
import { parseSuperFeedbackProcess, parseSuperFeedbackSubscribe } from "./feedback-helpers.ts"
import { persistRoomFeedbackItem, persistRoomProcessBranch, reconstructRequestProcess, SuperFeedbackHub } from "./feedback.ts"
import { WorkerFeedbackAttribution } from "./feedback-attribution.ts"
import { createCoordinatorPublicPublisher, handleWorkerFeedbackReport, observeLiveWorkerAcpEvent, observeLiveWorkerPreview, publishProjectedWorkerFeedback, reconcilePendingWorkerFeedback, recordAppliedRouteFeedback } from "./feedback-service.ts"

export type { SuperUserState } from "./state.ts"
import type { SuperWorkspace } from "@deskfleet/protocol/super-agent"
interface Dependencies {
  historyCatalog?: () => Promise<CatalogSnapshot>
  historyChanged?: () => void
  agents: SuperWorkers
  followUp?: SuperFollowUpHost
  schedules?: ScheduleCommandHost
  registration?: () => WorkerRegistration | undefined
  attachments?: SuperAttachmentStore
  defaultCoordinator?: string
  coordinatorOptions: (id: string, model?: string) => Promise<SuperCoordinatorOptions>
  coordinatorModel: (id: string) => SuperDecisionModel
  store: SuperStateStore
  authorize: (actor: AgentActor) => Promise<AgentActor>
  workspaces: (userId: string, includeDefaultWorker?: boolean) => Promise<SuperWorkspace[]>
  providers: () => { id: string; name: string; template?: string }[]
  ensureDefaultWorkspace: (userId: string) => Promise<string>
  route?: typeof routeSuperMessage
  /** Feature/rollback toggle for real-time main-conversation feedback; defaults to enabled unless DESKFLEET_DISABLE_REPLY_FEEDBACK=1. */
  enableReplyFeedback?: boolean
  /** Override stop confirmation timeout before emitting snapshot_dirty for unconfirmed stops (default 15s). */
  stopUnconfirmedMs?: number
}

interface ActiveRoute {
  controller: AbortController
  revision?: number
  phase: SuperCoordinatorPhase
}

function knownWorkspace(catalog: SuperWorkspace[], id: string): SuperWorkspace {
  const project = catalog.find(item => item.id === id)
  if (!project) throw new Error("Workspace not found in this registration")
  return project
}
function bindWorker(room: SuperRoom, ticket: SuperRoom["tickets"][number], session: AgentSessionRecord) {
  if (ticket.sessionId && ticket.sessionId !== session.id) throw new Error("The ticket already has a different worker")
  ticket.sessionId = session.id
  ticket.lastEventSeq ??= session.lastEventSeq
  for (const message of room.messages) if (message.ticketId === ticket.id && !message.sessionId) message.sessionId = session.id
}
/** A personal front desk inside an existing authenticated machine registration. Workers retain their normal lifecycle. */
export class SuperAgentService {
  readonly #deps: Dependencies
  readonly #queues = new Map<string, Promise<void>>()
  readonly #live = new Set<Promise<void>>()
  readonly #watchers = new Map<string, Set<string>>()
  readonly #workerSessions = new Map<string, AgentSessionRecord>()
  readonly #replays = new Map<string, { dirty: boolean }>()
  readonly #pendingRequests = new Map<string, { ticketId: string; requests: SuperWorkerRequest[] }>()
  readonly #failedReplays = new Set<string>()
  readonly #stop = new AbortController()
  readonly #routes = new Map<string, ActiveRoute>()
  readonly #stopTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #feedback = new SuperFeedbackHub()
  readonly #attribution = new WorkerFeedbackAttribution()
  #unsubscribe?: () => void
  #unsubscribePreview?: () => void
  constructor(deps: Dependencies) { this.#deps = deps }

  get feedbackEnabled(): boolean {
    return this.#deps.enableReplyFeedback ?? process.env.DESKFLEET_DISABLE_REPLY_FEEDBACK !== "1"
  }
  feedbackMetrics() { return this.#feedback.metrics() }
  notifySnapshotDirty(userId: string, workspaceId: SuperWorkspaceId, sourceMessageId?: string) {
    this.#feedback.notifySnapshotDirty(userId, workspaceId, sourceMessageId)
  }
  #stopUnconfirmedMs(): number {
    return this.#deps.stopUnconfirmedMs ?? STOP_UNCONFIRMED_MS
  }
  #clearStopTimers(uid: string, intentId: string) {
    const prefix = JSON.stringify([uid, intentId]).slice(0, -1) + ","
    for (const [key, timer] of this.#stopTimers) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer)
        this.#stopTimers.delete(key)
      }
    }
  }
  #scheduleStopTimeout(uid: string, intent: DispatchIntent) {
    if (this.#stop.signal.aborted || !intent.stop || intent.stop.state !== "stopping") return
    const timeoutMs = this.#stopUnconfirmedMs()
    const timerKey = JSON.stringify([uid, intent.id, intent.stop.cancelId])
    if (this.#stopTimers.has(timerKey)) return
    const remaining = Math.max(0, intent.stop.requestedAt + timeoutMs + 1 - Date.now())
    const timer = setTimeout(() => {
      this.#stopTimers.delete(timerKey)
      if (this.#stop.signal.aborted) return
      const live = this.#deps.store.get(uid)?.intents.find(item => item.id === intent.id)
      if (!live?.stop || live.stop.cancelId !== intent.stop!.cancelId) return
      if (visibleStopState(live.stop, timeoutMs) === "unconfirmed") {
        this.#feedback.notifySnapshotDirty(uid, live.roomId, live.messageId)
      }
    }, remaining)
    timer.unref()
    this.#stopTimers.set(timerKey, timer)
  }
  #extraDelegatedCompletedSeqs(room: SuperRoom): Record<string, string> {
    const seqs: Record<string, string> = {}
    for (const ticket of room.tickets) {
      if (!ticket.sessionId || !ticket.lastDeliveredSeq) continue
      const existing = seqs[ticket.sessionId]
      try {
        if (!existing || BigInt(ticket.lastDeliveredSeq) > BigInt(existing)) seqs[ticket.sessionId] = ticket.lastDeliveredSeq
      } catch {
        seqs[ticket.sessionId] = ticket.lastDeliveredSeq
      }
    }
    return seqs
  }
  #workspacePendingRequests(uid: string, workspaceId: SuperWorkspaceId, room: SuperRoom) {
    const requests = room.tickets.flatMap(ticket => {
      const pending = !ticket.archiveState && ticket.sessionId && this.#pendingRequests.get(JSON.stringify([uid, ticket.sessionId]))
      return pending && pending.ticketId === ticket.id ? pending.requests.map(request => ({ ...request, ticketId: ticket.id })) : []
    })
    if (this.#deps.followUp) {
      const seen = new Set(requests.map(r => JSON.stringify([r.item.sessionId, r.kind, r.item.id])))
      for (const extra of this.#deps.followUp.pendingRequestsForWorkspace(uid, workspaceId)) {
        const key = JSON.stringify([extra.item.sessionId, extra.kind, extra.item.id])
        if (!seen.has(key)) { seen.add(key); requests.push(extra) }
      }
    }
    return requests
  }
  #workspaceSummary(uid: string, workspaceId: SuperWorkspaceId, state: SuperUserState | undefined): SuperWorkspaceSummary {
    const room = roomWithArchives(state?.rooms.find(item => item.workspaceId === workspaceId) ?? roomFor(emptyState(), workspaceId), this.#workerSessions)
    const intents = state?.intents ?? []
    const pub = publicRoom(room, undefined, "", intents, undefined, this.#stopUnconfirmedMs())
    const pendingRequests = this.#workspacePendingRequests(uid, workspaceId, room)
    const activeIntents = intents.filter(intent => intent.roomId === workspaceId && intent.phase !== "withdrawn")
    return computeSaWorkspaceSummary({
      workspaceId,
      messages: pub.messages,
      tickets: pub.tickets,
      pendingRequests,
      lastRead: room.lastRead,
      readErrorKeys: room.readErrorKeys,
      activeIntents,
      extraDelegatedCompletedSeqs: this.#extraDelegatedCompletedSeqs(room),
    })
  }
  async #summary(uid: string): Promise<SuperMachineSummary> {
    const state = this.#deps.store.get(uid)
    const visibleWorkspaces = await this.#deps.workspaces(uid)
    const allWorkspaces = await this.#deps.workspaces(uid, true)
    const visibleIds = new Set(visibleWorkspaces.map(w => w.id))
    const privateWorkspaceId = allWorkspaces.find(w => !visibleIds.has(w.id))?.id
    const workspaceIds: SuperWorkspaceId[] = [null, ...visibleWorkspaces.map(w => w.id)]
    return {
      workspaces: workspaceIds.map(wid => this.#workspaceSummary(uid, wid, state)),
      ...(privateWorkspaceId ? { privateWorkspaceId } : {}),
      generatedAt: new Date().toISOString(),
    }
  }
  isSaWorkerSession(sessionId: string, creationOperationId?: string): boolean {
    if (this.#watchers.has(sessionId)) return true
    for (const uid of this.#deps.store.users()) {
      const state = this.#deps.store.get(uid)
      if (!state) continue
      if (state.rooms.some(r => r.tickets.some(t => t.sessionId === sessionId))) return true
      if (creationOperationId && state.intents.some(i => i.createId === creationOperationId && i.phase !== "withdrawn")) return true
    }
    return false
  }
  async subscribeFeedback(value: unknown, actor: AgentActor, push: (event: SuperFeedbackPush) => void): Promise<{ initial: SuperFeedbackSubscribeResult; unsubscribe: () => void }> {
    if (this.#stop.signal.aborted) throw new Error("Workspace agent is stopping")
    if (!this.feedbackEnabled) throw new Error("Reply feedback is unavailable on this host")
    if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and device are required")
    const parsed = parseSuperFeedbackSubscribe(value)
    if (parsed.workspaceId !== null) knownWorkspace(await this.#deps.workspaces(actor.userId), parsed.workspaceId)
    return this.#feedback.subscribe(actor.userId, parsed.workspaceId, parsed, push)
  }
  async reportFromWorker(sessionId: string, value: unknown, actor: AgentActor): Promise<SuperWorkerReportReceipt> {
    if (this.#stop.signal.aborted) throw new Error("Workspace agent is stopping")
    const workers = await projectWorkers(this.#deps, actor.userId ?? "")
    return handleWorkerFeedbackReport({ sessionId, value, actor, workers, getState: uid => this.#deps.store.get(uid), transaction: (uid, edit) => this.#transaction(uid, edit), hub: this.#feedback, attribution: this.#attribution })
  }
  #reconcileFeedback(sessionId: string, filterUid?: string) {
    for (const uid of reconcilePendingWorkerFeedback({ sessionId, filterUid, sessions: this.#workerSessions, getState: id => this.#deps.store.get(id), hub: this.#feedback, attribution: this.#attribution })) this.#replay(uid, sessionId)
  }

  #coordinator(state: SuperUserState | undefined, configured = this.#deps.providers()) {
    if (state?.coordinatorProviderId !== undefined) return configured.find(provider => provider.id === state.coordinatorProviderId)
    const preferred = configured.filter(provider => (provider.template ?? provider.id) === this.#deps.defaultCoordinator)
    return preferred.length === 1 ? preferred[0] : configured.length === 1 ? configured[0] : undefined
  }
  #transaction<R>(uid: string, edit: (state: SuperUserState) => R) {
    return this.#deps.store.update(uid, () => ({ ...emptyState(), coordinatorProviderId: this.#coordinator(undefined)?.id }), edit)
  }
  #room(uid: string, workspaceId: SuperWorkspaceId) {
    const room = this.#deps.store.get(uid)?.rooms.find(room => room.workspaceId === workspaceId)
      ?? roomFor(emptyState(), workspaceId, this.#deps.providers()[0]?.id || "")
    return roomWithArchives(room, this.#workerSessions)
  }
  #defaultProvider(room: SuperRoom) {
    const configured = this.#deps.providers()
    return configured.find(p => p.id === room.provider)?.id || configured[0]?.id || ""
  }
  async #snapshot(uid: string, workspaceId: SuperWorkspaceId) {
    let state = this.#deps.store.get(uid)
    const storedRoom = state?.rooms.find(item => item.workspaceId === workspaceId)
    if (storedRoom && roomNeedsTicketAccentBackfill(storedRoom)) {
      await this.#transaction(uid, saved => {
        const target = saved.rooms.find(item => item.workspaceId === workspaceId)
        if (target) backfillRoomTicketAccents(target, this.#workerSessions)
      })
      state = this.#deps.store.get(uid)
    }
    const room = roomWithArchives(state?.rooms.find(item => item.workspaceId === workspaceId) ?? roomFor(emptyState(), workspaceId), this.#workerSessions)
    const providers = this.#deps.providers()
    const coordinator = this.#coordinator(state, providers)
    const snapshot = publicRoom(room, coordinator?.id, this.#defaultProvider(room), state?.intents ?? [], message => {
      const route = this.#routes.get(JSON.stringify([uid, message.id]))
      return route && route.revision === message.revision ? route.phase : undefined
    }, this.#stopUnconfirmedMs())
    snapshot.pendingRequests = this.#workspacePendingRequests(uid, workspaceId, room)
    const delegatedCompletedSeqs = computeSaWorkspaceSummary({
      workspaceId,
      messages: snapshot.messages,
      tickets: snapshot.tickets,
      extraDelegatedCompletedSeqs: this.#extraDelegatedCompletedSeqs(room),
    }).delegatedCompletedSeqs
    if (Object.keys(delegatedCompletedSeqs).length) snapshot.delegatedCompletedSeqs = delegatedCompletedSeqs
    if (this.#deps.followUp) {
      snapshot.followUp = this.#deps.followUp.authSummary(uid, workspaceId)
      if (workspaceId !== null) {
        try {
          const runsPage = await this.#deps.followUp.listRuns({ userId: uid, workspaceId, limit: 50 })
          snapshot.followUpRuns = runsPage.runs
          if (runsPage.nextCursor) snapshot.followUpRunsCursor = runsPage.nextCursor
        } catch {
          // Non-fatal: older/test stubs may omit listRuns; snapshot still returns normally.
        }
      }
    }
    if (coordinator) {
      snapshot.coordinatorOverrides = state?.coordinatorOverrides?.[coordinator.id] ?? {}
      snapshot.coordinatorOptions = await this.#deps.coordinatorOptions(coordinator.id, snapshot.coordinatorOverrides.model)
      snapshot.coordinatorSelection = effectiveCoordinatorProfile(coordinator.template ?? coordinator.id, snapshot.coordinatorOverrides, snapshot.coordinatorOptions)
      const measurement = room.coordinatorMeasurement
      if (measurement && measurement.coordinator === coordinator.id && measurement.selection.model === snapshot.coordinatorSelection.model
        && measurement.selection.reasoningEffort === snapshot.coordinatorSelection.reasoningEffort) snapshot.coordinatorUsage = measurement.usage
    }
    snapshot.supportsWorkerReferences = true
    snapshot.supportsWorkerCommands = true
    snapshot.supportsAdhdSkill = true
    snapshot.supportsStop = true
    snapshot.supportsStoppedReEdit = true
    snapshot.supportsTicketArchive = true
    snapshot.supportsTicketLinks = true
    snapshot.supportsComposerMentions = true
    if (this.feedbackEnabled) {
      snapshot.supportsReplyFeedback = true
      snapshot.feedback = this.#feedback.snapshot(uid, room)
    }
    snapshot.supportsProactiveFollowUp = !!this.#deps.followUp
    snapshot.supportsScheduleCommands = !!this.#deps.schedules
    snapshot.supportsAttachmentPreviews = !!this.#deps.attachments
    snapshot.supportsAttachments = !!this.#deps.attachments
    snapshot.workerProviders = providers.map(({ id, name }) => ({ id, name }))
    // Older clients consume these fields separately. Registration grants both roles.
    snapshot.coordinatorProviders = snapshot.workerProviders
    return snapshot
  }

  /** True while a foreground interactive user message is actively routing in this workspace. */
  isInteractiveBusy(userId: string, workspaceId: SuperWorkspaceId): boolean {
    const room = this.#deps.store.get(userId)?.rooms.find(r => r.workspaceId === workspaceId)
    if (!room) return false
    return room.messages.some(m => m.role === "user" && m.state === "routing" && this.#routes.has(JSON.stringify([userId, m.id])))
  }

  /** Inspect SA delegation context for a Worker session (used by MCP schedule bridge to avoid duplicate creates). */
  workerDelegationForSession(sessionId: string): { userId: string; workspaceId: SuperWorkspaceId; sourceMessageId: string; hasNativeScheduleId?: string } | undefined {
    for (const uid of this.#deps.store.users()) {
      const state = this.#deps.store.get(uid)
      if (!state) continue
      const intent = state.intents.findLast(item => item.sessionId === sessionId)
      if (!intent) continue
      const room = state.rooms.find(r => r.workspaceId === intent.roomId)
      const nativeSchedule = room?.messages.findLast(m => m.sourceMessageId === intent.messageId && m.provenance?.origin === "schedule_receipt" && m.provenance.scheduleId)
      return {
        userId: uid,
        workspaceId: intent.roomId,
        sourceMessageId: intent.messageId,
        ...(nativeSchedule?.provenance?.scheduleId ? { hasNativeScheduleId: nativeSchedule.provenance.scheduleId } : {}),
      }
    }
    return undefined
  }
  #track(job: Promise<void>) {
    this.#live.add(job)
    void job.catch(error => console.error("Workspace agent:", errorText(error))).finally(() => this.#live.delete(job))
  }
  #queue(key: string, fn: () => Promise<void>) {
    const next = (this.#queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => { if (!this.#stop.signal.aborted) await fn() })
    this.#queues.set(key, next)
    this.#track(next.finally(() => { if (this.#queues.get(key) === next) this.#queues.delete(key) }))
  }
  #watch(uid: string, sessionId: string) {
    const users = this.#watchers.get(sessionId) || new Set<string>()
    users.add(uid); this.#watchers.set(sessionId, users)
  }
  async init() {
    this.#unsubscribe = this.#deps.agents.onEvent(event => {
      if (event.kind === "command") return
      this.#attribution.observeEvent(event)
      if (event.kind === "acp") {
        const watchers = this.#watchers.get(event.sessionId)
        if (!watchers?.size) return
        for (const uid of observeLiveWorkerAcpEvent({ event, watchers, sessions: this.#workerSessions, getState: id => this.#deps.store.get(id), hub: this.#feedback, attribution: this.#attribution })) this.#replay(uid, event.sessionId)
        return
      }
      if (event.kind === "turn" || event.kind === "input") this.#reconcileFeedback(event.sessionId)
      if (event.kind === "session") {
        const session = event.payload as AgentSessionRecord
        const previous = this.#workerSessions.get(session.id)
        this.#workerSessions.set(session.id, session)
        if (session.archiveState !== "active" && previous?.archiveState === "active") {
          for (const uid of this.#watchers.get(session.id) ?? []) this.#track(this.#transaction(uid, state => {
            const changedRooms: SuperWorkspaceId[] = []
            for (const room of state.rooms) {
              const ticket = room.tickets.find(item => item.sessionId === session.id)
              if (ticket) {
                leaveArchivedTicket(state, room, ticket.id)
                releaseTicketAccentOccupancy(room, ticket)
                changedRooms.push(room.workspaceId)
              }
            }
            return changedRooms
          }).then(changedRooms => {
            for (const wid of changedRooms) this.#feedback.notifySnapshotDirty(uid, wid)
          }))
        } else if (session.archiveState === "active" && previous && previous.archiveState !== "active") {
          for (const uid of this.#watchers.get(session.id) ?? []) this.#track(this.#transaction(uid, state => {
            const changedRooms: SuperWorkspaceId[] = []
            for (const room of state.rooms) {
              const ticket = room.tickets.find(item => item.sessionId === session.id)
              if (ticket && restoreTicketAccentOccupancy(room, ticket)) {
                changedRooms.push(room.workspaceId)
              }
            }
            return changedRooms
          }).then(changedRooms => {
            for (const wid of changedRooms) this.#feedback.notifySnapshotDirty(uid, wid)
          }))
        }
      }
      for (const uid of this.#watchers.get(event.sessionId) || []) this.#replay(uid, event.sessionId)
    })
    this.#unsubscribePreview = this.#deps.agents.onPreview?.(preview => {
      const watchers = this.#watchers.get(preview.sessionId)
      if (!watchers?.size) return
      observeLiveWorkerPreview({ preview, watchers, sessions: this.#workerSessions, getState: id => this.#deps.store.get(id), hub: this.#feedback, attribution: this.#attribution })
    })
    for (const session of await this.#deps.agents.journal.list()) {
      if (!this.#workerSessions.has(session.id)) this.#workerSessions.set(session.id, session)
    }
    for (const uid of this.#deps.store.users()) {
      let state = this.#deps.store.get(uid)
      if (!state) continue
      // A Worker may have been archived or restored from the regular UI while this front desk was offline.
      const inactive = state.rooms.flatMap(room => room.tickets.filter(ticket => ticketLifecycle(ticket, this.#workerSessions).archiveState
        && (room.focusTicketId === ticket.id || room.pendingQuestion?.ticketId === ticket.id || room.recentTicketIds.includes(ticket.id)
          || state!.intents.some(intent => intent.ticketId === ticket.id && !intent.stop && (intent.phase === "planned" || intent.phase === "working"))))
        .map(ticket => ({ workspaceId: room.workspaceId, ticketId: ticket.id })))
      const needsAccentSync = state.rooms.some(room =>
        roomNeedsTicketAccentBackfill(room)
        || room.tickets.some(ticket => {
          if (!isValidAccentSlot(ticket.accentSlot)) return false
          const archived = Boolean(ticketLifecycle(ticket, this.#workerSessions).archiveState)
          return archived ? ticket.accentCounted !== false : ticket.accentCounted === false
        }))
      if (inactive.length || needsAccentSync) {
        await this.#transaction(uid, saved => {
          for (const { workspaceId, ticketId } of inactive) leaveArchivedTicket(saved, roomFor(saved, workspaceId), ticketId)
          for (const room of saved.rooms) {
            backfillRoomTicketAccents(room, this.#workerSessions)
            syncRoomAccentOccupancy(room, this.#workerSessions)
          }
        })
        state = this.#deps.store.get(uid)!
      }
      for (const room of state.rooms) {
        for (const ticket of room.tickets) if (ticket.sessionId) {
          this.#watch(uid, ticket.sessionId)
          if (ticketLifecycle(ticket, this.#workerSessions).workerContext) this.#replay(uid, ticket.sessionId)
        }
        for (const message of room.messages) if (message.role === "user" && message.state === "routing") this.#scheduleRoute(uid, room.workspaceId, message.id)
      }
      for (const intent of state.intents) {
        if (intent.stop) {
          if (intent.stop.state === "stopping") this.#scheduleStopTimeout(uid, intent)
          if (intent.stop.state === "stopping" || intent.stop.state === "unconfirmed") this.#scheduleStop(uid, intent)
          continue
        }
        if (intent.phase === "planned" || intent.phase === "working") this.#scheduleDispatch(uid, intent)
        if (intent.phase === "uncertain") this.#track(this.#reconcile(uid, intent))
      }
    }
  }
  async close() {
    this.#stop.abort()
    for (const timer of this.#stopTimers.values()) clearTimeout(timer)
    this.#stopTimers.clear()
    this.#unsubscribe?.(); this.#unsubscribePreview?.(); this.#feedback.close(); this.#attribution.clear()
    while (this.#live.size) await Promise.allSettled([...this.#live])
  }

  handle(method: "_deskfleet/super-agent/summary", value: unknown, actor: AgentActor): Promise<SuperMachineSummary>
  handle(method: "_deskfleet/super-agent/markRead", value: unknown, actor: AgentActor): Promise<SuperWorkspaceSummary>
  handle(method: "_deskfleet/super-agent/history", value: unknown, actor: AgentActor): Promise<SuperHistory>
  handle(method: "_deskfleet/super-agent/followUpAuth", value: unknown, actor: AgentActor): Promise<FollowUpAuthReceipt>
  handle(method: "_deskfleet/super-agent/followUpSources", value: unknown, actor: AgentActor): Promise<FollowUpSourcesResponse>
  handle(method: "_deskfleet/super-agent/followUpUpdateSource", value: unknown, actor: AgentActor): Promise<FollowUpSourceRecord>
  handle(method: "_deskfleet/super-agent/followUpRuns", value: unknown, actor: AgentActor): Promise<FollowUpRunsPage>
  handle(method: "_deskfleet/super-agent/feedbackProcess", value: unknown, actor: AgentActor): Promise<SuperFeedbackProcessResult>
  handle(method: string, value: unknown, actor: AgentActor): Promise<SuperSnapshot>
  async handle(method: string, value: unknown, actor: AgentActor): Promise<SuperSnapshot | SuperMachineSummary | SuperWorkspaceSummary | SuperHistory | FollowUpAuthReceipt | FollowUpSourcesResponse | FollowUpSourceRecord | FollowUpRunsPage | SuperFeedbackProcessResult> {
    if (this.#stop.signal.aborted) throw new Error("Workspace agent is stopping")
    if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and device are required")
    if (method === "_deskfleet/super-agent/summary") {
      return this.#summary(actor.userId)
    }
    if (method === "_deskfleet/super-agent/markRead") {
      const parsed = parseSuperMarkRead(value)
      if (parsed.workspaceId !== null) knownWorkspace(await this.#deps.workspaces(actor.userId), parsed.workspaceId)
      const uid = actor.userId
      await this.#transaction(uid, state => {
        const room = roomFor(state, parsed.workspaceId, this.#deps.providers()[0]?.id || "")
        room.lastRead = mergeSaMarkerRef(room.lastRead, {
          key: parsed.key,
          order: parsed.order,
          messageId: parsed.messageId,
        })
        if (parsed.errorKeys?.length) {
          const merged = new Set([...(room.readErrorKeys ?? []), ...parsed.errorKeys])
          room.readErrorKeys = [...merged].slice(-200)
        }
      })
      return this.#workspaceSummary(uid, parsed.workspaceId, this.#deps.store.get(uid))
    }
    if (method === "_deskfleet/super-agent/history") {
      const reqObj = object(value)
      const result = await organizeHistory(this.#deps, reqObj.assign === undefined ? actor : await this.#deps.authorize(actor), value)
      if (reqObj.assign !== undefined && this.#deps.followUp?.isTakeoverActive(actor.userId)) {
        const assignObj = object(reqObj.assign)
        if (typeof assignObj.workspaceId === "string" && assignObj.workspaceId) {
          await this.#deps.followUp.syncWorkspaceTakeover(actor.userId, assignObj.workspaceId)
        }
      }
      return result
    }
    if (method === "_deskfleet/super-agent/followUpAuth") {
      if (!this.#deps.followUp) throw new Error("Proactive follow-up is unavailable on this host")
      return this.#deps.followUp.handleAuth(parseFollowUpAuthMutation(value), actor)
    }
    if (method === "_deskfleet/super-agent/followUpSources") {
      if (!this.#deps.followUp) throw new Error("Proactive follow-up is unavailable on this host")
      const arg = object(value)
      const wid = arg.workspaceId === null || arg.workspaceId === undefined ? null : identifier(arg.workspaceId)
      if (wid !== null) knownWorkspace(await this.#deps.workspaces(actor.userId), wid)
      return this.#deps.followUp.listSources(actor.userId, wid, actor)
    }
    if (method === "_deskfleet/super-agent/followUpUpdateSource") {
      if (!this.#deps.followUp) throw new Error("Proactive follow-up is unavailable on this host")
      return this.#deps.followUp.updateSource(parseFollowUpSourceUpdate(value), actor)
    }
    if (method === "_deskfleet/super-agent/followUpRuns") {
      if (!this.#deps.followUp) throw new Error("Proactive follow-up is unavailable on this host")
      const arg = object(value)
      const wid = arg.workspaceId === undefined || arg.workspaceId === null ? undefined : identifier(arg.workspaceId)
      if (wid !== undefined) knownWorkspace(await this.#deps.workspaces(actor.userId), wid)
      const sourceKind = arg.sourceKind === undefined ? undefined : (arg.sourceKind === "schedule" || arg.sourceKind === "session" ? arg.sourceKind as FollowUpSourceKind : (() => { throw new Error("Invalid source kind") })())
      const sourceId = arg.sourceId === undefined ? undefined : identifier(arg.sourceId)
      const rawCursor = arg.cursor === undefined ? undefined : object(arg.cursor)
      const cursor = rawCursor ? { createdAt: identifier(rawCursor.createdAt), id: identifier(rawCursor.id) } : undefined
      const limit = arg.limit === undefined ? undefined : Number(arg.limit)
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) throw new Error("Invalid run page limit")
      return this.#deps.followUp.listRuns({ userId: actor.userId, workspaceId: wid, sourceKind, sourceId, cursor, limit })
    }
    if (method === "_deskfleet/super-agent/feedbackProcess") {
      if (!this.feedbackEnabled) throw new Error("Reply feedback is unavailable on this host")
      const parsed = parseSuperFeedbackProcess(value)
      if (parsed.workspaceId !== null) knownWorkspace(await this.#deps.workspaces(actor.userId), parsed.workspaceId)
      const room = this.#room(actor.userId, parsed.workspaceId)
      const source = room.messages.find(item => item.id === parsed.sourceMessageId && item.role === "user")
      if (!source) throw new Error("Unknown workspace request")
      const workers = await projectWorkers(this.#deps, actor.userId)
      const liveActivities = this.#feedback.liveActivityForRequest(actor.userId, parsed.workspaceId, parsed.sourceMessageId, source.revision ?? 0)
      const intents = this.#deps.store.get(actor.userId)?.intents.filter(i => i.roomId === parsed.workspaceId && i.messageId === parsed.sourceMessageId && i.phase !== "withdrawn" && i.operation !== "stop") ?? []
      return reconstructRequestProcess({ room, sourceMessageId: parsed.sourceMessageId, workers, liveActivities, intents, afterSeq: parsed.afterSeq, limit: parsed.limit })
    }
    const uid = actor.userId
    const arg = object(value)
    const workspaceId = arg.workspaceId === null ? null : identifier(arg.workspaceId)
    if (workspaceId !== null) knownWorkspace(await this.#deps.workspaces(uid), workspaceId)
    if (method === "_deskfleet/super-agent/snapshot") {
      if (workspaceId !== null && this.#deps.followUp?.isTakeoverActive(uid)) {
        await this.#deps.followUp.syncWorkspaceTakeover(uid, workspaceId)
      }
      const snapshot = await this.#snapshot(uid, workspaceId)
      if (arg.attachment !== undefined) {
        const { messageId, index } = object(arg.attachment)
        const id = identifier(messageId)
        const message = this.#room(uid, workspaceId).messages.find(item => item.role === "user" && item.id === id)
        if (!this.#deps.attachments || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 ||
          !message?.attachments?.[index] || !message.attachmentKeys?.length) throw new Error("Attachment unavailable in this conversation")
        snapshot.attachmentPreview = { messageId: id, index, content: await this.#deps.attachments.preview(uid, message.attachmentKeys, index) }
      }
      for (const ticket of snapshot.tickets) {
        if (ticket.sessionId && ticket.workerContext && this.#failedReplays.has(JSON.stringify([uid, ticket.sessionId]))) this.#replay(uid, ticket.sessionId)
      }
      return snapshot
    }
    if (method === "_deskfleet/super-agent/settings") {
      const provider = arg.provider === undefined ? undefined : identifier(arg.provider)
      const coordinator = arg.coordinator === undefined ? undefined : identifier(arg.coordinator)
      const selection = arg.workerSelection === undefined ? undefined : object(arg.workerSelection)
      const selected = selection && {
        provider: identifier(selection.provider),
        model: selection.model === undefined ? undefined : identifier(selection.model),
        reasoningEffort: selection.reasoningEffort === undefined ? undefined : identifier(selection.reasoningEffort),
      }
      const autoApprove = arg.workerAutoApprove
      if (autoApprove !== undefined && typeof autoApprove !== "boolean") throw new Error("Invalid Worker auto-approval setting")
      const rawMode = arg.workerMode === undefined ? undefined : object(arg.workerMode)
      const workerMode = rawMode && { provider: identifier(rawMode.provider), mode: rawMode.mode === null ? null : identifier(rawMode.mode) }
      if (workerMode || autoApprove !== undefined) {
        const authority = await this.#deps.authorize(actor)
        if (workerMode?.mode) {
          const room = this.#room(uid, workspaceId)
          if (workerMode.provider !== (provider ?? this.#defaultProvider(room))) throw new Error("The default worker has changed")
          const choices = selected ?? (room.provider === workerMode.provider ? room.workerSelection : undefined)
          const config = await this.#deps.agents.handle("_deskfleet/agent/configuration", {
            provider: workerMode.provider, workspaceId: workspaceId ?? undefined, model: choices?.model,
            reasoningEffort: choices?.reasoningEffort, cache: true, includeMatrix: false,
          }, authority) as AgentConfiguration | null
          if (config?.provider.id !== workerMode.provider || !config.modes?.options.some(choice => choice.id === workerMode.mode)) throw new Error("The execution Agent does not offer this mode")
        }
      }
      const front = arg.coordinatorSelection === undefined ? undefined : object(arg.coordinatorSelection)
      const frontSelection = front && {
        model: front.model === undefined ? undefined : identifier(front.model),
        reasoningEffort: front.reasoningEffort === undefined ? undefined : identifier(front.reasoningEffort),
      }
      if (front && frontSelection) {
        const id = identifier(front.provider)
        if (!this.#deps.providers().some(entry => entry.id === id)) throw new Error("Unknown coordinator provider for this machine")
        validateCoordinatorProfile(frontSelection, await this.#deps.coordinatorOptions(id, frontSelection.model))
      }
      if (provider === undefined && coordinator === undefined && !selected && !front && !workerMode && autoApprove === undefined) throw new Error("Select a coordinator or worker provider")
      await this.#transaction(uid, state => {
        if (coordinator) {
          if (!this.#deps.providers().some(entry => entry.id === coordinator)) throw new Error("Unknown coordinator provider for this machine")
          state.coordinatorProviderId = coordinator
        }
        if (provider && !this.#deps.providers().some(entry => entry.id === provider)) throw new Error("Unknown worker provider")
        if (front && frontSelection) {
          const current = this.#coordinator(state)?.id
          if (!current || front.provider !== current) throw new Error("The coordinator has changed")
          state.coordinatorProviderId = current
          state.coordinatorOverrides ??= {}
          state.coordinatorOverrides[current] = frontSelection
        }
        if (!provider && !selected && !workerMode && autoApprove === undefined) return
        const room = roomFor(state, workspaceId)
        if (provider && room.provider !== provider) {
          room.provider = provider
          delete room.workerSelection
        }
        if (selected) {
          if (selected.provider !== this.#defaultProvider(room)) throw new Error("The default worker has changed")
          room.provider = selected.provider
          room.workerSelection = { ...room.workerSelection, model: selected.model, reasoningEffort: selected.reasoningEffort }
        }
        if (workerMode) {
          if (workerMode.provider !== this.#defaultProvider(room)) throw new Error("The default worker has changed")
          room.provider = workerMode.provider
          room.workerSelection ??= {}
          if (workerMode.mode === null) delete room.workerSelection.mode
          else room.workerSelection.mode = workerMode.mode
        }
        if (autoApprove !== undefined) room.workerAutoApprove = autoApprove
      })
      this.#feedback.notifySnapshotDirty(uid, workspaceId)
    } else if (method === "_deskfleet/super-agent/archiveTicket") {
      const ticketId = identifier(arg.ticketId)
      const sessionId = arg.sessionId === null ? undefined : identifier(arg.sessionId)
      const operationId = identifier(arg.operationId)
      const archived = arg.archived
      if (typeof archived !== "boolean") throw new Error("Choose whether to archive or restore the ticket")
      const authority = await this.#deps.authorize(actor)
      const verifyTarget = (room: SuperRoom) => {
        const ticket = room.tickets.find(item => item.id === ticketId)
        if (!ticket) throw new Error("Unknown ticket in this workspace")
        if (ticket.sessionId !== sessionId) throw new Error("The ticket's Worker has changed. Reopen the ticket and try again.")
        return ticket
      }
      if (sessionId) {
        const ticket = verifyTarget(this.#room(uid, workspaceId))
        const workers = await projectWorkers(this.#deps, uid)
        const { session } = await workers.journal.read(sessionId)
        if (session.workspaceId !== ticket.executionWorkspaceId) throw new Error("Worker is outside the ticket workspace")
        await workers.handle(archived ? "_deskfleet/session/archive" : "_deskfleet/session/restore", { sessionId, operationId }, authority)
        const refreshed = await workers.journal.read(sessionId).catch(() => undefined)
        if (refreshed) this.#workerSessions.set(sessionId, refreshed.session)
        await this.#transaction(uid, state => {
          const room = roomFor(state, workspaceId)
          const liveTicket = room.tickets.find(item => item.id === ticketId)
          if (!liveTicket) return
          if (archived) {
            leaveArchivedTicket(state, room, ticketId)
            releaseTicketAccentOccupancy(room, liveTicket)
          } else {
            restoreTicketAccentOccupancy(room, liveTicket)
          }
        })
      } else await this.#transaction(uid, state => {
        const room = roomFor(state, workspaceId)
        const ticket = verifyTarget(room)
        if (archived) {
          if (state.intents.some(intent => intent.ticketId === ticketId && ["planned", "working", "uncertain"].includes(intent.phase))) {
            throw new Error("Worker assignment is still pending. Stop the request or wait for its outcome before archiving.")
          }
          ticket.archiveState = "archived"
          leaveArchivedTicket(state, room, ticketId)
          releaseTicketAccentOccupancy(room, ticket)
        } else {
          delete ticket.archiveState
          restoreTicketAccentOccupancy(room, ticket)
        }
      })
      this.#feedback.notifySnapshotDirty(uid, workspaceId)
    } else if (method === "_deskfleet/super-agent/send") {
      if (arg.retry !== undefined && typeof arg.retry !== "boolean") throw new Error("Invalid retry option")
      const rawBlocks = superAttachments(arg.attachments)
      const reusedAttachments = parseSuperReusedAttachments(arg.reusedAttachments)
      const reEditOf = arg.reEditOf === undefined ? undefined : identifier(arg.reEditOf)
      const messageId = identifier(arg.messageId)
      if (reEditOf === messageId) throw new Error("Cannot re-edit the same message")
      const store = this.#deps.attachments
      const trustedPaths = new Set<string>()
      const reusedBlocks: SuperAttachment[] = []
      if (reusedAttachments?.length) {
        if (!store) throw new Error("This machine does not support workspace attachments")
        const existingRoom = this.#deps.store.get(uid)?.rooms.find(r => r.workspaceId === workspaceId)
        for (const ref of reusedAttachments) {
          const sourceMsg = existingRoom?.messages.find(item => item.role === "user" && item.id === ref.messageId)
          if (!sourceMsg?.attachments?.[ref.index] || !sourceMsg.attachmentKeys?.length) {
            throw new Error("Attachment unavailable in this conversation")
          }
          const resolved = await store.resolveReused(uid, sourceMsg.attachmentKeys, ref.index)
          reusedBlocks.push(resolved.block)
          if (resolved.trustedPath) trustedPaths.add(resolved.trustedPath)
        }
      }
      const blocks: SuperAttachment[] = [...reusedBlocks, ...rawBlocks]
      if (blocks.length) assertAttachmentBudget(blocks)
      const request: SuperSend = {
        workspaceId, messageId,
        text: arg.text === "" && (blocks.length || arg.retry) ? "" : text(arg.text),
        replyTo: arg.replyTo === undefined ? undefined : identifier(arg.replyTo),
        ...(reEditOf && { reEditOf }),
        command: commandTarget(arg.command),
        timeZone: validTimeZone(arg.timeZone),
      }
      request.mentions = workspaceMentions(request.text, arg.mentions)
      const hasSkills = selectedSkills(request.mentions).length > 0
      if (hasSkills && !request.command) throw new Error("Select a Worker provider for this skill.")
      if (request.command && !superWorkerCommandName(request.text) && !hasSkills) throw new Error("Enter a worker slash command or select a skill.")
      if (hasSkills) composerSkillText(request.text, request.mentions!, request.command!.provider)
      const key = blocks.length && store ? store.key(request.messageId, blocks) : undefined
      if (blocks.length) {
        if (!store || !key) throw new Error("This machine does not support workspace attachments")
        const existing = this.#deps.store.get(uid)
        const room = existing?.rooms.find(r => r.workspaceId === workspaceId)
        if (existing?.rooms.some(r => r !== room && r.messages.some(m => m.id === request.messageId))) throw new Error("Message ID already used in a different workspace")
        if (request.replyTo && !room?.messages.some(m => m.id === request.replyTo) && !room?.feedbackItems?.some(f => f.itemId === request.replyTo)) throw new Error("Quoted message is outside this workspace conversation")
        const accepted = room?.messages.find(m => m.id === request.messageId)
        if (arg.retry && !accepted) throw new Error("Unknown message to retry")
        if (accepted && (accepted.attachmentKeys?.[0] !== key || accepted.text !== request.text || accepted.replyTo !== request.replyTo || accepted.reEditOf !== request.reEditOf)) throw new Error("Message ID already used for a different request")
        if (!accepted && request.reEditOf) {
          if (!room || !this.#isConfirmedStoppedTurn(room, existing?.intents ?? [], request.reEditOf)) {
            throw new Error("Only a confirmed stopped request can be re-edited")
          }
        }
        await this.#deps.authorize(actor)
        const roots = workspaceId === null ? [] : knownWorkspace(await this.#deps.workspaces(uid), workspaceId).roots
        await store.save(uid, key, blocks, roots, trustedPaths)
      }
      const accepted = await this.#transaction(uid, state => {
        const room = roomFor(state, workspaceId, this.#deps.providers()[0]?.id || "")
        const prior = room.messages.find(message => message.id === request.messageId)
        if (prior) {
          if (prior.role !== "user" || prior.text !== request.text || prior.replyTo !== request.replyTo ||
            prior.reEditOf !== request.reEditOf ||
            ((!arg.retry || request.command) && !sameCommandTarget(prior.command, request.command)) ||
            ((!arg.retry || arg.mentions !== undefined) && !isDeepStrictEqual(prior.mentions, request.mentions)) ||
            ((!arg.retry || key !== undefined) && prior.attachmentKeys?.[0] !== key)) throw new Error("Message ID already used for a different request")
          if (arg.retry === true) {
            this.#checkTicketTarget(room, prior.correctedTicketId ?? ticketOfQuote(room, room.messages.find(item => item.id === prior.replyTo), prior.replyTo))
            const recovery = prior.state === "failed" && prior.reason === missingWorkerProvider
              ? dispatchRecovery(room, state.intents).get(prior.id) : undefined
            if (recovery) {
              const provider = prior.command?.provider ?? this.#defaultProvider(room)
              if (!this.#deps.providers().some(p => p.id === provider)) throw new Error(missingWorkerProvider)
              for (const intent of recovery) {
                const ticket = room.tickets.find(item => item.id === intent.ticketId)!
                ticket.provider = provider
                ticket.status = "queued"
                if (ticket.summary === intent.error) ticket.summary = ""
                intent.workerSelection = room.provider === provider ? room.workerSelection : undefined
                intent.provider = provider
                intent.actor = actor
                intent.phase = "planned"
                intent.error = undefined
              }
              prior.state = "assigned"
              prior.reason = undefined
              prior.failureCode = undefined
              prior.retryable = undefined
              return recovery
            }
            if (prior.state !== "failed" || !prior.retryable || state.intents.some(intent => intent.messageId === prior.id && intent.roomId === workspaceId)) {
              throw new Error("This message cannot be safely retried.")
            }
            prior.state = "routing"; prior.reason = undefined; prior.retryable = undefined
            prior.actor = actor; prior.revision = (prior.revision || 0) + 1
            return true
          }
          return false
        }
        if (arg.retry === true) throw new Error("Unknown message to retry")
        if (state.rooms.some(other => other !== room && other.messages.some(message => message.id === request.messageId))) {
          throw new Error("Message ID already used in a different workspace")
        }
        if (request.reEditOf && !this.#isConfirmedStoppedTurn(room, state.intents, request.reEditOf)) {
          throw new Error("Only a confirmed stopped request can be re-edited")
        }
        if (request.replyTo && !room.messages.some(message => message.id === request.replyTo) && !room.feedbackItems?.some(item => item.itemId === request.replyTo)) throw new Error("Quoted message is outside this workspace conversation")
        this.#checkTicketTarget(room, ticketOfQuote(room, room.messages.find(item => item.id === request.replyTo), request.replyTo))
        if (request.command) {
          const baseRoom = roomWithArchives(room, this.#workerSessions)
          const expected = superWorkerCommandTarget({ ...baseRoom, messageTicketLinks: resolveRoomMessageLinks(baseRoom), provider: this.#defaultProvider(room), ...(room.feedbackItems?.length ? { feedback: { cursor: 0, previewGeneration: "", items: room.feedbackItems, processes: [] } } : {}) }, request.replyTo)
          // Session configuration can already reflect a provider change made in the
          // Worker itself. The live registration and catalog are checked before dispatch.
          if (expected.sessionId) expected.provider = request.command.provider
          if (!sameCommandTarget(request.command, expected)) throw new Error("The command target has changed. Select the worker command again.")
        }
        const style = !request.command ? adhdCommand(request.text) : undefined
        if (style) room.adhdEnabled = style.enabled
        const styleOnly = !!style && !style.task && !key && !request.mentions?.length
        note(room, request.text, { id: request.messageId, role: "user", state: styleOnly ? "answered" : "routing", replyTo: request.replyTo, ...(request.reEditOf && { reEditOf: request.reEditOf }), actor, revision: 0,
          ...((style || room.adhdEnabled) && { adhdEnabled: !!room.adhdEnabled }),
          ...(request.timeZone && { clientTimeZone: request.timeZone }),
          ...(request.command && { command: request.command }), ...(request.mentions && { mentions: request.mentions }),
          ...(key ? { attachmentKeys: [key], attachments: blocks.map(attachmentInfo) } : {}) })
        if (styleOnly) {
          const reply = note(room, style.enabled ? "ADHD mode is on for this conversation." : "ADHD mode is off.", {
            sourceMessageId: request.messageId, adhdModeNotice: style.enabled ? "enabled" : "disabled",
          })
          bumpVisibleSeq(room, reply)
          return false
        }
        return true
      })
      this.#feedback.notifySnapshotDirty(uid, workspaceId, request.messageId)
      if (Array.isArray(accepted)) {
        for (const intent of accepted) this.#scheduleDispatch(uid, intent)
      } else if (accepted) this.#scheduleRoute(uid, workspaceId, request.messageId)
    } else if (method === "_deskfleet/super-agent/stop") {
      if (typeof arg.revision !== "number" || !Number.isSafeInteger(arg.revision) || arg.revision < 0) throw new Error("Invalid request revision")
      if (arg.sharedTurns !== undefined && (!Array.isArray(arg.sharedTurns) || arg.sharedTurns.length > 6)) throw new Error("Invalid shared turn selection")
      const request = { workspaceId, messageId: identifier(arg.messageId), revision: arg.revision,
        ticketId: arg.ticketId === undefined ? undefined : identifier(arg.ticketId),
        sharedTurns: arg.sharedTurns?.map(value => { const turn = object(value); return { ticketId: identifier(turn.ticketId), turnId: identifier(turn.turnId) } }) }
      const authorized = await this.#deps.authorize(actor)
      const { routeId, intents } = await this.#transaction(uid, state => requestWorkspaceStop(state, request, authorized))
      if (routeId) this.#routes.get(JSON.stringify([uid, routeId]))?.controller.abort()
      this.#feedback.abortRequestPreviews(uid, workspaceId, request.messageId, request.revision, request.ticketId)
      this.#feedback.notifySnapshotDirty(uid, workspaceId, request.messageId)
      for (const intent of intents) {
        if (intent.stop?.state === "stopping") this.#scheduleStopTimeout(uid, intent)
        this.#scheduleStop(uid, intent)
      }
    } else if (method === "_deskfleet/super-agent/correct") {
      const messageId = identifier(arg.messageId), ticketId = identifier(arg.ticketId)
      await this.#correct(uid, workspaceId, messageId, ticketId, actor)
      this.#feedback.notifySnapshotDirty(uid, workspaceId, messageId)
      this.#scheduleRoute(uid, workspaceId, messageId)
    } else if (method === "_deskfleet/super-agent/linkMessage") {
      const parsed = parseSuperLinkMessage(value)
      if (parsed.workspaceId !== workspaceId) throw new Error("Workspace mismatch")
      await this.#transaction(uid, state => {
        const room = roomFor(state, workspaceId, this.#deps.providers()[0]?.id || "")
        const targetMessage = room.messages.find(item => item.id === parsed.messageId)
        if (!targetMessage || isFoldedOperationMessage(room, targetMessage)) {
          throw new Error("Unknown message in this workspace")
        }
        const currentLinks = resolveRoomMessageLinks(room)[parsed.messageId] ?? []
        for (const tid of parsed.ticketIds) {
          const ticket = room.tickets.find(item => item.id === tid)
          if (!ticket) throw new Error("Unknown ticket in this workspace")
          if (!currentLinks.includes(tid)) this.#checkTicketTarget(room, tid)
        }
        const groupIds = expandEditableMessageGroup(room, parsed.messageId)
        setMessageTicketLinks(room, groupIds, parsed.ticketIds)
      })
      this.#feedback.notifySnapshotDirty(uid, workspaceId, parsed.messageId)
    } else if (method === "_deskfleet/super-agent/createTicket") {
      const parsed = parseSuperCreateTicket(value)
      if (parsed.workspaceId !== workspaceId) throw new Error("Workspace mismatch")
      await this.#transaction(uid, state => {
        const room = roomFor(state, workspaceId, this.#deps.providers()[0]?.id || "")
        const targetMessage = room.messages.find(item => item.id === parsed.messageId)
        if (!targetMessage || isFoldedOperationMessage(room, targetMessage)) {
          throw new Error("Unknown message in this workspace")
        }
        const defaultScope = superTaskText(targetMessage).trim().slice(0, 600) || parsed.title
        const ticket: StoredSuperTicket = {
          id: randomUUID(),
          title: parsed.title,
          scope: parsed.scope ?? defaultScope,
          summary: "",
          provider: this.#defaultProvider(room),
          updatedAt: new Date().toISOString(),
        }
        allocateTicketAccent(room, ticket, this.#workerSessions)
        room.tickets.push(ticket)
        recordRoomRecentTicketAccent(room, ticket.id)
        const groupIds = expandEditableMessageGroup(room, parsed.messageId)
        appendMessageTicketLinks(room, groupIds, ticket.id)
      })
      this.#feedback.notifySnapshotDirty(uid, workspaceId, parsed.messageId)
    } else throw new Error("Unknown workspace agent operation")
    return this.#snapshot(uid, workspaceId)
  }

  #checkTicketTarget(room: SuperRoom, id: string | undefined) {
    const ticket = id && room.tickets.find(item => item.id === id)
    if (ticket && ticketLifecycle(ticket, this.#workerSessions).archiveState) throw new Error(archivedTicketError)
  }

  #isConfirmedStoppedTurn(room: SuperRoom, intents: DispatchIntent[], sourceMessageId: string): boolean {
    const relevantIntents = intents.filter(intent => intent.roomId === room.workspaceId && intent.messageId === sourceMessageId && intent.operation !== "stop")
    for (const intent of relevantIntents) {
      if (intent.stop) {
        const stopState = visibleStopState(intent.stop, this.#stopUnconfirmedMs())
        if (stopState === "stopping" || stopState === "unconfirmed" || stopState === "finished") return false
      } else if (intent.phase === "planned" || intent.phase === "working" || intent.phase === "uncertain") {
        return false
      }
    }
    const pub = publicRoom(roomWithArchives(room, this.#workerSessions), undefined, "", intents, undefined, this.#stopUnconfirmedMs())
    return isConfirmedStoppedTurn(pub.messages, pub.tickets, sourceMessageId)
  }

  async #correct(uid: string, id: SuperWorkspaceId, messageId: string, ticketId: string, actor: AgentActor) {
    await this.#transaction(uid, state => {
      const room = roomFor(state, id)
      const target = room.tickets.find(ticket => ticket.id === ticketId)
      const original = room.messages.find(message => message.id === messageId && message.role === "user")
      if (!target || !original) throw new Error("Unknown ticket or original message")
      this.#checkTicketTarget(room, ticketId)
      if (original.command) throw new Error("This command is bound to its selected worker. Send a new command to choose another.")
      const intents = state.intents.filter(intent => intent.roomId === id && intent.messageId === messageId)
      if (original.state === "transferred" || original.state === "stopped" || intents.some(intent => intent.stop || !["planned", "withdrawn"].includes(intent.phase))) {
        throw new Error("This message may already have reached its worker. Inspect the linked session and send a new instruction to correct the work; it has not been sent again.")
      }
      for (const intent of intents.filter(item => item.phase === "planned")) {
        withdrawDispatch(state, room, intent)
      }
      original.corrections ??= []
      original.corrections.push({ fromTicketId: original.correctedTicketId || original.ticketId, toTicketId: ticketId, actor, createdAt: new Date().toISOString() })
      original.ticketId = undefined; original.sessionId = undefined
      if (room.messageLinks) delete room.messageLinks[original.id]
      original.correctedTicketId = ticketId; original.state = "routing"; original.reason = undefined
      original.revision = (original.revision || 0) + 1; original.actor = actor; original.retryable = undefined
    })
  }

  #scheduleRoute(uid: string, workspaceId: SuperWorkspaceId, messageId: string) {
    this.#queue(JSON.stringify(["route", uid, workspaceId]), async () => {
      const room = this.#room(uid, workspaceId)
      const message = room.messages.find(item => item.id === messageId)
      if (message?.state !== "routing" || !message.actor) return
      const revision = message.revision
      const key = JSON.stringify([uid, messageId])
      const controller = new AbortController()
      const route: ActiveRoute = { controller, revision, phase: "processing" }
      this.#routes.set(key, route)
      const signal = AbortSignal.any([this.#stop.signal, controller.signal])
      const historySources: SuperHistorySource[] = []
      let measurement: SuperRoom["coordinatorMeasurement"]
      let routeFailed = false
      try {
        this.#checkTicketTarget(room, message.correctedTicketId ?? ticketOfQuote(room, room.messages.find(item => item.id === message.replyTo), message.replyTo))
        const actor = await this.#deps.authorize(message.actor)
        const workers = await projectWorkers(this.#deps, uid)
        const workspaces = await this.#deps.workspaces(uid)
        if (workspaceId !== null) knownWorkspace(workspaces, workspaceId)
        if (message.command) {
          const providers = this.#deps.providers()
          route.phase = "matchingTicket"
          const decision = await routeWorkerCommand(workers, actor, room, message, message.command, providers)
          if (!signal.aborted) await this.#apply(uid, workspaceId, messageId, revision, decision, actor, workspaces, providers, new Map(), new Map(), [])
          return
        }
        const reference = parseWorkerReference(superTaskText(message))
        if (reference) {
          const prompt = reference.text || (attachedKeys(room, message).length ? "Review the attached material." : "")
          if (!prompt) throw new Error("Add a task after the worker ID or attach a file.")
          const quoted = room.messages.find(item => item.id === message.replyTo)
          const providers = this.#deps.providers()
          route.phase = "matchingTicket"
          const { decision, historicalWorkspace } = await resolveWorkerTarget({
            target: reference.target, prompt, actor, providers, registration: this.#deps.registration?.(), workers: workers, room,
            projects: workspaces, workspaces: workspaceId === null ? await this.#deps.workspaces(uid, true) : workspaces,
            quotedTicketId: ticketOfQuote(room, quoted), correctedTicketId: message.correctedTicketId, quoteText: quoted?.text,
          })
          const historical = new Map<string, AgentSessionRecord>()
          const sessionId = reference.target.sessionId
          if (historicalWorkspace) historical.set(sessionId, await inspectHistoricalWorker(workers, sessionId, historicalWorkspace, actor))
          if (!signal.aborted) await this.#apply(uid, workspaceId, messageId, revision, decision, actor, workspaces,
            providers, historical, new Map(), [], undefined, { sessionId, prompt })
          return
        }
        const history = workspaceId === null ? [] : (await workers.journal.list()).filter(item => item.workspaceId === workspaceId)
        const providers = this.#deps.providers()
        const scheduleHost = this.#deps.schedules
        const routeSchedules = scheduleHost
          ? scheduleHost.listSchedules()
              .filter(task => workspaceId === null || task.workspaceId === workspaceId)
              .map(task => {
                const sub = scheduleHost.getScheduleSubscription?.(uid, task.workspaceId, task.id)
                const active = task.runs.find(r => r.state === "running" || r.state === "claimed")
                const followUpStatus = sub?.awaitingAuthorization
                  ? "awaiting_authorization" as const
                  : sub?.enabled
                    ? "active" as const
                    : sub
                      ? "paused" as const
                      : "not_subscribed" as const
                return {
                  id: task.id, title: task.title, workspaceId: task.workspaceId, enabled: task.enabled,
                  trigger: task.trigger, targetKind: (task.target.kind === "existing" ? "existing" : task.target.context) as "worktree" | "directory" | "existing",
                  ...(task.target.kind === "existing" ? { sessionId: task.target.sessionId } : {}),
                  ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}),
                  followUpStatus,
                  ...(sub ? { followUpEnabled: sub.enabled, deliveryPolicy: sub.deliveryPolicy } : {}),
                  ...(active ? { activeRun: { runId: active.id, state: active.state as "claimed" | "running", startedAt: active.startedAt, ...(active.sessionId ? { sessionId: active.sessionId } : {}) } } : {}),
                  ...(task.lastRun ? {
                    lastRunState: task.lastRun.state,
                    lastRun: {
                      runId: task.lastRun.id, state: task.lastRun.state, startedAt: task.lastRun.startedAt,
                      ...(task.lastRun.finishedAt ? { finishedAt: task.lastRun.finishedAt } : {}),
                      ...(task.lastRun.sessionId ? { sessionId: task.lastRun.sessionId } : {}),
                      ...(task.lastRun.error ? { error: task.lastRun.error } : {}),
                    },
                  } : {}),
                }
              })
          : undefined
        const followUpCtx = this.#deps.followUp
          ? (() => {
              const summary = this.#deps.followUp!.authSummary(uid, workspaceId)
              return {
                authorized: summary.authorized,
                adoptAllSchedules: summary.adoptAllSchedules === true,
                pendingAuthScheduleCount: summary.pendingAuthScheduleCount ?? 0,
              }
            })()
          : undefined
        const context = frontendContext(room, message, workspaces, providers, history, routeSchedules, followUpCtx)
        const keys = attachedKeys(room, message)
        const references = selectedReferences(message.mentions)
        if (keys.length || references.length) {
          route.phase = "readingContext"
          if (keys.length && !this.#deps.attachments) throw new Error("Stored workspace attachments are unavailable")
          const files = keys.length ? await this.#deps.attachments!.load(uid, keys) : []
          const { evidence, files: selectedFiles } = await workspaceReferenceEvidence(workers, actor, room, references, historySources)
          context.attachments = await previewSuperAttachments([...files, ...evidence], selectedFiles)
          route.phase = "processing"
        }
        const state = this.#deps.store.get(uid)
        const front = this.#coordinator(state, providers)
        if (!front) throw new Error(missingCoordinatorProvider)
        context.coordinator = front.id
        const overrides = state?.coordinatorOverrides?.[front.id] ?? {}
        context.coordinatorSelection = effectiveCoordinatorProfile(front.template ?? front.id, overrides,
          await this.#deps.coordinatorOptions(front.id, overrides.model))
        const evidence = createSuperEvidence({
          listRoots: async id => knownWorkspace(await this.#deps.workspaces(uid), id).roots,
          readTicket: async id => {
            const t = this.#room(uid, workspaceId).tickets.find(t => t.id === id)
            if (!t) throw new Error("Unknown ticket")
            if (t.archiveState) throw new Error(archivedTicketError)
            const { title, scope, latestAcceptance, summary, status, sessionId, lastEventSeq, historySources, referenceTicketId } = t
            return JSON.stringify({ title, scope, latestAcceptance, summary, status, sessionId, lastEventSeq, historySources, referenceTicketId })
          },
          readHistory: async (id, after) => {
            const snapshot = await workers.journal.read(id)
            const expected = workspaceId
              ?? room.tickets.find(t => t.sessionId === id)?.executionWorkspaceId
              ?? scheduleHost?.listSchedules().find(t =>
                (t.target.kind === "existing" && t.target.sessionId === id) || t.runs.some(r => r.sessionId === id))?.workspaceId
            if (!expected || snapshot.session.workspaceId !== expected) throw new Error("Session is outside this workspace")
            const end = BigInt(snapshot.session.lastEventSeq)
            const from = after ?? (end > 100n ? end - 100n : 0n).toString()
            if (!/^\d+$/u.test(from)) throw new Error("Invalid history cursor")
            const page = await workers.journal.history(id, from, 100)
            const excerpt = superHistoryExcerpt(page)
            const shown = JSON.parse(excerpt) as { nextAfterSeq?: string; messages: unknown[] }
            if (shown.messages.length && shown.nextAfterSeq) historySources.push({ sessionId: id, afterSeq: from, throughSeq: shown.nextAfterSeq })
            return excerpt
          },
          readSchedule: scheduleHost ? async id => {
            const task = scheduleHost.listSchedules().find(item => item.id === id && (workspaceId === null || item.workspaceId === workspaceId))
            if (!task) throw new Error("Schedule is outside this workspace")
            const sub = scheduleHost.getScheduleSubscription?.(uid, task.workspaceId, task.id)
            const persisted = await scheduleHost.listScheduleRuns?.(uid, task.workspaceId, task.id, 10) ?? []
            const recentRuns = await inspectScheduleRunsWithEvidence({
              userId: uid, task, persistedRuns: persisted, journal: workers.journal, limit: 3,
            })
            const activeRun = recentRuns.find(r => r.evidenceStatus === "in_progress")
            return JSON.stringify({ ...task, followUp: sub, ...(activeRun ? { activeRun } : {}), recentRuns })
          } : undefined,
          readScheduleRuns: scheduleHost ? async (id, limit, runId) => {
            const task = scheduleHost.listSchedules().find(item => item.id === id && (workspaceId === null || item.workspaceId === workspaceId))
            if (!task) throw new Error("Schedule is outside this workspace")
            const sub = scheduleHost.getScheduleSubscription?.(uid, task.workspaceId, task.id)
            let persisted: Awaited<ReturnType<NonNullable<ScheduleCommandHost["listScheduleRuns"]>>>
            if (runId && scheduleHost.getScheduleRun) {
              const exact = await scheduleHost.getScheduleRun(uid, task.workspaceId, task.id, runId)
              persisted = exact ? [exact] : []
            } else {
              persisted = await scheduleHost.listScheduleRuns?.(uid, task.workspaceId, task.id, runId ? 200 : Math.max(limit ?? 10, 10)) ?? []
            }
            const runs = await inspectScheduleRunsWithEvidence({
              userId: uid, task, persistedRuns: persisted, journal: workers.journal, runId, limit: runId ? 1 : (limit ?? 5),
            })
            return JSON.stringify({
              scheduleId: task.id,
              title: task.title,
              followUp: sub,
              runs,
              ...(runId && !runs.length ? { notFoundRunId: runId } : {}),
            })
          } : undefined,
        })
        const coordinator = context.coordinator
        const selection = context.coordinatorSelection ?? {}
        signal.throwIfAborted()
        const onPublicMessage = createCoordinatorPublicPublisher({
          uid, workspaceId, sourceMessageId: messageId, revision: revision ?? 0, signal, hub: this.#feedback, track: job => this.#track(job),
          persistItem: async item => {
            if (signal.aborted) return
            await this.#transaction(uid, saved => {
              const liveRoom = roomFor(saved, workspaceId), liveSource = liveRoom.messages.find(entry => entry.id === messageId && entry.role === "user")
              if (liveSource?.state === "routing" && (liveSource.revision ?? 0) === (revision ?? 0)) persistRoomFeedbackItem(liveRoom, item)
            })
          },
        })
        const routing = (this.#deps.route || routeSuperMessage)(context, {
          evidence, model: this.#deps.coordinatorModel(coordinator), signal, onUsage: usage => { measurement = { coordinator, selection, usage } },
          onPhase: phase => { route.phase = phase; this.#feedback.notifySnapshotDirty(uid, workspaceId, messageId) },
          onPublicMessage,
        })
        // A provider or an in-flight evidence read can finish after abort. Free this project's routing queue now.
        const decision = await Promise.race([routing, aborted(signal, controller).then(() => undefined)])
        if (!decision || signal.aborted) return
        if (decision.actions.every(action => action.kind === "answer" || action.kind === "clarify")) route.phase = "replying"
        const turnIds = new Map<string, string>(), legacy = new Map<string, AgentSessionRecord>()
        const scheduleResults = new Map<number, ScheduleExecutionResult>()
        for (const [index, action] of decision.actions.entries()) {
          if (action.kind === "schedule") {
            if (!scheduleHost) throw new Error("Scheduled tasks are unavailable on this machine")
            const outcome = await executeSuperScheduleAction({
              action, actionIndex: index, sourceMessageId: messageId, sourceRevision: revision ?? 0,
              sourceText: superTaskText(message), clientTimeZone: message.clientTimeZone, workspaceId, room,
              actor, workspaces, providers, workers, host: scheduleHost,
            })
            scheduleResults.set(index, outcome)
          }
          if (action.kind === "create" && action.sessionId) {
            if (!workspaceId) throw new Error("Historical worker is outside this workspace")
            const workspace = knownWorkspace(workspaces, workspaceId)
            legacy.set(action.sessionId, await inspectHistoricalWorker(workers, action.sessionId, workspace, actor))
          }
          if (action.kind === "stop" || action.kind === "continue" && action.delivery === "steer") {
            const ticket = room.tickets.find(item => item.id === action.ticketId)
            if (!ticket?.sessionId) throw new Error("Ticket has no active worker to interrupt")
            const snapshot = await workers.journal.read(ticket.sessionId)
            if (snapshot.session.workspaceId !== ticket.executionWorkspaceId) throw new Error("Worker workspace changed")
            const active = snapshot.turns.findLast(activeTurn)
            if (!active) throw new HistoricalSessionUnavailable(ticket.sessionId, "The worker has no active turn to interrupt")
            turnIds.set(ticket.id, active.id)
          }
        }
        await this.#apply(uid, room.workspaceId, messageId, revision, decision, actor, workspaces, providers, legacy, turnIds, historySources, measurement, undefined, scheduleResults)
      } catch (error) {
        if (signal.aborted) return
        routeFailed = await this.#transaction(uid, state => {
          const failedRoom = roomFor(state, workspaceId)
          const current = failedRoom.messages.find(item => item.id === messageId)
          if (current?.state !== "routing" || current.revision !== revision) return false
          if (measurement) failedRoom.coordinatorMeasurement = measurement
          current.state = "failed"
          current.reason = errorText(error)
          current.retryable = true
          if (historySources.length) current.historySources = historySources
          if (error instanceof HistoricalSessionUnavailable) current.sessionId = error.sessionId
          bumpVisibleSeq(failedRoom, current)
          return true
        })
      } finally {
        this.#routes.delete(key)
        if (routeFailed) this.#feedback.notifySnapshotDirty(uid, workspaceId, messageId)
      }
    })
  }

  async #apply(uid: string, workspaceId: SuperWorkspaceId, messageId: string, revision: number | undefined, decision: SuperRouteResult,
    actor: AgentActor, catalog: SuperWorkspace[], providers: ReturnType<Dependencies["providers"]>,
    historical: Map<string, AgentSessionRecord>, turns: Map<string, string>, historySources: SuperHistorySource[], measurement?: SuperRoom["coordinatorMeasurement"], direct?: { sessionId: string; prompt: string }, scheduleResults?: Map<number, ScheduleExecutionResult>) {
    const next = await this.#transaction(uid, state => {
      const room = roomFor(state, workspaceId)
      const source = room.messages.find(message => message.id === messageId)
        const schedule: { intents: DispatchIntent[]; handoff?: { workspaceId: string; messageId: string }; feedbackItems: SuperFeedbackItem[] } = { intents: [], feedbackItems: [] }
      if (source?.state !== "routing" || source.revision !== revision) return schedule
      this.#checkTicketTarget(room, source.correctedTicketId ?? ticketOfQuote(room, room.messages.find(item => item.id === source.replyTo), source.replyTo))
      if (measurement) room.coordinatorMeasurement = measurement
      if (!decision.actions.length) throw new Error("The front desk could not determine a response")
      source.historySources = historySources.length ? historySources : undefined
      const chosen = new Set<string>()
      const split = decision.actions.filter(action => ["create", "continue", "stop"].includes(action.kind)).length > 1
      let question: SuperRoom["pendingQuestion"]
      for (const [actionIndex, action] of decision.actions.entries()) {
        if (action.kind === "schedule") {
          const outcome = scheduleResults?.get(actionIndex)
          if (!outcome) throw new Error("Missing schedule execution outcome")
          if (outcome.handoffWorkspaceId && workspaceId === null && !source.sourceMessageId) {
            const target = knownWorkspace(catalog, outcome.handoffWorkspaceId)
            const destination = roomFor(state, target.id, providers[0]?.id || "")
            const id = randomUUID()
            note(destination, superTaskText(source), { id, role: "user", ...((source.adhdEnabled || destination.adhdEnabled) && { adhdEnabled: true }), sourceMessageId: source.id, sourceWorkspaceId: workspaceId, actor, revision: 0, state: "routing", ...(source.clientTimeZone ? { clientTimeZone: source.clientTimeZone } : {}) })
            source.targetWorkspaceId = target.id; source.state = "transferred"; source.reason = decision.reason
            const handoffNotice = note(room, outcome.text, { sourceMessageId: source.id, targetWorkspaceId: target.id })
            bumpVisibleSeq(room, handoffNotice)
            schedule.handoff = { workspaceId: target.id, messageId: id }
            return schedule
          }
          const schedNote = note(room, outcome.text, {
            sourceMessageId: source.id,
            sessionId: outcome.provenance?.sessionId,
            provenance: outcome.provenance,
            ...(outcome.clarifyOptions?.length ? { options: outcome.clarifyOptions } : {}),
          })
          bumpVisibleSeq(room, schedNote)
          continue
        }
        if (action.kind === "handoff") {
          if (source.mentions?.length) throw new Error("These references belong to the current workspace. Open the destination project and select its references.")
          if (decision.actions.length !== 1 || action.workspaceId === workspaceId || source.sourceMessageId) throw new Error("Invalid or repeated workspace transfer")
          const target = knownWorkspace(catalog, action.workspaceId)
          const destination = roomFor(state, target.id, providers[0]?.id || "")
          const id = randomUUID()
          const keys = attachedKeys(room, source)
          const attachments = [...source.attachments ?? [], ...quotedAttachmentSource(room, source)?.attachments ?? []]
          note(destination, superTaskText(source), { id, role: "user", ...((source.adhdEnabled || destination.adhdEnabled) && { adhdEnabled: true }), ...(keys.length ? { attachmentKeys: keys, attachments } : {}), sourceMessageId: source.id, sourceWorkspaceId: workspaceId, actor, revision: 0, state: "routing", context: action.context })
          source.targetWorkspaceId = target.id; source.state = "transferred"; source.reason = decision.reason
          schedule.handoff = { workspaceId: target.id, messageId: id }
          return schedule
        }
        let ticket = "ticketId" in action && action.ticketId ? room.tickets.find(item => item.id === action.ticketId) : undefined
        if ("ticketId" in action && action.ticketId && !ticket) throw new Error("Coordinator selected an unknown Ticket")
        if (ticket) this.#checkTicketTarget(room, ticket.id)
        if (action.kind === "answer" || action.kind === "clarify") {
          const reply = note(room, text(action.text), { ticketId: ticket?.id, sessionId: ticket?.sessionId, sourceMessageId: source.id, historySources: source.historySources, options: action.options })
          bumpVisibleSeq(room, reply)
          if (ticket) chosen.add(ticket.id)
          if (ticket && action.options?.length) question = { ticketId: ticket.id, options: [...action.options], optionDisposition: action.optionDisposition }
          continue
        }
        if (action.kind !== "create" && action.kind !== "continue" && action.kind !== "stop") throw new Error("Unknown routing action")
        if (action.kind === "create") {
          const old = action.sessionId ? historical.get(action.sessionId) : undefined
          if (old && !this.#workerSessions.has(old.id)) this.#workerSessions.set(old.id, old)
          if (old && this.#workerSessions.get(old.id)?.archiveState !== "active") throw new Error("The historical Worker was archived before it could be assigned.")
          const ownedByAnother = action.sessionId && this.#deps.store.users().some(other => other !== uid &&
            this.#deps.store.get(other)?.rooms.some(r => r.tickets.some(t => t.sessionId === action.sessionId)))
          if (action.sessionId && (!old || ownedByAnother || state.rooms.some(r => r.tickets.some(t => t.sessionId === action.sessionId)))) throw new Error("Historical session is already assigned. Continue its existing ticket.")
          const provider = old?.provider || action.provider || this.#defaultProvider(room)
          if (action.provider && !providers.some(p => p.id === action.provider)) throw new Error("Unknown worker provider")
          ticket = {
            id: randomUUID(), title: text(action.title), scope: text(action.scope), summary: "",
            provider, status: "queued", historySources: source.historySources, updatedAt: new Date().toISOString(), referenceTicketId: ticket?.id,
            sessionId: old?.id, executionWorkspaceId: old?.workspaceId, lastEventSeq: old?.lastEventSeq,
          }
          allocateTicketAccent(room, ticket, this.#workerSessions)
          room.tickets.push(ticket)
          const discussionIds = resolveCreateDiscussionLinks(room, source, action)
          if (discussionIds.length) appendMessageTicketLinks(room, discussionIds, ticket.id)
        }
        if (!ticket) throw new Error("A worker action requires a ticket")
        if (source.command) {
          if (source.command.sessionId && ticket.sessionId !== source.command.sessionId) throw new Error("The command's worker has changed.")
          ticket.provider = source.command.provider
        }
        if (direct && ticket.sessionId !== direct.sessionId) throw new Error("The selected ticket no longer points to that worker.")
        if (!ticket.sessionId && !source.command && !providers.some(p => p.id === ticket.provider)) ticket.provider = this.#defaultProvider(room)
        if (source.correctedTicketId && ticket.id !== source.correctedTicketId) throw new Error("Routing disagreed with the user's correction. No work was sent.")
        if (chosen.has(ticket.id) && schedule.intents.some(intent => intent.ticketId === ticket!.id)) throw new Error("Duplicate worker action for a ticket")
        const originalText = direct?.prompt ?? superTaskText(source)
        const quoted = source.replyTo ? room.messages.find(m => m.id === source.replyTo) : undefined
        if (action.kind === "continue" && ticket.status === "stopped") {
          const quote = source.correctedTicketId ? { ticketId: source.correctedTicketId } : quoted ? { ticketId: ticketOfQuote(room, quoted) } : undefined
          if (!allowsStoppedResume(originalText, room.pendingQuestion, room.focusTicketId, quote, ticket.id)) {
            throw new Error(stoppedTicketContinuationError)
          }
        }
        chosen.add(ticket.id)
        const priorAcceptance = ticket.latestAcceptance
        const priorAcceptanceMessageId = ticket.acceptanceMessageId
        if (action.kind === "continue" && action.acceptanceUpdate) {
          ticket.latestAcceptance = text(action.acceptanceUpdate)
          ticket.acceptanceMessageId = source.id
        }
        const workerPrompt = text(action.prompt)
        // Keep the user's authority verbatim. When forwarding a rewritten assignment, make its recipient explicit.
        let prompt = workerPrompt
        if (split) prompt = [workerPrompt, source.context].filter(Boolean).join("\n\n")
        else if (action.kind !== "stop" && (workerPrompt !== originalText || source.context)) {
          prompt = [
            `Original user request to the coordinator:\n${originalText}`,
            source.context && `Handoff context:\n${source.context}`,
            `You are the Worker assigned to this request. Carry out the assignment and return the result within the user's constraints.\n${workerPrompt === originalText ? "" : workerPrompt}`.trimEnd(),
          ].filter(Boolean).join("\n\n")
        }
        // New workers cannot see the front desk. Carry the selected scope and the specific
        // quoted result (or cited ticket summary) alongside their assigned instruction.
        const reference = action.kind === "create" && ticket.referenceTicketId ? room.tickets.find(t => t.id === ticket!.referenceTicketId) : undefined
        const relevantQuote = !split || quoted?.ticketId === ticket.id || (reference && quoted?.ticketId === reference.id)
        const background = ((relevantQuote && quoted?.text) || reference?.summary || "").slice(0, 5000)
        const parts = [prompt]
        if (action.kind === "create" && !prompt.includes(ticket.scope)) parts.push(`Ticket scope:\n${ticket.scope}`)
        if (action.kind !== "stop" && background && !prompt.includes(background)) parts.push(`Quoted background:\n${background}`)
        const keys = action.kind === "stop" ? [] : attachedKeys(room, source, relevantQuote && !source.command)
        const skills = selectedSkills(source.mentions), references = selectedReferences(source.mentions)
        const intent: DispatchIntent = {
          ...(source.adhdEnabled && !source.command && action.kind !== "stop" && { adhdEnabled: true }),
          ...(skills.length && { skills }), ...(references.length && { references }),
          ...(keys.length ? { attachmentKeys: keys } : {}),
          id: randomUUID(), roomId: workspaceId, messageId, ticketId: ticket.id, actor, provider: ticket.provider,
          workerSelection: !ticket.sessionId && ticket.provider === room.provider ? room.workerSelection : undefined,
          sessionId: ticket.sessionId, workspaceId: ticket.executionWorkspaceId,
          prompt: source.command ? composerSkillText(source.text, source.mentions ?? [], source.command.provider) : parts.join("\n\n"), commandName: source.command ? superWorkerCommandName(source.text) : undefined,
          createId: randomUUID(), submitId: randomUUID(),
          operation: action.kind === "stop" ? "stop" : action.kind === "continue" && action.delivery === "steer" ? "steer" : "submit",
          adoptHistory: action.kind === "create" && action.sessionId ? true : undefined,
          priorTicketStatus: action.kind === "create" ? undefined : ticket.status ?? null, priorAcceptance, priorAcceptanceMessageId,
          turnId: turns.get(ticket.id), context: action.kind === "create" ? action.context : undefined, phase: "planned",
        }
        state.intents.push(intent); schedule.intents.push(intent)
        ticket.updatedAt = new Date().toISOString()
        if (action.kind !== "stop" && ticket.status !== "working" && ticket.status !== "attention") ticket.status = "queued"
        note(room, ticket.title, { kind: "dispatch", ticketId: ticket.id, sessionId: ticket.sessionId, sourceMessageId: source.id, reason: decision.reason })
      }
      const focus = chosen.size === 1 ? [...chosen][0] : undefined
      userFocus(room, focus); room.pendingQuestion = question
      source.ticketId = focus; source.sessionId = room.tickets.find(item => item.id === focus)?.sessionId
      source.state = schedule.intents.length ? "assigned" : "answered"; source.reason = decision.reason
      schedule.feedbackItems.push(...recordAppliedRouteFeedback({ room, source, focus, intents: schedule.intents, publicFeedback: decision.publicFeedback }))
      return schedule
    })
    for (const item of next.feedbackItems) this.#feedback.upsertItem(uid, workspaceId, item)
    this.#feedback.notifySnapshotDirty(uid, workspaceId, messageId)
    if (next.handoff) {
      this.#feedback.notifySnapshotDirty(uid, next.handoff.workspaceId, next.handoff.messageId)
      this.#scheduleRoute(uid, next.handoff.workspaceId, next.handoff.messageId)
    }
    for (const intent of next.intents) {
      if (intent.sessionId) this.#watch(uid, intent.sessionId)
      this.#scheduleDispatch(uid, intent)
    }
  }

  /** Reconcile previously unknown delivery only from durable evidence. This method cannot send work. */
  async #reconcile(uid: string, intent: DispatchIntent) {
    if (!intent.sessionId) return
    const command = await this.#deps.agents.journal.command(intent.submitId)
    if (!command || command.sessionId !== intent.sessionId || command.actor.userId !== uid) return
    const expected = intent.operation === "stop" ? "_deskfleet/turn/cancel" : "_deskfleet/input/submit"
    if (command.method !== expected) return
    const snapshot = await (await projectWorkers(this.#deps, uid)).journal.read(intent.sessionId)
    if (snapshot.session.workspaceId !== intent.workspaceId) return
    const input = snapshot.inputs.find(item => item.submissionCommandId === command.id)
    const receipt = command.result as AgentReceipt | undefined
    if (input?.state === "uncertain") return
    const confirmed = input?.state === "delivered" || command.status === "completed" && receipt?.sessionId === intent.sessionId &&
      (intent.operation === "stop" || !!receipt.inputId)
    const rejected = command.status === "failed" || command.status === "rejected" || input?.state === "failed" || input?.state === "withdrawn"
    if (!confirmed && !rejected) return
    const reconciled = await this.#transaction(uid, state => {
      const live = state.intents.find(item => item.id === intent.id)
      if (live?.phase !== "uncertain") return false
      const room = roomFor(state, intent.roomId)
      const ticket = room.tickets.find(item => item.id === intent.ticketId)
      const original = room.messages.find(item => item.id === intent.messageId)
      live.phase = rejected ? "failed" : "sent"
      live.error = rejected ? command.error || input?.error || "The original worker operation was rejected." : undefined
      live.inputId = input?.id || receipt?.inputId
      if (original) {
        original.state = rejected ? "failed" : "assigned"
        original.reason = live.error || "The worker journal confirmed receipt."
        if (rejected) bumpVisibleSeq(room, original)
      }
      if (ticket && ticket.status === "blocked" && !rejected) {
        if (snapshot.turns.some(activeTurn)) ticket.status = "working"
        else if (snapshot.inputs.some(i => i.state === "pending" || i.state === "dispatching")) ticket.status = "queued"
        else if (snapshot.turns.at(-1)?.state === "completed") delete ticket.status
        if ([...snapshot.permissions, ...snapshot.elicitations].some(req => req.state === "pending")) ticket.status = "attention"
      }
      note(room, live.error || "The worker journal confirmed the original delivery.", { kind: "delivery", role:"worker", ticketId:intent.ticketId, sessionId:intent.sessionId, sourceMessageId:intent.messageId })
      return true
    })
    if (reconciled) this.#feedback.notifySnapshotDirty(uid, intent.roomId, intent.messageId)
  }

  #scheduleStop(uid: string, intent: DispatchIntent) {
    // A create/submit already on the wire must save its receipt before resolving this request.
    this.#queue(JSON.stringify(["dispatch", uid, intent.ticketId]), async () => {
      const live = this.#deps.store.get(uid)?.intents.find(item => item.id === intent.id)
      if (!live?.stop || !["stopping", "unconfirmed"].includes(live.stop.state)) return
      const result = await projectWorkers(this.#deps, uid)
        .then(workers => stopWorkspaceDispatch(workers, live, this.#deps.authorize))
        .catch(() => ({ state: "unconfirmed" as const, snapshot: undefined, undelivered: false }))
      if (result.state === live.stop.state && (!result.snapshot || !observeWorkerInputs([live], result.snapshot))) {
        if (live.stop.state === "stopping") this.#scheduleStopTimeout(uid, live)
        return
      }
      const outcome = await this.#transaction(uid, state => {
        const saved = state.intents.find(item => item.id === live.id)
        if (!saved?.stop || saved.stop.cancelId !== live.stop!.cancelId) return undefined
        saved.stop.state = result.state
        const room = roomFor(state, saved.roomId)
        const ticket = room.tickets.find(item => item.id === saved.ticketId)
        if (!saved.sessionId && ticket && result.snapshot) {
          if (!this.#workerSessions.has(result.snapshot.session.id)) this.#workerSessions.set(result.snapshot.session.id, result.snapshot.session)
          bindWorker(room, ticket, result.snapshot.session)
          saved.sessionId = result.snapshot.session.id
          ticket.executionWorkspaceId = saved.workspaceId
        }
        if (result.undelivered) withdrawDispatch(state, room, saved, result.snapshot)
        if (result.snapshot) {
          observeWorkerInputs(state.intents, result.snapshot)
          if (result.state === "stopped" && ticket?.status === "queued" && BigInt(ticket.lastEventSeq ?? "0") <= BigInt(result.snapshot.session.lastEventSeq) &&
            !result.snapshot.turns.some(activeTurn) && !result.snapshot.inputs.some(i => i.state === "pending" || i.state === "dispatching") &&
            !state.intents.some(i => i.ticketId === saved.ticketId && !i.stop && (i.phase === "planned" || i.phase === "working"))) {
            ticket.status = "stopped"
            if (room.pendingQuestion?.ticketId === ticket.id) room.pendingQuestion = undefined
          }
        }
        return { roomId: saved.roomId, messageId: saved.messageId, stopState: saved.stop.state }
      })
      if (outcome) {
        if (outcome.stopState === "stopping") this.#scheduleStopTimeout(uid, live)
        else this.#clearStopTimers(uid, live.id)
        this.#feedback.notifySnapshotDirty(uid, outcome.roomId, outcome.messageId)
      }
      if (!live.sessionId && result.snapshot) {
        this.#watch(uid, result.snapshot.session.id)
        this.#replay(uid, result.snapshot.session.id)
      }
    })
  }

  #scheduleDispatch(uid: string, intent: DispatchIntent) {
    this.#queue(JSON.stringify(["dispatch", uid, intent.ticketId]), async () => {
      const current = () => this.#deps.store.get(uid)?.intents.find(item => item.id === intent.id)
      for (const prior of this.#deps.store.get(uid)?.intents ?? []) {
        if (prior.ticketId === intent.ticketId && prior.phase === "uncertain") await this.#reconcile(uid, prior)
      }
      // The predecessor may have created this Ticket's Session after this intent was enqueued.
      const precheckDirty = await this.#transaction(uid, state => {
        const live = state.intents.find(i => i.id === intent.id)
        const room = roomFor(state, intent.roomId)
        const ticket = room.tickets.find(item => item.id === intent.ticketId)
        if (!live || !ticket || live.phase !== "planned") return false
        if (ticketLifecycle(ticket, this.#workerSessions).archiveState) {
          withdrawDispatch(state, room, live)
          return true
        }
        const earlier = state.intents.slice(0, state.intents.indexOf(live)).find(i => i.ticketId === ticket.id && i.phase === "uncertain")
        if (earlier && live.operation !== "stop") {
          live.phase = "failed"; live.error = "A previous worker operation has no confirmed outcome. Inspect the original session before sending more work."
          const source = room.messages.find(m => m.id === live.messageId)
          if (source) {
            source.state = "failed"; source.reason = live.error
            bumpVisibleSeq(room, source)
          }
          ticket.status = "blocked"; ticket.summary = live.error
          note(room, live.error, { kind: "delivery", role: "worker", ticketId: ticket.id, sourceMessageId: live.messageId })
          return true
        }
        if (!live.sessionId && ticket.sessionId) live.sessionId = ticket.sessionId
        return false
      })
      if (precheckDirty) this.#feedback.notifySnapshotDirty(uid, intent.roomId, intent.messageId)
      const workers = await projectWorkers(this.#deps, uid)
      await deliverSuperIntent({
        workers, current, authorize: this.#deps.authorize, suspended: () => this.#stop.signal.aborted,
        autoApproveNewWorker: () => this.#room(uid, intent.roomId).workerAutoApprove === true,
        inspectHistory: async (sessionId, authority) => {
          const workspace = knownWorkspace(await this.#deps.workspaces(uid, intent.roomId === null), intent.workspaceId || intent.roomId || "")
          await inspectHistoricalWorker(workers, sessionId, workspace, authority)
        },
        workspace: async () => {
          const selected = current()
          if (!selected || !selected.sessionId && !this.#deps.providers().some(item => item.id === selected.provider)) throw new Error(missingWorkerProvider)
          if (this.#stop.signal.aborted) throw new Error("Workspace agent is stopping")
          const id = intent.roomId || await this.#deps.ensureDefaultWorkspace(uid)
          const workspace = knownWorkspace(await this.#deps.workspaces(uid, intent.roomId === null), id)
          if (selected.workspaceId && selected.workspaceId !== workspace.id) throw new Error("The ticket's execution workspace has changed")
          if (selected.context || selected.sessionId) return { id, context: selected.context || "directory" }
          const gitRoots = await Promise.all(workspace.roots.map(async path => {
            try { await executeGit(["-C", path, "rev-parse", "--verify", "HEAD^{commit}"]); return true }
            catch (error) { if (error instanceof GitPolicyError) throw error; return false }
          }))
          return { id, context: gitRoots.length && gitRoots.every(Boolean) ? "worktree" : "directory" }
        },
        loadAttachments: async keys => {
          if (!this.#deps.attachments) throw new Error("Stored workspace attachments are unavailable")
          return this.#deps.attachments.load(uid, keys)
        },
        checkpoint: async (patch, bound) => {
          await this.#transaction(uid, state => {
            const saved = state.intents.find(item => item.id === intent.id)
            // Archiving can cross a native submit. Its confirmed receipt still belongs in the transcript.
            if (!saved || saved.phase === "withdrawn" && (saved.stop || patch.phase !== "sent" || !saved.sessionId)) throw new Error("Dispatch has been withdrawn")
            Object.assign(saved, patch)
            const room = roomFor(state, saved.roomId)
            const ticket = room.tickets.find(item => item.id === saved.ticketId)!
            if (saved.workspaceId) ticket.executionWorkspaceId = saved.workspaceId
            if (patch.provider && ticket.sessionId === saved.sessionId) ticket.provider = patch.provider
            if (bound) {
              if (!this.#workerSessions.has(bound.id)) this.#workerSessions.set(bound.id, bound)
              bindWorker(room, ticket, bound)
            }
            if (saved.inputId && saved.sessionId) {
              const original = room.messages.find(m => m.id === saved.messageId && m.ticketId === saved.ticketId)
              if (original) original.inputId = saved.inputId
              const sourceMsg = original ?? room.messages.find(m => m.id === saved.messageId && m.role === "user")
              persistRoomProcessBranch(room, saved.messageId, sourceMsg?.revision ?? 0, {
                ticketId: saved.ticketId, sessionId: saved.sessionId, inputId: saved.inputId,
                ...(saved.deliveredTurnId ? { turnId: saved.deliveredTurnId } : {}), activityCount: 0,
              })
              for (const report of room.messages) {
                if (report.role !== "worker" || report.sessionId !== saved.sessionId || report.inputId !== saved.inputId) continue
                report.sourceMessageId = saved.messageId
                if (original && report.turnId) original.turnId = report.turnId
              }
            }
            if (saved.phase === "failed" || saved.phase === "uncertain") {
              const original = room.messages.find(msg => msg.id === saved.messageId)
              if (original) {
                original.state = saved.phase; original.reason = saved.error
                bumpVisibleSeq(room, original)
              }
              ticket.status = "blocked"; ticket.summary = saved.error || "Dispatch failed"
              note(room, ticket.summary, { kind: "delivery", role: "worker", ticketId: ticket.id, sessionId: ticket.sessionId, sourceMessageId: saved.messageId })
            }
          })
          if (patch.phase === "failed" || patch.phase === "uncertain" || patch.phase === "sent" || bound || patch.inputId) {
            this.#feedback.notifySnapshotDirty(uid, intent.roomId, intent.messageId)
          }
          if (bound) this.#watch(uid, bound.id)
          const reconciledSessionId = patch.sessionId ?? bound?.id ?? current()?.sessionId
          if (reconciledSessionId) this.#reconcileFeedback(reconciledSessionId, uid)
        },
      })
      const saved = current()
      if (saved?.sessionId) this.#replay(uid, saved.sessionId)
    })
  }

  #replay(uid: string, sessionId: string) {
    if (this.#stop.signal.aborted) return
    const key = JSON.stringify([uid, sessionId])
    const prior = this.#replays.get(key)
    if (prior) { prior.dirty = true; return }
    const slot = { dirty: true }
    this.#replays.set(key, slot)
    this.#track((async () => {
      try {
        do {
          slot.dirty = false
          const state = this.#deps.store.get(uid)
          for (const prior of state?.intents ?? []) if (prior.sessionId === sessionId && prior.phase === "uncertain") await this.#reconcile(uid, prior)
          const room = state?.rooms.find(r => r.tickets.some(t => t.sessionId === sessionId))
          const bound = room?.tickets.find(t => t.sessionId === sessionId)
          if (!room || !bound) { this.#pendingRequests.delete(key); return }
          const snapshot = await (await projectWorkers(this.#deps, uid)).journal.read(sessionId)
          if (snapshot.session.workspaceId !== bound.executionWorkspaceId) { this.#pendingRequests.delete(key); return }
          this.#attribution.observeSnapshot(snapshot)
          const resolvedInputs = await resolveWorkingIntentInputs(state?.intents ?? [], sessionId, snapshot, this.#deps.agents.journal)
          const prevPending = this.#pendingRequests.get(key)
          const requests = ownedPendingRequests(bound, snapshot, state?.intents ?? [])
          const nextPending = requests.length && snapshot.session.archiveState === "active" && snapshot.session.lifecycle === "ready"
            ? { ticketId: bound.id, requests }
            : undefined
          const pendingChanged = !isDeepStrictEqual(prevPending, nextPending)
          if (nextPending) this.#pendingRequests.set(key, nextPending)
          else this.#pendingRequests.delete(key)
          let from = bound.lastEventSeq || "0"
          const through = BigInt(snapshot.session.lastEventSeq)
          let notifiedInLoop = false
          while (!this.#stop.signal.aborted && BigInt(from) < through) {
            // Events can arrive between reading the snapshot and fetching its history.
            // Apply later events with their own snapshot so an older running turn cannot mask completion.
            const events = await this.#deps.agents.journal.history(sessionId, from, 200)
            const page = events.filter(event => BigInt(event.seq) <= through)
            if (page.length < events.length) slot.dirty = true
            if (!page.length || BigInt(page.at(-1)!.seq) <= BigInt(from)) break
            let projectedFeedback: SuperEventProjectionFeedback | undefined
            await this.#transaction(uid, state => {
              const liveRoom = roomFor(state, room.workspaceId)
              const ticket = liveRoom.tickets.find(t => t.id === bound.id && t.sessionId === sessionId)
              if (ticket) {
                for (const [intentId, matchedInputId] of resolvedInputs) {
                  const liveIntent = state.intents.find(i => i.id === intentId && !i.inputId)
                  if (liveIntent) liveIntent.inputId = matchedInputId
                }
                ticket.provider = snapshot.session.provider
                observeWorkerInputs(state.intents, snapshot)
                projectSuperEvents(liveRoom, ticket, page, snapshot, state.intents, feedback => { projectedFeedback = feedback })
                syncTicketSnapshotStatus(ticket, snapshot, state.intents)
              }
            })
            publishProjectedWorkerFeedback({ uid, workspaceId: room.workspaceId, room: this.#room(uid, room.workspaceId), projected: projectedFeedback, hub: this.#feedback })
            notifiedInLoop = true
            from = page.at(-1)!.seq
          }
          // A fast turn can finish while the input receipt is still being committed.
          // Its terminal event is already consumed when that commit requests the next replay.
          const last = snapshot.turns.at(-1)
          const pending = snapshot.inputs.some(i => i.state === "pending" || i.state === "dispatching")
          const observed = this.#room(uid, room.workspaceId).tickets.find(t => t.id === bound.id)
          let tailDirty = false
          if (last && !activeTurn(last) && !pending && observed?.status === "queued" && from === snapshot.session.lastEventSeq) {
            const settled = await this.#transaction(uid, current => {
              const r = roomFor(current, room.workspaceId)
              const t = r.tickets.find(t => t.id === bound.id)
              if (!t || t.status !== "queued" || t.lastEventSeq !== from || current.intents.some(i => i.ticketId === t.id && (i.phase === "planned" || i.phase === "working"))) return false
              if (r.messages.some(m => m.workerEvent === "result" && m.sessionId === sessionId && m.turnId === last.id)) {
                t.status = last.state === "completed" ? undefined : last.state === "cancelled" ? "stopped" : "blocked"
                if (t.status === "stopped" && r.pendingQuestion?.ticketId === t.id) r.pendingQuestion = undefined
                return true
              }
              return false
            })
            if (settled) tailDirty = true
          }
          const intents = this.#deps.store.get(uid)?.intents ?? []
          // A fast steer can be delivered before the front desk checkpoints its input receipt.
          if (observeWorkerInputs(intents, snapshot)) {
            const inputsChanged = await this.#transaction(uid, current => observeWorkerInputs(current.intents, snapshot))
            if (inputsChanged) tailDirty = true
          }
          if (tailDirty || (pendingChanged && !notifiedInLoop)) {
            this.#feedback.notifySnapshotDirty(uid, room.workspaceId)
          }
          this.#reconcileFeedback(sessionId, uid)
          for (const intent of intents) {
            if (intent.sessionId === sessionId && (intent.stop?.state === "stopping" || intent.stop?.state === "unconfirmed")) this.#scheduleStop(uid, intent)
          }
        } while (slot.dirty && !this.#stop.signal.aborted)
        this.#failedReplays.delete(key)
      } catch (error) {
        this.#pendingRequests.delete(key)
        this.#failedReplays.add(key)
        throw error
      } finally { this.#replays.delete(key) }
    })())
  }
}
