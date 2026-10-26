import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import { agentSnapshot } from "../../test/agent.ts"
import { catalogFixture, sessionId, workspaceId } from "../../test/catalog.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import ArchivedSessionsButton from "./ArchivedSessionsButton.vue"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
const page = () => new DOMWrapper(document.body)

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  i18n.global.locale.value = "en-US"
})
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  disposePinia(pinia)
  await flushPromises()
  i18n.global.locale.value = "en-US"
  vi.restoreAllMocks()
})

async function render() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { template: "<div />" } },
      { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
    ],
  })
  await router.push("/")
  const agents = useAgentSessionsStore()
  const fleet = useFleetStore()
  fleet.localDesktopTarget.online = true
  fleet.catalog = catalogFixture()
  const archived = agentSnapshot().session
  agents.sessions[sessionId] = {
    ...archived,
    id: sessionId,
    workspaceId,
    title: "Ship archive UI",
    archiveState: "archived",
    updatedAt: "2026-10-26T12:00:00Z",
  }
  agents.sessions["31"] = {
    ...archived,
    id: "31",
    workspaceId,
    title: "Still active",
    archiveState: "active",
    updatedAt: "2026-10-26T13:00:00Z",
  }
  const restore = vi.spyOn(agents, "restore").mockImplementation(async id => {
    agents.sessions[id] = { ...agents.sessions[id]!, archiveState: "active" }
  })
  const refresh = vi.spyOn(agents, "refresh").mockResolvedValue()
  wrapper = mount(ArchivedSessionsButton, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n] },
  })
  return { router, restore, refresh }
}

test("footer control lists archived sessions and restores one after confirmation", async () => {
  const { router, restore, refresh } = await render()
  expect(wrapper!.find('[aria-label="Archived sessions"]').exists()).toBe(true)
  await wrapper!.get("[data-archived-sessions]").trigger("click")
  await flushPromises()
  expect(refresh).toHaveBeenCalledOnce()
  const dialog = page().get('[role="dialog"]')
  expect(dialog.text()).toContain("Archived sessions")
  expect(dialog.text()).toContain("Ship archive UI")
  expect(dialog.text()).toContain("storefront")
  expect(dialog.text()).not.toContain("Still active")
  await dialog.get(`[data-restore-session="${sessionId}"]`).trigger("click")
  await flushPromises()
  const confirm = page().findAll('[role="dialog"]').at(-1)!
  expect(confirm.text()).toContain("Restore this session?")
  await confirm.get("[data-confirm-restore]").trigger("click")
  await flushPromises()
  expect(restore).toHaveBeenCalledExactlyOnceWith(sessionId)
  expect(router.currentRoute.value).toMatchObject({ name: "session", params: { sessionId } })
  expect(page().find('[role="dialog"]').exists()).toBe(false)
})

test("opening an archived session navigates without restoring", async () => {
  const { router, restore } = await render()
  await wrapper!.get("[data-archived-sessions]").trigger("click")
  await flushPromises()
  await page().get('[aria-label="Open Ship archive UI"]').trigger("click")
  await flushPromises()
  expect(restore).not.toHaveBeenCalled()
  expect(router.currentRoute.value).toMatchObject({ name: "session", params: { sessionId } })
})

test("zh locale labels the archived sessions chrome control", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await render()
  expect(wrapper!.find('[aria-label="已归档会话"]').exists()).toBe(true)
})
