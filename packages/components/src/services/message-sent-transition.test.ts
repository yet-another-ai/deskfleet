// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearSentMessageOrigin,
  consumeSentMessageTransition,
  recordSentMessageOrigin,
  SENT_MESSAGE_DURATION_MS,
  SENT_MESSAGE_EASING,
  SENT_MESSAGE_LIFT_DURATION_MS,
  SENT_MESSAGE_LIFT_EASING,
} from "./message-sent-transition.ts"

function mockRect(el: Element, r: { left: number; top: number; width: number; height: number }): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => ({}),
  } as DOMRect)
}

function spyAnimate(el: HTMLElement) {
  const listeners = new Map<string, Array<() => void>>()
  const spy = vi.fn(() => ({
    addEventListener: (type: string, cb: () => void) => listeners.set(type, [...listeners.get(type) ?? [], cb]),
    cancel: vi.fn(),
  } as unknown as Animation))
  Object.defineProperty(el, "animate", { configurable: true, writable: true, value: spy })
  return { spy, finish: () => listeners.get("finish")?.forEach(cb => cb()) }
}

describe("message-sent-transition", () => {
  afterEach(() => {
    clearSentMessageOrigin()
    vi.restoreAllMocks()
  })

  it("morphs a newly committed user message bubble from the composer shell rect with an animejs spring", () => {
    const composer = document.createElement("div")
    mockRect(composer, { left: 120, top: 620, width: 680, height: 112 })

    const entry = document.createElement("div")
    const meta = document.createElement("div")
    meta.dataset.userMessageMeta = ""
    const bubble = document.createElement("div")
    bubble.dataset.userMessageBubble = ""
    const avatar = document.createElement("div")
    avatar.dataset.userMessageAvatar = ""
    entry.append(meta, bubble, avatar)
    mockRect(bubble, { left: 560, top: 240, width: 220, height: 42 })

    const bubbleAnim = spyAnimate(bubble)
    const metaAnim = spyAnimate(meta)
    const avatarAnim = spyAnimate(avatar)

    recordSentMessageOrigin(composer)
    expect(consumeSentMessageTransition(entry)).toHaveLength(4)
    expect(bubble.dataset.messageSending).toBe("true")
    expect(SENT_MESSAGE_EASING).toMatch(/^linear\(/)
    expect(bubbleAnim.spy).toHaveBeenNthCalledWith(1, expect.any(Array), {
      duration: SENT_MESSAGE_DURATION_MS,
      easing: SENT_MESSAGE_EASING,
    })
    expect(bubbleAnim.spy).toHaveBeenNthCalledWith(2, [
      { transform: "translateY(380px)" },
      { transform: "translateY(0px)" },
    ], { duration: SENT_MESSAGE_LIFT_DURATION_MS, easing: SENT_MESSAGE_LIFT_EASING })
    expect(metaAnim.spy).toHaveBeenCalledOnce()
    expect(avatarAnim.spy).toHaveBeenCalledOnce()

    bubbleAnim.finish()
    expect(bubble.dataset.messageSending).toBeUndefined()
    expect(consumeSentMessageTransition(entry)).toEqual([])
  })

  it("skips animations while still consuming the pending origin when reducedMotion is enabled", () => {
    const composer = document.createElement("div")
    mockRect(composer, { left: 120, top: 620, width: 680, height: 112 })
    const entry = document.createElement("div")
    const bubble = document.createElement("div")
    bubble.dataset.userMessageBubble = ""
    entry.append(bubble)
    const bubbleAnim = spyAnimate(bubble)

    recordSentMessageOrigin(composer)
    expect(consumeSentMessageTransition(entry, true)).toEqual([])
    expect(bubbleAnim.spy).not.toHaveBeenCalled()
    expect(consumeSentMessageTransition(entry, false)).toEqual([])
  })

  it("waits for smooth scrolling to settle when scrolled up, keeping the entry hidden until it reaches the bottom", () => {
    const composer = document.createElement("div")
    mockRect(composer, { left: 120, top: 620, width: 680, height: 112 })

    const scroller = document.createElement("div")
    scroller.dataset.sessionScrollViewport = ""
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2400, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: { value: 1200, writable: true, configurable: true },
    })
    const scrollTo = vi.spyOn(scroller, "scrollTo").mockImplementation(() => {})

    const entry = document.createElement("div")
    mockRect(entry, { left: 120, top: 1100, width: 680, height: 64 })
    const bubble = document.createElement("div")
    bubble.dataset.userMessageBubble = ""
    entry.append(bubble)
    scroller.append(entry)
    document.body.append(scroller)
    mockRect(bubble, { left: 560, top: 500, width: 220, height: 42 })
    const bubbleAnim = spyAnimate(bubble)

    recordSentMessageOrigin(composer)
    const animations = consumeSentMessageTransition(entry)
    expect(animations).toHaveLength(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: 2400, behavior: "smooth" })
    expect(entry.style.opacity).toBe("0")
    expect(bubbleAnim.spy).not.toHaveBeenCalled()

    scroller.dispatchEvent(new Event("scrollend"))
    expect(entry.style.opacity).toBe("")
    expect(scroller.scrollTop).toBe(2400)
    expect(animations).toHaveLength(2)

    scroller.remove()
  })
})
