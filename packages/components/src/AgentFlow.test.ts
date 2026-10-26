import { client as platformClient } from "@deskfleet/client/platform"
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentEvent, AgentSnapshot } from "../../../apps/daemon/src/agent-protocol.ts"
import type { ProviderSnapshot } from "../../../apps/daemon/src/provider-protocol.ts"
import App from "./App.vue"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import { agentElicitation, agentInput, agentPermission, agentSnapshot } from "./test/agent.ts"
import { catalogFixture, workspaceId } from "./test/catalog.ts"
import { useProvidersStore } from "./stores/providers.ts"
import { deferred } from "./test/desktop-media.ts"
import SessionView from "./views/SessionView.vue"
const transport = vi.hoisted(() => ({ call: vi.fn(), receive: (_value: { method: string; params: unknown }) => {}, state: (_state: string) => {} }))
vi.mock("./services/agent-client.ts", () => ({ AgentClient: class {
  constructor(_api: unknown, state: typeof transport.state, receive: typeof transport.receive) { transport.state = state; transport.receive = receive }
  connect = async () => { transport.state("connected") }
  call = transport.call
  close = () => {}
} }))
const page = () => new DOMWrapper(document.body)
let wrapper: VueWrapper
let pinia: ReturnType<typeof createPinia>
let snapshot: AgentSnapshot
let events: AgentEvent[]
const button = (text: string) => wrapper.findAll("button").find(button => button.text() === text)!
function emit(kind: AgentEvent["kind"], payload: AgentEvent["payload"]): void {
  const event: AgentEvent = { sessionId: "30", seq: String(events.length + 1), kind, payload, createdAt: "now", runGeneration: 1, turnId: "70" }
  events.push(event); snapshot.session.lastEventSeq = event.seq
  transport.receive({ method: "_deskfleet/session/event", params: structuredClone(event) })
}
beforeEach(async () => {
  window.localStorage.removeItem("deskfleet.agent-configuration")
  snapshot = agentSnapshot(); snapshot.session.workspaceId = workspaceId
  events = []
  const catalog = catalogFixture()
  vi.spyOn(platformClient.catalog, "list").mockImplementation(async () => structuredClone(catalog))
  vi.spyOn(platformClient.desktop, "target").mockResolvedValue({ id: "local-daemon", name: "Host", online: true, desktop: true })
  transport.call.mockReset().mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "initialize") return {}
    if (method === "_deskfleet/session/list") return []
    if (method === "_deskfleet/agent/configuration") return {
      provider: { id: String(params.provider), name: String(params.provider) }, models: null, reasoningEfforts: null, modes: null,
    }
    if (method === "_deskfleet/session/create") {
      snapshot.session.title = String(params.title)
      snapshot.session.provider = String(params.provider)
      catalog.workspaces[0]!.worktrees.push({ id: "31", sessionId: "30", workspaceId, directories: [{ path: "/worktree/new" }] })
      return structuredClone(snapshot)
    }
    if (method === "_deskfleet/session/subscribe") return structuredClone(snapshot)
    if (method === "_deskfleet/session/history") return structuredClone(events.filter(event => BigInt(event.seq) > BigInt(String(params.afterSeq))))
    if (method === "_deskfleet/input/submit") {
      const input = agentInput({ content: params.content as ReturnType<typeof agentInput>["content"] })
      snapshot.inputs = [input]; emit("input", input)
      return { operationId: params.operationId, commandId: "50", sessionId: "30", inputId: "40" }
    }
    return null
  })
  await router.push("/")
  pinia = createPinia()
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, router, i18n], stubs: { LiveTerminal: true } } })
  await flushPromises()
})
afterEach(() => { wrapper?.unmount(); disposePinia(pinia); vi.restoreAllMocks() })

