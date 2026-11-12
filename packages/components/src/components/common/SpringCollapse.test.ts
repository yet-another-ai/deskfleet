import { mount, type VueWrapper } from "@vue/test-utils"
import { CollapsibleRoot } from "reka-ui"
import { defineComponent, h, nextTick, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import SpringCollapse from "./SpringCollapse.vue"

let wrapper: VueWrapper
let frames: Map<number, FrameRequestCallback>
let frameId = 0

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 200, this.hasAttribute("data-measured-content") ? 120 : 0)
  })
})
afterEach(() => {
  wrapper.unmount()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function tick(duration: number) {
  for (let elapsed = 0; elapsed < duration; elapsed += 16) {
    vi.advanceTimersByTime(16)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
    await nextTick()
  }
}
function fixture(initial = false) {
  const open = ref(initial)
  wrapper = mount(defineComponent({
    setup: () => () => h(CollapsibleRoot, { open: open.value }, {
      default: () => h(SpringCollapse, { "data-measured-content": "" }, { default: () => h("button", { "data-inner-content": "" }, "Details") }),
    }),
  }))
  return { open, surface: () => wrapper.get<HTMLElement>(".ui-collapsible") }
}

test("closing keeps content until rest and reopening continues from the current height", async () => {
  const { open, surface } = fixture()
  expect(wrapper.find("[data-inner-content]").exists()).toBe(false)
  open.value = true
  await nextTick()
  await nextTick()
  expect(surface().element.style.height).toBe("0px")
  await tick(2000)
  expect(surface().element.style.height).toBe("auto")
  open.value = false
  await nextTick()
  expect(surface().element.style.height).toBe("120px")
  expect(wrapper.find("[data-inner-content]").exists()).toBe(true)
  expect(surface().attributes("inert")).toBeDefined()
  await tick(96)
  const closingHeight = parseFloat(surface().element.style.height)
  expect(closingHeight).toBeGreaterThan(0)
  expect(closingHeight).toBeLessThan(120)
  open.value = true
  await nextTick()
  await nextTick()
  expect(parseFloat(surface().element.style.height)).toBe(closingHeight)
  expect(wrapper.find("[data-inner-content]").exists()).toBe(true)
  await tick(2000)
  expect(surface().element.style.height).toBe("auto")
  open.value = false
  await nextTick()
  await tick(2000)
  expect(surface().element.style.height).toBe("0px")
  expect(wrapper.find("[data-inner-content]").exists()).toBe(false)
})

test("unmounting a moving collapse releases its frame loop", async () => {
  fixture(true)
  await nextTick()
  await nextTick()
  await tick(80)
  expect(frames.size).toBeGreaterThan(0)
  wrapper.unmount()
  expect(frames.size).toBe(0)
})

test("empty content closes without waiting for an animation that never starts", async () => {
  const { open } = fixture(true)
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect())
  await nextTick()
  await nextTick()
  open.value = false
  await nextTick()
  expect(wrapper.find("[data-inner-content]").exists()).toBe(false)
})
