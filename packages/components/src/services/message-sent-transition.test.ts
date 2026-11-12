import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { clearSentMessageOrigin, consumeSentMessageTransition, recordSentMessageOrigin } from "./message-sent-transition.ts"

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
  clearSentMessageOrigin()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function tick(milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 16) {
    vi.advanceTimersByTime(16)
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
    await Promise.resolve()
  }
}
function fixture(scrolledUp = false) {
  const composer = document.createElement("div")
  vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(new DOMRect(120, 620, 680, 112))
  const scroller = document.createElement("div")
  scroller.dataset.sessionScrollViewport = ""
  Object.defineProperties(scroller, {
    scrollHeight: { value: scrolledUp ? 2400 : 500 },
    clientHeight: { value: 500 },
    scrollTop: { value: scrolledUp ? 1200 : 0, writable: true },
  })
  const entry = document.createElement("div")
  vi.spyOn(entry, "getBoundingClientRect").mockReturnValue(new DOMRect(120, 240, 680, 64))
  const bubble = document.createElement("div")
  bubble.dataset.userMessageBubble = ""
  const content = document.createElement("div")
  bubble.append(content)
  vi.spyOn(bubble, "getBoundingClientRect").mockReturnValue(new DOMRect(560, 240, 220, 42))
  const meta = document.createElement("div")
  meta.dataset.userMessageMeta = ""
  const avatar = document.createElement("div")
  avatar.dataset.userMessageAvatar = ""
  entry.append(meta, bubble, avatar)
  scroller.append(entry)
  document.body.append(scroller)
  recordSentMessageOrigin(composer)
  return { composer, scroller, entry, bubble, meta, content }
}

test("morphs from the composer with a live spring and restores styles once settled", async () => {
  const { entry, bubble, meta, content } = fixture()
  const animations = consumeSentMessageTransition(entry)
  expect(animations).toHaveLength(1)
  expect(bubble.dataset.messageSending).toBe("true")
  expect(bubble.style.width).toBe("680px")
  expect(bubble.style.height).toBe("112px")
  expect(bubble.style.translate).toBe("20px 380px")
  expect(meta.style.opacity).toBe("0")
  await tick(100)
  expect(parseFloat(bubble.style.width)).toBeGreaterThan(220)
  expect(parseFloat(bubble.style.width)).toBeLessThan(680)
  await tick(3000)
  await animations[0]!.finished
  expect(bubble.dataset.messageSending).toBeUndefined()
  expect(bubble.style.width).toBe("")
  expect(bubble.style.translate).toBe("")
  expect(content.style.minWidth).toBe("")
  expect(meta.style.opacity).toBe("")
  expect(frames.size).toBe(0)
  expect(consumeSentMessageTransition(entry)).toEqual([])
})

test("reduced motion consumes the pending origin without scheduling motion", () => {
  const { entry, bubble } = fixture()
  expect(consumeSentMessageTransition(entry, true)).toEqual([])
  expect(bubble.dataset.messageSending).toBeUndefined()
  expect(frames.size).toBe(0)
  expect(consumeSentMessageTransition(entry)).toEqual([])
})

test("waits for spring scrolling to finish before revealing the animated bubble", async () => {
  const { entry, bubble, scroller } = fixture(true)
  const animations = consumeSentMessageTransition(entry)
  expect(animations).toHaveLength(1)
  expect(entry.style.opacity).toBe("0")
  expect(scroller.scrollTop).toBe(1200)
  expect(bubble.dataset.messageSending).toBeUndefined()
  await tick(100)
  expect(scroller.scrollTop).toBeGreaterThan(1200)
  expect(scroller.scrollTop).toBeLessThan(1900)
  await tick(3000)
  await animations[0]!.finished
  expect(entry.style.opacity).toBe("")
  expect(scroller.scrollTop).toBe(1900)
  expect(bubble.dataset.messageSending).toBeUndefined()
})

test.each(["cancel", "wheel", "detach"])("%s during scrolling restores visibility and prevents a late send animation", async interruption => {
  const { entry, bubble, scroller } = fixture(true)
  const animations = consumeSentMessageTransition(entry)
  await tick(64)
  if (interruption === "cancel") animations[0]!.cancel()
  else if (interruption === "wheel") scroller.dispatchEvent(new WheelEvent("wheel"))
  else entry.remove()
  await tick(3000)
  await animations[0]!.finished
  expect(entry.style.opacity).toBe("")
  expect(bubble.dataset.messageSending).toBeUndefined()
  expect(bubble.style.width).toBe("")
  expect(frames.size).toBe(0)
})

test("cancel during the morph removes transient styles immediately", async () => {
  const { entry, bubble, content } = fixture()
  const animations = consumeSentMessageTransition(entry)
  await tick(100)
  animations[0]!.cancel()
  expect(bubble.dataset.messageSending).toBeUndefined()
  expect(bubble.style.width).toBe("")
  expect(content.style.minWidth).toBe("")
  expect(frames.size).toBe(0)
  await animations[0]!.finished
})