test("a workspace prompt creates a Session, keeps shared candidates, streams tools and preserves execution when navigating away", async () => {
  await wrapper.get("textarea").setValue("Implement the feature")
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  await vi.waitFor(() => expect(router.currentRoute.value.params.sessionId).toBe("30"))
  expect(transport.call.mock.calls.find(([method]) => method === "_deskfleet/session/create")?.[1]).toMatchObject({ workspaceId, title: "Implement the feature", provider: "codex", context: "worktree", operationId: expect.any(String) })
  expect(wrapper.get('[aria-label="Queued"]').text()).toContain("Implement the feature")
  expect(wrapper.find('a[href="#/worktrees/31"]').exists()).toBe(true)
  const delivered = agentInput({ content: [{ type: "text", text: "Implement the feature" }], state: "delivered", turnId: "70", actualDelivery: "turn_start" })
  emit("input", delivered)
  emit("turn", { id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: "now" })
  emit("acp", { sessionId: "provider", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the files" } } })
  emit("acp", { sessionId: "provider", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file", status: "in_progress" } })
  emit("permission", agentPermission())
  await flushPromises()
  expect(wrapper.get('[aria-label="Conversation"]').text()).toContain("Reading the files")
  expect(wrapper.get('[aria-label="Conversation"]').text()).toContain("Read file")
  expect(button("Allow once").exists()).toBe(true)
  emit("permission", agentPermission({ state: "resolved", optionId: "deny", actor: { kind: "user", userId: "Grace", sourceMachine: { originId: "remote", id: "99" } } }))
  await flushPromises()
  expect(wrapper.find('[aria-label="Permissions"]').exists()).toBe(false)
  expect(wrapper.get('[aria-label="Conversation"] [data-permission-id="60"]').text()).toContain("Reject · Grace")
  await router.push({ name: "workspace", params: { workspaceId } }); await flushPromises()
  expect(transport.call.mock.calls.some(([method]) => method === "_deskfleet/session/stop" || method === "_deskfleet/turn/cancel")).toBe(false)
})

test.each(["archiving", "archived"] as const)("questions remain visible but cannot be answered while a Session is %s", async archiveState => {
  await wrapper.get("textarea").setValue("Implement the feature")
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  emit("elicitation", agentElicitation())
  await flushPromises()
  expect(wrapper.get('[data-testid="elicitation-submit"]').attributes("disabled")).toBeUndefined()
  emit("session", { ...snapshot.session, archiveState })
  await flushPromises()
  expect(wrapper.get('[data-testid="elicitation-submit"]').attributes("disabled")).toBeDefined()
  await wrapper.get('[data-testid="elicitation-decline"]').trigger("click")
  expect(transport.call.mock.calls.some(([method]) => method === "_deskfleet/elicitation/respond")).toBe(false)
})

test("returning to unchanged conversation history scrolls after loading, while live updates respect manual scrolling", async () => {
  await wrapper.get("textarea").setValue("Implement the feature")
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  snapshot.elicitations = [agentElicitation()]
  emit("elicitation", snapshot.elicitations[0]!)
  await flushPromises()
  await router.push({ name: "workspace", params: { workspaceId } })
  await flushPromises()

  const restored = deferred<AgentSnapshot>()
  const normal = transport.call.getMockImplementation()!
  transport.call.mockImplementation((method, params) => method === "_deskfleet/session/subscribe" ? restored.promise : normal(method, params))
  await router.push({ name: "session", params: { sessionId: "30" } })
  await flushPromises()
  const session = wrapper.findComponent(SessionView)
  const scroller = session.get<HTMLElement>(".overflow-y-auto")
  Object.defineProperties(scroller.element, { scrollHeight: { value: 1600 }, clientHeight: { value: 400 }, scrollTop: { value: 0, writable: true } })
  const scrollTo = vi.spyOn(scroller.element, "scrollTo").mockImplementation(() => {
    expect(session.find('[data-testid="agent-elicitation"]').exists()).toBe(true)
    expect(session.text()).not.toContain("Restoring conversation")
  })
  expect(session.text()).toContain("Restoring conversation")
  restored.resolve(structuredClone(snapshot))
  await flushPromises()
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1600 })

  scrollTo.mockClear()
  await scroller.trigger("scroll")
  emit("acp", { sessionId: "provider", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "More context" } } })
  await flushPromises()
  expect(scrollTo).not.toHaveBeenCalled()
  scroller.element.scrollTop = 1200
  await scroller.trigger("scroll")
  emit("acp", { sessionId: "provider", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Still working" } } })
  await flushPromises()
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1600 })
})

