import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { defineComponent, h } from "vue"
import type { AgentCommand, AgentEvent } from "../../../../../daemon/src/agent-protocol.ts"
import { agentEvent, agentInput, agentPermission, agentSnapshot, actor } from "../test/agent.ts"
import { deferred } from "../test/desktop-media.ts"
import { useAgentSessionsStore } from "./agent-sessions.ts"
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
