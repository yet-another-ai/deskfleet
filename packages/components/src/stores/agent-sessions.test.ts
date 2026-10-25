import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { defineComponent, h } from "vue"
import type { AgentCommand, AgentEvent } from "../../../../apps/daemon/src/agent-protocol.ts"
import { agentElicitation, agentEvent, agentInput, agentPermission, agentSnapshot, actor } from "../test/agent.ts"
import { deferred } from "../test/desktop-media.ts"
import { useAgentSessionsStore } from "./agent-sessions.ts"
import { client as platformClient } from "@deskfleet/client/platform"
const mock = vi.hoisted(() => ({ call: vi.fn(), connect: vi.fn(async () => {}), close: vi.fn(), notification: (_value: { method: string; params: unknown }) => {}, request: (_value: { id: string; method: string; params: unknown }): Promise<unknown> => Promise.resolve(), state: (_state: string) => {} }))
vi.mock("../services/agent-client.ts", () => ({ AgentClient: class {
  constructor(_api: unknown, state: typeof mock.state, notification: typeof mock.notification, request: typeof mock.request) { mock.state = state; mock.notification = notification; mock.request = request }
  connect = mock.connect; call = mock.call; close = mock.close
} }))
let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia); mock.call.mockReset(); mock.close.mockClear()
  mock.call.mockImplementation(async (method: string) => {
    if (method === "initialize") return { _meta: { deskfleet: { identity: actor } } }
    if (method === "_deskfleet/session/subscribe") return agentSnapshot()
    if (method === "_deskfleet/session/history") return []
    if (method === "_deskfleet/session/list") return [agentSnapshot().session]
    return null
  })
})
afterEach(() => disposePinia(pinia))
const receive = (event: AgentEvent) => mock.notification({ method: "_deskfleet/session/event", params: event })

test("a live peer continues prompts during signaling loss and only disconnected views use central history", async () => {
  const previous = platformClient.agent.history
  const history = { available: () => false, list: vi.fn(async () => [agentSnapshot().session]), snapshot: vi.fn(async () => agentSnapshot()), events: vi.fn(async () => []) }
  platformClient.agent.history = history
  try {
    const store = useAgentSessionsStore()
    mock.state("connected")
    await store.submit("30", "Peer stays live", "backlog")
    expect(mock.call).toHaveBeenCalledWith("_deskfleet/input/submit", expect.objectContaining({ sessionId: "30" }))
    expect(history.snapshot).not.toHaveBeenCalled()
    mock.state("error")
    await store.open("30")
    expect(history.snapshot).toHaveBeenCalledWith("30")
    await expect(store.submit("30", "No peer", "backlog")).rejects.toThrow("offline")
  } finally { platformClient.agent.history = previous }
})

