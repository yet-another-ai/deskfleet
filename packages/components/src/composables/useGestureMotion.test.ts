import { mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { usePanZoom } from "./usePanZoom.ts"
import { useInertialRange } from "./useInertialRange.ts"

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
async function pointer(type: string, x: number, id = 1) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, button: 0, clientX: x })
  Object.defineProperty(event, "timeStamp", { value: performance.now() })
  wrapper.element.dispatchEvent(event)
  await nextTick()
}
function panFixture() {
  let pan!: ReturnType<typeof usePanZoom>
  wrapper = mount(defineComponent({
    setup() {
      pan = usePanZoom()
      return () => h("div", { onPointerdown: pan.startDrag, onPointermove: pan.moveDrag, onPointerup: pan.endDrag })
    },
  }))
  return pan
}

test("the first zoom input animates, and a new target starts at the rendered scale", async () => {
  const pan = panFixture()
  pan.zoomIn()
  expect(pan.scale.value).toBe(1)
  await tick(80)
  expect(pan.scale.value).toBeGreaterThan(1)
  expect(pan.scale.value).toBeLessThan(1.25)
  const current = pan.scale.value
  pan.zoomOut()
  expect(pan.scale.value).toBe(current)
  await tick(1600)
  expect(pan.scale.value).toBe(1)
})

test("canvas release coasts in the drag direction and a new pointer catches its current position", async () => {
  const pan = panFixture()
  await pointer("pointerdown", 0)
  await tick(32)
  await pointer("pointermove", 80)
  expect(pan.panX.value).toBe(80)
  await pointer("pointerup", 80)
  expect(pan.panX.value).toBe(80)
  await tick(64)
  expect(pan.panX.value).toBeGreaterThan(80)
  const caught = pan.panX.value
  await pointer("pointerdown", 80)
  expect(pan.panX.value).toBe(caught)
  await tick(16)
  await pointer("pointermove", 90, 2)
  expect(pan.panX.value).toBe(caught)
  await pointer("pointermove", 90)
  expect(pan.panX.value).toBe(caught + 10)
  await pointer("pointerup", 90)
  let previous = pan.panX.value
  for (let frame = 0; frame < 100; frame++) {
    await tick(16)
    expect(pan.panX.value).toBeGreaterThanOrEqual(previous)
    previous = pan.panX.value
  }
  const stopped = pan.panX.value
  await tick(200)
  expect(pan.panX.value).toBe(stopped)
})

function rangeFixture() {
  const value = ref(80)
  const enabled = ref(true)
  const commit = vi.fn()
  const preview = vi.fn((next: number) => { value.value = next })
  let range!: ReturnType<typeof useInertialRange>
  wrapper = mount(defineComponent({
    setup() {
      range = useInertialRange({ value: () => value.value, min: 0, max: 360, preview, commit, enabled: () => enabled.value })
      return () => h("input", {
        type: "range", min: 0, max: 360, step: 0.01, value: range.value.value,
        onPointerdown: range.startDrag, onPointermove: range.moveDrag, onPointerup: range.endDrag,
        onInput: range.onInput, onChange: range.onChange, onKeydown: range.onKeydown,
      })
    },
  }))
  vi.spyOn(wrapper.element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 24))
  return { range, commit, preview, enabled }
}

test("range track clicks animate from rest and save the final value once motion stops", async () => {
  const { range, commit } = rangeFixture()
  await pointer("pointerdown", 150)
  expect(range.value.value).toBe(80)
  await tick(80)
  expect(range.value.value).toBeGreaterThan(80)
  expect(range.value.value).toBeLessThan(270)
  await pointer("pointerup", 150)
  expect(commit).not.toHaveBeenCalled()
  await tick(1800)
  expect(range.value.value).toBe(270)
  expect(commit).toHaveBeenCalledExactlyOnceWith(270)
})

test("range dragging follows the pointer, coasts on release and never rebounds at a bound", async () => {
  const { range, commit } = rangeFixture()
  await pointer("pointerdown", 80 / 360 * 200)
  await tick(16)
  await pointer("pointermove", 180)
  expect(range.value.value).toBe(324)
  await pointer("pointerup", 180)
  expect(commit).not.toHaveBeenCalled()
  let previous = range.value.value
  for (let frame = 0; frame < 100; frame++) {
    await tick(16)
    expect(range.value.value).toBeGreaterThanOrEqual(previous)
    expect(range.value.value).toBeLessThanOrEqual(360)
    previous = range.value.value
  }
  expect(commit).toHaveBeenCalledExactlyOnceWith(360)
})

test("range input animates, repeated keys accumulate steps and disabling stops a pointer change", async () => {
  const { range, commit, enabled } = rangeFixture()
  ;(wrapper.element as HTMLInputElement).value = "125"
  await wrapper.trigger("input")
  await wrapper.trigger("change")
  expect(range.value.value).toBe(80)
  expect(commit).not.toHaveBeenCalled()
  await tick(1800)
  expect(range.value.value).toBe(125)
  expect(commit).toHaveBeenCalledExactlyOnceWith(125)
  await wrapper.trigger("keydown", { key: "ArrowRight" })
  await wrapper.trigger("keydown", { key: "ArrowRight" })
  expect(range.value.value).toBe(125)
  await tick(1800)
  expect(range.value.value).toBeCloseTo(125.02)
  expect(commit).toHaveBeenCalledTimes(2)
  await pointer("pointerdown", 150)
  await tick(32)
  enabled.value = false
  await nextTick()
  const stopped = range.value.value
  await pointer("pointerup", 150)
  await tick(1800)
  expect(range.value.value).toBe(stopped)
  expect(commit).toHaveBeenCalledTimes(2)
})

test("a right arrow during range inertia targets a step beyond the current thumb", async () => {
  const { range, commit } = rangeFixture()
  await pointer("pointerdown", 80 / 360 * 200)
  await tick(96)
  await pointer("pointermove", 75)
  expect(range.value.value).toBe(135)
  await pointer("pointerup", 75)
  await tick(64)
  const moving = range.value.value
  expect(moving).toBeGreaterThan(135.01)
  await wrapper.trigger("keydown", { key: "ArrowRight" })
  expect(range.value.value).toBe(moving)
  await tick(16)
  expect(range.value.value).toBeGreaterThan(moving)
  await tick(2000)
  expect(range.value.value).toBeCloseTo(moving + 0.01)
  expect(commit).toHaveBeenCalledExactlyOnceWith(range.value.value)
})
