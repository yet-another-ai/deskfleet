import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { h } from "vue"
import { createMemoryHistory, createRouter, RouterLink } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import SessionContextMenu from "./SessionContextMenu.vue"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
const page = () => new DOMWrapper(document.body)
const item = (text: string) => page().findAll('[role="menuitem"]').find(item => item.text() === text)!

beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); i18n.global.locale.value = "en-US" })
afterEach(async () => {
  wrapper?.unmount(); wrapper = undefined
  disposePinia(pinia)
  await flushPromises()
})

async function render(selected = false, disabled = false, archiveState: "active" | "archiving" | "archived" = "active") {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
  ] })
  await router.push(`/sessions/${selected ? "30" : "31"}`)
  const agents = useAgentSessionsStore()
  const rename = vi.spyOn(agents, "rename").mockResolvedValue()
  const archive = vi.spyOn(agents, "archive").mockResolvedValue()
  const restore = vi.spyOn(agents, "restore").mockResolvedValue()
  wrapper = mount(SessionContextMenu, {
    attachTo: document.body,
    props: { sessionId: "30", title: "Investigate failing checks", archiveState, disabled },
    slots: { default: () => h(RouterLink, { to: "/sessions/30" }, () => "Investigate failing checks") },
    global: { plugins: [pinia, router, i18n] },
  })
  return { router, rename, archive, restore, row: wrapper.get("a") }
}

test.each([false, true])("right-click opens a session menu without navigating (selected: %s)", async selected => {
  const { router, row } = await render(selected)
  await row.trigger("contextmenu", { button: 2, clientX: 30, clientY: 40 }); await flushPromises()
  expect(page().get('[role="menu"]').attributes("aria-label")).toBe("Session actions")
  expect(page().findAll('[role="menuitem"]').map(item => item.text())).toEqual(["Rename session", "Archive session"])
  expect(router.currentRoute.value.params.sessionId).toBe(selected ? "30" : "31")
  await page().get('[role="menu"]').trigger("keydown", { key: "Escape" }); await flushPromises()
  expect(page().find('[role="menu"]').exists()).toBe(false)
  await vi.waitFor(() => expect(document.activeElement).toBe(row.element))
})

test("offline sessions expose disabled actions without opening dialogs", async () => {
  const { row, rename, archive } = await render(false, true)
  await row.trigger("contextmenu", { button: 2 }); await flushPromises()
  for (const action of page().findAll('[role="menuitem"]')) {
    expect(action.attributes("data-disabled")).toBeDefined()
    await action.trigger("click")
  }
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  expect(rename).not.toHaveBeenCalled()
  expect(archive).not.toHaveBeenCalled()
})

test.each([{ key: "F10", shiftKey: true }, { key: "ContextMenu" }])("keyboard context menu supports $key and Escape returns focus", async keys => {
  const { row } = await render()
  row.element.focus()
  await row.trigger("keydown", keys); await flushPromises()
  expect(page().find('[role="menu"]').exists()).toBe(true)
  await page().get('[role="menu"]').trigger("keydown", { key: "Escape" }); await flushPromises()
  expect(page().find('[role="menu"]').exists()).toBe(false)
  await vi.waitFor(() => expect(document.activeElement).toBe(row.element))
})

test("rename operates on the clicked session, retains failures, and restores row focus after retry", async () => {
  const { router, row, rename } = await render()
  rename.mockRejectedValueOnce(new Error("Connection lost"))
  await row.trigger("contextmenu", { button: 2 }); await flushPromises()
  await item("Rename session").trigger("click"); await flushPromises()
  expect(page().find('[role="menu"]').exists()).toBe(false)
  const dialog = page().get('[role="dialog"]')
  await vi.waitFor(() => expect(document.activeElement).toBe(dialog.get("input").element))
  expect(dialog.get("input").element.value).toBe("Investigate failing checks")
  await dialog.get("input").setValue("  Payment investigation  ")
  await dialog.get("form").trigger("submit"); await flushPromises()
  expect(rename).toHaveBeenCalledExactlyOnceWith("30", "Payment investigation")
  expect(dialog.get('[role="alert"]').text()).toBe("Connection lost")
  expect(dialog.get("input").element.value).toBe("  Payment investigation  ")
  expect(router.currentRoute.value.params.sessionId).toBe("31")
  await dialog.get("form").trigger("submit"); await flushPromises()
  expect(rename).toHaveBeenCalledTimes(2)
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  await vi.waitFor(() => expect(document.activeElement).toBe(row.element))
})

test.each(["active", "archived"] as const)("%s session confirms its archive action without navigating", async archiveState => {
  const { router, row, archive, restore } = await render(false, false, archiveState)
  const action = archiveState === "archived" ? "Restore session" : "Archive session"
  await row.trigger("contextmenu", { button: 2 }); await flushPromises()
  await item(action).trigger("click"); await flushPromises()
  expect(archive).not.toHaveBeenCalled()
  expect(restore).not.toHaveBeenCalled()
  const dialog = page().get('[role="dialog"]')
  expect(dialog.text()).toContain(archiveState === "archived" ? "Restore this session?" : "Archive this session?")
  await dialog.get(".ui-button-primary").trigger("click"); await flushPromises()
  expect(archiveState === "archived" ? restore : archive).toHaveBeenCalledExactlyOnceWith("30")
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  expect(router.currentRoute.value.params.sessionId).toBe("31")
  await vi.waitFor(() => expect(document.activeElement).toBe(row.element))
})
