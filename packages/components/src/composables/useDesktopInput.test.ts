import { effectScope, nextTick, ref, shallowRef } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { desktopPoint, useDesktopInput } from "./useDesktopInput.ts"
import type { DesktopPointerMode } from "./useDesktopTouch.ts"
import type { DesktopInputMessage } from "@deskfleet/client/desktop-input"

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

function fixture(platform = "Win32") {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)
  const video = document.createElement("video")
  video.tabIndex = 0
  document.body.append(video)
  Object.defineProperties(video, {
    videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, clientHeight: { value: 600 },
  })
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 800, height: 600 } as DOMRect)
  const captured = new Set<number>()
  vi.spyOn(video, "setPointerCapture").mockImplementation(id => { captured.add(id) })
  vi.spyOn(video, "hasPointerCapture").mockImplementation(id => captured.has(id))
  vi.spyOn(video, "releasePointerCapture").mockImplementation(id => {
    captured.delete(id)
    video.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: id }))
  })
  const scope = effectScope()
  const enabled = ref(true)
  const reverseScroll = ref(false)
  const clipboardSharing = ref(true)
  const remoteClipboard = shallowRef<{ id: number; text: string } | null>(null)
  const send = vi.fn((_message: DesktopInputMessage) => true)
  const surface = shallowRef<HTMLVideoElement | null>(video)
  const pointerMode = ref<DesktopPointerMode>("absolute")
  scope.run(() => useDesktopInput(surface, enabled, send, reverseScroll, clipboardSharing, remoteClipboard, pointerMode))
  disposers.push(() => { scope.stop(); video.remove() })
  let mouseButtons = 0
  function pointer(type: string, init: PointerEventInit = {}) {
    const button = init.button ?? (type === "pointermove" ? -1 : 0)
    const mask = [1, 4, 2, 8, 16][button] ?? 0
    if (init.buttons !== undefined) mouseButtons = init.buttons
    else if (type === "pointerdown") mouseButtons |= mask
    else if (type === "pointerup") mouseButtons &= ~mask
    const event = new PointerEvent(type, { pointerId: 1, pointerType: "mouse", clientX: 410, clientY: 320, button, buttons: mouseButtons, cancelable: true, ...init })
    video.dispatchEvent(event)
    return event
  }
  function key(type: string, code: string, repeat = false, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent(type, { code, repeat, cancelable: true, ...init })
    video.dispatchEvent(event)
    return event
  }
  return { video, surface, enabled, reverseScroll, clipboardSharing, remoteClipboard, send, pointer, key, scope, pointerMode }
}

