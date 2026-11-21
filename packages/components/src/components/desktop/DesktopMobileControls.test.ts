import { mount } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import DesktopMobileControls from "./DesktopMobileControls.vue"
import { sendDesktopText } from "./mobile-keyboard.ts"

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
function fixture() {
  const stage = document.createElement("div")
  document.body.append(stage)
  const send = vi.fn(() => true)
  const wrapper = mount(DesktopMobileControls, { props: { modelValue: "absolute", enabled: true, stage, platform: "darwin", send }, global: { plugins: [i18n] }, attachTo: stage })
  cleanups.push(() => { wrapper.unmount(); stage.remove() })
  const editor = () => stage.querySelector("textarea")!
  return { stage, wrapper, send, editor }
}
test("opens the system keyboard in the click gesture and commits IME text exactly once", async () => {
  const f = fixture()
  await f.wrapper.get("[data-desktop-system-keyboard]").trigger("click")
  expect(document.activeElement).toBe(f.editor())
  f.editor().dispatchEvent(new CompositionEvent("compositionstart"))
  f.editor().value = "\u200b你好"
  f.editor().dispatchEvent(new InputEvent("input", { isComposing: true }))
  expect(f.send).not.toHaveBeenCalled()
  f.editor().dispatchEvent(new CompositionEvent("compositionend"))
  f.editor().dispatchEvent(new InputEvent("input", { data: "你好" }))
  expect(f.send.mock.calls).toEqual([
    [{ type: "releaseAll" }], [{ type: "clipboard", text: "你好" }],
    [{ type: "key", code: "MetaLeft", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyV", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyV", pressed: false, repeat: false }],
    [{ type: "key", code: "MetaLeft", pressed: false, repeat: false }],
  ])
})

test("Hacker Keyboard sends one-shot chords and closes when control pauses", async () => {
  const f = fixture()
  await f.wrapper.get("[data-desktop-hacker-keyboard]").trigger("click")
  // The panel is teleported into the fullscreen stage.
  const press = (label: string) => [...f.stage.querySelectorAll("button")].find(node => node.textContent?.trim() === label)!.click()
  press("Ctrl")
  await f.wrapper.vm.$nextTick()
  press("C")
  expect(f.send.mock.calls).toEqual([
    [{ type: "key", code: "ControlLeft", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyC", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyC", pressed: false, repeat: false }],
    [{ type: "key", code: "ControlLeft", pressed: false, repeat: false }],
  ])
  await f.wrapper.setProps({ enabled: false })
  expect(f.stage.querySelector("[data-desktop-key-panel]")).toBeNull()
  expect(f.editor().disabled).toBe(true)
})

test("empty/oversized text and failed clipboard delivery do not trigger paste", () => {
  const send = vi.fn(() => true)
  sendDesktopText(send, "\0", "linux")
  sendDesktopText(send, "好".repeat(11_000), "linux")
  expect(send).not.toHaveBeenCalled()
  send.mockReturnValueOnce(true).mockReturnValueOnce(false)
  sendDesktopText(send, "hello", "linux")
  expect(send).toHaveBeenCalledTimes(2)
})

test("terminal text uses Ctrl+Shift+V and releases both modifiers", () => {
  const send = vi.fn(() => true)
  sendDesktopText(send, "你好", "linux", true)
  expect(send.mock.calls).toEqual([
    [{ type: "releaseAll" }], [{ type: "clipboard", text: "你好" }],
    [{ type: "key", code: "ControlLeft", pressed: true, repeat: false }],
    [{ type: "key", code: "ShiftLeft", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyV", pressed: true, repeat: false }],
    [{ type: "key", code: "KeyV", pressed: false, repeat: false }],
    [{ type: "key", code: "ShiftLeft", pressed: false, repeat: false }],
    [{ type: "key", code: "ControlLeft", pressed: false, repeat: false }],
  ])
})
