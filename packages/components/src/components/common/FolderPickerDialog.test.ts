import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { DirectoryListing } from "../../../../client/src/filesystem.ts"
import { i18n } from "../../i18n/index.ts"
import FolderPickerDialog from "./FolderPickerDialog.vue"

let wrapper: VueWrapper | undefined
const home: DirectoryListing = {
  path: "/home/agent", parentPath: "/home", homePath: "/home/agent", roots: [{ name: "/", path: "/" }],
  directories: [
    { name: "code", path: "/home/agent/code", hidden: false },
    { name: ".config", path: "/home/agent/.config", hidden: true },
  ],
}
const code: DirectoryListing = { ...home, path: "/home/agent/code", parentPath: "/home/agent", directories: [] }
async function render(browse: (path?: string) => Promise<DirectoryListing>, initialPath?: string) {
  wrapper = mount(FolderPickerDialog, { attachTo: document.body,
    props: { browse, initialPath, machineName: "remote-builder" },
    global: { stubs: { teleport: { inheritAttrs: false, template: "<slot />" } }, plugins: [i18n] },
  })
  await wrapper.vm.$nextTick()
  return wrapper
}
function button(view: VueWrapper, text: string) {
  return view.findAll("button").find(value => value.text() === text)!
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

test("browses folders on the supplied machine and only selects the loaded directory", async () => {
  let loaded!: (value: DirectoryListing) => void
  const browse = vi.fn().mockReturnValueOnce(new Promise<DirectoryListing>(resolve => { loaded = resolve })).mockResolvedValueOnce(code).mockResolvedValueOnce(home)
  const view = await render(browse)
  expect(button(view, "Select folder").attributes("disabled")).toBeDefined()
  loaded(home)
  await flushPromises()
  expect(browse).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(view.text()).toContain("remote-builder")
  expect(view.find("input:not([type=checkbox])").exists()).toBe(false)
  expect(view.find('[aria-label="Open .config"]').exists()).toBe(false)
  await view.get('[role="checkbox"]').trigger("click")
  expect(view.find('[aria-label="Open .config"]').exists()).toBe(true)
  await view.get('[aria-label="Open code"]').trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith("/home/agent/code")
  expect(view.get('[role="status"]').text()).toBe("No folders in this location.")
  expect(view.emitted("select")).toBeUndefined()
  await view.get('nav[aria-label="Current location"] button').trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith("/home/agent")
  await button(view, "Select folder").trigger("click")
  expect(view.emitted("select")).toEqual([["/home/agent"]])
  expect(view.emitted("cancel")).toBeUndefined()
})

test("toggles the top location bar into an input when clicking the edit button and navigates on Enter or check button", async () => {
  const browse = vi.fn().mockResolvedValueOnce(home).mockResolvedValueOnce(code).mockResolvedValueOnce(home)
  const view = await render(browse)
  await flushPromises()
  expect(view.find('input[name="folder-picker-path"]').exists()).toBe(false)
  await view.get("[data-edit-path]").trigger("click")
  const pathInput = view.get('input[name="folder-picker-path"]')
  expect((pathInput.element as HTMLInputElement).value).toBe("/home/agent")
  await pathInput.setValue("/home/agent/code")
  await view.get("[data-apply-path]").trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith("/home/agent/code")
  expect(view.find('input[name="folder-picker-path"]').exists()).toBe(false)
  expect(view.get("[data-current-path]").attributes("data-current-path")).toBe("/home/agent/code")
  await view.get("[data-edit-path]").trigger("click")
  const secondInput = view.get('input[name="folder-picker-path"]')
  await secondInput.setValue("/home/agent")
  await secondInput.trigger("keydown.enter")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith("/home/agent")
  expect(view.get("[data-current-path]").attributes("data-current-path")).toBe("/home/agent")
})

test("uses server paths for roots and parent navigation across operating systems", async () => {
  const windows: DirectoryListing = {
    path: "Z:\\projects", parentPath: "Z:\\", homePath: "C:\\Users\\agent", roots: [{ name: "Z:\\", path: "Z:\\" }], directories: [],
  }
  const root = { ...windows, path: "Z:\\", parentPath: null }
  const browse = vi.fn().mockResolvedValueOnce(windows).mockResolvedValue(root)
  const view = await render(browse, "Z:\\projects")
  await flushPromises()
  expect(browse).toHaveBeenCalledWith("Z:\\projects")
  await view.get('[aria-label="Up"]').trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith("Z:\\")
  expect(view.get('[aria-label="Up"]').attributes("disabled")).toBeDefined()
  await view.get('[aria-label="Home"]').trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith("C:\\Users\\agent")
  await button(view, "Z:\\").trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith("Z:\\")
})

test("Escape leaves inline path editing before dismissing the picker", async () => {
  const view = await render(vi.fn().mockResolvedValue(home))
  await flushPromises()
  await view.get("[data-edit-path]").trigger("click")
  const input = view.get<HTMLInputElement>('[name="folder-picker-path"]')
  expect(document.activeElement).toBe(input.element)
  await input.setValue("/not-applied")
  await input.trigger("keydown", { key: "Escape" })
  expect(view.find('[name="folder-picker-path"]').exists()).toBe(false)
  expect(view.get("[data-current-path]").attributes("data-current-path")).toBe(home.path)
  expect(view.emitted("cancel")).toBeUndefined()
  await flushPromises()
  await view.get('[role="dialog"]').trigger("keydown", { key: "Escape" })
  expect(view.emitted("cancel")).toEqual([[]])
})

test("selecting an edited path validates it and never selects the previous folder on failure", async () => {
  const browse = vi.fn().mockResolvedValueOnce(home).mockRejectedValueOnce(new Error("Directory not found")).mockResolvedValueOnce(code)
  const view = await render(browse)
  await flushPromises()
  await view.get("[data-edit-path]").trigger("click")
  await view.get('[name="folder-picker-path"]').setValue("/missing")
  await button(view, "Select folder").trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith("/missing")
  expect(view.get('[role="alert"]').text()).toBe("Directory not found")
  expect(view.emitted("select")).toBeUndefined()
  await view.get("[data-edit-path]").trigger("click")
  await view.get('[name="folder-picker-path"]').setValue("  /home/agent/code  ")
  await button(view, "Select folder").trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith(code.path)
  expect(view.emitted("select")).toEqual([[code.path]])
})

test("failed navigation cannot select the previous folder and retries the failed path", async () => {
  const browse = vi.fn().mockResolvedValueOnce(home).mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(code)
  const view = await render(browse)
  await flushPromises()
  await view.get('[aria-label="Open code"]').trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Permission denied")
  expect(button(view, "Select folder").attributes("disabled")).toBeDefined()
  await button(view, "Retry").trigger("click")
  await flushPromises()
  expect(browse).toHaveBeenLastCalledWith(code.path)
  await button(view, "Select folder").trigger("click")
  expect(view.emitted("select")).toEqual([[code.path]])
})

test("ignores outdated directory responses when a newer navigation finishes first", async () => {
  let resolveCode!: (value: DirectoryListing) => void
  const browse = vi.fn().mockResolvedValueOnce(home)
    .mockReturnValueOnce(new Promise<DirectoryListing>(resolve => { resolveCode = resolve }))
    .mockResolvedValueOnce(home)
  const view = await render(browse)
  await flushPromises()
  await view.get('[aria-label="Open code"]').trigger("click")
  await view.get('[aria-label="Home"]').trigger("click")
  await flushPromises()
  resolveCode(code)
  await flushPromises()
  expect(view.get("[data-current-path]").attributes("data-current-path")).toBe(home.path)
  await button(view, "Select folder").trigger("click")
  expect(view.emitted("select")).toEqual([[home.path]])
})

test("Escape cancels only the picker without choosing a folder", async () => {
  const view = await render(vi.fn().mockResolvedValue(home))
  await flushPromises()
  await view.get("[role=dialog]").trigger("keydown", { key: "Escape" })
  expect(view.emitted("cancel")).toEqual([[]])
  expect(view.emitted("select")).toBeUndefined()
})