test("touch taps map to the image and absolute drags release on pause", () => {
  const f = fixture()
  f.pointer("pointerdown", { pointerType: "touch", clientY: 40 })
  f.pointer("pointerup", { pointerType: "touch", clientY: 40 })
  expect(f.send).not.toHaveBeenCalled()
  f.pointer("pointerdown", { pointerType: "touch" })
  f.pointer("pointerup", { pointerType: "touch" })
  expect(f.send.mock.calls).toEqual([
    [{ type: "pointerButton", button: 0, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerButton", button: 0, pressed: false, x: 0.5, y: 0.5 }],
  ])
  f.send.mockClear()
  f.pointer("pointerdown", { pointerType: "touch" })
  f.pointer("pointermove", { pointerType: "touch", clientX: 1200 })
  f.enabled.value = false
  expect(f.send.mock.calls).toEqual([
    [{ type: "pointerButton", button: 0, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerMove", x: 1, y: 0.5 }],
    [{ type: "pointerButton", button: 0, pressed: false, x: 1, y: 0.5 }],
  ])
  expect(f.video.hasPointerCapture(1)).toBe(false)
})

test("relative touch moves from the cursor, preserves it across gestures, and taps without jumping", () => {
  const f = fixture()
  f.pointerMode.value = "relative"
  f.pointer("pointerdown", { pointerType: "touch", clientX: 40, clientY: 40 })
  f.pointer("pointermove", { pointerType: "touch", clientX: 120, clientY: 40 })
  f.pointer("pointerup", { pointerType: "touch", clientX: 120, clientY: 40 })
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: "pointerMove", x: 0.6, y: 0.5 })
  f.pointer("pointerdown", { pointerType: "touch", clientX: 700 })
  f.pointer("pointerup", { pointerType: "touch", clientX: 700 })
  expect(f.send.mock.calls.slice(1)).toEqual([
    [{ type: "pointerButton", button: 0, pressed: true, x: 0.6, y: 0.5 }],
    [{ type: "pointerButton", button: 0, pressed: false, x: 0.6, y: 0.5 }],
  ])
})

test("two-finger scrolling never leaves a drag held or clicks when a finger lifts", () => {
  const f = fixture()
  f.pointer("pointerdown", { pointerType: "touch" })
  f.pointer("pointermove", { pointerType: "touch", clientX: 450 })
  f.pointer("pointerdown", { pointerType: "touch", pointerId: 2 })
  f.pointer("pointermove", { pointerType: "touch", pointerId: 2, clientY: 340 })
  f.pointer("pointerup", { pointerType: "touch", pointerId: 2 })
  f.pointer("pointerup", { pointerType: "touch" })
  expect(f.send.mock.calls.filter(([message]) => message.type === "pointerButton")).toHaveLength(2)
  expect(f.send).toHaveBeenCalledWith({ type: "wheel", deltaX: -0, deltaY: -10 })
})

test("two-finger scroll targets the touched pane before sending a wheel event", () => {
  const f = fixture()
  f.pointer("pointerdown", { pointerType: "touch", clientX: 210 })
  f.pointer("pointerdown", { pointerType: "touch", pointerId: 2, clientX: 230 })
  f.pointer("pointermove", { pointerType: "touch", pointerId: 2, clientX: 230, clientY: 340 })
  expect(f.send.mock.calls).toEqual([
    [{ type: "pointerMove", x: 0.25, y: 0.5 }],
    [{ type: "wheel", deltaX: -0, deltaY: -10 }],
  ])
})

test("relative double-tap-and-hold drags and releases at the virtual cursor", () => {
  const f = fixture()
  f.pointerMode.value = "relative"
  f.pointer("pointerdown", { pointerType: "touch" })
  f.pointer("pointerup", { pointerType: "touch" })
  f.send.mockClear()
  f.pointer("pointerdown", { pointerType: "touch" })
  f.pointer("pointermove", { pointerType: "touch", clientX: 490 })
  f.pointer("pointerup", { pointerType: "touch", clientX: 490 })
  expect(f.send.mock.calls).toEqual([
    [{ type: "pointerButton", button: 0, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerMove", x: 0.6, y: 0.5 }],
    [{ type: "pointerButton", button: 0, pressed: false, x: 0.6, y: 0.5 }],
  ])
})

test("touch cancellation and mode changes cancel pending long presses", () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    f.pointer("pointerdown", { pointerType: "touch" })
    f.pointerMode.value = "relative"
    vi.advanceTimersByTime(600)
    expect(f.send).not.toHaveBeenCalled()
    f.pointer("pointerdown", { pointerType: "touch" })
    vi.advanceTimersByTime(600)
    expect(f.send.mock.calls).toEqual([
      [{ type: "pointerButton", button: 2, pressed: true, x: 0.5, y: 0.5 }],
      [{ type: "pointerButton", button: 2, pressed: false, x: 0.5, y: 0.5 }],
    ])
    f.pointer("pointercancel", { pointerType: "touch" })
    expect(f.video.hasPointerCapture(1)).toBe(false)
  } finally { vi.useRealTimers() }
})

test("maps the visible image rather than letterbox bars, and clamps captured drags", () => {
  const { video } = fixture()
  expect(desktopPoint(video, 410, 320)).toEqual({ x: 0.5, y: 0.5 })
  expect(desktopPoint(video, 410, 40)).toBeNull()
  expect(desktopPoint(video, 1000, 1000, true)).toEqual({ x: 1, y: 1 })
  expect(desktopPoint(video, 10, 95)).toEqual({ x: 0, y: 0 })
})

test("ignores view-only input and letterbox clicks, captures and releases a drag outside the video", () => {
  const f = fixture()
  f.enabled.value = false
  expect(f.pointer("pointerdown").defaultPrevented).toBe(false)
  expect(f.key("keydown", "KeyA").defaultPrevented).toBe(false)
  expect(f.send).not.toHaveBeenCalled()
  f.enabled.value = true
  f.pointer("pointerdown", { clientY: 30 })
  expect(f.send).not.toHaveBeenCalled()
  f.pointer("pointerdown")
  expect(document.activeElement).toBe(f.video)
  expect(f.video.setPointerCapture).toHaveBeenCalledWith(1)
  f.pointer("pointermove", { clientX: 1200, clientY: -10 })
  f.pointer("pointerup", { clientX: 1200, clientY: -10 })
  expect(f.send.mock.calls).toEqual([
    [{ type: "pointerButton", button: 0, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerMove", x: 1, y: 0 }],
    [{ type: "pointerButton", button: 0, pressed: false, x: 1, y: 0 }],
  ])
})

test("sends physical keys and repeat state; a normal mouse-up preserves a held modifier", () => {
  const f = fixture()
  f.video.focus()
  f.key("keydown", "ShiftLeft")
  f.pointer("pointerdown")
  f.pointer("pointerup")
  expect(f.send).not.toHaveBeenCalledWith({ type: "releaseAll" })
  f.key("keydown", "KeyQ", true)
  f.key("keyup", "KeyQ")
  f.key("keyup", "ShiftLeft")
  expect(f.send).toHaveBeenCalledWith({ type: "key", code: "KeyQ", pressed: true, repeat: true })
  expect(f.send).toHaveBeenCalledWith({ type: "key", code: "ShiftLeft", pressed: false, repeat: false })
})

test("forwards a modifier held before video focus and releases it when the right-side key lifts", () => {
  const f = fixture("Linux armv8l")
  f.key("keydown", "KeyC", false, { ctrlKey: true })
  f.key("keyup", "KeyC", false, { ctrlKey: true })
  f.key("keyup", "ControlRight")
  f.key("keydown", "KeyD")
  expect(f.send.mock.calls.map(([event]) => event.type === "key" && [event.code, event.pressed])).toEqual([
    ["ControlLeft", true], ["KeyC", true], ["KeyC", false], ["ControlLeft", false], ["KeyD", true],
  ])
})

test("uses the physical modifier side and clears flag-only Command chords on iPhone", () => {
  const f = fixture("iPhone")
  f.key("keydown", "ShiftRight", false, { shiftKey: true })
  f.key("keydown", "KeyC", false, { shiftKey: true, metaKey: true })
  f.key("keyup", "MetaRight", false, { shiftKey: true })
  f.key("keyup", "ShiftRight")
  expect(f.send.mock.calls.map(([event]) => event.type === "key" && [event.code, event.pressed])).toEqual([
    ["ShiftRight", true], ["MetaLeft", true], ["KeyC", true],
    ["MetaLeft", false], ["KeyC", false], ["ShiftRight", false],
  ])
})

test("AltGr flags on a physical right Alt do not synthesize a Control key", () => {
  const f = fixture("Linux armv8l")
  vi.spyOn(KeyboardEvent.prototype, "getModifierState").mockImplementation(name => name === "AltGraph")
  f.key("keydown", "AltRight", false, { ctrlKey: true, altKey: true })
  f.key("keydown", "KeyE", false, { ctrlKey: true, altKey: true })
  expect(f.send.mock.calls.map(([event]) => event.type === "key" && event.code)).toEqual(["AltRight", "KeyE"])
})

test("preserves chorded mouse transitions and capture until the last button releases", () => {
  const f = fixture()
  f.key("keydown", "ShiftLeft")
  // Browser event sequence: only the first press and final release use down/up.
  f.pointer("pointerdown", { button: 0, buttons: 1 })
  f.pointer("pointermove", { button: 2, buttons: 3 })
  f.pointer("pointermove", { button: 0, buttons: 2 })
  expect(f.video.releasePointerCapture).not.toHaveBeenCalled()
  f.pointer("pointermove", { button: -1, buttons: 2, clientX: 1200, clientY: -10 })
  f.pointer("pointerup", { button: 2, buttons: 0, clientX: 1200, clientY: -10 })
  expect(f.send.mock.calls.slice(1)).toEqual([
    [{ type: "pointerButton", button: 0, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerButton", button: 2, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerButton", button: 0, pressed: false, x: 0.5, y: 0.5 }],
    [{ type: "pointerMove", x: 1, y: 0 }],
    [{ type: "pointerButton", button: 2, pressed: false, x: 1, y: 0 }],
  ])
  expect(f.video.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  expect(f.send).not.toHaveBeenCalledWith({ type: "releaseAll" })
})

test("uses the distinct middle and side button masks without capturing a local drag", () => {
  const f = fixture()
  f.pointer("pointermove", { button: -1, buttons: 1 })
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: "pointerMove", x: 0.5, y: 0.5 })
  f.send.mockClear()
  f.pointer("pointerdown", { button: 1, buttons: 4 })
  f.pointer("pointermove", { button: 3, buttons: 12 })
  f.pointer("pointermove", { button: 4, buttons: 28 })
  f.pointer("pointermove", { button: 1, buttons: 24 })
  f.pointer("pointermove", { button: 3, buttons: 16 })
  f.pointer("pointerup", { button: 4, buttons: 0 })
  expect(f.send.mock.calls).toEqual([
    [{ type: "pointerButton", button: 1, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerButton", button: 3, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerButton", button: 4, pressed: true, x: 0.5, y: 0.5 }],
    [{ type: "pointerButton", button: 1, pressed: false, x: 0.5, y: 0.5 }],
    [{ type: "pointerButton", button: 3, pressed: false, x: 0.5, y: 0.5 }],
    [{ type: "pointerButton", button: 4, pressed: false, x: 0.5, y: 0.5 }],
  ])
})

test("normalizes line and page wheels into pixels and blocks local scrolling only over the image", () => {
  const f = fixture()
  // happy-dom's WheelEvent does not yet inherit MouseEvent's client coordinates.
  const wheel = (init: WheelEventInit, clientY = 320) => {
    const event = new WheelEvent("wheel", init)
    Object.defineProperties(event, { clientX: { value: 410 }, clientY: { value: clientY } })
    return event
  }
  const line = wheel({ deltaX: 2, deltaY: -3, deltaMode: 1, cancelable: true })
  f.video.dispatchEvent(line)
  expect(line.defaultPrevented).toBe(true)
  expect(f.send).toHaveBeenNthCalledWith(1, { type: "pointerMove", x: 0.5, y: 0.5 })
  expect(f.send).toHaveBeenLastCalledWith({ type: "wheel", deltaX: 32, deltaY: -48 })
  f.video.dispatchEvent(wheel({ deltaY: 1, deltaMode: 2 }))
  expect(f.send).toHaveBeenLastCalledWith({ type: "wheel", deltaX: 0, deltaY: 600 })
  f.reverseScroll.value = true
  f.video.dispatchEvent(wheel({ deltaX: 2, deltaY: -3, deltaMode: 1 }))
  expect(f.send).toHaveBeenLastCalledWith({ type: "wheel", deltaX: -32, deltaY: 48 })
  f.video.dispatchEvent(wheel({ deltaY: 1, deltaMode: 2 }))
  expect(f.send).toHaveBeenLastCalledWith({ type: "wheel", deltaX: 0, deltaY: -600 })
  const bar = wheel({ deltaY: 100, cancelable: true }, 30)
  f.video.dispatchEvent(bar)
  expect(bar.defaultPrevented).toBe(false)
})

test("Command release clears chord keys whose key-up the browser suppressed", () => {
  const f = fixture("MacIntel")
  f.key("keydown", "ShiftLeft")
  f.key("keydown", "MetaLeft")
  f.key("keydown", "KeyC")
  f.key("keyup", "MetaLeft")
  expect(f.send).toHaveBeenLastCalledWith({ type: "key", code: "KeyC", pressed: false, repeat: false })
  expect(f.send).not.toHaveBeenCalledWith({ type: "key", code: "ShiftLeft", pressed: false, repeat: false })
  const sent = f.send.mock.calls.length
  f.key("keyup", "KeyC")
  expect(f.send).toHaveBeenCalledTimes(sent)
})

test("Windows Meta release preserves a held key and its subsequent repeats", () => {
  const f = fixture("Win32")
  f.key("keydown", "KeyA")
  f.key("keydown", "MetaLeft")
  f.key("keyup", "MetaLeft")
  expect(f.send).not.toHaveBeenCalledWith({ type: "key", code: "KeyA", pressed: false, repeat: false })
  f.key("keydown", "KeyA", true)
  f.key("keyup", "KeyA")
  expect(f.send.mock.calls).toEqual([
    [{ type: "key", code: "KeyA", pressed: true, repeat: false }],
    [{ type: "key", code: "MetaLeft", pressed: true, repeat: false }],
    [{ type: "key", code: "MetaLeft", pressed: false, repeat: false }],
    [{ type: "key", code: "KeyA", pressed: true, repeat: true }],
    [{ type: "key", code: "KeyA", pressed: false, repeat: false }],
  ])
})

test("releases held input on blur, visibility loss, pause, lost capture, and disposal", async () => {
  const f = fixture()
  for (const release of [
    () => f.video.dispatchEvent(new Event("blur")),
    () => window.dispatchEvent(new Event("blur")),
    () => { vi.spyOn(document, "visibilityState", "get").mockReturnValueOnce("hidden"); document.dispatchEvent(new Event("visibilitychange")) },
    () => { f.enabled.value = false },
    () => f.pointer("lostpointercapture"),
    () => f.scope.stop(),
  ]) {
    f.enabled.value = true
    f.pointer("pointerdown")
    f.key("keydown", "ControlLeft")
    f.send.mockClear()
    release()
    await nextTick()
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: "releaseAll" })
  }
})

test("replacing the video releases held input and follows the new surface", async () => {
  const f = fixture()
  f.pointer("pointerdown")
  f.key("keydown", "ControlLeft")
  f.send.mockClear()
  const next = document.createElement("video")
  next.tabIndex = 0
  document.body.append(next)
  Object.defineProperties(next, {
    videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, clientHeight: { value: 600 },
  })
  vi.spyOn(next, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, width: 800, height: 600 } as DOMRect)
  f.surface.value = next
  await nextTick()
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: "releaseAll" })
  f.send.mockClear()
  f.pointer("pointerdown")
  expect(f.send).not.toHaveBeenCalled()
  next.dispatchEvent(new PointerEvent("pointerdown", {
    pointerId: 1, pointerType: "mouse", clientX: 410, clientY: 320, button: 0, buttons: 1, cancelable: true,
  }))
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: "pointerButton", button: 0, pressed: true, x: 0.5, y: 0.5 })
  next.remove()
})

