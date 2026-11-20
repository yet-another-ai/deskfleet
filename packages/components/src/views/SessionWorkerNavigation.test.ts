import { useWorkspaceAgentMode } from "../services/workspace-agent-navigation.ts"
import { getClient } from "@deskfleet/client/platform"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { createApp } from "vue"
import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { i18n } from "../i18n/index.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { agentSnapshot } from "../test/agent.ts"
import { catalogFixture, workspaceId } from "../test/catalog.ts"
import ForkSessionDialog from "../components/session/ForkSessionDialog.vue"
import AgentSessionMenu from "../components/session/AgentSessionMenu.vue"
import SessionView from "./SessionView.vue"

test.each([
  { capable: true, project: true, composer: false, loading: true },
  { capable: true, project: false, composer: true },
  { capable: true, project: true, composer: false },
  { capable: false, project: false, composer: true },
  { capable: false, project: true, composer: true },
])("legacy session on PC: capable=$capable, project=$project", async ({ capable, project, composer, loading }) => {
  const pinia = createPinia()
  const client = {
    ...getClient(), target: { id: "pc", local: false }, platform: "darwin" as const,
    localChannels: { open: vi.fn(), close: vi.fn(), send: vi.fn(), onEvent: vi.fn() },
    superAgent: capable ? { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() } : undefined,
  }
  const context = createApp({}).provide(platformClientKey, client).use(pinia)
  const agents = context.runWithContext(() => useAgentSessionsStore())
  const fleet = context.runWithContext(() => useFleetStore())
  vi.spyOn(agents, "open").mockResolvedValue()
  const snapshot = agentSnapshot()
  snapshot.session.workspaceId = project ? workspaceId : undefined
  if (!loading) {
    agents.sessions["30"] = snapshot.session
    agents.views["30"] = { snapshot, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }
    fleet.catalog = catalogFixture()
  }
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/sessions/:sessionId", name: "session", component: SessionView },
    { path: "/", name: "new-session", component: {} }, { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
  ] })
  await router.push({ name: "session", params: { sessionId: "30" }, query: { superFrom: project ? workspaceId : "", superMachine: "pc" } })
  const wrapper = mount(SessionView, { props: { sessionId: "30" }, global: {
    plugins: [pinia, router, i18n], provide: { [platformClientKey as symbol]: client },
    stubs: { SessionHeader: { template: "<header><slot /><slot name='actions' /></header>" }, SessionComposer: true },
  } })
  try {
    await flushPromises()
    expect(wrapper.find("session-composer-stub").exists()).toBe(composer)
    expect(wrapper.find("[data-worker-controls]").exists()).toBe(!!(capable && project && !loading))
    if (capable && project && !loading) {
      expect(wrapper.find("[data-composer-yolo]").exists()).toBe(true)
      const trigger = wrapper.get("[data-agent-configuration-trigger]")
      await trigger.trigger("keydown", { key: "ArrowDown" })
      await flushPromises()
      const menu = new DOMWrapper(document.body).get("[data-agent-configuration-menu]")
      expect(menu.findAll("[data-agent-control]").map(row => row.attributes("data-agent-control")))
        .toEqual(["agent", "model", "reasoning", "mode"])
      await menu.trigger("keydown", { key: "Escape" })
      await flushPromises()
    }
    await wrapper.findAll("button").find(item => item.text() === i18n.global.t("superAgent.back"))!.trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.name).toBe(project ? "workspace-agent" : "new-session")
    expect(router.currentRoute.value.query.machine).toBe("pc")
    if (project) expect(router.currentRoute.value.params.workspaceId).toBe(workspaceId)
  } finally { wrapper.unmount(); disposePinia(pinia) }
})