test("the new-session composer remembers a working-directory choice and creates that Session", async () => {
  await wrapper.get('[aria-label="Session context: New worktree"]').trigger("click")
  await page().findAll('[role="menuitemradio"]').find(item => item.text().startsWith("Working directory"))!.trigger("click"); await flushPromises()
  expect(page().find('[role="menu"]').exists()).toBe(false)
  expect(window.localStorage.getItem("deskfleet.session-context")).toBe("directory")
  await wrapper.get("textarea").setValue("Fix it in place")
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  expect(transport.call.mock.calls.find(([method]) => method === "_deskfleet/session/create")?.[1]).toMatchObject({ workspaceId, context: "directory" })
  window.localStorage.removeItem("deskfleet.session-context")
})

test("new sessions use the selected configured provider and show its name", async () => {
  vi.spyOn(platformClient.providers, "list").mockResolvedValue({
    revision: "registry-1", templates: [],
    providers: [
      { id: "codex", template: "codex", name: "Codex", env: {} },
      { id: "work-codex", template: "codex", name: "Work Codex", icon: "deepseek", env: { CODEX_HOME: "/work/config" } },
    ],
  })
  await useProvidersStore(pinia).refresh()
  await flushPromises()
  await wrapper.get('[data-agent-configuration-trigger]').trigger("click")
  await flushPromises()
  await page().get('[data-agent-control="agent"]').trigger("click")
  await page().get('[role="menuitemradio"][data-value="work-codex"]').trigger("click")
  await flushPromises()
  expect(wrapper.findAll('[data-agent-configuration-trigger]')).toHaveLength(1)
  expect(wrapper.find('[aria-label="Choose provider"]').exists()).toBe(false)
  expect(transport.call).toHaveBeenCalledWith("_deskfleet/agent/configuration", { provider: "work-codex", workspaceId, probeId: expect.any(String) })
  await vi.waitFor(() => expect(wrapper.find('[data-provider-icon="deepseek"]').exists()).toBe(true))
  await wrapper.get("textarea").setValue("Use the work account")
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  expect(transport.call.mock.calls.find(([method]) => method === "_deskfleet/session/create")?.[1]).toMatchObject({ provider: "work-codex" })
  expect(wrapper.get('[data-agent-configuration-trigger]').text()).toContain("Work Codex")
  expect(wrapper.get('[data-agent-configuration-trigger] [data-provider-icon]').attributes('data-provider-icon')).toBe("deepseek")
  expect(wrapper.get('aside a[href="#/sessions/30"] [data-provider-icon]').attributes('data-provider-icon')).toBe("deepseek")

  vi.mocked(platformClient.providers.list).mockResolvedValue({ revision: "registry-1", templates: [], providers: [{ id: "work-codex", template: "codex", name: "Work Codex", icon: "claude", env: {} }] })
  await useProvidersStore(pinia).refresh()
  await flushPromises()
  expect(wrapper.get('[data-agent-configuration-trigger] [data-provider-icon]').attributes('data-provider-icon')).toBe("claude")
  expect(wrapper.get('aside a[href="#/sessions/30"] [data-provider-icon]').attributes('data-provider-icon')).toBe("claude")
})

