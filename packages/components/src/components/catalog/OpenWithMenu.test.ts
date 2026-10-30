import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { LocalApplication } from "../../../../client/src/applications.ts"
import { i18n } from "../../i18n/index.ts"
import { workspaceId } from "../../test/catalog.ts"
import OpenWithMenu from "./OpenWithMenu.vue"

const cleanup: (() => void)[] = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop() })
const installed: LocalApplication[] = [
  { id: "vscode", name: "VS Code", kind: "editor" },
  { id: "cursor", name: "Cursor", kind: "editor" },
  { id: "vscodium", name: "VSCodium", kind: "editor" },
  { id: "zed", name: "Zed", kind: "editor" },
  { id: "terminal", name: "Host terminal", kind: "terminal" },
  { id: "file-manager", name: "Host file manager", kind: "fileManager" },
]

async function setup(props: { directoryIndex?: number; directoryPath?: string; disabled?: boolean } = {}) {
  const applications = {
    scan: vi.fn(async (): Promise<LocalApplication[]> => installed),
    openWorkspace: vi.fn(async () => {}),
  }
  const wrapper = mount(OpenWithMenu, {
    props: { api: applications, machineId: "machine-1", workspaceId, ...props }, attachTo: document.body,
    global: { plugins: [i18n] },
  })
  cleanup.push(() => wrapper.unmount())
  return { wrapper, applications }
}

const page = () => new DOMWrapper(document.body)
const menuItems = () => page().findAll('[role="menuitem"]')
async function openMenu(wrapper: VueWrapper, label = "Open default directory with"): Promise<void> {
  const trigger = wrapper.get<HTMLButtonElement>(`button[aria-label="${label}"]`)
  trigger.element.focus()
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
}
async function choose(name: string): Promise<void> {
  const item = menuItems().find(item => item.text() === name)!
  ;(item.element as HTMLElement).focus()
  await item.trigger("keydown", { key: "Enter" })
  await flushPromises()
}

test("Open with scans on demand and opens the default directory without sending its path", async () => {
  const { wrapper, applications } = await setup()
  expect(applications.scan).not.toHaveBeenCalled()
  await openMenu(wrapper)
  expect(applications.scan).toHaveBeenCalledOnce()
  expect(menuItems().map(item => item.text())).toEqual(["VS Code", "Cursor", "VSCodium", "Zed", "Terminal", "File manager", "Rescan"])
  await choose("VS Code")
  expect(applications.openWorkspace).toHaveBeenCalledExactlyOnceWith({ applicationId: "vscode", machineId: "machine-1", workspaceId })
  expect(page().find('[role="menu"]').exists()).toBe(false)
})

test("the menu shows scanning and empty states, and Rescan refreshes installed choices", async () => {
  const { wrapper, applications } = await setup()
  let finish!: (applications: LocalApplication[]) => void
  applications.scan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await openMenu(wrapper)
  expect(page().get('[role="status"]').text()).toBe("Scanning installed apps…")
  expect(menuItems().find(item => item.text() === "Rescan")!.attributes("data-disabled")).toBeDefined()
  finish([])
  await flushPromises()
  expect(page().get('[role="status"]').text()).toBe("No supported apps found.")
  applications.scan.mockResolvedValueOnce([installed[1]!])
  await choose("Rescan")
  expect(applications.scan).toHaveBeenCalledTimes(2)
  expect(menuItems().map(item => item.text())).toEqual(["Cursor", "Rescan"])
  expect(applications.openWorkspace).not.toHaveBeenCalled()
})

test.each([
  { name: "Terminal", id: "terminal" },
  { name: "File manager", id: "file-manager" },
])("an additional directory opens in the external $name by its configured index", async ({ name, id }) => {
  const { wrapper, applications } = await setup({ directoryIndex: 1, directoryPath: "/code/api" })
  await openMenu(wrapper, "Open /code/api with")
  await choose(name)
  expect(applications.openWorkspace).toHaveBeenCalledExactlyOnceWith({ applicationId: id, machineId: "machine-1", workspaceId, directoryIndex: 1 })
})

test("scan failures stay visible in the menu and can be retried with Rescan", async () => {
  const { wrapper, applications } = await setup()
  applications.scan.mockRejectedValueOnce(new Error("Host scan failed"))
  await openMenu(wrapper)
  expect(page().get('[role="alert"]').text()).toBe("Could not scan apps: Host scan failed")
  await choose("Rescan")
  expect(page().find('[role="alert"]').exists()).toBe(false)
  expect(menuItems().map(item => item.text())).toContain("Zed")
})

test("launch failures remain visible after the menu closes and allow another attempt", async () => {
  const { wrapper, applications } = await setup()
  applications.openWorkspace.mockRejectedValueOnce(new Error("Application was removed"))
  await openMenu(wrapper)
  await choose("Cursor")
  expect(page().find('[role="menu"]').exists()).toBe(false)
  expect(wrapper.get('[role="alert"]').text()).toBe("Could not open Cursor: Application was removed")
  await openMenu(wrapper)
  await choose("Zed")
  expect(applications.openWorkspace).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})

test("disabled application actions do not scan", async () => {
  const { wrapper, applications } = await setup({ disabled: true })
  expect(wrapper.get('button[aria-label="Open default directory with"]').attributes("disabled")).toBeDefined()
  expect(applications.scan).not.toHaveBeenCalled()
})
