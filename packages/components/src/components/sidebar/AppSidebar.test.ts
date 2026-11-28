import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { computed, shallowReactive } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { i18n } from "../../i18n/index.ts"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { machineRuntimesKey, type MachineRuntime, type MachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { createSidebarFilter } from "../../composables/useSidebarFilter.ts"
import { createSidebarOrder } from "../../composables/useSidebarOrder.ts"
import { createSidebarPanel } from "../../composables/useSidebarPanel.ts"
import { useWorkspaceAgentMode } from "../../services/workspace-agent-navigation.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import AppSidebar from "./AppSidebar.vue"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia> | undefined
let activeAccount: AccountSession | undefined

async function mountSidebar(options: {
  account?: AccountSession
  client?: DeskfleetDesktopApi
  runtimes?: MachineRuntimes
} = {}) {
  pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/projects/new", name: "new-project", component: {} },
      { path: "/search", name: "search", component: {} },
      { path: "/desktops", name: "remote-desktops", component: {} },
      { path: "/schedules/:scheduleId?", name: "schedules", component: {} },
      { path: "/sessions/archived", name: "archived-sessions", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/terminals/:terminalId", name: "terminal", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
      { path: "/settings/preferences", name: "settings", component: {} },
    ],
  })
  await router.push("/")
  wrapper = mount(AppSidebar, {
    attachTo: document.body,
    global: {
      plugins: [pinia, router, i18n],
      provide: {
        ...(options.client && { [platformClientKey as symbol]: options.client }),
        ...(options.account && { [accountSessionKey as symbol]: options.account }),
        ...(options.runtimes && { [machineRuntimesKey as symbol]: options.runtimes }),
      },
      stubs: {
        Teleport: { inheritAttrs: false, template: "<slot />" },
        WindowToolbar: true,
        TeamSwitcher: true,
        SidebarNavigation: true,
        PinnedSessions: true,
        MachineSection: true,
        MachineSidebarSurface: true,
        AccountNotices: true,
        ProviderUpdateNotice: true,
        AppUpdateNotice: true,
        SidebarFooter: true,
      },
    },
  })
  await flushPromises()
  return { wrapper, fleet: useFleetStore(pinia) }
}

afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  activeAccount?.dispose()
  activeAccount = undefined
  if (pinia) {
    disposePinia(pinia)
    pinia = undefined
  }
  useWorkspaceAgentMode().value = false
  window.localStorage.clear()
  i18n.global.locale.value = "en-US"
  vi.restoreAllMocks()
  await flushPromises()
})

test("renders the machines header refresh control as an icon button with accessible name, hover tooltip, and intact add-machine button", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  useWorkspaceAgentMode().value = true
  const { central } = fakeCentral({ machines: [machineFixture("m1", "team-1", "Mac mini")] })
  activeAccount = createAccountSession(central)
  await flushPromises()
  const client: DeskfleetDesktopApi = {
    ...getClient(),
    platform: "darwin",
    localChannels: { open: vi.fn(), close: vi.fn(), send: vi.fn(), onEvent: vi.fn() },
  }
  const { wrapper } = await mountSidebar({ account: activeAccount, client })

  const refresh = wrapper.get('button[aria-label="刷新"]')
  const addMachine = wrapper.get('button[aria-label="添加机器"]')
  const header = refresh.element.closest("div")?.parentElement
  expect(header?.querySelector("span")?.textContent).toBe("机器")

  const actions = Array.from(refresh.element.parentElement?.querySelectorAll("button") ?? [])
  expect(actions).toEqual([refresh.element, addMachine.element])

  expect(refresh.text()).toBe("")
  expect(refresh.find('svg[aria-hidden="true"]').exists()).toBe(true)
  expect(refresh.classes()).toEqual(expect.arrayContaining(["ui-button-ghost", "h-7", "w-7"]))
  expect(addMachine.text()).toBe("")
  expect(addMachine.find('svg[aria-hidden="true"]').exists()).toBe(true)
  expect(addMachine.classes()).toEqual(expect.arrayContaining(["ui-button-ghost", "h-7", "w-7"]))

  vi.useFakeTimers()
  try {
    await refresh.trigger("pointermove", { pointerType: "mouse" })
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(wrapper.get('[role="tooltip"]').text()).toBe("刷新")
  } finally {
    vi.useRealTimers()
  }

  expect(activeAccount.dialog.value).toBeUndefined()
  await addMachine.trigger("click")
  expect(activeAccount.dialog.value).toBe("add-machine")
})

test("preserves refresh click dispatch and catalogLoading disabled state without affecting the add-machine button", async () => {
  const { central } = fakeCentral({ machines: [machineFixture("m1", "team-1", "Mac mini")] })
  activeAccount = createAccountSession(central)
  await flushPromises()
  const refreshMachines = vi.spyOn(activeAccount, "refreshMachines").mockResolvedValue()
  const refreshCatalog = vi.fn()
  const runtime = { refreshCatalog, mount: vi.fn(() => () => {}) } as unknown as MachineRuntime
  const runtimes = {
    opened: shallowReactive(new Map([["m1", runtime]])),
    sidebarScrollTop: 0,
    sidebarFilter: createSidebarFilter(),
    sidebarOrder: createSidebarOrder(computed(() => "test")),
    sidebarPanel: createSidebarPanel(),
    open: vi.fn(() => runtime),
  } as unknown as MachineRuntimes

  const { wrapper, fleet } = await mountSidebar({ account: activeAccount, runtimes })
  const refreshLocal = vi.spyOn(fleet, "refreshLocal").mockResolvedValue()
  const refreshButton = () => wrapper.get('button[aria-label="Refresh"]')
  const addButton = () => wrapper.get('button[aria-label="Add machine"]')

  await refreshButton().trigger("click")
  expect(refreshCatalog).toHaveBeenCalledTimes(1)
  expect(refreshMachines).toHaveBeenCalledTimes(1)
  expect(refreshLocal).not.toHaveBeenCalled()

  fleet.catalogLoading = true
  await flushPromises()
  expect(refreshButton().attributes("aria-disabled")).toBe("true")
  expect(refreshButton().classes()).toContain("op-40")
  await refreshButton().trigger("click")
  expect(refreshCatalog).toHaveBeenCalledTimes(1)
  expect(refreshMachines).toHaveBeenCalledTimes(1)

  expect(addButton().attributes("aria-disabled")).toBeUndefined()
  await addButton().trigger("click")
  expect(activeAccount.dialog.value).toBe("add-machine")
})

test("refreshes the local catalog when no remote machine runtimes are mounted", async () => {
  const { wrapper, fleet } = await mountSidebar()
  const refreshLocal = vi.spyOn(fleet, "refreshLocal").mockResolvedValue()
  const refreshButton = wrapper.get('button[aria-label="Refresh"]')
  expect(refreshButton.text()).toBe("")
  expect(wrapper.find('button[aria-label="Add machine"]').exists()).toBe(false)

  await refreshButton.trigger("click")
  expect(refreshLocal).toHaveBeenCalledTimes(1)
})