test("restored sessions show pending provider identity until its configuration loads", async () => {
  wrapper.unmount()
  disposePinia(pinia)
  const read = deferred<ProviderSnapshot>()
  const list = vi.spyOn(platformClient.providers, "list").mockReturnValueOnce(read.promise)
  snapshot.session.provider = "work-codex"
  const call = transport.call.getMockImplementation()!
  transport.call.mockImplementation((method, params) => method === "_deskfleet/session/list"
    ? Promise.resolve([structuredClone(snapshot.session)]) : call(method, params))
  await router.push({ name: "session", params: { sessionId: "30" } })
  pinia = createPinia()
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [pinia, router, i18n], stubs: { LiveTerminal: true } } })
  await flushPromises()
  expect(wrapper.get('[data-agent-configuration-trigger]').text()).toBe("Agent")
  expect(wrapper.find('[data-agent-configuration-trigger] [data-provider-pending]').exists()).toBe(true)
  expect(wrapper.find('aside a[href="#/sessions/30"] [data-provider-pending]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain("Provider unavailable")

  read.resolve({ revision: "registry-1", templates: [], providers: [{ id: "work-codex", template: "codex", name: "Work Codex", icon: "deepseek", env: {} }] })
  await flushPromises()
  expect(wrapper.get('[data-agent-configuration-trigger]').text()).toBe("Work Codex")
  await vi.waitFor(() => expect(wrapper.get('[data-agent-configuration-trigger] [data-provider-icon]').attributes("data-provider-icon")).toBe("deepseek"))
  expect(wrapper.get('aside a[href="#/sessions/30"] [data-provider-icon]').attributes("data-provider-icon")).toBe("deepseek")
  expect(wrapper.find('[data-agent-configuration-trigger] [data-provider-pending]').exists()).toBe(false)

  list.mockResolvedValue({ revision: "registry-1", templates: [], providers: [] })
  await useProvidersStore(pinia).refresh()
  await flushPromises()
  expect(wrapper.get('[data-agent-configuration-trigger]').text()).toBe("Provider unavailable")
  expect(wrapper.find('[data-agent-configuration-trigger] [data-provider-pending]').exists()).toBe(false)
  expect(wrapper.find('aside a[href="#/sessions/30"] [data-provider-pending]').exists()).toBe(false)
})

test("an empty provider list links to Agents settings and prevents session creation", async () => {
  vi.spyOn(platformClient.providers, "list").mockResolvedValue({ revision: "registry-1", templates: [], providers: [] })
  await useProvidersStore(pinia).refresh()
  await flushPromises()
  await wrapper.get("textarea").setValue("Keep my draft")
  expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeDefined()
  expect(wrapper.find('a[href="#/settings/agents"]').exists()).toBe(true)
  await wrapper.get("textarea").trigger("keydown", { key: "Enter" })
  expect(transport.call.mock.calls.some(([method]) => method === "_deskfleet/session/create")).toBe(false)
})

test("a stopped agent asks for nothing and the next message is simply sent", async () => {
  await wrapper.get("textarea").setValue("Implement the feature")
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  await vi.waitFor(() => expect(router.currentRoute.value.params.sessionId).toBe("30"))
  emit("run", { sessionId: "30", generation: 1, state: "stopped", startedAt: "now", endedAt: "now" })
  await flushPromises()
  expect(wrapper.get("main").text()).not.toMatch(/stopped|Resume/u)
  const prompt = wrapper.get<HTMLTextAreaElement>("textarea")
  expect(prompt.attributes("placeholder")).toBe("Describe a task for the agent")
  await prompt.setValue("Keep going")
  expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeUndefined()
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  expect(transport.call.mock.calls.filter(([method]) => method === "_deskfleet/input/submit").at(-1)?.[1]).toMatchObject({ content: [{ type: "text", text: "Keep going" }] })
  expect(transport.call.mock.calls.some(([method]) => method === "_deskfleet/session/resume")).toBe(false)
})

