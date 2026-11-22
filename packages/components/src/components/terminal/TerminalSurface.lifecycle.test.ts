import { mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { APPEARANCE_STORAGE_KEY } from "../../stores/appearance.ts"

// Exercise xterm's real DOM renderer and ligatures lifecycle without GPU/image support.
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() { throw new Error("WebGL unavailable") }
  },
}))
vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class {
    activate() {}
    dispose() {}
  },
}))

const { default: TerminalSurface } = await import("./TerminalSurface.vue")
let pinia: ReturnType<typeof createPinia>
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

beforeEach(() => {
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  pinia = createPinia()
  setActivePinia(pinia)
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
})
afterEach(() => {
  frames.clear()
  disposePinia(pinia)
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
})

test("unmount cancels viewport refreshes when terminal ligatures are enabled", () => {
  const wrapper = mount(TerminalSurface, { props: { ligatures: true }, attachTo: document.body })
  const terminal = wrapper.vm.terminal
  terminal.resize(100, 30)
  expect(frames.size).toBeGreaterThan(0)
  wrapper.unmount()

  // Drain frames that would execute after a tab switch or closing the preview.
  expect(() => {
    const queued = [...frames.values()]
    frames.clear()
    for (const callback of queued) callback(0)
  }).not.toThrow()
  expect(frames.size).toBe(0)
})

test("Android keyboard events and committed IME text reach interactive xterm onData", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android Chrome")
  vi.spyOn(KeyboardEvent.prototype, "getModifierState").mockReturnValue(false)
  const wrapper = mount(TerminalSurface, { props: { interactive: true }, attachTo: document.body })
  const textarea = wrapper.vm.terminal.textarea!
  const key = (type: string, init: KeyboardEventInit) => {
    const event = new KeyboardEvent(type, { ...init, bubbles: true, cancelable: true })
    textarea.dispatchEvent(event)
    return event
  }
  // A mobile keyboard can report Enter's legacy code for a bare modifier.
  const control = { key: "Control", code: "ControlLeft", keyCode: 13 }
  expect(key("keydown", { ...control, ctrlKey: true }).defaultPrevented).toBe(true)
  key("keyup", control)
  expect(wrapper.emitted("input")).toBeUndefined()

  const chord = { key: "Process", code: "Digit1", altKey: true, shiftKey: true, keyCode: 229 }
  for (const type of ["keydown", "keypress", "keyup"]) key(type, chord)
  // A reliable arrow is decoded by xterm itself.
  key("keydown", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 })
  key("keyup", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 })

  // Plain Shift+1 is committed as text by the Android input method.
  key("keydown", { key: "Process", code: "Digit1", shiftKey: true, keyCode: 229 })
  textarea.value = "!"
  textarea.dispatchEvent(new InputEvent("input", { data: "!", inputType: "insertText", bubbles: true, composed: true }))
  await vi.waitFor(() => expect(wrapper.emitted("input")?.flat()).toEqual(["\x1b!", "\x1b[D", "!"]))
  textarea.value = ""

  textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
  key("keydown", { key: "Process", code: "KeyC", ctrlKey: true, keyCode: 229, isComposing: true })
  textarea.value = "漢"
  textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "漢", bubbles: true }))
  await vi.waitFor(() => expect(wrapper.emitted("input")?.flat()).toEqual(["\x1b!", "\x1b[D", "!", "漢"]))

  await wrapper.setProps({ interactive: false })
  key("keydown", { key: "Process", code: "KeyC", ctrlKey: true, keyCode: 229 })
  expect(wrapper.emitted("input")).toHaveLength(4)
  wrapper.unmount()
})
