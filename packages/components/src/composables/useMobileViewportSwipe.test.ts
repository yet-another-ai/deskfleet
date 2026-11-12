import { mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref, type Ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { useMobileViewportSwipe } from "./useMobileViewportSwipe.ts"

let wrapper: VueWrapper
let swipe: ReturnType<typeof useMobileViewportSwipe>
let index: Ref<number>
let enabled: Ref<boolean>
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
  enabled = ref(true)
  reducedMotion = ref(false)
  wrapper = mount(defineComponent({
    setup() {
      const viewport = ref<HTMLElement | null>(null)
      swipe = useMobileViewportSwipe({
        viewport, index: () => index.value, count: () => 2,
        enabled: () => enabled.value, reducedMotion: () => reducedMotion.value,
        select: value => { index.value = value }, reveal: () => {},
      })
      return () => h("div", { ref: viewport }, [
        h("div", { "data-mermaid-canvas": "" }, [h("svg")]),
        h("div", { "data-preview-kind": "image" }, [h("div", { "data-preview-canvas": "" }, [h("img")])]),
        h("div", { "data-office-preview": "xlsx" }, [h("canvas")]),
      ])
    },
  }))
  Object.defineProperty(wrapper.element, "clientWidth", { value: 390 })
  for (const el of [wrapper.element, ...wrapper.findAll("*").map(item => item.element)]) (el as HTMLElement).setPointerCapture = vi.fn()
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
async function pointer(_edge: "left" | "right", type: string, x: number, target: Element = wrapper.element) {
  const event = new PointerEvent(type, { bubbles: true, pointerType: "touch", pointerId: 1, isPrimary: true, clientX: x, clientY: 200 })
  Object.defineProperty(event, "timeStamp", { value: performance.now() })
  target.dispatchEvent(event)
  await nextTick()
}

test("release keeps the rendered position and capture release does not cancel settling", async () => {
  await pointer("right", "pointerdown", 380)
  await tick(100)
  await pointer("right", "pointermove", 180)
  const touch = new TouchEvent("touchmove", { bubbles: true, cancelable: true })
  wrapper.element.dispatchEvent(touch)
  expect(touch.defaultPrevented).toBe(true)
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

test.each(["[data-mermaid-canvas] svg", "[data-preview-canvas] img", "[data-office-preview] canvas"])(
  "pannable canvas %s keeps its own drag gesture without switching views", async selector => {
    const target = wrapper.get(selector).element
    await pointer("right", "pointerdown", 280, target)
    await pointer("right", "pointermove", 100, target)
    await pointer("right", "pointerup", 100, target)
    expect(swipe.offset.value).toBe(0)
    expect(swipe.dragging.value).toBe(false)
    expect(index.value).toBe(0)
    if (selector.includes("data-office-preview")) {
      expect(wrapper.get("[data-office-preview]").element.setPointerCapture).not.toHaveBeenCalled()
      expect(target.setPointerCapture).toHaveBeenCalledWith(1)
    }
  },
)

test("button navigation animates the first input and redirects without changing screen position", async () => {
  index.value = 1
  await nextTick()
  expect(swipe.offset.value).toBe(390)
  expect(swipe.settling.value).toBe(true)
  await tick(96)
  const screen = swipe.offset.value - 390
  expect(screen).toBeLessThan(0)
  expect(screen).toBeGreaterThan(-390)
  index.value = 0
  await nextTick()
  expect(swipe.offset.value).toBeCloseTo(screen)
  await tick(1200)
  expect(swipe.offset.value).toBe(0)
  expect(swipe.settling.value).toBe(false)
})

test("opening the overview during settling lets the stage finish without a frozen offset", async () => {
  await pointer("right", "pointerdown", 380)
  await tick(32)
  await pointer("right", "pointermove", 180)
  await pointer("right", "pointerup", 180)
  await tick(48)
  const before = swipe.offset.value
  enabled.value = false
  await nextTick()
  expect(swipe.offset.value).toBe(before)
  expect(swipe.settling.value).toBe(true)
  await tick(1200)
  expect(swipe.offset.value).toBe(0)
  expect(swipe.settling.value).toBe(false)
})
