import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import type { CatalogWorkspace } from "../../../../client/src/catalog.ts"
import { i18n } from "../../i18n/index.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import FolderPickerDialog from "../common/FolderPickerDialog.vue"
import WorkspaceCreateDialog from "./WorkspaceCreateDialog.vue"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia> | undefined
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  if (pinia) disposePinia(pinia)
  pinia = undefined
  await flushPromises()
  vi.restoreAllMocks()
})

test("Escape cannot cancel a pending creation and is available again after saving fails", async () => {
  pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore()
  fleet.localDesktopTarget.online = true
  fleet.catalogReady = true
  const request = Promise.withResolvers<CatalogWorkspace>()
  const create = vi.spyOn(fleet, "createWorkspace").mockReturnValue(request.promise)
  const view = mount(WorkspaceCreateDialog, {
    attachTo: document.body,
    global: { plugins: [pinia, i18n], stubs: { FolderPickerDialog: true } },
  })
  wrapper = view
  await flushPromises()
  const page = new DOMWrapper(document.body)
  await page.get('button[name="directory-path-0"]').trigger("click")
  view.getComponent(FolderPickerDialog).vm.$emit("select", "/code/project")
  await view.vm.$nextTick()
  await page.get('[role="dialog"] form').trigger("submit")
  expect(create).toHaveBeenCalledExactlyOnceWith("project", [{ path: "/code/project" }])
  await page.get('[role="dialog"]').trigger("keydown", { key: "Escape" })
  expect(page.get('[role="dialog"]').attributes("data-state")).toBe("open")
  expect(view.emitted("cancel")).toBeUndefined()

  request.reject(new Error("Directory unavailable"))
  await flushPromises()
  expect(page.get('[role="alert"]').text()).toBe("Directory unavailable")
  await page.get('[role="dialog"]').trigger("keydown", { key: "Escape" })
  await vi.waitFor(() => expect(view.emitted("cancel")).toHaveLength(1))
  expect(page.find('[role="dialog"]').exists()).toBe(false)
  expect(view.emitted("created")).toBeUndefined()
})
