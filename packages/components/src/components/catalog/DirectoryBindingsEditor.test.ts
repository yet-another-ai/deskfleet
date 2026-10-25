import { mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { CatalogDirectory } from "../../../../client/src/catalog.ts"
import { i18n } from "../../i18n/index.ts"
import FolderPickerDialog from "../common/FolderPickerDialog.vue"
import DirectoryBindingsEditor from "./DirectoryBindingsEditor.vue"

let wrapper: VueWrapper | undefined
function render(directories: CatalogDirectory[]) {
  const view = mount(DirectoryBindingsEditor, {
    props: {
      modelValue: directories, machineName: "build-host", browse: vi.fn(),
      "onUpdate:modelValue": value => { void wrapper?.setProps({ modelValue: value }) },
    },
    global: { plugins: [i18n], stubs: { FolderPickerDialog: true } },
  })
  wrapper = view
  return view
}
function addButton(view: VueWrapper) {
  return view.findAll("button").find(button => button.text() === "Add directory")!
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

test("adding and replacing directories only commits picker selections", async () => {
  const view = render([{ path: "/code/web" }])
  expect(view.find("input").exists()).toBe(false)
  await addButton(view).trigger("click")
  expect(view.getComponent(FolderPickerDialog).props("initialPath")).toBe("/code/web")
  view.getComponent(FolderPickerDialog).vm.$emit("cancel")
  await view.vm.$nextTick()
  expect(view.props("modelValue")).toEqual([{ path: "/code/web" }])
  await addButton(view).trigger("click")
  view.getComponent(FolderPickerDialog).vm.$emit("select", "/code/api")
  await view.vm.$nextTick()
  expect(view.props("modelValue")).toEqual([{ path: "/code/web" }, { path: "/code/api" }])
  await view.get('[name="directory-path-0"]').trigger("click")
  view.getComponent(FolderPickerDialog).vm.$emit("select", "/code/site")
  await view.vm.$nextTick()
  expect(view.props("modelValue")).toEqual([{ path: "/code/site" }, { path: "/code/api" }])
  expect(view.get('[name="directory-path-0"]').text()).toContain("Default")
})

test("prevents duplicate paths while preserving ordering and the default directory", async () => {
  const view = render([{ path: "/code/web" }, { path: "/code/api" }])
  await view.get('[name="directory-path-0"]').trigger("click")
  view.getComponent(FolderPickerDialog).vm.$emit("select", "/code/api")
  await view.vm.$nextTick()
  expect(view.get('[role="alert"]').text()).toBe("This directory is already included.")
  expect(view.props("modelValue")).toEqual([{ path: "/code/web" }, { path: "/code/api" }])
  await view.get('[aria-label="Move directory 2 up"]').trigger("click")
  expect(view.props("modelValue")).toEqual([{ path: "/code/api" }, { path: "/code/web" }])
  expect(view.get('[name="directory-path-0"]').text()).toContain("/code/api")
  expect(view.get('[name="directory-path-0"]').text()).toContain("Default")
  await view.get('[aria-label="Remove directory 2"]').trigger("click")
  expect(view.props("modelValue")).toEqual([{ path: "/code/api" }])
})

test("disabling the editor dismisses an open folder picker", async () => {
  const view = render([{ path: "/code/web" }])
  await addButton(view).trigger("click")
  expect(view.findComponent(FolderPickerDialog).exists()).toBe(true)
  await view.setProps({ disabled: true })
  await view.setProps({ disabled: false })
  expect(view.findComponent(FolderPickerDialog).exists()).toBe(false)
})

test("fills the initial empty directory instead of adding an unselected row", async () => {
  const view = render([{ path: "" }])
  await addButton(view).trigger("click")
  expect(view.getComponent(FolderPickerDialog).props("initialPath")).toBeUndefined()
  view.getComponent(FolderPickerDialog).vm.$emit("select", "/code/web")
  await view.vm.$nextTick()
  expect(view.props("modelValue")).toEqual([{ path: "/code/web" }])
})
