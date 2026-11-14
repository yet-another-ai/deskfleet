import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { nextTick } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import BottomSheet from "./BottomSheet.vue"

let wrapper: VueWrapper
let frames: Map<number, FrameRequestCallback>
let frameId = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  wrapper = mount(BottomSheet, { props: { open: false, title: "Workspaces" }, attachTo: document.body, global: { plugins: [i18n] } })
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
function panel() { return document.querySelector<HTMLElement>(".bottom-sheet") }

test("the first opening moves from closed and a reversal retains the same live panel until rest", async () => {
  await wrapper.setProps({ open: true })
  await flushPromises()
  const element = panel()!
  expect(element.style.transform).toContain("calc(1 *")
  await tick(96)
  const before = element.style.transform
  expect(before).not.toContain("calc(1 *")
  await wrapper.setProps({ open: false })
  expect(panel()).toBe(element)
  expect(element.style.transform).toBe(before)
  await tick(48)
  const closing = element.style.transform
  await wrapper.setProps({ open: true })
  expect(panel()).toBe(element)
  expect(element.style.transform).toBe(closing)
  await tick(1600)
  expect(element.style.transform).toContain("calc(0 *")
  await wrapper.setProps({ open: false })
  expect(panel()).toBe(element)
  await tick(1600)
  expect(panel()).toBeNull()
})

async function pointer(element: HTMLElement, type: string, y: number) {
  const event = new PointerEvent(type, {
    bubbles: true, pointerType: "mouse", pointerId: 1, isPrimary: true,
    button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 100, clientY: y,
  })
  Object.defineProperty(event, "timeStamp", { value: performance.now() })
  element.dispatchEvent(event)
  await Promise.resolve()
  await nextTick()
}
function travel(element: HTMLElement) {
  return Number(element.style.transform.match(/calc\(([-\d.e]+) \*/u)?.[1])
}
async function openPanel() {
  await wrapper.setProps({ open: true })
  await flushPromises()
  await tick(1600)
  const element = panel()!
  Object.defineProperty(element, "offsetHeight", { value: 848 })
  element.setPointerCapture = vi.fn()
  return element
}

test("the first accepted pointer move renders immediately and release retains its velocity", async () => {
  const element = await openPanel()
  await pointer(element, "pointerdown", 100)
  await pointer(element, "pointermove", 100.5)
  expect(travel(element)).toBe(0)
  await tick(96)
  await pointer(element, "pointermove", 112)
  expect(travel(element)).toBeCloseTo(12 / 800)
  await pointer(element, "pointerup", 112)
  expect(wrapper.emitted("close")).toBeUndefined()
  expect(travel(element)).toBeCloseTo(12 / 800)
  await tick(32)
  expect(travel(element)).toBeGreaterThan(12 / 800)
  await tick(1600)
  expect(travel(element)).toBe(0)
})

test("Reka still dismisses a slow pointer swipe beyond its distance threshold", async () => {
  const element = await openPanel()
  await pointer(element, "pointerdown", 100)
  await tick(512)
  await pointer(element, "pointermove", 160)
  expect(travel(element)).toBeCloseTo(60 / 800)
  await pointer(element, "pointerup", 160)
  expect(wrapper.emitted("close")).toHaveLength(1)
})
