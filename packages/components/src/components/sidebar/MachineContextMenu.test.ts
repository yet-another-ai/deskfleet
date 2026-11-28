import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { h } from "vue"
import { i18n } from "../../i18n/index.ts"
import MachineContextMenu from "./MachineContextMenu.vue"

const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const stop of cleanups.splice(0)) stop()
  i18n.global.locale.value = "en-US"
  await flushPromises()
})

const page = () => new DOMWrapper(document.body)

function mountMenu(showingHidden: boolean, hasHiddenWorkspaces: boolean) {
  const wrapper = mount(MachineContextMenu, {
    attachTo: document.body,
    props: { machineId: "machine-1", name: "dev-host.local", showingHidden, hasHiddenWorkspaces },
    slots: { default: () => h("button", { type: "button" }, "dev-host.local") },
    global: { plugins: [i18n] },
  })
  cleanups.push(() => wrapper.unmount())
  return wrapper
}

test("right-click anchors the machine menu at the pointer and emits toggleHidden when enabled", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const wrapper = mountMenu(false, true)
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 88, clientY: 64 })
  wrapper.get("button").element.dispatchEvent(event)
  await flushPromises()
  expect(event.defaultPrevented).toBe(true)

  const exposed = wrapper.vm as unknown as { cursor?: { x: number; y: number }; pointerReference?: { getBoundingClientRect(): DOMRect } }
  expect(exposed.cursor).toEqual({ x: 88, y: 64 })
  expect(exposed.pointerReference?.getBoundingClientRect()).toMatchObject({ left: 88, top: 64, right: 88, bottom: 64 })

  const item = page().get('[data-machine-action="toggle-hidden-workspaces"]')
  expect(item.text()).toBe("显示隐藏工作区")
  expect(item.attributes("data-disabled")).toBeUndefined()
  await item.trigger("click")
  await flushPromises()
  expect(wrapper.emitted("toggleHidden")).toHaveLength(1)
})

test("disables Show hidden workspaces when the machine has no hidden workspaces and supports keyboard close", async () => {
  const wrapper = mountMenu(false, false)
  const button = wrapper.get("button")
  button.element.focus()
  await button.trigger("keydown", { key: "F10", shiftKey: true })
  await flushPromises()

  const item = page().get('[data-machine-action="toggle-hidden-workspaces"]')
  expect(item.text()).toBe("Show hidden workspaces")
  expect(item.attributes("data-disabled")).toBeDefined()
  await item.trigger("click")
  await flushPromises()
  expect(wrapper.emitted("toggleHidden")).toBeUndefined()

  await page().get('[role="menu"]').trigger("keydown", { key: "Escape" })
  await flushPromises()
  expect(page().find('[role="menu"]').exists()).toBe(false)
  await vi.waitFor(() => expect(document.activeElement).toBe(button.element))
})

test("shows Hide hidden workspaces while reveal mode is active", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const wrapper = mountMenu(true, true)
  await wrapper.get("button").trigger("contextmenu", { button: 2, clientX: 16, clientY: 20 })
  await flushPromises()
  const item = page().get('[data-machine-action="toggle-hidden-workspaces"]')
  expect(item.text()).toBe("收起隐藏工作区")
  await item.trigger("click")
  await flushPromises()
  expect(wrapper.emitted("toggleHidden")).toHaveLength(1)
})
