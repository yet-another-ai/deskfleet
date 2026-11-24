import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import AccountMenu from "./AccountMenu.vue"
import SidebarDesktopsPanel from "./SidebarDesktopsPanel.vue"
import SidebarSchedulesPanel from "./SidebarSchedulesPanel.vue"
import SuperAgentSection from "./SuperAgentSection.vue"

let wrapper: VueWrapper | undefined
let account: AccountSession | undefined
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  localStorage.clear()
  i18n.global.locale.value = "en-US"
})

afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  account?.dispose()
  account = undefined
  disposePinia(pinia)
  await flushPromises()
  vi.restoreAllMocks()
})

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/super-agent", name: "super-agent", component: {} },
      { path: "/desktops", name: "remote-desktops", component: {} },
      { path: "/schedules/:scheduleId?", name: "schedules", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/terminals/:terminalId", name: "terminal", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
    ],
  })
}

test("SuperAgentSection renders as an expandable machine node with sessions and new-conversation action", async () => {
  const fake = fakeCentral()
  fake.central.superAgentAvailability.mockResolvedValue({ enabled: true })
  fake.central.superAgentSessions.mockResolvedValue([
    { sessionId: "sa-1", title: "Release planning", lastActiveAt: 2000, engine: "hosted" },
    { sessionId: "sa-2", title: null, lastActiveAt: 1000, engine: "hosted" },
  ])
  account = createAccountSession(fake.central)
  await flushPromises()
  const router = makeRouter()
  await router.push("/")
  wrapper = mount(SuperAgentSection, {
    global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: account } },
  })
  await flushPromises()

  expect(wrapper.find("[data-super-agent-section]").exists()).toBe(true)
  expect(wrapper.text()).toContain("Super Agent")
  expect(wrapper.text()).toContain("Release planning")
  expect(wrapper.text()).toContain("Untitled conversation")

  await wrapper.get('a[href="/super-agent?session=hosted:sa-1"]').trigger("click")
  await flushPromises()
  expect(router.currentRoute.value).toMatchObject({ name: "super-agent", query: { session: "hosted:sa-1" } })

  await wrapper.get('button[aria-label="New conversation"]').trigger("click")
  await flushPromises()
  expect(router.currentRoute.value).toMatchObject({ name: "super-agent", query: { new: "1" } })

  // Filtering unread/working hides idle Super Agent section.
  useLayoutStore().sidebarFilter.filter.value = "unread"
  await flushPromises()
  expect(wrapper.find("[data-super-agent-section]").exists()).toBe(false)
})

test("SidebarDesktopsPanel lists machines and opens remote desktop control tabs", async () => {
  const fake = fakeCentral({
    machines: [
      machineFixture("m1", "team-1", "Runner", true),
    ],
  })
  fake.state.machines[0]!.capabilities.desktop = true
  account = createAccountSession(fake.central)
  await flushPromises()
  const openMachineRoute = vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  const router = makeRouter()
  await router.push("/desktops")
  wrapper = mount(SidebarDesktopsPanel, {
    global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: account } },
  })
  await flushPromises()

  expect(wrapper.get('a[href="/desktops"]').text()).toContain("All machines")
  const machineBtn = wrapper.findAll("button").find(b => b.text().includes("Runner"))!
  await machineBtn.trigger("click")
  expect(openMachineRoute).toHaveBeenCalledWith("m1", { name: "machine-control", params: { machineId: "m1" }, query: { tab: "desktop" } })
})

test("AccountMenu displays team name, plan badge, and user name in one bottom trigger", async () => {
  const fake = fakeCentral()
  fake.central.billing.mockResolvedValue({ ...(await fake.central.billing("team-1")), plan: "pro" })
  account = createAccountSession(fake.central)
  await flushPromises()
  const router = makeRouter()
  await router.push("/")
  wrapper = mount(AccountMenu, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: account } },
  })
  await flushPromises()

  const trigger = wrapper.get("[data-account-menu] button")
  expect(trigger.text()).toContain("Design team")
  expect(trigger.text()).toContain("Pro")
  expect(trigger.text()).toContain("Ada")
})

test("SidebarSchedulesPanel groups tasks by machine like Conversations and opens task details", async () => {
  const fake = fakeCentral({
    machines: [
      machineFixture("m1", "team-1", "Studio", true),
      machineFixture("m2", "team-1", "Runner", true),
    ],
  })
  fake.central.rpc = vi.fn(async (_teamId: string, machineId: string, method: string) => {
    if (method !== "scheduleList") return null
    if (machineId === "m1") {
      return [{
        id: "sched-1", title: "Nightly check", prompt: "Run checks", workspaceId: "w1", enabled: true,
        target: { kind: "new", provider: "codex", context: "worktree" },
        trigger: { kind: "daily", time: "09:00", timeZone: "UTC" },
        createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z", runs: [],
      }]
    }
    return []
  }) as typeof fake.central.rpc
  account = createAccountSession(fake.central)
  await flushPromises()
  const openMachineRoute = vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  const router = makeRouter()
  await router.push("/schedules")
  wrapper = mount(SidebarSchedulesPanel, {
    global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: account } },
  })
  await flushPromises()

  expect(wrapper.find('[data-machine-id="m1"]').text()).toContain("Studio")
  expect(wrapper.find('[data-machine-id="m1"]').text()).toContain("Nightly check")
  expect(wrapper.find('[data-machine-id="m2"]').text()).toContain("Runner")
  await wrapper.get('[data-schedule-id="sched-1"]').trigger("click")
  expect(openMachineRoute).toHaveBeenCalledWith("m1", { name: "schedules", params: { scheduleId: "sched-1" } })

  await wrapper.get("[data-sidebar-schedule-new-primary]").trigger("click")
  expect(openMachineRoute).toHaveBeenCalledWith("m1", { name: "schedules", params: { scheduleId: "new" } })
})
