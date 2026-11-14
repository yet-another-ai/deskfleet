import { effectScope, nextTick, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { animateSpring } from "../services/spring.ts"
import { useSpring } from "./useSpring.ts"

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
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function tick(milliseconds: number): void {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    vi.advanceTimersByTime(16)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
  }
}

test("Vue scheduling retains momentum when redirected and stops on scope disposal", () => {
  const scope = effectScope()
  const spring = scope.run(() => useSpring(0))!
  spring.setTarget(100)
  expect(spring.position.value).toBe(0)
  tick(100)
  const position = spring.position.value
  const velocity = spring.velocity.value
  spring.setTarget(-100)
  expect(spring.position.value).toBe(position)
  expect(spring.velocity.value).toBe(velocity)
  tick(100)
  expect(spring.position.value).not.toBe(position)
  const disposed = spring.position.value
  scope.stop()
  tick(100)
  expect(spring.position.value).toBe(disposed)
  expect(frames.size).toBe(0)
})

test("reduced motion settles targets and stops inertia at its current position", async () => {
  const scope = effectScope()
  const reduced = ref(true)
  const spring = scope.run(() => useSpring(0, { reducedMotion: () => reduced.value }))!
  spring.setTarget(100)
  expect(spring.position.value).toBe(100)
  expect(frames.size).toBe(0)
  reduced.value = false
  await nextTick()
  spring.startDrag(0)
  spring.dragTo(200, 0.1)
  spring.endDrag(0.1, "inertia")
  tick(100)
  const current = spring.position.value
  expect(current).toBeGreaterThan(200)
  expect(spring.target.value).toBe(current)
  reduced.value = true
  await nextTick()
  expect(spring.position.value).toBe(current)
  expect(spring.isActive.value).toBe(false)
  scope.stop()
})

test("imperative cancellation resolves completion and can resume retained motion", async () => {
  const update = vi.fn()
  const animation = animateSpring(0, 100, update)
  expect(update).toHaveBeenLastCalledWith(0)
  tick(100)
  const position = animation.spring.position
  const velocity = animation.spring.velocity
  animation.cancel()
  await animation.finished
  expect(frames.size).toBe(0)
  expect(animation.spring.position).toBe(position)
  expect(animation.spring.velocity).toBe(velocity)
  animation.setTarget(-100)
  expect(animation.spring.velocity).toBe(velocity)
  tick(3000)
  await animation.finished
  expect(update).toHaveBeenLastCalledWith(-100)
  expect(frames.size).toBe(0)
})
