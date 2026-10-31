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
