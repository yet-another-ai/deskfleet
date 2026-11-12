import { mount, type VueWrapper } from "@vue/test-utils"
import { nextTick } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import MobileViewFrame from "./MobileViewFrame.vue"

let wrapper: VueWrapper
let frames: Map<number, FrameRequestCallback>
let frameId = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  wrapper = mount(MobileViewFrame, { props: {
    title: "Chat", active: true, preview: false, sourceWidth: 390, sourceHeight: 800,
    x: 0, y: 0, scale: 1, closable: false, busy: false, direct: false, scrollOrigin: 0,
  }, global: { plugins: [i18n] } })
})
afterEach(() => { wrapper.unmount(); vi.restoreAllMocks(); vi.useRealTimers() })
async function tick(duration: number) {
  for (let elapsed = 0; elapsed < duration; elapsed += 16) {
    vi.advanceTimersByTime(16)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
    await nextTick()
  }
}
function transform() { return wrapper.get<HTMLElement>("[data-view-surface]").element.style.transform }

test("overview reversals retain the current surface and settle at the latest destination", async () => {
  await wrapper.setProps({ x: 16, y: 48, scale: 0.28, preview: true })
  expect(transform()).toBe("translate3d(0px, 0px, 0) scale(1)")
  await tick(96)
  const before = transform()
  expect(before).not.toContain("scale(1)")
  await wrapper.setProps({ x: 0, y: 0, scale: 1, preview: false })
  expect(transform()).toBe(before)
  await tick(1600)
  expect(transform()).toBe("translate3d(0px, 0px, 0) scale(1)")
  expect(frames.size).toBe(0)
})

test("changing the scroll origin preserves the surface viewport position", async () => {
  await wrapper.setProps({ y: 200, scrollOrigin: 200 })
  expect(transform()).toBe("translate3d(0px, 200px, 0) scale(1)")
  expect(frames.size).toBe(0)
})