test("a Session's shells open in its bottom panel, belong to its Worktree, and stay out of the sidebar", async () => {
  await wrapper.get("textarea").setValue("Implement the feature")
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  await vi.waitFor(() => expect(router.currentRoute.value.params.sessionId).toBe("30"))
  const dial = vi.spyOn(platformClient.terminal, "dial").mockImplementation(async options => ({
    id: options.terminalId, title: "new", cwd: "/worktree/new", cols: 80, rows: 24, status: "running",
    ...(options.mode === "create" && options.worktreeId ? { worktreeId: options.worktreeId } : {}),
  }))
  expect(wrapper.find('[aria-label="Session terminals"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Show terminal"]').trigger("click")
  await vi.waitFor(() => expect(dial).toHaveBeenCalledOnce())
  expect(dial).toHaveBeenCalledWith(expect.objectContaining({ mode: "create", worktreeId: "31" }))
  expect(dial.mock.calls[0]![0]).not.toHaveProperty("cwd")
  expect(wrapper.get('[aria-label="Session terminals"]').findAll('[role="tab"]')).toHaveLength(1)
  expect(wrapper.get("aside").find('a[href^="#/terminals/"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Hide terminal"]').trigger("click")
  expect(wrapper.find('[aria-label="Session terminals"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Show terminal"]').trigger("click")
  await vi.waitFor(() => expect(wrapper.find('[aria-label="Session terminals"]').exists()).toBe(true))
  expect(dial).toHaveBeenCalledOnce()
  await wrapper.get('[aria-label="Session terminals"] [aria-label="Hang up Shell 1"]').trigger("click")
  await flushPromises()
  expect(wrapper.find('[aria-label="Session terminals"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="Show terminal"]').exists()).toBe(true)
  await wrapper.get('[aria-label="Show terminal"]').trigger("click")
  await vi.waitFor(() => expect(dial).toHaveBeenCalledTimes(2))
  expect(wrapper.get('[aria-label="Session terminals"]').findAll('[role="tab"]')).toHaveLength(1)
  window.localStorage.removeItem("deskfleet.terminal-panel-open")
})


test("the selected model, effort and native mode reach a newly created Session through the agent channel", async () => {
  const original = transport.call.getMockImplementation()!
  let model = "sequoia"
  let effort = "medium"
  let mode = "workspace-write"
  transport.call.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "_deskfleet/agent/configuration") {
      if (params.release) return null
      model = String(params.model ?? model)
      effort = String(params.reasoningEffort ?? effort)
      mode = String(params.mode ?? mode)
      return {
        provider: { id: "codex", name: "Codex" },
        models: { id: "model", currentValue: model, options: [{ id: "sequoia", name: "Sequoia" }, { id: "orbit", name: "Orbit" }] },
        reasoningEfforts: { id: "effort", currentValue: effort, options: [{ id: "medium", name: "Medium" }, { id: "high", name: "High" }] },
        modes: { id: "mode", currentValue: mode, options: [{ id: "workspace-write", name: "Workspace access" }, { id: "agent", name: "Auto review" }] },
      }
    }
    return original(method, params)
  })
  await wrapper.get('[aria-label="Configure agent: Codex"]').trigger("click")
  await flushPromises()
  await page().get('[data-agent-control="model"]').trigger("click")
  await page().get('[role="menuitemradio"][data-value="orbit"]').trigger("click")
  await flushPromises()
  await page().get('[data-agent-control="reasoning"]').trigger("click")
  await page().get('[role="menuitemradio"][data-value="high"]').trigger("click")
  await flushPromises()
  await page().get('[data-agent-control="mode"]').trigger("click")
  await page().get('[role="menuitemradio"][data-value="agent"]').trigger("click")
  await flushPromises()
  await wrapper.get("textarea").setValue("Use the selected reasoning model")
  await wrapper.get('[aria-label="Send"]').trigger("click")
  await flushPromises()
  expect(transport.call.mock.calls.find(([method]) => method === "_deskfleet/session/create")?.[1]).toMatchObject({ model: "orbit", reasoningEffort: "high", mode: "agent" })
  expect(transport.call.mock.calls.some(([method]) => method === "_deskfleet/input/submit")).toBe(true)
  window.localStorage.removeItem("deskfleet.agent-configuration")
})