test("synchronizes local and remote clipboard text while seeding baseline, ordering paste before KeyV, deduplicating echoes, and honoring the toggle", async () => {
  const readText = vi.fn(async () => "initial baseline")
  const writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText, writeText },
  })
  const f = fixture()
  await nextTick()

  // Initial connect and first focus with unchanged baseline do not overwrite the remote clipboard.
  window.dispatchEvent(new Event("focus"))
  await nextTick()
  expect(f.send).not.toHaveBeenCalled()

  // Plain KeyV typing sends immediately in order without waiting on clipboard reads.
  f.key("keydown", "KeyV")
  f.key("keydown", "KeyE")
  f.key("keyup", "KeyV")
  f.key("keyup", "KeyE")
  expect(f.send.mock.calls).toEqual([
    [{ type: "key", code: "KeyV", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyE", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyV", pressed: false, repeat: false }],
    [{ type: "key", code: "KeyE", pressed: false, repeat: false }],
  ])
  f.send.mockClear()

  // Ctrl+V syncs the clipboard before KeyV and preserves modifier release and subsequent key ordering.
  f.key("keydown", "ControlLeft", false, { ctrlKey: true })
  f.key("keydown", "KeyV", false, { ctrlKey: true })
  f.key("keyup", "KeyV", false, { ctrlKey: true })
  f.key("keyup", "ControlLeft")
  f.key("keydown", "KeyA")
  f.key("keyup", "KeyA")
  await nextTick()
  await nextTick()
  expect(f.send.mock.calls).toEqual([
    [{ type: "key", code: "ControlLeft", pressed: true, repeat: false }],
    [{ type: "clipboard", text: "initial baseline" }],
    [{ type: "key", code: "KeyV", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyV", pressed: false, repeat: false }],
    [{ type: "key", code: "ControlLeft", pressed: false, repeat: false }],
    [{ type: "key", code: "KeyA", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyA", pressed: false, repeat: false }],
  ])
  f.send.mockClear()

  // Copying new text while unfocused sends it on window focus.
  readText.mockResolvedValue("local clip")
  window.dispatchEvent(new Event("focus"))
  await nextTick()
  expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: "clipboard", text: "local clip" })
  f.send.mockClear()

  // Identical local clipboard read or remote echo is suppressed.
  window.dispatchEvent(new Event("focus"))
  await nextTick()
  expect(f.send).not.toHaveBeenCalled()
  f.remoteClipboard.value = { id: 1, text: "local clip" }
  await nextTick()
  expect(writeText).not.toHaveBeenCalled()

  // Fresh remote clipboard update writes to navigator.clipboard and prevents echo back.
  f.remoteClipboard.value = { id: 2, text: "remote clip" }
  await nextTick()
  expect(writeText).toHaveBeenCalledExactlyOnceWith("remote clip")
  readText.mockResolvedValue("remote clip")
  window.dispatchEvent(new Event("focus"))
  await nextTick()
  expect(f.send).not.toHaveBeenCalled()

  // Disabling clipboard sharing suppresses both directions.
  f.clipboardSharing.value = false
  readText.mockResolvedValue("while disabled")
  window.dispatchEvent(new Event("focus"))
  f.remoteClipboard.value = { id: 3, text: "ignored remote" }
  await nextTick()
  expect(f.send).not.toHaveBeenCalled()
  expect(writeText).toHaveBeenCalledTimes(1)
})

test("stale paste clipboard read resolving after barrier timeout is discarded", async () => {
  vi.useFakeTimers()
  try {
    let resolveRead!: (value: string) => void
    const readText = vi.fn()
      .mockResolvedValueOnce("initial baseline")
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveRead = resolve }))
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText, writeText },
    })
    const f = fixture()
    await nextTick()
    f.send.mockClear()

    f.key("keydown", "ControlLeft", false, { ctrlKey: true })
    f.key("keydown", "KeyV", false, { ctrlKey: true })
    f.key("keyup", "KeyV", false, { ctrlKey: true })
    f.key("keyup", "ControlLeft")

    vi.advanceTimersByTime(150)
    expect(f.send.mock.calls).toEqual([
      [{ type: "key", code: "ControlLeft", pressed: true, repeat: false }],
      [{ type: "key", code: "KeyV", pressed: true, repeat: false }],
      [{ type: "key", code: "KeyV", pressed: false, repeat: false }],
      [{ type: "key", code: "ControlLeft", pressed: false, repeat: false }],
    ])
    f.send.mockClear()

    // Late resolution of the timed-out read must not send stale clipboard text.
    resolveRead("stale late clipboard")
    await nextTick()
    await nextTick()
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
