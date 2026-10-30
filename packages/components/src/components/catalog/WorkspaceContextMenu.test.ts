import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { h, ref } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import WorkspaceContextMenu from "./WorkspaceContextMenu.vue"

const cleanup: (() => void)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0)) stop(); await flushPromises() })
const page = () => new DOMWrapper(document.body)
const menuItem = (label: string) => page().findAll('[role="menuitem"]').find(item => item.text() === label)!

async function setup(disabled = false, selectedMachine = "local-daemon") {
  const pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore()
  const update = vi.spyOn(fleet, "updateWorkspace").mockResolvedValue()
  const remove = vi.spyOn(fleet, "deleteWorkspace").mockResolvedValue()
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: {} },
    { path: "/sessions/:sessionId", name: "session", component: {} },
  ] })
  await router.push("/")
  const wrapper = mount(WorkspaceContextMenu, {
    attachTo: document.body,
    props: { workspaceId: "workspace", machineId: "local-daemon", name: "Project", directories: [{ path: "/code/project" }], disabled },
    slots: { default: () => h("button", { type: "button" }, "Project") },
    global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: { machineId: ref(selectedMachine) } } },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  return { wrapper, update, remove, fleet, router }
}

async function openMenu(wrapper: VueWrapper): Promise<void> {
  await wrapper.get("button").trigger("contextmenu", { button: 2 }); await flushPromises()
}

test("keyboard workspace management edits the clicked workspace and restores row focus", async () => {
  const { wrapper, update } = await setup()
  const row = wrapper.get("button")
  row.element.focus()
  await row.trigger("keydown", { key: "F10", shiftKey: true }); await flushPromises()
  expect(page().findAll('[role="menuitem"]').map(item => item.text())).toEqual(["Edit workspace", "Delete workspace"])
  await menuItem("Edit workspace").trigger("click"); await flushPromises()
  const dialog = page().get('[role="dialog"]')
  await dialog.get('input[name="workspace-name"]').setValue("Renamed")
  await dialog.get("form").trigger("submit"); await flushPromises()
  expect(update).toHaveBeenCalledExactlyOnceWith("workspace", "Renamed", [{ path: "/code/project" }])
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  await vi.waitFor(() => expect(document.activeElement).toBe(row.element))
})

test("deletion requires confirmation and retains a failed attempt for retry", async () => {
  const { wrapper, remove } = await setup()
  remove.mockRejectedValueOnce(new Error("Workspace is still in use"))
  await openMenu(wrapper)
  await menuItem("Delete workspace").trigger("click"); await flushPromises()
  expect(remove).not.toHaveBeenCalled()
  const dialog = page().get('[role="dialog"]')
  expect(dialog.text()).toContain("Project")
  await dialog.get(".ui-button-danger").trigger("click"); await flushPromises()
  expect(remove).toHaveBeenCalledExactlyOnceWith("workspace")
  expect(dialog.get('[role="alert"]').text()).toBe("Workspace is still in use")
  await dialog.get(".ui-button-danger").trigger("click"); await flushPromises()
  expect(remove).toHaveBeenCalledTimes(2)
  expect(page().find('[role="dialog"]').exists()).toBe(false)
})

test("unavailable workspace management remains disabled", async () => {
  const { wrapper, update, remove } = await setup(true)
  await openMenu(wrapper)
  for (const item of page().findAll('[role="menuitem"]')) {
    expect(item.attributes("data-disabled")).toBeDefined()
    await item.trigger("click")
  }
  await flushPromises()
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  expect(update).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})

test.each(["local-daemon", "other-machine"])("deletion redirects only for the selected owning machine (%s)", async selectedMachine => {
  const { wrapper, fleet, router } = await setup(false, selectedMachine)
  vi.spyOn(fleet, "findSession").mockReturnValue({
    machine: { id: "local-daemon", name: "host", local: true, online: true, desktop: false, sessions: [], terminals: [], workspaces: [] },
    workspace: { id: "workspace", name: "Project", directories: [], sessions: [], terminals: [] },
    session: { id: "session" },
  })
  await router.push({ name: "session", params: { sessionId: "session" } })
  await openMenu(wrapper)
  await menuItem("Delete workspace").trigger("click"); await flushPromises()
  await page().get('[role="dialog"] .ui-button-danger').trigger("click"); await flushPromises()
  expect(router.currentRoute.value.name).toBe(selectedMachine === "local-daemon" ? "new-session" : "session")
})
