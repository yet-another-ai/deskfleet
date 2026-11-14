import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { scrollSpring, springScrollIntoView } from "./spring-scroll.ts"

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
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers() })
async function tick(milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    vi.advanceTimersByTime(16)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
    await Promise.resolve()
  }
}
function scroller() {
  const element = document.createElement("div")
  Object.defineProperties(element, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } })
  element.style.overflowY = "auto"
  document.body.append(element)
  return element
}

test("animates the first scroll and preserves momentum while redirecting", async () => {
  const element = scroller()
  const first = scrollSpring(element, 1200)
  expect(element.scrollTop).toBe(0)
  await tick(64)
  const position = element.scrollTop
  const second = scrollSpring(element, 0)
  expect(await first.finished).toBe(false)
  expect(element.scrollTop).toBe(position)
  await tick(16)
  expect(element.scrollTop).toBeGreaterThan(position)
  await tick(3000)
  expect(await second.finished).toBe(true)
  expect(element.scrollTop).toBe(0)
  expect(frames.size).toBe(0)
})

test.each(["wheel", "pointerdown"])("%s interrupts scrolling and releases frame callbacks", async event => {
  const element = scroller()
  const scroll = scrollSpring(element, 1000)
  await tick(80)
  const position = element.scrollTop
  element.dispatchEvent(new Event(event))
  expect(await scroll.finished).toBe(false)
  await tick(1000)
  expect(element.scrollTop).toBe(position)
  expect(frames.size).toBe(0)
})

test("reduced motion clamps to scroll bounds without scheduling frames", async () => {
  const element = scroller()
  const scroll = scrollSpring(element, 3000, true)
  expect(element.scrollTop).toBe(1600)
  expect(await scroll.finished).toBe(true)
  expect(frames.size).toBe(0)
})

test("locate centers content in its scroll parent with the same spring", async () => {
  const element = scroller()
  const target = document.createElement("div")
  element.append(target)
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 400, 400))
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 900, 100, 100))
  const scroll = springScrollIntoView(target)
  expect(element.scrollTop).toBe(0)
  await tick(3000)
  expect(await scroll.finished).toBe(true)
  expect(element.scrollTop).toBe(650)
})