test.each([
  { forkTurn: "70", machine: "pc", supported: true, expected: "dialog" },
  { forkTurn: "70", machine: "pc", supported: true, expected: "cancelProject" },
  { forkTurn: "70", machine: "pc", supported: true, expected: "escapeDefault" },
  { forkTurn: undefined, machine: "pc", supported: true, expected: "cancelWorker" },
  { forkTurn: "69", machine: "pc", supported: true, expected: "agent.forkStale" },
  { forkTurn: "70", machine: "other", supported: true, expected: "agent.forkScope" },
  { forkTurn: "70", machine: "pc", supported: false, expected: "agent.forkUnsupported" },
])("project fork from $machine turn $forkTurn with capability $supported gives $expected", async ({ forkTurn, machine, supported, expected }) => {
  const pinia = createPinia()
  const client = { ...getClient(), target: { id: "pc", local: false }, superAgent: { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() } }
  const context = createApp({}).provide(platformClientKey, client).use(pinia)
  const agents = context.runWithContext(() => useAgentSessionsStore())
  const fleet = context.runWithContext(() => useFleetStore())
  vi.spyOn(agents, "open").mockResolvedValue()
  vi.spyOn(agents, "attend").mockResolvedValue(false)
  vi.spyOn(fleet, "refreshLocalCatalog").mockResolvedValue()
  agents.state = "connected"
  const snapshot = agentSnapshot()
  snapshot.session.workspaceId = workspaceId
  snapshot.session.capabilities!.fork = supported
  snapshot.turns = [{ id: "70", sessionId: "30", runGeneration: 1, initialInputId: "40", dispatchCommandId: "50", startedAt: "now", state: "completed" }]
  agents.sessions["30"] = snapshot.session
  agents.views["30"] = { snapshot, events: [], loading: false, syncing: true, error: null, historySeq: "0", snapshotSeq: "0" }
  const child = agentSnapshot()
  child.session.id = "31"
  child.session.workspaceId = workspaceId
  const fork = vi.spyOn(agents, "fork").mockResolvedValue(child)
  fleet.catalog = catalogFixture()
  fleet.localDesktopTarget.online = true
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/sessions/:sessionId", name: "session", component: SessionView },
    { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
    { path: "/", name: "new-session", component: {} },
  ] })
  const superFrom = expected === "escapeDefault" ? "" : workspaceId
  await router.push({ name: "session", params: { sessionId: "30" }, query: { superMachine: machine, superFrom, forkTurn } })
  const wrapper = mount(SessionView, { attachTo: document.body, props: { sessionId: "30" }, global: {
    plugins: [pinia, router, i18n], provide: { [platformClientKey as symbol]: client },
    stubs: { AgentSessionMenu: true, SessionHeader: { template: "<header><slot name='actions'/></header>" } },
  } })
  try {
    await flushPromises()
    expect(wrapper.findComponent(ForkSessionDialog).exists()).toBe(false)
    agents.views["30"]!.syncing = false
    await flushPromises()
    expect(wrapper.getComponent(AgentSessionMenu).props("canFork")).toBe(supported)
    expect(router.currentRoute.value.query.forkTurn).toBeUndefined()
    if (expected.startsWith("agent.")) {
      expect(wrapper.findComponent(ForkSessionDialog).exists()).toBe(false)
      expect(wrapper.text()).toContain(i18n.global.t(expected))
      expect(fork).not.toHaveBeenCalled()
      return
    }
    if (expected === "cancelWorker") {
      wrapper.getComponent(AgentSessionMenu).vm.$emit("fork")
      await flushPromises()
    }
    expect(wrapper.getComponent(ForkSessionDialog).props("disabled")).toBe(false)
    const dialog = new DOMWrapper(document.querySelector<HTMLElement>('[role="dialog"]')!)
    if (expected !== "dialog") {
      if (expected === "escapeDefault") await dialog.trigger("keydown", { key: "Escape" })
      else await dialog.findAll("button").find(item => item.text() === i18n.global.t("catalog.cancel"))!.trigger("click")
      await vi.waitFor(() => expect(wrapper.findComponent(ForkSessionDialog).exists()).toBe(false))
      await flushPromises()
      expect(router.currentRoute.value.name).toBe(expected === "cancelWorker" ? "session" : expected === "escapeDefault" ? "new-session" : "workspace-agent")
      if (expected === "cancelProject") expect(router.currentRoute.value.params.workspaceId).toBe(workspaceId)
      expect(fork).not.toHaveBeenCalled()
      return
    }
    await dialog.get('[role="radio"][value="directory"]').trigger("click")
    await dialog.get(".ui-button-primary").trigger("click")
    await vi.waitFor(() => expect(wrapper.findComponent(ForkSessionDialog).exists()).toBe(false))
    expect(fork).toHaveBeenCalledExactlyOnceWith("30", "directory", "70")
    expect(router.currentRoute.value.params.sessionId).toBe("31")
    expect(router.currentRoute.value.query).toEqual({ superFrom: workspaceId, superMachine: "pc" })
  } finally { wrapper.unmount(); disposePinia(pinia) }
})

beforeEach(() => { useWorkspaceAgentMode().value = true })

afterEach(() => { useWorkspaceAgentMode().value = false })
