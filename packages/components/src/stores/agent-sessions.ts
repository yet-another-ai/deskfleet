import { client as platformClient } from "@deskfleet/client/platform"
import { useLocalStorage } from "@vueuse/core"
import { defineStore } from "pinia"
import { onScopeDispose, ref, watch } from "vue"
import type { AgentCommand, AgentElicitation, AgentEvent, AgentInput, AgentMethod, AgentMethods, AgentPermission, AgentRun, AgentSessionContext, AgentSessionRecord, AgentSnapshot, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"
import type { ElicitationDraft } from "../services/agent-elicitation.ts"
import type { ComposerAttachment } from "../services/composer-attachments.ts"
import type { ComposerMention } from "../services/composer-mentions.ts"
import type { ComposerReference, ComposerReferenceSearch } from "../../../../apps/daemon/src/composer-reference-protocol.ts"
import { agentComposerCatalog, agentConfiguration as normalizeAgentConfiguration } from "../../../../apps/daemon/src/agent-configuration-protocol.ts"
import type { AgentConfiguration } from "../../../client/src/agent-configuration.ts"
import type { GitChangedNotification, GitDiffRequest } from "../../../../apps/daemon/src/git-protocol.ts"
import { useProvidersStore } from "./providers.ts"
import { AgentClient, type AgentConnectionState, type AgentNotification } from "../services/agent-client.ts"

export interface AgentSelection { provider: string; model?: string; reasoningEffort?: string; mode?: string }

export interface AgentSessionView {
  snapshot: AgentSnapshot | null
  events: AgentEvent[]
  loading: boolean
  error: string | null
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
  const api = platformClient.agent
  const providers = useProvidersStore()
  const sessions = ref<Record<string, AgentSessionRecord>>({})
  const views = ref<Record<string, AgentSessionView>>({})
  const drafts = ref<Record<string, string>>({})
  const draftAttachments = ref<Record<string, ComposerAttachment[]>>({})
  const draftMentions = ref<Record<string, ComposerMention[]>>({})
  const draftErrors = ref<Record<string, string>>({})
  const preparingDrafts = ref<Record<string, boolean>>({})
  const elicitationDrafts = ref<Record<string, ElicitationDraft>>({})
  const draftConfiguration = useLocalStorage<AgentSelection>("deskfleet.agent-configuration", { provider: "codex" })
  const configurations = ref<Record<string, AgentConfiguration>>({})
  const configurationReads = new Map<string, Promise<AgentConfiguration>>()
  const configurationSequences = new Map<string, string>()
  const commandSequences = new Map<string, string>()
  const unclassifiedCommands = new Map<string, Parameters<typeof agentComposerCatalog>[0]>()
  const state = ref<AgentConnectionState>("idle")
  const error = ref<string | null>(null)
  const operations = ref<Record<string, PendingAgentOperation>>({})
  const journals = new Map<string, Map<string, AgentEvent>>()
  const loads = new Map<string, Promise<void>>()
  const reads = new Map<string, Promise<void>>()
  const permissionRequests = new Map<string, { sessionId: string; permissionId: string; resolve(value: unknown): void }>()
  const gitSubscriptions = new Map<string, { sessionId: string; listener(error?: string): void }>()
  let connectionGeneration = 0
  let initialized: Promise<void> | null = null
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
    // Keep a fork's result until its caller consumes it: a completion event can
    // precede a lost response, and the next attempt must find the same Session.
    if (pending.method === "_deskfleet/session/fork") { pending.result = command.result; return }
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
    sessions.value[event.sessionId] = { ...snapshot.session }
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
    resolvePermissions()
    resolveElicitations(current.snapshot)
  }
  function remember(events: AgentEvent[]): void {
    const changed = new Set<string>()
    for (const event of events) {
      if (journal(event.sessionId).has(event.seq)) continue
      journal(event.sessionId).set(event.seq, event)
      if (event.kind === "session" && sequenceCompare(event.seq, sessions.value[event.sessionId]?.lastEventSeq ?? "0") >= 0) sessions.value[event.sessionId] = event.payload as AgentSessionRecord
      if (event.kind === "command") commandReceived(event.payload as AgentCommand)
      if (event.kind === "run" && (event.payload as AgentRun).state === "starting"
        && sequenceCompare(event.seq, commandSequences.get(event.sessionId) ?? "0") > 0) {
        const current = configurations.value[event.sessionId]
        if (current) configurations.value[event.sessionId] = { ...current, commands: [], skills: [] }
        unclassifiedCommands.delete(event.sessionId)
        commandSequences.set(event.sessionId, event.seq)
      }
      if (event.kind === "acp" && "update" in event.payload && event.payload.update.sessionUpdate === "config_option_update"
        && sequenceCompare(event.seq, configurationSequences.get(event.sessionId) ?? "0") > 0) {
        const providerId = sessions.value[event.sessionId]?.provider ?? configurations.value[event.sessionId]?.provider.id
        const provider = providers.providers.find(provider => provider.id === providerId)
        configurations.value[event.sessionId] = { ...configurations.value[event.sessionId], ...normalizeAgentConfiguration(event.payload.update.configOptions, providerId ? {
          id: providerId, name: provider?.name ?? configurations.value[event.sessionId]?.provider.name ?? providerId,
        } : undefined) }
        configurationSequences.set(event.sessionId, event.seq)
      }
      if (event.kind === "acp" && "update" in event.payload && event.payload.update.sessionUpdate === "available_commands_update"
        && sequenceCompare(event.seq, commandSequences.get(event.sessionId) ?? "0") > 0) {
        projectCommands(event.sessionId, event.payload.update.availableCommands)
        commandSequences.set(event.sessionId, event.seq)
      }
      changed.add(event.sessionId)
    }
    for (const id of changed) {
      view(id).events = [...journal(id).values()].sort((left, right) => sequenceCompare(left.seq, right.seq))
      advance(id)
    }
  }
  function snapshotReceived(snapshot: AgentSnapshot): void {
    const current = view(snapshot.session.id)
    if (sequenceCompare(snapshot.session.lastEventSeq, current.snapshotSeq) < 0) return
    current.snapshot = snapshot
    current.snapshotSeq = snapshot.session.lastEventSeq
    sessions.value[snapshot.session.id] = { ...snapshot.session }
    advance(snapshot.session.id)
  }

  const client = new AgentClient(api, (next, detail) => {
    state.value = next
    error.value = detail ?? null
    if (next === "error" || next === "idle") {
      initialized = null
      connectionGeneration++
      gitSubscriptions.clear()
      for (const pending of permissionRequests.values()) pending.resolve({ outcome: { outcome: "cancelled" } })
      permissionRequests.clear()
    }
  }, (notification: AgentNotification) => {
    if (notification.method === "_deskfleet/session/event") {
      const event = notification.params as AgentEvent
      remember([event])
      const current = views.value[event.sessionId]
      if (current?.snapshot && sequenceCompare(current.historySeq, event.seq) < 0 && !current.loading) void readHistory(event.sessionId).catch(() => {})
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
        protocolVersion: 1, clientInfo: { name: "deskfleet", version: "0.1.0" }, clientCapabilities: {},
      })
    })().catch(reason => { initialized = null; throw reason })
    return initialized
  }
  async function call<M extends AgentMethod>(method: M, params: AgentMethods[M]["params"]): Promise<AgentMethods[M]["result"]> {
    const controlled = api.control?.(method, params)
    if (controlled) return controlled
    const history = api.history
    if (history && !history.available() && state.value !== "connected") {
      const values = params as { sessionId?: string; afterSeq?: string; limit?: number }
      if (method === "_deskfleet/session/list") return await history.list() as AgentMethods[M]["result"]
      if (method === "_deskfleet/session/subscribe") return await history.snapshot(values.sessionId!) as AgentMethods[M]["result"]
      if (method === "_deskfleet/session/history") return await history.events(values.sessionId!, values.afterSeq!, values.limit ?? 100) as AgentMethods[M]["result"]
      throw new Error("The machine is offline")
    }
    await initialize()
    return client.call<AgentMethods[M]["result"]>(method, params)
  }
  function refresh(sessionId?: string): Promise<void> {
    const listedBefore = new Map(Object.values(sessions.value).map(session => [session.id, session.lastEventSeq]))
    const list = (refreshing ??= call("_deskfleet/session/list", {}).then(records => {
      const received = new Map(records.map(session => [session.id, session]))
      for (const current of Object.values(sessions.value)) {
        const record = received.get(current.id)
        if (record ? sequenceCompare(current.lastEventSeq, record.lastEventSeq) > 0 : !listedBefore.has(current.id) || sequenceCompare(current.lastEventSeq, listedBefore.get(current.id)!) > 0) received.set(current.id, current)
      }
      sessions.value = Object.fromEntries(received)
    }).catch(reason => { error.value = messageOf(reason) }).finally(() => { refreshing = null }))
    return list.then(() => {
      const id = sessionId ?? activeSessionId
      if (id && id === activeSessionId && sessions.value[id]) return open(id, false)
    })
  }
  function readHistory(id: string): Promise<void> {
    const existing = reads.get(id)
    if (existing) return existing
    const reading = (async () => {
      for (;;) {
        const afterSeq = view(id).historySeq
        const events = await call("_deskfleet/session/history", { sessionId: id, afterSeq, limit: 100 })
        if (disposed) return
        remember(events)
        const current = view(id)
        const latest = current.events.at(-1)?.seq ?? "0"
        const target = sequenceCompare(latest, current.snapshotSeq) > 0 ? latest : current.snapshotSeq
        if (sequenceCompare(current.historySeq, target) >= 0) { current.error = null; return }
        if (events.length === 0 || current.historySeq === afterSeq) throw new Error("Conversation history is incomplete; reconnect to load missing events")
      }
    })().catch(reason => { view(id).error = messageOf(reason); throw reason }).finally(() => { reads.delete(id) })
    reads.set(id, reading)
    return reading
  }
  function open(id: string, showLoading = true): Promise<void> {
    if (showLoading) activeSessionId = id
    const existing = loads.get(id)
    if (existing) return existing
    const current = view(id)
    if (showLoading) current.loading = true
    current.error = null
    const loading = (async () => {
      snapshotReceived(await call("_deskfleet/session/subscribe", { sessionId: id }))
      await readHistory(id)
      await reconcileOperations(id)
    })().catch(reason => { current.error = messageOf(reason) }).finally(() => { current.loading = false; loads.delete(id) })
    loads.set(id, loading)
    return loading
  }
  async function reconcileOperations(id: string): Promise<void> {
    for (const pending of Object.values(operations.value).filter(value => value.sessionId === id)) {
      const command = await call("_deskfleet/command/get", { operationId: pending.operationId })
      if (command) commandReceived(command)
    }
  }
  async function mutation<M extends Exclude<AgentMethod, "_deskfleet/session/list" | "_deskfleet/session/subscribe" | "_deskfleet/session/history" | "_deskfleet/command/get" | "_deskfleet/agent/configuration" | "_deskfleet/session/configuration" | "_deskfleet/git/status" | "_deskfleet/git/diff" | "_deskfleet/git/subscribe" | "_deskfleet/git/unsubscribe" | "_deskfleet/composer/references" | "_deskfleet/composer/resolve">>(
    method: M, params: Omit<AgentMethods[M]["params"], "operationId">, text?: string, submittedDraft?: SubmittedAgentDraft,
  ): Promise<AgentMethods[M]["result"]> {
    const operationId = crypto.randomUUID()
    const sessionId = "sessionId" in params ? params.sessionId as string : undefined
    operations.value[operationId] = { operationId, sessionId, method, text,
      ...(text !== undefined && sessionId ? {
        attachmentIds: submittedDraft ? [...submittedDraft.attachmentIds] : (draftAttachments.value[sessionId] ?? []).map(item => item.id),
        mentionSnapshot: JSON.stringify(submittedDraft?.mentions ?? draftMentions.value[sessionId] ?? []),
      } : {}),
      workspaceId: "workspaceId" in params ? params.workspaceId as string : undefined, params: { ...params, operationId } }
    try {
      const result = await call(method, { ...params, operationId } as AgentMethods[M]["params"])
      completeOperation(operationId)
      return result
    } catch (reason) {
      const pending = operations.value[operationId]
      if (pending?.method === "_deskfleet/session/fork" && pending.result) {
        completeOperation(operationId)
        return pending.result as AgentMethods[M]["result"]
      }
      if (pending) pending.error = messageOf(reason)
      throw reason
    }
  }
  async function checkOperation(operationId: string): Promise<unknown> {
    const pending = operations.value[operationId]
    if (!pending) return
    const received = (result: unknown): unknown => {
      if (pending.method === "_deskfleet/session/fork") snapshotReceived(result as AgentSnapshot)
      completeOperation(operationId)
      return result
    }
    try {
      if (pending.result) return received(pending.result)
      const command = await call("_deskfleet/command/get", { operationId })
      if (command && ["failed", "rejected", "uncertain"].includes(command.status)) {
        delete operations.value[operationId]
        throw new Error(command.error ?? command.status)
      }
      if (command?.status === "completed") {
        commandReceived(command)
        return received(command.result)
      }
      // Reuse the exact request identity when the first response was lost. The
      // daemon serializes duplicates, including a request still being accepted.
      const result = await call(pending.method, pending.params as AgentMethods[typeof pending.method]["params"])
      return received(result)
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
  function mergeConfiguration(sessionId: string, result: AgentConfiguration, sequence: string | undefined, commands: string | undefined): AgentConfiguration {
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
    const key = `${sessionId}:${composer}`
    const current = configurationReads.get(key)
    if (current) return current
    const sequence = configurationSequences.get(sessionId)
    const commands = commandSequences.get(sessionId)
    const reading = call("_deskfleet/session/configuration", { sessionId, ...(composer ? { composer } : {}) })
      .then(result => mergeConfiguration(sessionId, result, sequence, commands))
      .finally(() => { configurationReads.delete(key) })
    configurationReads.set(key, reading)
    return reading
  }
  async function configureSession(sessionId: string, choices: Omit<AgentSelection, "provider">): Promise<AgentConfiguration> {
    const sequence = configurationSequences.get(sessionId)
    const commands = commandSequences.get(sessionId)
    const result = await mutation("_deskfleet/session/configure", { sessionId, ...choices })
    return mergeConfiguration(sessionId, result, sequence, commands)
  }
  async function create(workspaceId: string | undefined, title: string, context: AgentSessionContext, provider: string): Promise<AgentSnapshot> {
    const pending = Object.values(operations.value).find(operation => operation.method === "_deskfleet/session/create" && operation.workspaceId === workspaceId)
    const choices = draftConfiguration.value.provider === provider ? draftConfiguration.value : undefined
    const snapshot = pending ? await checkOperation(pending.operationId) as AgentSnapshot : await mutation("_deskfleet/session/create", {
      ...(workspaceId ? { workspaceId } : {}), title, provider, context, model: choices?.model, reasoningEffort: choices?.reasoningEffort, mode: choices?.mode,
    })
    snapshotReceived(snapshot)
    return snapshot
  }
  async function fork(sessionId: string, context: AgentSessionContext): Promise<AgentSnapshot> {
    const pending = Object.values(operations.value).find(operation => operation.method === "_deskfleet/session/fork" && operation.sessionId === sessionId)
    const snapshot = pending ? await checkOperation(pending.operationId) as AgentSnapshot : await mutation("_deskfleet/session/fork", { sessionId, context })
    snapshotReceived(snapshot)
    return snapshot
  }
  const submit = (sessionId: string, content: string | AgentInput["content"], delivery: "backlog" | "steer", turnId?: string, draftText?: string, submittedDraft?: SubmittedAgentDraft) => {
    const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content
    const trackedText = draftText ?? (typeof content === "string" ? content : (drafts.value[sessionId] ?? ""))
    return mutation("_deskfleet/input/submit", {
      sessionId, content: blocks, delivery, ...(turnId ? { turnId } : {}),
    }, trackedText, submittedDraft)
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
  async function archive(sessionId: string): Promise<void> {
    snapshotReceived(await mutation("_deskfleet/session/archive", { sessionId }))
  }
  async function restore(sessionId: string): Promise<void> {
    snapshotReceived(await mutation("_deskfleet/session/restore", { sessionId }))
  }
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
  onScopeDispose(() => { disposed = true; gitSubscriptions.clear(); client.close() })
  return { sessions, views, drafts, draftAttachments, draftMentions, draftErrors, preparingDrafts, elicitationDrafts, draftConfiguration, configurations, agentConfiguration, releaseAgentConfiguration, sessionConfiguration, configureSession, state, error, operations, refresh, open, checkOperation, create, fork, submit, steer, withdraw, retry, cancel, respond, respondToElicitation, stop, archive, restore, composerReferences, resolveComposerReferences, gitStatus, gitDiff, watchGit }
})
