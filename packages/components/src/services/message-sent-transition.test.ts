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
})