test("merges snapshot, history pages and concurrent live events once without regressing snapshot state", async () => {
  const snapshot = agentSnapshot(); snapshot.session.lastEventSeq = "3"; snapshot.inputs = [agentInput({ state: "delivered" })]
  const history = deferred<AgentEvent[]>()
  mock.call.mockImplementation(async (method: string, params: { afterSeq?: string }) => {
    if (method === "initialize") return {}
    if (method === "_deskfleet/session/subscribe") return snapshot
    if (method === "_deskfleet/session/history" && params.afterSeq === "0") return history.promise
    if (method === "_deskfleet/session/history") return [agentEvent(3, "input", snapshot.inputs[0]!)]
  })
  const store = useAgentSessionsStore()
  const opening = store.open("30"); await flushPromises()
  const permission = agentPermission()
  receive(agentEvent(4, "permission", permission))
  receive(agentEvent(4, "permission", permission))
  history.resolve([agentEvent(1, "session", { ...snapshot.session, title: "Old title", lastEventSeq: "1" }), agentEvent(2, "input", agentInput())])
  await opening
  expect(store.views["30"]!.events.map(event => event.seq)).toEqual(["1", "2", "3", "4"])
  expect(store.views["30"]!.snapshot?.inputs[0]?.state).toBe("delivered")
  expect(store.views["30"]!.snapshot?.session.title).toBe("Fix tests")
  expect(store.views["30"]!.snapshot?.permissions).toEqual([permission])
  expect(store.views["30"]!.historySeq).toBe("4")
  mock.notification({ method: "session/update", params: { sessionId: "30", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mirror" } } } })
  expect(store.views["30"]!.events).toHaveLength(4)
})

test("another viewer's permission decision resolves the original callback and no view teardown stops execution", async () => {
  const store = useAgentSessionsStore(); await store.open("30")
  receive(agentEvent(1, "permission", agentPermission()))
  const response = mock.request({ id: "request-1", method: "session/request_permission", params: { sessionId: "30", _meta: { deskfleet: { permissionId: "60" } } } })
  receive(agentEvent(2, "permission", agentPermission({ state: "resolved", optionId: "deny", actor: { ...actor, userId: "Grace" } })))
  await expect(response).resolves.toEqual({ outcome: { outcome: "cancelled" } })
  expect(mock.call.mock.calls.some(([method]) => method === "_deskfleet/permission/respond")).toBe(false)
  store.$dispose()
  expect(mock.close).toHaveBeenCalledOnce()
  expect(mock.call.mock.calls.some(([method]) => method === "_deskfleet/session/stop")).toBe(false)
})

test("a question decision from another viewer closes the form and clears transient answers", async () => {
  const store = useAgentSessionsStore(); await store.open("30")
  receive(agentEvent(1, "elicitation", agentElicitation()))
  store.elicitationDrafts["80"] = { target: "staging", secret: "private" }
  mock.call.mockRejectedValueOnce(new Error("Lost response"))
  await expect(store.respondToElicitation("30", "80", { action: "accept", content: { target: "staging", secret: "private" } })).rejects.toThrow("Lost response")
  expect(Object.values(store.operations)).toHaveLength(1)
  const resolved = agentElicitation({ state: "resolved", response: { action: "decline" }, actor: { ...actor, userId: "Grace" } })
  receive(agentEvent(2, "elicitation", resolved))
  expect(store.views["30"]!.snapshot?.elicitations).toEqual([resolved])
  expect(store.elicitationDrafts).toEqual({})
  expect(store.operations).toEqual({})
  await store.respondToElicitation("30", "80", { action: "accept", content: { target: "production" } })
  expect(mock.call.mock.calls.filter(([method]) => method === "_deskfleet/elicitation/respond")).toHaveLength(1)
})

test("lost question replies block a second answer and retry the original command identity", async () => {
  const store = useAgentSessionsStore(); await store.open("30")
  receive(agentEvent(1, "elicitation", agentElicitation()))
  store.elicitationDrafts["80"] = { target: "staging" }
  const normal = mock.call.getMockImplementation()!
  mock.call.mockRejectedValueOnce(new Error("Lost response"))
  await expect(store.respondToElicitation("30", "80", { action: "accept", content: { target: "staging" } })).rejects.toThrow()
  const original = mock.call.mock.calls.at(-1)!
  const operation = Object.values(store.operations)[0]!
  await store.respondToElicitation("30", "80", { action: "cancel" })
  expect(mock.call.mock.calls.at(-1)).toEqual(original)
  const resolved = agentElicitation({ state: "resolved", response: { action: "accept", content: { target: "staging" } } })
  const snapshot = agentSnapshot(); snapshot.elicitations = [resolved]; snapshot.session.lastEventSeq = "2"
  mock.call.mockImplementation(async (method: string, params: unknown) => {
    if (method === "_deskfleet/elicitation/respond") return resolved
    if (method === "_deskfleet/session/subscribe") return snapshot
    if (method === "_deskfleet/session/history") return [agentEvent(2, "elicitation", resolved)]
    return normal(method, params)
  })
  mock.state("connected")
  await store.checkOperation(operation.operationId)
  expect(mock.call.mock.calls.filter(([method]) => method === "_deskfleet/elicitation/respond")).toEqual([original, original])
  expect(store.views["30"]!.snapshot?.elicitations).toEqual([resolved])
  expect(store.elicitationDrafts).toEqual({})
  expect(store.operations).toEqual({})
})

test("a lost submission response preserves its operation ID and clears only the submitted draft on reconciliation", async () => {
  const store = useAgentSessionsStore(); await store.open("30")
  const normal = mock.call.getMockImplementation()!
  mock.call.mockImplementation(async (method: string, params: unknown) => {
    if (method === "_deskfleet/input/submit") throw new Error("Connection lost")
    return normal(method, params)
  })
  store.drafts["30"] = "First"
  await expect(store.submit("30", "First", "backlog")).rejects.toThrow("Connection lost")
  const operation = Object.values(store.operations)[0]!
  store.drafts["30"] = "Second draft"
  const command: AgentCommand = { id: "50", operationId: operation.operationId, actor, sessionId: "30", method: operation.method, params: operation.params, isCanonical: true, status: "completed", result: { operationId: operation.operationId, commandId: "50", sessionId: "30", inputId: "40" }, receivedAt: "now" }
  mock.call.mockImplementation(async (method: string, params: unknown) => method === "_deskfleet/command/get" ? command : normal(method, params))
  mock.state("error")
  await store.open("30")
  expect(store.operations).toEqual({})
  expect(store.drafts["30"]).toBe("Second draft")
  expect(mock.call.mock.calls.filter(([method]) => method === "_deskfleet/input/submit")).toHaveLength(1)
})

test("explicit check reuses an unknown operation's exact params instead of allocating another input", async () => {
  const store = useAgentSessionsStore(); await store.open("30")
  mock.call.mockRejectedValueOnce(new Error("Lost response"))
  store.drafts["30"] = "First"
  await expect(store.submit("30", "First", "backlog")).rejects.toThrow()
  const original = mock.call.mock.calls.at(-1)!
  const operation = Object.values(store.operations)[0]!
  mock.call.mockResolvedValueOnce(null).mockResolvedValueOnce({ operationId: operation.operationId, commandId: "50", sessionId: "30" })
  await store.checkOperation(operation.operationId)
  expect(mock.call.mock.calls.at(-1)).toEqual(original)
  expect(store.drafts["30"]).toBe("")
  expect(store.operations).toEqual({})
})

test("Git reads initialize the shared connection without creating mutation receipts or altering drafts", async () => {
  const store = useAgentSessionsStore()
  store.drafts["30"] = "Keep my draft"
  const status = { sessionId: "30", repositories: [], directories: [] }
  const request = { sessionId: "30", repositoryId: "checkout", path: "source.ts", kind: "staged" as const }
  const diff = { ...request, patch: "+new\n", binary: false, truncated: false }
  mock.call.mockImplementation(async (method: string) => {
    if (method === "initialize") return {}
    if (method === "_deskfleet/git/status") return status
    if (method === "_deskfleet/git/diff") return diff
  })
  await expect(store.gitStatus("30")).resolves.toEqual(status)
  await expect(store.gitDiff(request)).resolves.toEqual(diff)
  expect(mock.call.mock.calls.map(([method]) => method)).toEqual(["initialize", "_deskfleet/git/status", "_deskfleet/git/diff"])
  expect(mock.call).toHaveBeenCalledWith("_deskfleet/git/status", { sessionId: "30" })
  expect(mock.call).toHaveBeenCalledWith("_deskfleet/git/diff", request)
  mock.call.mockRejectedValueOnce(new Error("Checkout is unavailable"))
  await expect(store.gitStatus("30")).rejects.toThrow("Checkout is unavailable")
  expect(store.operations).toEqual({})
  expect(store.views).toEqual({})
  expect(store.drafts["30"]).toBe("Keep my draft")
})


test.each([false, true])("the rendered restoring indicator clears without further live events (history: %s)", async hasHistory => {
  const snapshot = agentSnapshot()
  const events = hasHistory ? [agentEvent(1, "input", agentInput({ state: "delivered" }))] : []
  snapshot.session.lastEventSeq = String(events.length)
  const history = deferred<AgentEvent[]>()
  mock.call.mockImplementation(async (method: string) => {
    if (method === "initialize") return {}
    if (method === "_deskfleet/session/subscribe") return snapshot
    if (method === "_deskfleet/session/history") return history.promise
  })
  const store = useAgentSessionsStore()
  const status = mount(defineComponent({ setup: () => () => h("p", store.views["30"]?.loading ? "Restoring conversation" : "Ready") }))
  try {
    const opening = store.open("30")
    await flushPromises()
    expect(status.text()).toBe("Restoring conversation")
    history.resolve(events)
    await opening
    await flushPromises()
    expect(status.text()).toBe("Ready")
  } finally { status.unmount() }
})

test("draft choices accompany session creation and live changes use an idempotent session command", async () => {
  const store = useAgentSessionsStore()
  store.draftConfiguration = { provider: "codex", model: "draft-model", reasoningEffort: "high" }
  const normal = mock.call.getMockImplementation()!
  const live = { provider: { id: "codex", name: "Codex" }, models: { id: "model", currentValue: "live-model", options: [{ id: "live-model", name: "Live model" }] }, reasoningEfforts: null }
  mock.call.mockImplementation(async (method: string, params: unknown) => {
    if (method === "_deskfleet/session/create") return agentSnapshot()
    if (method === "_deskfleet/session/configuration" || method === "_deskfleet/session/configure") return live
    return normal(method, params)
  })
  await store.create("20", "Create configured session", "directory", "codex")
  expect(mock.call).toHaveBeenCalledWith("_deskfleet/session/create", expect.objectContaining({ workspaceId: "20", model: "draft-model", reasoningEffort: "high", operationId: expect.any(String) }))
  await store.sessionConfiguration("30")
  expect(mock.call).toHaveBeenLastCalledWith("_deskfleet/session/configuration", { sessionId: "30" })
  expect(store.configurations["30"]).toEqual(live)
  await store.configureSession("30", { model: "live-model" })
  expect(mock.call).toHaveBeenLastCalledWith("_deskfleet/session/configure", { sessionId: "30", model: "live-model", operationId: expect.any(String) })
  expect(store.draftConfiguration.model).toBe("draft-model")
  window.localStorage.removeItem("deskfleet.agent-configuration")
})

test("live configuration events update the UI without extra reads and outrank stale responses or history", async () => {
  const store = useAgentSessionsStore()
  const pending = deferred<{ provider: { id: string; name: string }; models: null; reasoningEfforts: null }>()
  const normal = mock.call.getMockImplementation()!
  mock.call.mockImplementation(async (method: string, params: unknown) => method === "_deskfleet/session/configuration" ? pending.promise : normal(method, params))
  const reading = store.sessionConfiguration("30")
  await flushPromises()
  const update = (model: string) => ({ sessionId: "provider", update: { sessionUpdate: "config_option_update" as const, configOptions: [{ id: "model", name: "Model", type: "select" as const, category: "model", currentValue: model, options: [{ value: "sequoia", name: "Sequoia" }, { value: "orbit", name: "Orbit" }] }] } })
  receive(agentEvent(2, "acp", update("orbit")))
  receive(agentEvent(1, "acp", update("sequoia")))
  pending.resolve({ provider: { id: "codex", name: "Codex" }, models: null, reasoningEfforts: null })
  await reading
  expect(store.configurations["30"]?.models?.currentValue).toBe("orbit")
  expect(mock.call.mock.calls.filter(([method]) => method === "_deskfleet/session/configuration")).toHaveLength(1)
})

test("session creation excludes model preferences saved for another configured provider", async () => {
  const store = useAgentSessionsStore()
  store.draftConfiguration = { provider: "codex", model: "codex-only", reasoningEffort: "high" }
  mock.call.mockResolvedValue(agentSnapshot())
  await store.create("20", "Use another agent", "directory", "work-agent")
  expect(mock.call).toHaveBeenCalledWith("_deskfleet/session/create", {
    workspaceId: "20", title: "Use another agent", context: "directory", provider: "work-agent",
    model: undefined, reasoningEffort: undefined, operationId: expect.any(String),
  })
  window.localStorage.removeItem("deskfleet.agent-configuration")
})

test("live option updates retain the Session's configured provider identity", async () => {
  const store = useAgentSessionsStore()
  store.sessions["30"] = { ...agentSnapshot().session, provider: "work-agent" }
  store.configurations["30"] = { provider: { id: "work-agent", name: "Work agent" }, models: null, reasoningEfforts: null }
  receive(agentEvent(1, "acp", { sessionId: "provider", update: {
    sessionUpdate: "config_option_update", configOptions: [{
      id: "model", name: "Model", type: "select", category: "model", currentValue: "work-model",
      options: [{ value: "work-model", name: "Work model" }],
    }],
  } }))
  expect(store.configurations["30"]?.provider).toEqual({ id: "work-agent", name: "Work agent" })
  expect(store.configurations["30"]?.models?.currentValue).toBe("work-model")
})
