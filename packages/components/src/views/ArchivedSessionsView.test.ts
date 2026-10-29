import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { defineComponent, h } from "vue"
import { createMemoryHistory, createRouter, RouterView } from "vue-router"
import { accountSessionKey, createAccountSession, type AccountSession } from "../composables/useAccountSession.ts"
import { i18n } from "../i18n/index.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { agentSnapshot } from "../test/agent.ts"
import { catalogFixture, sessionId, workspaceId } from "../test/catalog.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { selectOption } from "../test/controls.ts"
import { deferred } from "../test/desktop-media.ts"
import ArchivedSessionsView from "./ArchivedSessionsView.vue"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
let account: AccountSession | undefined
const page = () => new DOMWrapper(document.body)
type Agents = ReturnType<typeof useAgentSessionsStore>

beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); i18n.global.locale.value = "en-US" })
afterEach(async () => {
  wrapper?.unmount(); wrapper = undefined
  disposePinia(pinia)
  account?.dispose(); account = undefined
  await flushPromises()
  vi.restoreAllMocks()
})

async function render(options: { empty?: boolean; online?: boolean; refresh?: (agents: Agents) => Promise<void> } = {}) {
  const agents = useAgentSessionsStore()
  const fleet = useFleetStore()
  fleet.localDesktopTarget.online = options.online ?? true
  fleet.localDesktopTarget.name = "Build machine"
  fleet.catalog = catalogFixture()
  if (!options.empty) {
    agents.sessions[sessionId] = { ...agentSnapshot().session, id: sessionId, workspaceId, title: "Ship archive UI", archiveState: "archived", updatedAt: "2026-10-26T12:00:00Z" }
    agents.sessions["31"] = { ...agentSnapshot().session, id: "31", workspaceId, title: "Still active", archiveState: "active", updatedAt: "2026-10-26T13:00:00Z" }
  }
  const restore = vi.spyOn(agents, "restore").mockImplementation(async id => {
    agents.sessions[id] = { ...agents.sessions[id]!, archiveState: "active" }
  })
  const refresh = vi.spyOn(agents, "refresh").mockImplementation(async () => { await options.refresh?.(agents) })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: { template: "<div>New session</div>" } },
    { path: "/sessions/archived", name: "archived-sessions", component: ArchivedSessionsView, meta: { hideDetails: true } },
    { path: "/sessions/:sessionId", name: "session", component: { template: "<div>Session conversation</div>" } },
  ] })
  await router.push("/sessions/archived")
  wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], provide: account ? { [accountSessionKey as symbol]: account } : {} },
  })
  await flushPromises()
  return { agents, fleet, restore, refresh, router }
}

test("direct navigation lists only archived Sessions, newest first, in the main page", async () => {
  const { agents, refresh, router } = await render()
  agents.sessions["32"] = { ...agentSnapshot().session, id: "32", workspaceId: undefined, title: "Home investigation", archiveState: "archived", updatedAt: "2026-10-27T12:00:00Z" }
  await flushPromises()
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(refresh).toHaveBeenCalledOnce()
  expect(wrapper!.get("h1").text()).toBe("Archived sessions")
  expect(wrapper!.findAll("[data-archived-session]").map(row => row.attributes("data-archived-session"))).toEqual(["32", sessionId])
  expect(wrapper!.text()).toContain("Ship archive UI")
  expect(wrapper!.text()).toContain("storefront")
  expect(wrapper!.text()).toContain("Build machine")
  expect(wrapper!.text()).not.toContain("Still active")
  expect(page().find('[role="dialog"]').exists()).toBe(false)
})

test("opening an archived conversation and going Back returns to the archive page without restoring", async () => {
  const { router, restore, refresh } = await render()
  await wrapper!.get('a[aria-label="Open Ship archive UI"]').trigger("click"); await flushPromises()
  expect(router.currentRoute.value).toMatchObject({ name: "session", params: { sessionId } })
  expect(restore).not.toHaveBeenCalled()
  router.back(); await flushPromises()
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(wrapper!.get("h1").text()).toBe("Archived sessions")
  expect(refresh).toHaveBeenCalledTimes(2)
})

test("initial loading precedes the empty archive state", async () => {
  const response = deferred<void>()
  await render({ empty: true, refresh: () => response.promise })
  expect(wrapper!.get('[role="status"]').text()).toBe("Loading archived sessions…")
  expect(wrapper!.text()).not.toContain("No archived sessions")
  expect(wrapper!.get('[aria-label="Refresh"]').attributes("disabled")).toBeDefined()
  response.resolve(); await flushPromises()
  expect(wrapper!.find('[role="status"]').exists()).toBe(false)
  expect(wrapper!.text()).toContain("No archived sessions")
  expect(wrapper!.get('[aria-label="Refresh"]').attributes("disabled")).toBeUndefined()
})

test("a failed refresh retains archived rows and Retry clears the error after a successful read", async () => {
  let fail = true
  const { refresh } = await render({ refresh: async agents => { if (fail) agents.error = "History unavailable" } })
  expect(wrapper!.get('[role="alert"]').text()).toBe("History unavailable")
  expect(wrapper!.text()).toContain("Ship archive UI")
  fail = false
  await wrapper!.findAll("button").find(button => button.text() === "Retry")!.trigger("click"); await flushPromises()
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(wrapper!.find('[role="alert"]').exists()).toBe(false)
  await wrapper!.get('[aria-label="Refresh"]').trigger("click"); await flushPromises()
  expect(refresh).toHaveBeenCalledTimes(3)
})

