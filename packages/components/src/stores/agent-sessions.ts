import { client as platformClient } from "@deskfleet/client/platform"
import { useLocalStorage } from "@vueuse/core"
import { defineStore } from "pinia"
import { onScopeDispose, ref } from "vue"
import type { AgentCommand, AgentElicitation, AgentEvent, AgentInput, AgentMethod, AgentMethods, AgentPermission, AgentRun, AgentSessionContext, AgentSessionRecord, AgentSnapshot, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"
import type { ElicitationDraft } from "../services/agent-elicitation.ts"
import { agentConfiguration as normalizeAgentConfiguration } from "../../../../apps/daemon/src/agent-configuration-protocol.ts"
import type { AgentConfiguration } from "../../../client/src/agent-configuration.ts"
import type { GitDiffRequest } from "../../../../apps/daemon/src/git-protocol.ts"
import { useProvidersStore } from "./providers.ts"
import { AgentClient, type AgentConnectionState, type AgentNotification } from "../services/agent-client.ts"

export interface AgentSelection { provider: string; model?: string; reasoningEffort?: string }

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
  workspaceId?: string
  params: Record<string, unknown>
  error?: string
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
  const elicitationDrafts = ref<Record<string, ElicitationDraft>>({})
  const draftConfiguration = useLocalStorage<AgentSelection>("deskfleet.agent-configuration", { provider: "codex" })
  const configurations = ref<Record<string, AgentConfiguration>>({})
  const configurationReads = new Map<string, Promise<AgentConfiguration>>()
  const configurationSequences = new Map<string, string>()
  const state = ref<AgentConnectionState>("idle")
  const error = ref<string | null>(null)
  const operations = ref<Record<string, PendingAgentOperation>>({})
  const journals = new Map<string, Map<string, AgentEvent>>()
  const loads = new Map<string, Promise<void>>()
  const reads = new Map<string, Promise<void>>()
  const permissionRequests = new Map<string, { sessionId: string; permissionId: string; resolve(value: unknown): void }>()
  let initialized: Promise<void> | null = null
  let refreshing: Promise<void> | null = null
  let disposed = false

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
    if (pending.text !== undefined && pending.sessionId && drafts.value[pending.sessionId] === pending.text) {
      drafts.value[pending.sessionId] = ""
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
      if (event.kind === "acp" && "update" in event.payload && event.payload.update.sessionUpdate === "config_option_update"
        && sequenceCompare(event.seq, configurationSequences.get(event.sessionId) ?? "0") > 0) {
        const providerId = sessions.value[event.sessionId]?.provider ?? configurations.value[event.sessionId]?.provider.id
        const provider = providers.providers.find(provider => provider.id === providerId)
        configurations.value[event.sessionId] = normalizeAgentConfiguration(event.payload.update.configOptions, providerId ? {
          id: providerId, name: provider?.name ?? configurations.value[event.sessionId]?.provider.name ?? providerId,
        } : undefined)
        configurationSequences.set(event.sessionId, event.seq)
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
      for (const pending of permissionRequests.values()) pending.resolve({ outcome: { outcome: "cancelled" } })
      permissionRequests.clear()
    }
  }, (notification: AgentNotification) => {
    if (notification.method === "_deskfleet/session/event") {
      const event = notification.params as AgentEvent
      remember([event])
      const current = views.value[event.sessionId]
      if (current?.snapshot && sequenceCompare(current.historySeq, event.seq) < 0 && !current.loading) void readHistory(event.sessionId).catch(() => {})
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
  function refresh(): Promise<void> {
    const listedBefore = new Map(Object.values(sessions.value).map(session => [session.id, session.lastEventSeq]))
    refreshing ??= call("_deskfleet/session/list", {}).then(records => {
      const received = new Map(records.map(session => [session.id, session]))
      for (const current of Object.values(sessions.value)) {
        const record = received.get(current.id)
        if (record ? sequenceCompare(current.lastEventSeq, record.lastEventSeq) > 0 : !listedBefore.has(current.id) || sequenceCompare(current.lastEventSeq, listedBefore.get(current.id)!) > 0) received.set(current.id, current)
      }
      sessions.value = Object.fromEntries(received)
      return Promise.all(Object.keys(views.value).filter(id => sessions.value[id]).map(open)).then(() => {})
    }).catch(reason => { error.value = messageOf(reason) }).finally(() => { refreshing = null })
    return refreshing
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
  function open(id: string): Promise<void> {
    const existing = loads.get(id)
    if (existing) return existing
    const current = view(id)
    current.loading = true
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
  async function mutation<M extends Exclude<AgentMethod, "_deskfleet/session/list" | "_deskfleet/session/subscribe" | "_deskfleet/session/history" | "_deskfleet/command/get" | "_deskfleet/agent/configuration" | "_deskfleet/session/configuration" | "_deskfleet/git/status" | "_deskfleet/git/diff">>(
    method: M, params: Omit<AgentMethods[M]["params"], "operationId">, text?: string,
  ): Promise<AgentMethods[M]["result"]> {
    const operationId = crypto.randomUUID()
    const sessionId = "sessionId" in params ? params.sessionId as string : undefined
    operations.value[operationId] = { operationId, sessionId, method, text, workspaceId: "workspaceId" in params ? params.workspaceId as string : undefined, params: { ...params, operationId } }
    try {
      const result = await call(method, { ...params, operationId } as AgentMethods[M]["params"])
      completeOperation(operationId)
      return result
    } catch (reason) {
      const pending = operations.value[operationId]
      if (pending) pending.error = messageOf(reason)
      throw reason
    }
  }
  async function checkOperation(operationId: string): Promise<unknown> {
    const pending = operations.value[operationId]
    if (!pending) return
    try {
      const command = await call("_deskfleet/command/get", { operationId })
      if (command && ["failed", "rejected", "uncertain"].includes(command.status)) {
        delete operations.value[operationId]
        throw new Error(command.error ?? command.status)
      }
      if (command?.status === "completed") {
        commandReceived(command)
        return command.result
      }
      // Reuse the exact request identity when the first response was lost. The
      // daemon serializes duplicates, including a request still being accepted.
      const result = await call(pending.method, pending.params as AgentMethods[typeof pending.method]["params"])
      completeOperation(operationId)
      return result
    } finally {
      if (pending.sessionId && state.value === "connected") await open(pending.sessionId)
    }
  }

  const agentConfiguration = (params: AgentSelection & { workspaceId?: string }) => call("_deskfleet/agent/configuration", params)
  function sessionConfiguration(sessionId: string): Promise<AgentConfiguration> {
    const current = configurationReads.get(sessionId)
    if (current) return current
    const sequence = configurationSequences.get(sessionId)
    const reading = call("_deskfleet/session/configuration", { sessionId }).then(result => {
      if (sequence === configurationSequences.get(sessionId)) configurations.value[sessionId] = result
      return configurations.value[sessionId]!
    }).finally(() => { configurationReads.delete(sessionId) })
    configurationReads.set(sessionId, reading)
    return reading
  }
  async function configureSession(sessionId: string, choices: Omit<AgentSelection, "provider">): Promise<AgentConfiguration> {
    const sequence = configurationSequences.get(sessionId)
    const result = await mutation("_deskfleet/session/configure", { sessionId, ...choices })
    if (sequence === configurationSequences.get(sessionId)) configurations.value[sessionId] = result
    return configurations.value[sessionId]!
  }
  async function create(workspaceId: string, title: string, context: AgentSessionContext, provider: string): Promise<AgentSnapshot> {
    const pending = Object.values(operations.value).find(operation => operation.method === "_deskfleet/session/create" && operation.workspaceId === workspaceId)
    const choices = draftConfiguration.value.provider === provider ? draftConfiguration.value : undefined
    const snapshot = pending ? await checkOperation(pending.operationId) as AgentSnapshot : await mutation("_deskfleet/session/create", { workspaceId, title, provider, context, model: choices?.model, reasoningEffort: choices?.reasoningEffort })
    snapshotReceived(snapshot)
    return snapshot
  }
  const submit = (sessionId: string, text: string, delivery: "backlog" | "steer", turnId?: string) => mutation("_deskfleet/input/submit", {
    sessionId, content: [{ type: "text", text }], delivery, ...(turnId ? { turnId } : {}),
  }, text)
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
  const gitStatus = (sessionId: string) => call("_deskfleet/git/status", { sessionId })
  const gitDiff = (request: GitDiffRequest) => call("_deskfleet/git/diff", request)
  onScopeDispose(() => { disposed = true; client.close() })
  return { sessions, views, drafts, elicitationDrafts, draftConfiguration, configurations, agentConfiguration, sessionConfiguration, configureSession, state, error, operations, refresh, open, checkOperation, create, submit, steer, withdraw, retry, cancel, respond, respondToElicitation, stop, archive, restore, gitStatus, gitDiff }
})
