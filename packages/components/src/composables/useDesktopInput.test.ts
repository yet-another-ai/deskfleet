import { effectScope, nextTick, ref, shallowRef } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { desktopPoint, useDesktopInput } from "./useDesktopInput.ts"

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
  const send = vi.fn(() => true)
  scope.run(() => useDesktopInput(shallowRef(video), enabled, send))
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
  function key(type: string, code: string, repeat = false) {
    const event = new KeyboardEvent(type, { code, repeat, cancelable: true })
    video.dispatchEvent(event)
    return event
  }
  return { video, enabled, send, pointer, key, scope }
}

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
    () => { vi.spyOn(document, "hidden", "get").mockReturnValueOnce(true); document.dispatchEvent(new Event("visibilitychange")) },
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