test("restoring a Session requires confirmation and then opens its conversation", async () => {
  const { router, restore } = await render()
  await wrapper!.get(`[data-restore-session="${sessionId}"]`).trigger("click"); await flushPromises()
  expect(restore).not.toHaveBeenCalled()
  const dialog = page().get('[role="dialog"]')
  expect(dialog.text()).toContain("Restore this session?")
  await dialog.get("[data-confirm-restore]").trigger("click"); await flushPromises()
  expect(restore).toHaveBeenCalledExactlyOnceWith(sessionId)
  expect(router.currentRoute.value).toMatchObject({ name: "session", params: { sessionId } })
  expect(page().find('[role="dialog"]').exists()).toBe(false)
})

test("restore failure remains in the confirmation for retry and cancellation leaves the Session archived", async () => {
  const { agents, router, restore } = await render()
  restore.mockRejectedValueOnce(new Error("Machine disconnected"))
  await wrapper!.get(`[data-restore-session="${sessionId}"]`).trigger("click"); await flushPromises()
  await page().get("[data-confirm-restore]").trigger("click"); await flushPromises()
  expect(page().get('[role="dialog"] [role="alert"]').text()).toBe("Machine disconnected")
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(agents.sessions[sessionId]!.archiveState).toBe("archived")
  await page().get('[role="dialog"]').trigger("keydown", { key: "Escape" }); await flushPromises()
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  await wrapper!.get(`[data-restore-session="${sessionId}"]`).trigger("click"); await flushPromises()
  expect(page().find('[role="alert"]').exists()).toBe(false)
  await page().get("[data-confirm-restore]").trigger("click"); await flushPromises()
  expect(restore).toHaveBeenCalledTimes(2)
  expect(router.currentRoute.value.params.sessionId).toBe(sessionId)
})

test("offline archived history can be opened without pin actions while restore and rename remain disabled", async () => {
  const { router, restore } = await render({ online: false })
  expect(wrapper!.get(`[data-restore-session="${sessionId}"]`).attributes("aria-disabled")).toBe("true")
  await wrapper!.get(`[data-restore-session="${sessionId}"]`).trigger("click"); await flushPromises()
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  expect(wrapper!.get("[data-archived-session]").text()).toContain("Offline")
  const link = wrapper!.get('a[aria-label="Open Ship archive UI"]')
  await link.trigger("contextmenu", { button: 2 }); await flushPromises()
  const items = page().findAll('[role="menuitem"]')
  expect(items.map(item => item.text())).toEqual(["Rename session", "Restore session"])
  expect(items.find(item => item.text() === "Rename session")!.attributes("data-disabled")).toBeDefined()
  expect(items.find(item => item.text() === "Restore session")!.attributes("data-disabled")).toBeDefined()
  await page().get('[role="menu"]').trigger("keydown", { key: "Escape" }); await flushPromises()
  await link.trigger("click"); await flushPromises()
  expect(router.currentRoute.value.params.sessionId).toBe(sessionId)
  expect(restore).not.toHaveBeenCalled()
})

test("a Machine going offline after opening the confirmation prevents restoration", async () => {
  const { fleet, restore } = await render()
  await wrapper!.get(`[data-restore-session="${sessionId}"]`).trigger("click"); await flushPromises()
  fleet.localDesktopTarget.online = false
  await flushPromises()
  expect(page().get("[data-confirm-restore]").attributes("disabled")).toBeDefined()
  await page().get("[data-confirm-restore]").trigger("click")
  expect(restore).not.toHaveBeenCalled()
})

test("an in-flight restore cannot submit twice or pull the user back after leaving the page", async () => {
  const { router, restore } = await render()
  const response = deferred<void>()
  restore.mockImplementation(() => response.promise)
  await wrapper!.get(`[data-restore-session="${sessionId}"]`).trigger("click"); await flushPromises()
  await page().get("[data-confirm-restore]").trigger("click")
  await page().get("[data-confirm-restore]").trigger("click")
  await page().get('[role="dialog"]').trigger("keydown", { key: "Escape" }); await flushPromises()
  expect(restore).toHaveBeenCalledOnce()
  expect(page().find('[role="dialog"]').exists()).toBe(true)
  await router.push("/"); await flushPromises()
  response.resolve(); await flushPromises()
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(page().find('[role="dialog"]').exists()).toBe(false)
})

test("the archive Machine selector delegates ordinary Machine selection", async () => {
  const fake = fakeCentral({ machines: [machineFixture("local-daemon", "team-1", "Build machine"), machineFixture("other", "team-1", "Other machine")] })
  account = createAccountSession(fake.central)
  await flushPromises()
  const selectMachine = vi.spyOn(account, "selectMachine")
  await render()
  await selectOption(wrapper!, '[data-control-name="archive-machine"]', "Other machine")
  expect(selectMachine).toHaveBeenCalledExactlyOnceWith("other")
})
