import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, nextTick, ref } from "vue"
import { DropdownMenuItem } from "reka-ui"
import { afterEach, expect, test, vi } from "vitest"
import UiDialog from "./UiDialog.vue"
import MenuPopover from "./MenuPopover.vue"

let view: VueWrapper | undefined
afterEach(async () => { view?.unmount(); view = undefined; await flushPromises(); vi.restoreAllMocks(); vi.useRealTimers() })
const content = () => new DOMWrapper(document.querySelector<HTMLElement>('[role="dialog"]')!)

test("returns keyboard focus to the menu trigger after a selected action's dialog closes", async () => {
  vi.useFakeTimers()
  view = mount(defineComponent({
    components: { UiDialog, MenuPopover, DropdownMenuItem },
    setup: () => ({ editing: ref(false) }),
    template: '<MenuPopover label="Workspace actions"><template #trigger>Actions</template><template #default="{ openDialog }"><DropdownMenuItem as="button" @select="openDialog(() => { editing = true })">Edit</DropdownMenuItem></template></MenuPopover><UiDialog v-if="editing" title="Edit workspace" @close="editing = false"><input aria-label="Name" /></UiDialog>',
  }), { attachTo: document.body })
  const trigger = view.get<HTMLButtonElement>('button[aria-label="Workspace actions"]')
  trigger.element.focus()
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  const item = new DOMWrapper(document.querySelector<HTMLElement>('[role="menuitem"]')!)
  item.element.focus()
  await item.trigger("keydown", { key: "Enter" })
  await flushPromises()
  // Complete the menu's deferred focus cleanup while the dialog is still open.
  await vi.runAllTimersAsync()
  await flushPromises()
  expect(document.activeElement).toBe(content().get("input").element)
  await content().get("input").trigger("keydown", { key: "Escape" })
  await vi.runAllTimersAsync()
  await flushPromises()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger.element)
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  await new DOMWrapper(document.querySelector<HTMLElement>('[role="menu"]')!).trigger("keydown", { key: "Escape" })
  await flushPromises()
  await vi.runAllTimersAsync()
  await flushPromises()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(trigger.element)
})

test("portals a named modal, focuses its input, dismisses on Escape, and restores its opener", async () => {
  view = mount(defineComponent({
    components: { UiDialog },
    setup: () => ({ open: ref(false) }),
    template: '<button @click="open = true">Open</button><UiDialog v-if="open" title="Edit workspace" @close="open = false"><input aria-label="Name" /><button>Save</button></UiDialog>',
  }), { attachTo: document.body })
  const opener = view.get("button")
  opener.element.focus()
  await opener.trigger("click")
  await flushPromises()
  const dialog = content()
  expect(dialog.element.parentElement).toBe(document.body)
  expect(document.getElementById(dialog.attributes("aria-labelledby")!)?.textContent).toBe("Edit workspace")
  expect(document.activeElement).toBe(dialog.get("input").element)
  await dialog.get("input").trigger("keydown", { key: "Escape" })
  await flushPromises()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(opener.element)
})

test("keeps pending actions open and only dismisses the top nested dialog", async () => {
  view = mount(defineComponent({
    components: { UiDialog },
    setup: () => ({ nested: ref(false), pending: ref(true) }),
    template: '<UiDialog title="Parent"><button @click="nested = true">Browse</button><UiDialog v-if="nested" title="Folder" :prevent-close="pending" @close="nested = false"><button @click="pending = false">Finish</button></UiDialog></UiDialog>',
  }), { attachTo: document.body })
  await flushPromises()
  const browse = content().get("button")
  browse.element.focus()
  await browse.trigger("click")
  await flushPromises()
  const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]')
  expect(dialogs).toHaveLength(2)
  const nested = new DOMWrapper(dialogs[1]!)
  await nested.trigger("keydown", { key: "Escape" })
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
  await nested.get("button").trigger("click")
  await nested.trigger("keydown", { key: "Escape" })
  await flushPromises()
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  expect(document.activeElement).toBe(browse.element)
})

function springFrames() {
  vi.useFakeTimers({ toFake: ["performance"] })
  const frames = new Map<number, FrameRequestCallback>()
  let nextId = 0
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++nextId, callback); return nextId })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  return async (duration: number) => {
    for (let elapsed = 0; elapsed < duration; elapsed += 16) {
      vi.advanceTimersByTime(16)
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(performance.now())
      await nextTick()
    }
  }
}

test("a close request retains the inert panel until its spring settles before clearing caller state", async () => {
  const tick = springFrames()
  view = mount(defineComponent({
    components: { UiDialog },
    setup: () => ({ present: ref(true) }),
    template: '<UiDialog v-if="present" title="Edit" v-slot="{ close }" @close="present = false"><button @click="close">Cancel</button></UiDialog>',
  }), { attachTo: document.body })
  await flushPromises()
  const element = content().element
  expect(element.style.scale).toBe("0.98")
  await tick(1600)
  expect(element.style.scale).toBe("1")
  await content().get("button").trigger("click")
  expect(document.querySelector('[role="dialog"]')).toBe(element)
  expect(element.hasAttribute("inert")).toBe(true)
  await tick(96)
  expect(Number(element.style.scale)).toBeLessThan(1)
  expect(Number(element.style.scale)).toBeGreaterThan(0.98)
  await tick(1600)
  await flushPromises()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test.each([
  { focus: "without a focus change", blur: false },
  { focus: "after focus moves to the body", blur: true },
])("reopening an in-flight exit $focus preserves the panel and original opener", async ({ blur }) => {
  const tick = springFrames()
  const opener = document.createElement("button")
  document.body.append(opener)
  opener.focus()
  view = mount(UiDialog, { props: { open: true, title: "Edit" }, slots: { default: '<input aria-label="Name" />' }, attachTo: document.body })
  await flushPromises()
  await tick(1600)
  const element = content().element
  await view.setProps({ open: false })
  await tick(96)
  const duringExit = element.style.scale
  if (blur) {
    const active = document.activeElement as HTMLElement
    active.blur()
    expect(document.activeElement).toBe(document.body)
  }
  await view.setProps({ open: true })
  expect(document.querySelector('[role="dialog"]')).toBe(element)
  expect(element.style.scale).toBe(duringExit)
  await tick(1600)
  expect(view.emitted("close")).toBeUndefined()
  await view.setProps({ open: false })
  await tick(1600)
  await flushPromises()
  expect(view.emitted("close")).toHaveLength(1)
  expect(document.activeElement).toBe(opener)
})

test("reduced motion completes opening and closing without queued frames", async () => {
  const frames = vi.spyOn(window, "requestAnimationFrame")
  vi.spyOn(window, "matchMedia").mockImplementation(query => Object.assign(new EventTarget(), {
    matches: query === "(prefers-reduced-motion: reduce)", media: query,
  }) as MediaQueryList)
  view = mount(UiDialog, { props: { open: true, title: "Edit" }, attachTo: document.body })
  await flushPromises()
  expect(content().element.style.scale).toBe("1")
  expect(frames).not.toHaveBeenCalled()
  await view.setProps({ open: false })
  await flushPromises()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(view.emitted("close")).toHaveLength(1)
})
