import { useWorkspaceAgentMode } from "../../services/workspace-agent-navigation.ts"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import SidebarNavigation from "./SidebarNavigation.vue"
import { accountSessionKey, createAccountSession } from "../../composables/useAccountSession.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import { platformClientKey } from "../../composables/usePlatformClient.ts"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia> | undefined
const tabButton = (label: string) => wrapper!.get<HTMLButtonElement>(`button[role="tab"][aria-label="${label}"]`)

async function setup(path = "/", client?: DeskfleetDesktopApi, account?: ReturnType<typeof createAccountSession>) {
  pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/projects/new", name: "new-project", component: {} },
      { path: "/compose", name: "manual-session", component: {} },
      { path: "/search", name: "search", component: {} },
      { path: "/desktops", name: "remote-desktops", component: {} },
      { path: "/schedules/:scheduleId?", name: "schedules", component: {} },
      { path: "/sessions/archived", name: "archived-sessions", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/terminals/:terminalId", name: "terminal", component: {} },
      { path: "/worktrees/:worktreeId", name: "worktree", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
      { path: "/super-agent", name: "super-agent", component: {} },
    ],
  })
  await router.push(path)
  wrapper = mount(SidebarNavigation, { attachTo: document.body, global: {
    plugins: [pinia, router, i18n], provide: {
      ...(client && { [platformClientKey as symbol]: client }),
      ...(account && { [accountSessionKey as symbol]: account }),
    },
  } })
  await flushPromises()
  return { router, layout: useLayoutStore() }
}

afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  if (pinia) {
    disposePinia(pinia)
    pinia = undefined
  }
  window.localStorage.clear()
  await flushPromises()
  i18n.global.locale.value = "en-US"
})

test("renders accessible tablist capsules that switch sidebar panels without changing the main route", async () => {
  const { router, layout } = await setup("/sessions/session-42?tab=changes")
  expect(wrapper!.get("nav").attributes("aria-label")).toBe("Navigation")
  expect(wrapper!.get('[role="tablist"]').attributes("aria-label")).toBe("Navigation")
  expect(tabButton("Conversations").attributes("aria-selected")).toBe("true")
  expect(tabButton("Conversations").attributes("tabindex")).toBe("0")
  expect(tabButton("Schedules").attributes("aria-selected")).toBe("false")
  expect(tabButton("Schedules").attributes("tabindex")).toBe("-1")

  await tabButton("Schedules").trigger("click")
  expect(layout.sidebarPanel.panel.value).toBe("schedules")
  expect(tabButton("Schedules").attributes("aria-selected")).toBe("true")
  expect(router.currentRoute.value.fullPath).toBe("/sessions/session-42?tab=changes")

  await tabButton("Search").trigger("click")
  expect(layout.sidebarPanel.panel.value).toBe("search")
  expect(router.currentRoute.value.fullPath).toBe("/sessions/session-42?tab=changes")

  await tabButton("Remote desktop").trigger("click")
  expect(layout.sidebarPanel.panel.value).toBe("desktops")
  expect(router.currentRoute.value.fullPath).toBe("/sessions/session-42?tab=changes")
})

test("supports roving arrow-key focus with manual activation", async () => {
  const { layout } = await setup("/sessions/session-42")
  const conversations = tabButton("Conversations")
  const schedules = tabButton("Schedules")
  const search = tabButton("Search")

  conversations.element.focus()
  await conversations.trigger("keydown", { key: "ArrowRight" })
  expect(document.activeElement).toBe(schedules.element)
  expect(layout.sidebarPanel.panel.value).toBe("conversations")

  await schedules.trigger("keydown", { key: "End" })
  expect(document.activeElement).toBe(search.element)
  expect(layout.sidebarPanel.panel.value).toBe("conversations")

  await search.trigger("keydown", { key: "Home" })
  expect(document.activeElement).toBe(conversations.element)
})

test.each([
  { path: "/schedules", panel: "schedules", label: "Schedules" },
  { path: "/schedules/daily-review", panel: "schedules", label: "Schedules" },
  { path: "/desktops", panel: "desktops", label: "Remote desktop" },
  { path: "/search?q=review&kind=chat", panel: "search", label: "Search" },
])("syncs initial deep link $path to the $panel sidebar panel", async ({ path, panel, label }) => {
  const { layout } = await setup(path)
  expect(layout.sidebarPanel.panel.value).toBe(panel)
  expect(tabButton(label).attributes("aria-selected")).toBe("true")
})

test("keeps the Search sidebar panel open when navigating to a session or schedule result", async () => {
  const { router, layout } = await setup("/sessions/session-42")
  await tabButton("Search").trigger("click")
  expect(layout.sidebarPanel.panel.value).toBe("search")

  await router.push("/sessions/session-99")
  await flushPromises()
  expect(layout.sidebarPanel.panel.value).toBe("search")

  await router.push("/schedules/daily-review")
  await flushPromises()
  expect(layout.sidebarPanel.panel.value).toBe("search")
})

test.each(["darwin", "web"] as const)("the project-aware %s host puts project actions under their machine", async platform => {
  useWorkspaceAgentMode().value = true
  const machine = machineFixture("remote", "team-1", "Existing Mac")
  const { central } = fakeCentral({ machines: [machine] })
  const account = createAccountSession(central)
  try {
    await flushPromises()
    await setup("/sessions/session-42", {
      ...getClient(), platform, remoteWorkspaceAgent: platform === "web", target: { id: machine.id, local: false },
      localChannels: platform === "web" ? undefined : { open: vi.fn(), close: vi.fn(), send: vi.fn(), onEvent: vi.fn() },
    }, account)
    expect(wrapper!.find('[data-new-project]').exists()).toBe(false)
    expect(wrapper!.text()).not.toContain(i18n.global.t("superAgent.defaultWorkspace"))
    expect(wrapper!.text()).not.toContain(i18n.global.t("nav.newSession"))
  } finally {
    account.dispose()
  }
})

afterEach(() => { useWorkspaceAgentMode().value = false })
