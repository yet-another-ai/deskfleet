import { useConversationCache } from "../services/conversation-cache.ts"
import { useAgentLiveState } from "../composables/useAgentLiveState.ts"
import { isSubagentNotification } from "../../../client/src/agent-session-scope.ts"
import type { AgentLiveUpdate } from "../../../client/src/agent-live.ts"
import { snapshotIsWorking, type SessionActivity } from "../services/agent-conversation.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { cloneFnJSON, useLocalStorage, useTimeoutFn } from "@vueuse/core"
import { defineStore } from "pinia"
import { markRaw, onScopeDispose, ref, watch } from "vue"
import type { AgentCommand, AgentElicitation, AgentEvent, AgentInput, AgentMethod, AgentMethods, AgentPermission, AgentPreview, AgentRun, AgentSessionContext, AgentSessionRecord, AgentSnapshot, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"
import { AgentPreviews } from "../services/agent-preview.ts"
import type { ElicitationDraft } from "../services/agent-elicitation.ts"
import type { ComposerAttachment } from "../services/composer-attachments.ts"
import type { ComposerMention } from "../services/composer-mentions.ts"
import type { ComposerReference, ComposerReferenceSearch } from "../../../../apps/daemon/src/composer-reference-protocol.ts"
import { agentComposerCatalog, agentConfiguration as normalizeAgentConfiguration } from "../../../../apps/daemon/src/agent-configuration-protocol.ts"
import { isSnapshotReference } from "../../../../apps/daemon/src/agent-command-results.ts"
import type { AgentConfiguration } from "../../../client/src/agent-configuration.ts"
import { RelayConnectionError, type RelayDeniedReason } from "../../../client/src/relay.ts"
import type { GitChangedNotification, GitDiffRequest } from "../../../../apps/daemon/src/git-protocol.ts"
import { useProvidersStore } from "./providers.ts"
import { AgentClient, type AgentConnectionState, type AgentNotification } from "../services/agent-client.ts"
import { captureAnalyticsContext } from "../services/analytics.ts"
import type { SessionCapacityDetails } from "../services/entitlement-events.ts"

export interface AgentSelection { provider: string; model?: string; reasoningEffort?: string; mode?: string; configValues?: Record<string, string | boolean> }

export interface AgentSessionView {
  snapshot: AgentSnapshot | null
  /** Display history includes an ephemeral preview tail; cursors below are durable. */
  events: AgentEvent[]
  loading: boolean
  syncing?: boolean
  error: string | null
  relayDeniedReason?: RelayDeniedReason
  historySeq: string
  snapshotSeq: string
}
export interface PendingAgentOperation {
  operationId: string
  sessionId?: string
  method: AgentMethod
  text?: string
  attachmentIds?: string[]
  mentionSnapshot?: string
  workspaceId?: string
  params: Record<string, unknown>
  error?: string
  result?: unknown
}
export interface SubmittedAgentDraft {
  mentions: readonly ComposerMention[]
  attachmentIds: readonly string[]
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
const sequenceCompare = (left: string, right: string) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
function replace<T>(values: T[], value: T, key: (value: T) => string | number): void {
  const index = values.findIndex(item => key(item) === key(value))
  if (index === -1) values.push(value)
  else values[index] = value
}

/** Shared projections outlive the visible route; the daemon owns execution and history. */
export const useAgentSessionsStore = defineStore("agent-sessions", () => {
  const platformClient = usePlatformClient()
  const api = platformClient.agent
  const cache = useConversationCache()
  const live = useAgentLiveState()
  const cacheDirty = new Set<string>()
  const cacheTimer = useTimeoutFn(persistConversations, 1000, { immediate: false })
  function persistConversations(): void {
    for (const id of cacheDirty) {
      const current = views.value[id]
      if (current?.snapshot && !retainedDisplays.has(id) && current.historySeq === current.snapshotSeq) {
        void cache?.write(id, { snapshot: current.snapshot, events: [...journal(id).values()].sort((a, b) => sequenceCompare(a.seq, b.seq)) })
      }
    }
    cacheDirty.clear()
  }
  const providers = useProvidersStore()
  const sessions = ref<Record<string, AgentSessionRecord>>({})
  const activity = ref<Record<string, { seq: string; working: SessionActivity | false }>>({})
  const views = ref<Record<string, AgentSessionView>>({})
  const drafts = ref<Record<string, string>>({})
  const draftAttachments = ref<Record<string, ComposerAttachment[]>>({})
  const draftMentions = ref<Record<string, ComposerMention[]>>({})
  const draftErrors = ref<Record<string, string>>({})
  const preparingDrafts = ref<Record<string, boolean>>({})
  const optimisticInputs = ref<Record<string, AgentInput>>({})
  const elicitationDrafts = ref<Record<string, ElicitationDraft>>({})
  const draftConfiguration = useLocalStorage<AgentSelection>("deskfleet.agent-configuration", { provider: "codex" })
  const draftYolo = ref(false)
  const configurations = ref<Record<string, AgentConfiguration>>({})
  const configurationReads = new Map<string, Promise<AgentConfiguration>>()
  const configurationSequences = new Map<string, string>()
  // A provider switch invalidates reads and merges started for the previous Agent.
  const configurationEpochs = new Map<string, number>()
  const commandSequences = new Map<string, string>()
  const unclassifiedCommands = new Map<string, Parameters<typeof agentComposerCatalog>[0]>()
  const state = ref<AgentConnectionState>("idle")
  const error = ref<string | null>(null)
  const relayDeniedReason = ref<RelayDeniedReason>()
  const operations = ref<Record<string, PendingAgentOperation>>({})
  const sessionPresence = ref<Record<string, string[]>>({})
  const retainedDisplays = new Set<string>()
  const journals = new Map<string, Map<string, AgentEvent>>()
  const journalTails = new Map<string, string>()
  const previews = new AgentPreviews()
  const visiblePreviews = new Map<string, Set<string>>()
  const pendingPreviews = new Set<string>()
  let pendingEvents: AgentEvent[] = []
  const displayTimer = useTimeoutFn(flushDisplay, 33, { immediate: false })
  // Central history and in-flight reads can arrive after a successful deletion.
  const deletedSessions = new Set<string>()
  const loads = new Map<string, Promise<void>>()
  const reads = new Map<string, Promise<void>>()
  const permissionRequests = new Map<string, { sessionId: string; permissionId: string; resolve(value: unknown): void }>()
  const gitSubscriptions = new Map<string, { sessionId: string; listener(error?: string): void }>()
  let connectionGeneration = 0
  let attendanceAttempt = 0
  let initialized: Promise<void> | null = null
  let refreshPending = false
  let refreshFailed = false
  let refreshing: Promise<void> | null = null
  let activeSessionId: string | undefined
  let disposed = false

  function projectCommands(sessionId: string, commands: Parameters<typeof agentComposerCatalog>[0]): void {
    const current = configurations.value[sessionId]
    const providerId = sessions.value[sessionId]?.provider ?? current?.provider.id
    const provider = providers.providers.find(provider => provider.id === providerId)
    configurations.value[sessionId] = {
      ...(current ?? normalizeAgentConfiguration([], { id: providerId ?? "", name: provider?.name ?? providerId ?? "" })),
      ...(provider ? agentComposerCatalog(commands, provider.template) : { commands: [], skills: [] }),
    }
    if (provider) unclassifiedCommands.delete(sessionId)
    else unclassifiedCommands.set(sessionId, commands)
  }
  watch(() => providers.providers, () => {
    for (const [sessionId, commands] of unclassifiedCommands) projectCommands(sessionId, commands)
  })

  function view(id: string): AgentSessionView {
    views.value[id] ??= { snapshot: null, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }
    // Reading back through the ref returns Vue's proxy, including on first use.
    return views.value[id]
  }
  function journal(id: string): Map<string, AgentEvent> {
    let events = journals.get(id)
    if (!events) { events = new Map(); journals.set(id, events) }
    return events
  }
  function resolvePermissions(): void {
    for (const [id, pending] of permissionRequests) {
      const permission = views.value[pending.sessionId]?.snapshot?.permissions.find(item => item.id === pending.permissionId)
      if (!permission || permission.state === "pending") continue
      // Buttons use the idempotent permission/respond command. Completing the
      // mirrored SDK callback must not impersonate this viewer as another voter.
      pending.resolve({ outcome: { outcome: "cancelled" } })
      permissionRequests.delete(id)
    }
  }
  function resolveElicitations(snapshot: AgentSnapshot): void {
    for (const elicitation of snapshot.elicitations) {
      if (elicitation.state === "pending") continue
      delete elicitationDrafts.value[elicitation.id]
      // A committed decision, including another viewer's, finishes this form.
      // Drop transient response payloads so secret answers are not retained.
      for (const operation of Object.values(operations.value)) {
        if (operation.sessionId === snapshot.session.id && operation.method === "_deskfleet/elicitation/respond" && operation.params.elicitationId === elicitation.id) delete operations.value[operation.operationId]
      }
    }
  }
  function completeOperation(operationId: string): void {
    const pending = operations.value[operationId]
    if (!pending) return
    if (pending.text !== undefined && pending.sessionId) {
      delete draftErrors.value[pending.sessionId]
      if ((drafts.value[pending.sessionId] ?? "") === pending.text
        && JSON.stringify(draftMentions.value[pending.sessionId] ?? []) === pending.mentionSnapshot) {
        drafts.value[pending.sessionId] = ""
        draftMentions.value[pending.sessionId] = []
      }
      draftAttachments.value[pending.sessionId] = (draftAttachments.value[pending.sessionId] ?? []).filter(item => !pending.attachmentIds?.includes(item.id))
    }
    delete operations.value[operationId]
  }
  function commandReceived(command: AgentCommand): void {
    const pending = operations.value[command.operationId]
    if (!pending) return
    if (command.status === "accepted") return
    if (command.status === "rejected" || command.status === "failed" || command.status === "uncertain") {
      pending.error = command.error ?? command.status
      return
    }
    // Keep create/fork results until their caller consumes them: a completion
    // event can precede a lost response, and the next attempt must find the same Session.
    if (pending.method === "_deskfleet/session/create" || pending.method === "_deskfleet/session/fork") {
      pending.result = command.result
      return
    }
    completeOperation(command.operationId)
  }
  function apply(event: AgentEvent, snapshot: AgentSnapshot): void {
    switch (event.kind) {
      case "session": snapshot.session = { ...event.payload as AgentSessionRecord }; break
      case "run": replace(snapshot.runs, event.payload as AgentRun, value => value.generation); break
      case "input": replace(snapshot.inputs, event.payload as AgentInput, value => value.id); break
      case "turn": replace(snapshot.turns, event.payload as AgentTurn, value => value.id); break
      case "permission": replace(snapshot.permissions, event.payload as AgentPermission, value => value.id); break
      case "elicitation": replace(snapshot.elicitations, event.payload as AgentElicitation, value => value.id); break
      case "command": commandReceived(event.payload as AgentCommand); break
    }
    snapshot.session.lastEventSeq = event.seq
  }
  function advance(id: string): void {
    const current = view(id)
    const events = journal(id)
    while (events.has((BigInt(current.historySeq) + 1n).toString())) current.historySeq = (BigInt(current.historySeq) + 1n).toString()
    if (!current.snapshot) return
    let next = events.get((BigInt(current.snapshotSeq) + 1n).toString())
    while (next) {
      apply(next, current.snapshot)
      current.snapshotSeq = next.seq
      next = events.get((BigInt(current.snapshotSeq) + 1n).toString())
    }
    if (sequenceCompare(current.snapshotSeq, sessions.value[id]?.lastEventSeq ?? "0") >= 0) sessions.value[id] = { ...current.snapshot.session }
    if (cache) { cacheDirty.add(id); if (!cacheTimer.isPending.value) cacheTimer.start() }
    resolvePermissions()
    resolveElicitations(current.snapshot)
  }
  function remember(events: AgentEvent[]): void {
    const changed = new Map<string, AgentEvent[]>()
    for (const event of events) {
      if (deletedSessions.has(event.sessionId)) continue
      if (journal(event.sessionId).has(event.seq)) continue
      markRaw(event)
      journal(event.sessionId).set(event.seq, event)
      if (sequenceCompare(event.seq, journalTails.get(event.sessionId) ?? "0") > 0) journalTails.set(event.sessionId, event.seq)
      if (event.kind === "session" && sequenceCompare(event.seq, sessions.value[event.sessionId]?.lastEventSeq ?? "0") >= 0) sessions.value[event.sessionId] = event.payload as AgentSessionRecord
      if (event.kind === "input") delete optimisticInputs.value[event.sessionId]
      if (event.kind === "command") commandReceived(event.payload as AgentCommand)
      if (event.kind === "run" && (event.payload as AgentRun).state === "starting"
        && sequenceCompare(event.seq, commandSequences.get(event.sessionId) ?? "0") > 0) {
        const current = configurations.value[event.sessionId]
        if (current) configurations.value[event.sessionId] = { ...current, commands: [], skills: [] }
        unclassifiedCommands.delete(event.sessionId)
        commandSequences.set(event.sessionId, event.seq)
      }
      if (event.kind === "acp" && "update" in event.payload && !isSubagentNotification(event.payload) && event.payload.update.sessionUpdate === "config_option_update"
        && sequenceCompare(event.seq, configurationSequences.get(event.sessionId) ?? "0") > 0) {
        const providerId = sessions.value[event.sessionId]?.provider ?? configurations.value[event.sessionId]?.provider.id
        const provider = providers.providers.find(provider => provider.id === providerId)
        configurations.value[event.sessionId] = { ...configurations.value[event.sessionId], ...normalizeAgentConfiguration(event.payload.update.configOptions, providerId ? {
          id: providerId, name: provider?.name ?? configurations.value[event.sessionId]?.provider.name ?? providerId,
        } : undefined) }
        configurationSequences.set(event.sessionId, event.seq)
      }
      if (event.kind === "acp" && "update" in event.payload && !isSubagentNotification(event.payload) && event.payload.update.sessionUpdate === "available_commands_update"
        && sequenceCompare(event.seq, commandSequences.get(event.sessionId) ?? "0") > 0) {
        projectCommands(event.sessionId, event.payload.update.availableCommands)
        commandSequences.set(event.sessionId, event.seq)
      }
      const additions = changed.get(event.sessionId) ?? []
      additions.push(event)
      changed.set(event.sessionId, additions)
    }
    for (const [id, additions] of changed) {
      const current = view(id)
      // A committed preview has exactly the same draft and sequence. Promote it
      // without replacing display history, even when a commit spans many frames.
      const visible = visiblePreviews.get(id)
      const appended = additions.filter(event => !visible?.delete(event.seq))
      let previous = current.events.at(-1)?.seq
      const ordered = appended.every(event => {
        const follows = previous === undefined || sequenceCompare(event.seq, previous) > 0
        previous = event.seq
        return follows
      })
      // Live notifications normally extend the journal; only late history needs a full merge.
      if (ordered && !retainedDisplays.has(id)) current.events.push(...appended)
      else if (retainedDisplays.has(id)) {
        const merged = new Map(current.events.map(event => [event.seq, event]))
        for (const event of journal(id).values()) merged.set(event.seq, event)
        current.events = [...merged.values()].sort((a, b) => sequenceCompare(a.seq, b.seq))
      } else {
        current.events = [...journal(id).values()].sort((left, right) => sequenceCompare(left.seq, right.seq))
        visiblePreviews.delete(id)
        retainedDisplays.delete(id)
      }
      advance(id)
      previews.committed(id, current.historySeq)
      appendPreview(id)
    }
  }
  function appendPreview(id: string): void {
    if (deletedSessions.has(id)) return
    const current = view(id)
    const events = previews.after(id, current.events.at(-1)?.seq ?? "0")
    if (events.length) {
      let visible = visiblePreviews.get(id)
      if (!visible) { visible = new Set(); visiblePreviews.set(id, visible) }
      for (const event of events) visible.add(event.seq)
      current.events.push(...events.map(event => markRaw(event)))
    }
  }
  function flushDisplay(recoverHistory = true): void {
    displayTimer.stop()
    const events = pendingEvents
    pendingEvents = []
    remember(events)
    for (const id of pendingPreviews) appendPreview(id)
    pendingPreviews.clear()
    if (!recoverHistory || disposed) return
    for (const id of new Set(events.map(event => event.sessionId))) {
      const current = views.value[id]
      if (current?.snapshot && sequenceCompare(current.historySeq, journalTails.get(id) ?? "0") < 0 && !current.loading) void readHistory(id).catch(() => {})
    }
  }
  function clearPreviews(): void {
    pendingPreviews.clear()
    visiblePreviews.clear()
    for (const id of previews.ids()) {
      previews.delete(id)
      if (views.value[id]) views.value[id]!.events = [...journal(id).values()].sort((left, right) => sequenceCompare(left.seq, right.seq))
    }
  }
  function snapshotReceived(snapshot: AgentSnapshot): void {
    if (deletedSessions.has(snapshot.session.id)) return
    const current = view(snapshot.session.id)
    if (sequenceCompare(snapshot.session.lastEventSeq, current.snapshotSeq) < 0) return
    if (snapshot.inputs.length) delete optimisticInputs.value[snapshot.session.id]
    current.snapshot = snapshot
    current.snapshotSeq = snapshot.session.lastEventSeq
    if (sequenceCompare(snapshot.session.lastEventSeq, sessions.value[snapshot.session.id]?.lastEventSeq ?? "0") >= 0) sessions.value[snapshot.session.id] = { ...snapshot.session }
    advance(snapshot.session.id)
  }

  const client = new AgentClient(api, (next, detail, relayReason) => {
    state.value = next
    refreshFailed = false
    error.value = detail ?? null
    relayDeniedReason.value = relayReason
    if (next === "error" || next === "idle") {
      flushDisplay(false)
      clearPreviews()
      initialized = null
      connectionGeneration++
      gitSubscriptions.clear()
      sessionPresence.value = {}
      live.clear()
      for (const pending of permissionRequests.values()) pending.resolve({ outcome: { outcome: "cancelled" } })
      permissionRequests.clear()
    }
  }, (notification: AgentNotification) => {
    if (notification.method === "_deskfleet/session/event") {
      const event = notification.params as AgentEvent
      pendingEvents.push(event)
      if (event.kind === "acp" && "update" in event.payload
        && ["agent_message_chunk", "agent_thought_chunk"].includes(event.payload.update.sessionUpdate)) {
        if (!displayTimer.isPending.value) displayTimer.start()
      } else flushDisplay()
    } else if (notification.method === "_deskfleet/session/live") {
      const update = notification.params as AgentLiveUpdate
      if (!deletedSessions.has(update.sessionId)) live.receive(update)
    } else if (notification.method === "_deskfleet/session/preview") {
      const preview = notification.params as AgentPreview
      if (!deletedSessions.has(preview.sessionId) && previews.receive(preview)) {
        pendingPreviews.add(preview.sessionId)
        if (!displayTimer.isPending.value) displayTimer.start()
      }
    } else if (notification.method === "_deskfleet/session/presence") {
      const update = notification.params as { sessionId: string; userIds: string[] }
      if (update.userIds.length) sessionPresence.value = { ...sessionPresence.value, [update.sessionId]: update.userIds }
      else {
        const next = { ...sessionPresence.value }
        delete next[update.sessionId]
        sessionPresence.value = next
      }
    } else if (notification.method === "_deskfleet/git/changed") {
      const change = notification.params as GitChangedNotification
      const subscription = gitSubscriptions.get(change.subscriptionId)
      if (subscription?.sessionId === change.sessionId) subscription.listener(change.error)
    } else if (notification.method === "$/cancel_request") {
      const id = String((notification.params as { requestId: string | number }).requestId)
      permissionRequests.get(id)?.resolve({ outcome: { outcome: "cancelled" } })
      permissionRequests.delete(id)
    }
    // session/update mirrors committed ACP journal events; consuming it again duplicates text.
  }, request => {
    if (request.method !== "session/request_permission") return Promise.reject(new Error("Unsupported client request"))
    const params = request.params as { sessionId: string; _meta?: { deskfleet?: { permissionId?: string } } }
    const permissionId = params._meta?.deskfleet?.permissionId
    if (!permissionId) return Promise.reject(new Error("Permission request is missing its durable identity"))
    return new Promise(resolve => {
      permissionRequests.set(String(request.id), { sessionId: params.sessionId, permissionId, resolve })
      resolvePermissions()
    })
  })

  function initialize(): Promise<void> {
    initialized ??= (async () => {
      await client.connect()
      await client.call("initialize", {
        protocolVersion: 1, clientInfo: { name: "deskfleet", title: "DeskFleet", version: "0.15.0" }, clientCapabilities: {},
      })
    })().catch(reason => { initialized = null; throw reason })
    return initialized
  }
  async function call<M extends AgentMethod>(method: M, params: AgentMethods[M]["params"]): Promise<AgentMethods[M]["result"]> {
    const requestParams = cloneFnJSON(params)
    const controlled = api.control?.(method, requestParams)
    if (controlled) return controlled
    const history = api.history
    if (history && !history.available() && state.value !== "connected") {
      const values = requestParams as { sessionId?: string; afterSeq?: string; limit?: number }
      if (method === "_deskfleet/session/list") return await history.list() as AgentMethods[M]["result"]
      if (method === "_deskfleet/session/subscribe") return await history.snapshot(values.sessionId!) as AgentMethods[M]["result"]
      if (method === "_deskfleet/session/history") return await history.events(values.sessionId!, values.afterSeq!, values.limit ?? 100) as AgentMethods[M]["result"]
      throw new Error("The machine is offline")
    }
    await initialize()
    return client.call<AgentMethods[M]["result"]>(method, requestParams)
  }
  function refresh(sessionId?: string): Promise<void> {
    refreshPending = true
    const list = (refreshing ??= (async () => {
      do {
        refreshPending = false
        try {
          await refreshList()
          if (refreshFailed) {
            refreshFailed = false
            error.value = null
            relayDeniedReason.value = undefined
          }
        } catch (reason) {
          // A newer notification still needs its own read after this request fails.
          // Central history recovery does not recover a failed live connection.
          if (!refreshPending && state.value !== "error") {
            refreshFailed = true
            error.value = messageOf(reason)
            relayDeniedReason.value = reason instanceof RelayConnectionError ? reason.relayDeniedReason : undefined
          }
        }
      } while (refreshPending && !disposed)
    })().finally(() => { refreshing = null }))
    return list.then(() => {
      const id = sessionId ?? activeSessionId
      if (id && id === activeSessionId && sessions.value[id]) return open(id, false)
    })
  }
  async function refreshList(): Promise<void> {
    const listedBefore = new Map(Object.values(sessions.value).map(session => [session.id, session.lastEventSeq]))
    // Catalog activity must not depend on opening every conversation's live channel.
    const records: (AgentSessionRecord & { working?: boolean | SessionActivity })[] = await (api.history ? api.history.list() : call("_deskfleet/session/list", {}))
    if (disposed) return
    const listed = new Set(records.map(session => session.id))
    let catalogSessions = new Set<string>()
    if (api.history && Object.keys(sessions.value).some(id => !listed.has(id))) {
      // Catalog and history uploads are independent. Missing retained history
      // cannot erase live metadata while the catalog still owns the Session.
      const catalog = await platformClient.catalog.list()
      if (disposed) return
      catalogSessions = new Set(catalog.sessionIds)
    }
    const received = new Map(records.filter(session => !deletedSessions.has(session.id)).map(session => [session.id, session]))
    for (const record of records) {
      if (deletedSessions.has(record.id)) continue
      const previous = activity.value[record.id]
      if (record.working !== undefined && (!previous || sequenceCompare(record.lastEventSeq, previous.seq) >= 0)) {
        activity.value[record.id] = { seq: record.lastEventSeq, working: record.working === true ? "working" : record.working }
      }
    }
    for (const current of Object.values(sessions.value)) {
      const record = received.get(current.id)
      if (record ? sequenceCompare(current.lastEventSeq, record.lastEventSeq) > 0 : catalogSessions.has(current.id) || !listedBefore.has(current.id) || sequenceCompare(current.lastEventSeq, listedBefore.get(current.id)!) > 0) received.set(current.id, current)
    }
    if (api.history) for (const id of listedBefore.keys()) {
      if (!received.has(id) && !catalogSessions.has(id)) forgetSession(id)
    }
    if (cache) void cache.retain([...received.keys(), ...catalogSessions])
    sessions.value = Object.fromEntries(received)
    for (const id of Object.keys(activity.value)) if (!received.has(id)) delete activity.value[id]
  }
  function isWorking(id: string): SessionActivity | false {
    const live = views.value[id]?.snapshot
    const summary = activity.value[id]
    if (summary && (!live || sequenceCompare(summary.seq, live.session.lastEventSeq) > 0)) return summary.working
    return snapshotIsWorking(live)
  }
  function readHistory(id: string): Promise<void> {
    const existing = reads.get(id)
    if (existing) return existing
    const reading = (async () => {
      for (;;) {
        const afterSeq = view(id).historySeq
        const events = await call("_deskfleet/session/history", { sessionId: id, afterSeq, limit: 100 })
        if (disposed || deletedSessions.has(id)) return
        remember(events)
        const current = view(id)
        const latest = journalTails.get(id) ?? "0"
        const target = sequenceCompare(latest, current.snapshotSeq) > 0 ? latest : current.snapshotSeq
        if (sequenceCompare(current.historySeq, target) >= 0) { current.error = null; current.relayDeniedReason = undefined; return }
        if (events.length === 0 || current.historySeq === afterSeq) throw new Error("Conversation history is incomplete; reconnect to load missing events")
      }
    })().catch(reason => {
      if (!deletedSessions.has(id)) {
        view(id).error = messageOf(reason)
        view(id).relayDeniedReason = reason instanceof RelayConnectionError ? reason.relayDeniedReason : undefined
      }
      throw reason
    }).finally(() => { reads.delete(id) })
    reads.set(id, reading)
    return reading
  }
  function open(id: string, showLoading = true): Promise<void> {
    if (deletedSessions.has(id)) return Promise.resolve()
    if (showLoading) activeSessionId = id
    const existing = loads.get(id)
    if (existing) return existing
    const current = view(id)
    if (showLoading) current.loading = !current.snapshot
    if (showLoading || !current.snapshot) current.syncing = true
    current.error = null
    current.relayDeniedReason = undefined
    let liveSnapshot = false
    let cachedShown = false
    const cached = !current.snapshot ? cache?.read(id).then(value => {
      if (!value || disposed || deletedSessions.has(id) || liveSnapshot || current.snapshot) return
      cachedShown = true
      current.snapshot = value.snapshot
      current.events = value.events.map(event => markRaw(event))
      retainedDisplays.add(id)
      current.loading = false
    }) : undefined
    const history = api.history
    // Retained data is a display projection only: it must not advance the
    // daemon cursor or win duplicate sequence numbers against its journal.
    const retained = !current.snapshot && history?.parallel?.() && history.available() ? (async () => {
      const snapshot = await history.snapshot(id)
      const events: AgentEvent[] = []
      let after = "0"
      while (!disposed && !deletedSessions.has(id) && !liveSnapshot) {
        const page = await history.events(id, after, 100)
        if (disposed || deletedSessions.has(id) || liveSnapshot) return
        events.push(...page)
        if (journal(id).size === 0 && !cachedShown) {
          current.snapshot = snapshot
          current.events = [...events]
          retainedDisplays.add(id)
          current.loading = false
        }
        const next = page.at(-1)?.seq
        if (!next || sequenceCompare(next, after) <= 0 || sequenceCompare(next, snapshot.session.lastEventSeq) >= 0) return
        after = next
      }
    })().catch(() => {}) : undefined
    const loading = (async () => {
      const snapshot = await call("_deskfleet/session/subscribe", { sessionId: id })
      if (disposed || deletedSessions.has(id)) return
      liveSnapshot = true
      snapshotReceived(snapshot)
      await readHistory(id)
      if (retainedDisplays.delete(id)) current.events = [...journal(id).values()].sort((a, b) => sequenceCompare(a.seq, b.seq))
      if (cache) { cacheDirty.add(id); if (!cacheTimer.isPending.value) cacheTimer.start() }
      await reconcileOperations(id)
    })().catch(async reason => {
      await cached
      await retained
      current.error = messageOf(reason)
      current.relayDeniedReason = reason instanceof RelayConnectionError ? reason.relayDeniedReason : undefined
    }).finally(() => { current.loading = false; current.syncing = false; loads.delete(id) })
    loads.set(id, loading)
    return loading
  }
  async function reconcileOperations(id: string): Promise<void> {
    for (const pending of Object.values(operations.value).filter(value => value.sessionId === id)) {
      const command = await call("_deskfleet/command/get", { operationId: pending.operationId })
      if (command) commandReceived(command)
    }
  }
  async function attend(sessionId: string): Promise<boolean> {
    if (state.value !== "connected") return false
    const generation = connectionGeneration
    const attempt = ++attendanceAttempt
    try {
      const controlled = api.control?.("_deskfleet/session/attend", { sessionId })
      if (controlled) await controlled
      else {
        await initialize()
        // call() would reconnect and send this attempt on the replacement channel.
        if (attempt !== attendanceAttempt || generation !== connectionGeneration || state.value !== "connected") return false
        await client.call("_deskfleet/session/attend", { sessionId })
      }
      const current = attempt === attendanceAttempt && generation === connectionGeneration && state.value === "connected"
      if (current) return true
      // This attempt registered on a channel the view no longer owns, and nothing newer replaced it.
      if (attempt === attendanceAttempt && state.value === "connected") {
        try { await client.call("_deskfleet/session/leave", { sessionId }) } catch { /* The replacement channel already dropped this viewer. */ }
      }
      return false
    } catch {
      return false
    }
  }
  async function leave(sessionId: string): Promise<void> {
    const generation = connectionGeneration
    if (state.value !== "connected") return
    try {
      const controlled = api.control?.("_deskfleet/session/leave", { sessionId })
      if (controlled) { await controlled; return }
      await initialize()
      if (generation !== connectionGeneration || state.value !== "connected") return
      await client.call("_deskfleet/session/leave", { sessionId })
    } catch { /* A closed channel already removed this viewer. */ }
  }
  async function mutation<M extends Exclude<AgentMethod, "_deskfleet/session/list" | "_deskfleet/session/subscribe" | "_deskfleet/session/history" | "_deskfleet/command/get" | "_deskfleet/agent/configuration" | "_deskfleet/agent/usage" | "_deskfleet/session/configuration" | "_deskfleet/git/branches" | "_deskfleet/git/prepare" | "_deskfleet/git/status" | "_deskfleet/git/diff" | "_deskfleet/git/subscribe" | "_deskfleet/git/unsubscribe" | "_deskfleet/session/attend" | "_deskfleet/session/leave" | "_deskfleet/composer/references" | "_deskfleet/composer/resolve">>(
    method: M, params: Omit<AgentMethods[M]["params"], "operationId">, text?: string, submittedDraft?: SubmittedAgentDraft,
  ): Promise<AgentMethods[M]["result"]> {
    const operationId = crypto.randomUUID()
    const requestParams = markRaw(cloneFnJSON({ ...params, operationId }))
    const sessionId = "sessionId" in requestParams ? requestParams.sessionId as string : undefined
    operations.value[operationId] = { operationId, sessionId, method, text,
      ...(text !== undefined && sessionId ? {
        attachmentIds: submittedDraft ? [...submittedDraft.attachmentIds] : (draftAttachments.value[sessionId] ?? []).map(item => item.id),
        mentionSnapshot: JSON.stringify(submittedDraft?.mentions ?? draftMentions.value[sessionId] ?? []),
      } : {}),
      workspaceId: "workspaceId" in requestParams ? requestParams.workspaceId as string : undefined, params: requestParams }
    try {
      const result = await call(method, requestParams as AgentMethods[M]["params"])
      completeOperation(operationId)
      return result
    } catch (reason) {
      const pending = operations.value[operationId]
      if (pending?.result && (pending.method === "_deskfleet/session/create" || pending.method === "_deskfleet/session/fork")) {
        const result = await resolveCommandResult(pending.result)
        completeOperation(operationId)
        return result as AgentMethods[M]["result"]
      }
      if (pending) pending.error = messageOf(reason)
      throw reason
    }
  }
  async function resolveCommandResult(result: unknown): Promise<unknown> {
    return isSnapshotReference(result) ? call("_deskfleet/session/subscribe", { sessionId: result.sessionId }) : result
  }
  async function checkOperation(operationId: string): Promise<unknown> {
    const pending = operations.value[operationId]
    if (!pending) return
    const received = async (result: unknown): Promise<unknown> => {
      const resolved = await resolveCommandResult(result)
      if (isSnapshotReference(result) || pending.method === "_deskfleet/session/fork" || pending.method === "_deskfleet/session/rename" || pending.method === "_deskfleet/session/yolo" || pending.method === "_deskfleet/session/read" || pending.method === "_deskfleet/session/unread") snapshotReceived(resolved as AgentSnapshot)
      completeOperation(operationId)
      return resolved
    }
    try {
      if (pending.result) return await received(pending.result)
      const command = await call("_deskfleet/command/get", { operationId })
      if (command && ["failed", "rejected", "uncertain"].includes(command.status)) {
        delete operations.value[operationId]
        throw new Error(command.error ?? command.status)
      }
      if (command?.status === "completed") {
        pending.result = command.result
        return await received(command.result)
      }
      // Reuse the exact request identity when the first response was lost. The
      // daemon serializes duplicates, including a request still being accepted.
      const result = await call(pending.method, pending.params as AgentMethods[typeof pending.method]["params"])
      return await received(result)
    } finally {
      if (pending.sessionId && state.value === "connected") await open(pending.sessionId)
    }
  }

  async function agentConfiguration(params: AgentSelection & { workspaceId?: string; probeId?: string; composer?: boolean; restore?: Omit<AgentSelection, "provider"> }): Promise<AgentConfiguration> {
    const result = await call("_deskfleet/agent/configuration", params)
    if (!result) throw new Error("Agent configuration is unavailable")
    return result
  }
  async function releaseAgentConfiguration(params: { provider: string; workspaceId?: string; probeId: string }): Promise<void> {
    await call("_deskfleet/agent/configuration", { ...params, release: true })
  }
  const agentUsage = (provider: string) => call("_deskfleet/agent/usage", { provider })
  function configurationEpoch(sessionId: string): number {
    return configurationEpochs.get(sessionId) ?? 0
  }
  function emptyConfiguration(providerId: string | undefined): AgentConfiguration {
    const id = providerId ?? ""
    return normalizeAgentConfiguration([], { id, name: providers.providers.find(provider => provider.id === id)?.name ?? id })
  }
  function mergeConfiguration(sessionId: string, result: AgentConfiguration, sequence: string | undefined, commands: string | undefined, epoch: number): AgentConfiguration {
    const expected = sessions.value[sessionId]?.provider
    // A response for the replaced Agent must not overwrite the new provider's state,
    // including when its request started before the switch was confirmed.
    if (epoch !== configurationEpoch(sessionId) || expected !== undefined && result.provider.id !== expected) {
      const latest = configurations.value[sessionId]
      return latest && (expected === undefined || latest.provider.id === expected) ? latest : emptyConfiguration(expected)
    }
    const latest = configurations.value[sessionId]
    const catalog = commands === commandSequences.get(sessionId) ? result : latest ?? result
    if (catalog === result) unclassifiedCommands.delete(sessionId)
    configurations.value[sessionId] = {
      ...(sequence === configurationSequences.get(sessionId) ? result : latest ?? result),
      commands: catalog.commands, skills: catalog.skills,
    }
    return configurations.value[sessionId]!
  }
  function sessionConfiguration(sessionId: string, composer = false): Promise<AgentConfiguration> {
    const epoch = configurationEpoch(sessionId)
    const key = `${sessionId}:${epoch}:${composer}`
    const current = configurationReads.get(key)
    if (current) return current
    const sequence = configurationSequences.get(sessionId)
    const commands = commandSequences.get(sessionId)
    const reading = call("_deskfleet/session/configuration", { sessionId, ...(composer ? { composer } : {}) })
      .then(result => mergeConfiguration(sessionId, result, sequence, commands, epoch))
      .finally(() => { configurationReads.delete(key) })
    configurationReads.set(key, reading)
    return reading
  }
  async function configureSession(sessionId: string, choices: Omit<AgentSelection, "provider">): Promise<AgentConfiguration> {
    const epoch = configurationEpoch(sessionId)
    const sequence = configurationSequences.get(sessionId)
    const commands = commandSequences.get(sessionId)
    const result = await mutation("_deskfleet/session/configure", { sessionId, ...choices })
    return mergeConfiguration(sessionId, result, sequence, commands, epoch)
  }
  /** Replace a stopped Session's Agent; its previous conversation context is not transferred. */
  async function switchAgent(sessionId: string, provider: string): Promise<void> {
    // Fence reads that started before the user confirmed the replacement.
    configurationEpochs.set(sessionId, configurationEpoch(sessionId) + 1)
    snapshotReceived(await mutation("_deskfleet/session/switch-agent", { sessionId, provider }))
    // The previous Agent's catalog and command list do not describe the replacement.
    // Keep values already projected from the new provider's live events.
    if (configurations.value[sessionId]?.provider.id !== provider) {
      delete configurations.value[sessionId]
      configurationSequences.delete(sessionId)
      commandSequences.delete(sessionId)
      unclassifiedCommands.delete(sessionId)
    }
  }
  async function capacityAction(action: "create" | "fork" | "restore", details: SessionCapacityDetails, run: () => Promise<AgentSnapshot>, track: ReturnType<typeof captureAnalyticsContext>): Promise<AgentSnapshot> {
    track("session_capacity_action", { action, outcome: "attempt", ...details })
    try {
      const snapshot = await run()
      track("session_capacity_action", { action, outcome: "success", context: snapshot.session.context, scope: snapshot.session.workspaceId ? "workspace" : "machine" })
      return snapshot
    } catch (reason) {
      track("session_capacity_action", { action, outcome: "failure", ...details })
      throw reason
    }
  }
  async function create(workspaceId: string | undefined, title: string, context: AgentSessionContext, provider: string, baseBranch?: string, baseRevisions?: AgentMethods["_deskfleet/session/create"]["params"]["baseRevisions"], enableYolo = draftYolo.value, options?: { deferStartup?: boolean; cwd?: string }): Promise<AgentSnapshot> {
    const track = captureAnalyticsContext()
    const pending = Object.values(operations.value).find(operation => operation.method === "_deskfleet/session/create" && operation.workspaceId === workspaceId)
    const choices = draftConfiguration.value.provider === provider ? draftConfiguration.value : undefined
    const revisions = workspaceId && context === "worktree" && baseRevisions ? cloneFnJSON(baseRevisions) : undefined
    const branch = !revisions && workspaceId && context === "worktree" && baseBranch?.trim() ? baseBranch.trim() : undefined
    const cwd = context === "directory" && options?.cwd?.trim() ? options.cwd.trim() : undefined
    const params: Omit<AgentMethods["_deskfleet/session/create"]["params"], "operationId"> = {
      ...(workspaceId ? { workspaceId } : {}), title, provider, context, ...(cwd ? { cwd } : {}), ...(branch ? { baseBranch: branch } : {}), ...(revisions ? { baseRevisions: revisions } : {}), ...(options?.deferStartup ? { deferStartup: true } : {}), ...(enableYolo ? { yolo: true } : {}), model: choices?.model, reasoningEffort: choices?.reasoningEffort, mode: choices?.mode, configValues: choices?.configValues,
    }
    const snapshot = await capacityAction("create", { context, scope: workspaceId ? "workspace" : "machine" }, async () => {
      if (pending) {
        if (pending.result) return await checkOperation(pending.operationId) as AgentSnapshot
        const command = await call("_deskfleet/command/get", { operationId: pending.operationId })
        if (command?.status === "completed") {
          pending.result = command.result
          return await checkOperation(pending.operationId) as AgentSnapshot
        }
        if (command?.status === "accepted" || !command && JSON.stringify({ ...params, operationId: pending.operationId }) === JSON.stringify(pending.params)) {
          try {
            const result = await call(pending.method, pending.params as AgentMethods[typeof pending.method]["params"]) as AgentSnapshot
            completeOperation(pending.operationId)
            return result
          } catch (reason) {
            if (pending.result) return await checkOperation(pending.operationId) as AgentSnapshot
            pending.error = messageOf(reason)
            throw reason
          }
        }
        delete operations.value[pending.operationId]
      }
      return mutation("_deskfleet/session/create", params)
    }, track)
    draftYolo.value = false
    snapshotReceived(snapshot)
    track("session_created", { context: snapshot.session.context, scope: snapshot.session.workspaceId ? "workspace" : "machine" })
    return snapshot
  }
  async function fork(sessionId: string, context: AgentSessionContext): Promise<AgentSnapshot> {
    const track = captureAnalyticsContext()
    const pending = Object.values(operations.value).find(operation => operation.method === "_deskfleet/session/fork" && operation.sessionId === sessionId)
    const source = sessions.value[sessionId]
    const snapshot = await capacityAction("fork", { context, ...(source ? { scope: source.workspaceId ? "workspace" : "machine" } as const : {}) }, () => pending ? checkOperation(pending.operationId) as Promise<AgentSnapshot> : mutation("_deskfleet/session/fork", { sessionId, context }), track)
    snapshotReceived(snapshot)
    track("session_forked", { context: snapshot.session.context })
    return snapshot
  }
  const submit = async (sessionId: string, content: string | AgentInput["content"], delivery: "backlog" | "steer", turnId?: string, draftText?: string, submittedDraft?: SubmittedAgentDraft) => {
    const track = captureAnalyticsContext()
    const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content
    const trackedText = draftText ?? (typeof content === "string" ? content : (drafts.value[sessionId] ?? ""))
    track("input_submit_action", { outcome: "attempt", delivery })
    try {
      const result = await mutation("_deskfleet/input/submit", {
        sessionId, content: blocks, delivery, ...(turnId ? { turnId } : {}),
      }, trackedText, submittedDraft)
      track("input_submit_action", { outcome: "success", delivery })
      track("input_submitted", { delivery })
      return result
    } catch (reason) {
      track("input_submit_action", { outcome: "failure", delivery })
      throw reason
    }
  }
  const steer = (sessionId: string, inputId: string, turnId: string) => mutation("_deskfleet/input/steer", { sessionId, inputId, turnId })
  const withdraw = (sessionId: string, inputId: string) => mutation("_deskfleet/input/withdraw", { sessionId, inputId })
  const retry = (sessionId: string, inputId: string) => mutation("_deskfleet/input/retry", { sessionId, inputId })
  const cancel = (sessionId: string, turnId: string) => mutation("_deskfleet/turn/cancel", { sessionId, turnId })
  async function respond(sessionId: string, permissionId: string, optionId: string): Promise<void> {
    const permission = await mutation("_deskfleet/permission/respond", { sessionId, permissionId, optionId })
    const snapshot = view(sessionId).snapshot
    if (snapshot) replace(snapshot.permissions, permission, value => value.id)
    resolvePermissions()
  }
  async function respondToElicitation(sessionId: string, elicitationId: string, response: NonNullable<AgentElicitation["response"]>): Promise<void> {
    if (view(sessionId).snapshot?.elicitations.find(item => item.id === elicitationId)?.state !== "pending") return
    if (Object.values(operations.value).some(operation => operation.sessionId === sessionId && operation.method === "_deskfleet/elicitation/respond" && operation.params.elicitationId === elicitationId)) return
    const elicitation = await mutation("_deskfleet/elicitation/respond", { sessionId, elicitationId, response })
    const snapshot = view(sessionId).snapshot
    if (snapshot) {
      const current = snapshot.elicitations.find(item => item.id === elicitation.id && item.runGeneration === elicitation.runGeneration)
      if (current?.completedAt && !elicitation.completedAt) elicitation.completedAt = current.completedAt
      replace(snapshot.elicitations, elicitation, value => value.id)
      resolveElicitations(snapshot)
    }
  }
  async function stop(sessionId: string): Promise<void> { snapshotReceived(await mutation("_deskfleet/session/stop", { sessionId })) }
  async function markRead(sessionId: string, throughSeq: string): Promise<void> {
    const pending = Object.values(operations.value).find(operation => operation.method === "_deskfleet/session/read"
      && operation.sessionId === sessionId && operation.params.throughSeq === throughSeq)
    if (pending) {
      if (!pending.error) return
      delete pending.error
      try {
        snapshotReceived(await call("_deskfleet/session/read", { sessionId, throughSeq, operationId: pending.operationId }))
        completeOperation(pending.operationId)
      } catch (reason) { pending.error = messageOf(reason); throw reason }
      return
    }
    snapshotReceived(await mutation("_deskfleet/session/read", { sessionId, throughSeq }))
  }
  async function markUnread(sessionId: string): Promise<void> {
    const pending = Object.values(operations.value).find(operation => operation.method === "_deskfleet/session/unread" && operation.sessionId === sessionId)
    if (pending) {
      if (!pending.error) return
      delete pending.error
      try {
        snapshotReceived(await call("_deskfleet/session/unread", { sessionId, operationId: pending.operationId }))
        completeOperation(pending.operationId)
      } catch (reason) { pending.error = messageOf(reason); throw reason }
      return
    }
    snapshotReceived(await mutation("_deskfleet/session/unread", { sessionId }))
  }
  async function rename(sessionId: string, title: string): Promise<void> {
    const pending = Object.values(operations.value).find(operation => operation.method === "_deskfleet/session/rename"
      && operation.sessionId === sessionId && operation.params.title === title)
    if (pending) {
      await checkOperation(pending.operationId)
      return
    }
    snapshotReceived(await mutation("_deskfleet/session/rename", { sessionId, title }))
  }
  async function setYolo(sessionId: string, enabled: boolean): Promise<void> {
    const pending = Object.values(operations.value).find(
      operation =>
        operation.method === "_deskfleet/session/yolo"
        && operation.sessionId === sessionId
        && operation.params.enabled === enabled,
    )
    if (pending) {
      await checkOperation(pending.operationId)
      return
    }
    snapshotReceived(await mutation("_deskfleet/session/yolo", { sessionId, enabled }))
  }
  async function archive(sessionId: string): Promise<void> {
    const track = captureAnalyticsContext()
    snapshotReceived(await mutation("_deskfleet/session/archive", { sessionId }))
    track("session_archived", {})
  }
  async function restore(sessionId: string): Promise<void> {
    const track = captureAnalyticsContext()
    const session = sessions.value[sessionId]
    snapshotReceived(await capacityAction("restore", session ? { context: session.context, scope: session.workspaceId ? "workspace" : "machine" } : {}, () => mutation("_deskfleet/session/restore", { sessionId }), track))
    track("session_restored", {})
  }
  async function remove(sessionId: string): Promise<void> {
    await mutation("_deskfleet/session/delete", { sessionId })
    // Only an acknowledged deletion can exclude future snapshots and events.
    deletedSessions.add(sessionId)
    forgetSession(sessionId)
  }
  function forgetSession(sessionId: string): void {
    cacheDirty.delete(sessionId)
    void cache?.remove(sessionId)
    for (const elicitation of views.value[sessionId]?.snapshot?.elicitations ?? []) delete elicitationDrafts.value[elicitation.id]
    delete sessions.value[sessionId]
    delete activity.value[sessionId]
    delete views.value[sessionId]
    delete optimisticInputs.value[sessionId]
    delete configurations.value[sessionId]
    configurationSequences.delete(sessionId)
    journals.delete(sessionId)
    journalTails.delete(sessionId)
    previews.delete(sessionId)
    live.remove(sessionId)
    visiblePreviews.delete(sessionId)
  }
  const gitBranches = (workspaceId: string) => call("_deskfleet/git/branches", { workspaceId })
  const prepareGit = (workspaceId: string, context: AgentSessionContext, confirmationToken?: string) => call("_deskfleet/git/prepare", { workspaceId, context, ...(confirmationToken ? { confirmationToken } : {}) })
  const gitStatus = (sessionId: string, force = false) => call("_deskfleet/git/status", { sessionId, ...(force ? { force } : {}) })
  const composerReferences = (params: ComposerReferenceSearch) => call("_deskfleet/composer/references", params)
  const resolveComposerReferences = (sessionId: string, references: ComposerReference[]) => call("_deskfleet/composer/resolve", { sessionId, references })
  const gitDiff = (request: GitDiffRequest) => call("_deskfleet/git/diff", request)
  async function watchGit(sessionId: string, listener: (error?: string) => void): Promise<() => void> {
    const subscriptionId = crypto.randomUUID()
    const generation = connectionGeneration
    const subscription = { sessionId, listener }
    gitSubscriptions.set(subscriptionId, subscription)
    const stop = () => {
      if (gitSubscriptions.get(subscriptionId) !== subscription) return
      gitSubscriptions.delete(subscriptionId)
      // A released view must never reconnect merely to remove an old subscription.
      if (!disposed && generation === connectionGeneration && state.value === "connected") {
        void client.call("_deskfleet/git/unsubscribe", { subscriptionId }).catch(() => {})
      }
    }
    try {
      await call("_deskfleet/git/subscribe", { sessionId, subscriptionId })
      return stop
    } catch (reason) {
      stop()
      throw reason
    }
  }
  const closeTransport = () => { flushDisplay(false); clearPreviews(); client.close() }
  onScopeDispose(() => { cacheTimer.stop(); persistConversations(); disposed = true; displayTimer.stop(); pendingEvents = []; pendingPreviews.clear(); gitSubscriptions.clear(); closeTransport() })
  return { notices: live.notices, authStatuses: live.authStatuses, dismissNotice: live.dismiss, sessions, views, isWorking, drafts, draftAttachments, draftMentions, draftErrors, preparingDrafts, optimisticInputs, elicitationDrafts, draftConfiguration, draftYolo, configurations, agentConfiguration, releaseAgentConfiguration, agentUsage, sessionConfiguration, configureSession, switchAgent, state, error, relayDeniedReason, operations, sessionPresence, refresh, open, attend, leave, markRead, markUnread, checkOperation, create, fork, submit, steer, withdraw, retry, cancel, respond, respondToElicitation, stop, rename, setYolo, archive, restore, remove, composerReferences, resolveComposerReferences, gitBranches, prepareGit, gitStatus, gitDiff, watchGit, closeTransport }
})
