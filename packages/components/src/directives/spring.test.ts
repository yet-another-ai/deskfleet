import { mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref, withDirectives } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { vSpring, vSpringEnter, vSpringHover } from "./spring.ts"

let wrapper: VueWrapper | undefined
let frames: Map<number, FrameRequestCallback>
let frameId = 0
let reduced = false

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  reduced = false
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ matches: reduced, media: query }) as MediaQueryList)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function tick(duration: number, interval = 16) {
  for (let elapsed = 0; elapsed < duration; elapsed += interval) {
    vi.advanceTimersByTime(interval)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
    await nextTick()
  }
}

test("the first target change animates and a reversal preserves forward momentum", async () => {
  const left = ref(0)
  wrapper = mount(defineComponent({
    setup: () => () => withDirectives(h("div"), [[vSpring, { left: `${left.value}px` }]]),
  }))
  const element = wrapper.element as HTMLElement
  left.value = 100
  await nextTick()
  expect(element.style.left).toBe("0px")
  await tick(80)
  const before = parseFloat(element.style.left)
  expect(before).toBeGreaterThan(0)
  expect(before).toBeLessThan(100)
  left.value = -100
  await nextTick()
  expect(parseFloat(element.style.left)).toBe(before)
  // A restarted easing or a reset velocity would move left on this first step.
  await tick(1, 1)
  expect(parseFloat(element.style.left)).toBeGreaterThan(before)
  await tick(2000)
  expect(element.style.left).toBe("-100px")
  expect(frames.size).toBe(0)
})

test("unmount cancels every numeric channel without leaving scheduled updates", async () => {
  wrapper = mount(defineComponent({
    setup: () => () => withDirectives(h("div"), [[vSpring, { to: { translate: "100px 40px", width: "80px" }, from: { translate: "0px 0px", width: "0px" } }]]),
  }))
  await tick(64)
  const element = wrapper.element as HTMLElement
  const position = element.style.cssText
  expect(frames.size).toBe(3)
  wrapper.unmount()
  wrapper = undefined
  expect(frames.size).toBe(0)
  await tick(100)
  expect(element.style.cssText).toBe(position)
})

test("reduced motion applies targets immediately, including when enabled during motion", async () => {
  const left = ref(100)
  reduced = true
  wrapper = mount(defineComponent({
    setup: () => () => withDirectives(h("div"), [[vSpring, { left: `${left.value}px` }, undefined, { enter: true }]]),
  }))
  const element = wrapper.element as HTMLElement
  expect(element.style.left).toBe("100px")
  expect(frames.size).toBe(0)
  reduced = false
  left.value = 200
  await nextTick()
  await tick(80)
  expect(parseFloat(element.style.left)).toBeLessThan(200)
  reduced = true
  left.value = 300
  await nextTick()
  expect(element.style.left).toBe("300px")
  expect(frames.size).toBe(0)
})

test("anchored entrances use their side and release the temporary translate after settling", async () => {
  wrapper = mount(defineComponent({
    setup: () => () => withDirectives(h("div", { "data-side": "bottom" }), [[vSpringEnter]]),
  }))
  const element = wrapper.element as HTMLElement
  expect(element.style.translate).toBe("0px -4px")
  await tick(80)
  const offset = parseFloat(element.style.translate.split(" ")[1]!)
  expect(offset).toBeGreaterThan(-4)
  expect(offset).toBeLessThan(0)
  await tick(2000)
  expect(element.style.translate).toBe("")
  expect(frames.size).toBe(0)
})

test("hover starts without a jump and unmount removes its pointer listeners", async () => {
  wrapper = mount(defineComponent({
    setup: () => () => withDirectives(h("button"), [[vSpringHover, -2]]),
  }))
  const element = wrapper.element as HTMLElement
  element.dispatchEvent(new PointerEvent("pointerenter"))
  expect(element.style.translate).toBe("0px 0px")
  await tick(64)
  expect(element.style.translate).not.toBe("0px 0px")
  wrapper.unmount()
  wrapper = undefined
  expect(frames.size).toBe(0)
  element.dispatchEvent(new PointerEvent("pointerenter"))
  expect(frames.size).toBe(0)
})
