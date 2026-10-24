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
function render(browse: (path?: string) => Promise<DirectoryListing>, initialPath?: string) {
  wrapper = mount(FolderPickerDialog, {
    props: { browse, initialPath, machineName: "remote-builder" },
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
  return wrapper
}
function button(view: VueWrapper, text: string) {
  return view.findAll("button").find(value => value.text() === text)!
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

test("browses folders on the supplied machine and only selects the loaded directory", async () => {
  const browse = vi.fn().mockResolvedValueOnce(home).mockResolvedValueOnce(code).mockResolvedValueOnce(home)
  const view = render(browse)
  expect(button(view, "Select folder").attributes("disabled")).toBeDefined()
  await flushPromises()
  expect(browse).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(view.text()).toContain("remote-builder")
  expect(view.find("input:not([type=checkbox])").exists()).toBe(false)
  expect(view.find('[aria-label="Open .config"]').exists()).toBe(false)
  await view.get('input[type="checkbox"]').setValue(true)
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

test("uses server paths for roots and parent navigation across operating systems", async () => {
  const windows: DirectoryListing = {
    path: "Z:\\projects", parentPath: "Z:\\", homePath: "C:\\Users\\agent", roots: [{ name: "Z:\\", path: "Z:\\" }], directories: [],
  }
  const root = { ...windows, path: "Z:\\", parentPath: null }
  const browse = vi.fn().mockResolvedValueOnce(windows).mockResolvedValue(root)
  const view = render(browse, "Z:\\projects")
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

test("failed navigation cannot select the previous folder and retries the failed path", async () => {
  const browse = vi.fn().mockResolvedValueOnce(home).mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(code)
  const view = render(browse)
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
  const view = render(browse)
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
  const view = render(vi.fn().mockResolvedValue(home))
  await flushPromises()
  await view.get("dialog").trigger("cancel")
  expect(view.emitted("cancel")).toEqual([[]])
  expect(view.emitted("select")).toBeUndefined()
})
