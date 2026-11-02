import { mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref, type Ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { useMobileViewportSwipe } from "./useMobileViewportSwipe.ts"

let wrapper: VueWrapper
let swipe: ReturnType<typeof useMobileViewportSwipe>
let index: Ref<number>
let reducedMotion: Ref<boolean>
let frames: Map<number, FrameRequestCallback>
let frameId: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] })
  frames = new Map()
  frameId = 0
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  index = ref(0)
  reducedMotion = ref(false)
  wrapper = mount(defineComponent({
    setup() {
      const viewport = ref<HTMLElement | null>(null)
      const left = ref<HTMLElement | null>(null)
      const right = ref<HTMLElement | null>(null)
      swipe = useMobileViewportSwipe({
        viewport, left, right, index: () => index.value, count: () => 2,
        enabled: () => true, reducedMotion: () => reducedMotion.value,
        select: value => { index.value = value }, reveal: () => {},
      })
      return () => h("div", { ref: viewport }, [h("div", { ref: left, "data-edge": "left" }), h("div", { ref: right, "data-edge": "right" })])
    },
  }))
  Object.defineProperty(wrapper.element, "clientWidth", { value: 390 })
  for (const edge of wrapper.findAll("[data-edge]")) (edge.element as HTMLElement).setPointerCapture = vi.fn()
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
async function pointer(edge: "left" | "right", type: string, x: number) {
  const event = new PointerEvent(type, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: x, clientY: 200 })
  Object.defineProperty(event, "timeStamp", { value: performance.now() })
  wrapper.get(`[data-edge="${edge}"]`).element.dispatchEvent(event)
  await nextTick()
}

test("release keeps the rendered position and capture release does not cancel settling", async () => {
  await pointer("right", "pointerdown", 380)
  await tick(100)
  await pointer("right", "pointermove", 180)
  const position = swipe.offset.value
  await tick(100)
  await pointer("right", "pointerup", 180)
  await pointer("right", "lostpointercapture", 180)
  expect(index.value).toBe(1)
  expect(-390 + swipe.offset.value).toBe(position)
  expect(swipe.settling.value).toBe(true)
  await tick(120)
  expect(swipe.offset.value).toBeGreaterThan(0)
  expect(swipe.offset.value).toBeLessThan(190)
  await tick(800)
  expect(swipe.offset.value).toBe(0)
  expect(swipe.settling.value).toBe(false)
})

test("a new touch catches the settling view without jumping", async () => {
  await pointer("right", "pointerdown", 380)
  await tick(100)
  await pointer("right", "pointermove", 180)
  await pointer("right", "pointerup", 180)
  await tick(80)
  const position = swipe.offset.value
  await pointer("left", "pointerdown", 10)
  expect(swipe.offset.value).toBe(position)
  expect(swipe.settling.value).toBe(false)
  await tick(50)
  expect(swipe.offset.value).toBe(position)
  await pointer("left", "pointermove", 40)
  expect(swipe.offset.value).toBeCloseTo(position + 30)
  await pointer("left", "pointercancel", 40)
  expect(index.value).toBe(1)
  await tick(800)
  expect(swipe.offset.value).toBe(0)
})

test("boundary resistance increases with distance and returns without selecting", async () => {
  await pointer("left", "pointerdown", 10)
  await tick(100)
  await pointer("left", "pointermove", 130)
  const first = swipe.offset.value
  await tick(100)
  await pointer("left", "pointermove", 250)
  expect(swipe.offset.value).toBeGreaterThan(first)
  expect(swipe.offset.value - first).toBeLessThan(first)
  await pointer("left", "pointerup", 250)
  expect(index.value).toBe(0)
  expect(swipe.settling.value).toBe(true)
  await tick(800)
  expect(swipe.offset.value).toBe(0)
})

test("reduced motion completes selection without scheduling a spring", async () => {
  reducedMotion.value = true
  await pointer("right", "pointerdown", 380)
  await tick(100)
  await pointer("right", "pointermove", 180)
  await pointer("right", "pointerup", 180)
  expect(index.value).toBe(1)
  expect(swipe.offset.value).toBe(0)
  expect(swipe.settling.value).toBe(false)
  expect(frames.size).toBe(0)
})

test.each([{ hold: 0, selected: 1 }, { hold: 120, selected: 0 }])(
  "a short flick uses recent velocity (held for $hold ms)", async ({ hold, selected }) => {
    await pointer("right", "pointerdown", 380)
    await tick(16)
    await pointer("right", "pointermove", 340)
    await tick(hold)
    await pointer("right", "pointerup", 340)
    expect(index.value).toBe(selected)
    await tick(800)
    expect(swipe.offset.value).toBe(0)
  },
)
