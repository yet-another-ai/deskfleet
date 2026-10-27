import { mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from "../../stores/appearance.ts"

let pinia: ReturnType<typeof createPinia>
beforeEach(() => { localStorage.removeItem(APPEARANCE_STORAGE_KEY); pinia = createPinia(); setActivePinia(pinia) })
afterEach(() => { disposePinia(pinia); localStorage.removeItem(APPEARANCE_STORAGE_KEY) })

const terminals: FakeTerminal[] = []
const fits: { fit: ReturnType<typeof vi.fn> }[] = []
const ligatureAddons: { dispose: ReturnType<typeof vi.fn> }[] = []

class FakeTerminal {
  element: HTMLElement | undefined
  options: Record<string, unknown>
  cols = 100
  rows = 30
  input: (data: string) => void = () => {}
  resized: (size: { cols: number; rows: number }) => void = () => {}
  titled: (title: string) => void = () => {}
  subscription = { dispose: vi.fn() }
  onData = vi.fn((listener: typeof this.input) => { this.input = listener; return this.subscription })
  onResize = vi.fn((listener: typeof this.resized) => { this.resized = listener; return this.subscription })
  onTitleChange = vi.fn((listener: typeof this.titled) => { this.titled = listener; return this.subscription })
  open = vi.fn((element: HTMLElement) => { this.element = element })
  refresh = vi.fn()
  write = vi.fn()
  focus = vi.fn()
  reset = vi.fn()
  dispose = vi.fn()
  loadAddon = vi.fn()
  constructor(options: Record<string, unknown>) {
    this.options = options
    terminals.push(this)
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }))
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn()
    constructor() {
      fits.push(this)
    }
  },
}))
vi.mock("@xterm/addon-ligatures", () => ({
  LigaturesAddon: class {
    dispose = vi.fn()
    constructor() { ligatureAddons.push(this) }
  },
}))

const { default: TerminalSurface } = await import("./TerminalSurface.vue")

test("opens a read-only xterm.js terminal that fits its container", () => {
  const wrapper = mount(TerminalSurface, { props: { banner: "first\nsecond" } })
  const [terminal] = terminals
  const [fit] = fits

  // Input stays disabled until a session transport exists.
  expect(terminal!.options.disableStdin).toBe(true)
  terminal!.input("pasted command\r")
  expect(wrapper.emitted("input")).toBeUndefined()
  expect(terminal!.loadAddon).toHaveBeenCalledWith(fit)
  expect(terminal!.open).toHaveBeenCalledWith(wrapper.element)
  expect(fit!.fit).toHaveBeenCalled()
  expect(terminal!.write).toHaveBeenNthCalledWith(1, "\x1b[?25l")
  // xterm.js needs carriage returns to start the next line at column zero.
  expect(terminal!.write).toHaveBeenNthCalledWith(2, "first\r\nsecond")
  expect(wrapper.emitted("ready")).toEqual([[{ cols: 100, rows: 30 }]])

  wrapper.unmount()
  expect(terminal!.dispose).toHaveBeenCalledOnce()
})

test("forwards terminal input and size changes and enables input only when attached", async () => {
  const wrapper = mount(TerminalSurface)
  const terminal = terminals.at(-1)!
  expect(terminal.write).not.toHaveBeenCalled()
  await wrapper.setProps({ interactive: true })
  expect(terminal.options.disableStdin).toBe(false)
  expect(terminal.focus).toHaveBeenCalledOnce()
  terminal.input("\u0003")
  terminal.resized({ cols: 120, rows: 40 })
  terminal.titled("node server.js")
  expect(wrapper.emitted("title")).toEqual([["node server.js"]])
  expect(wrapper.emitted("input")).toEqual([["\u0003"]])
  expect(wrapper.emitted("resize")).toEqual([[{ cols: 120, rows: 40 }]])
  await wrapper.setProps({ interactive: false })
  expect(terminal.options.disableStdin).toBe(true)
  wrapper.unmount()
  expect(terminal.subscription.dispose).toHaveBeenCalledTimes(3)
})

test("applies the terminal font fallback list to existing terminals and refits their cells", async () => {
  const appearance = useAppearanceStore()
  const defaultFont = appearance.terminalFont
  const customFont = '"JetBrains Mono", "Noto Sans Mono CJK SC", monospace'
  appearance.settings.terminalFont = customFont
  appearance.settings.terminalLigatures = true
  const initialAddons = ligatureAddons.length
  const wrapper = mount(TerminalSurface)
  const terminal = terminals.at(-1)!
  const fit = fits.at(-1)!
  expect(terminal.options.fontFamily).toBe(customFont)
  expect(ligatureAddons).toHaveLength(initialAddons + 1)
  const firstAddon = ligatureAddons.at(-1)!
  fit.fit.mockClear()

  appearance.settings.terminalFont = '"Cascadia Code", Consolas, monospace'
  await nextTick()
  expect(terminal.options.fontFamily).toBe('"Cascadia Code", Consolas, monospace')
  expect(fit.fit).toHaveBeenCalledOnce()
  expect(terminal.open).toHaveBeenCalledOnce()
  expect(firstAddon.dispose).toHaveBeenCalledOnce()
  expect(ligatureAddons).toHaveLength(initialAddons + 2)
  expect(terminal.loadAddon).toHaveBeenLastCalledWith(ligatureAddons.at(-1))

  appearance.settings.terminalFont = ""
  await nextTick()
  expect(terminal.options.fontFamily).toBe(defaultFont)
  expect(fit.fit).toHaveBeenCalledTimes(2)
  expect(ligatureAddons).toHaveLength(initialAddons + 3)
  wrapper.unmount()
})

test("enables and disables the official ligatures addon on existing session terminals", async () => {
  const appearance = useAppearanceStore()
  const initialAddons = ligatureAddons.length
  const wrapper = mount(TerminalSurface)
  const terminal = terminals.at(-1)!
  expect(terminal.options.allowProposedApi).toBe(true)
  expect(ligatureAddons).toHaveLength(initialAddons)
  expect(terminal.element!.style.fontFeatureSettings).toBe('"calt" off, "liga" off')
  terminal.refresh.mockClear()

  appearance.settings.terminalLigatures = true
  await nextTick()
  const addon = ligatureAddons.at(-1)!
  expect(ligatureAddons).toHaveLength(initialAddons + 1)
  expect(terminal.loadAddon).toHaveBeenLastCalledWith(addon)
  expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1)

  appearance.settings.terminalLigatures = false
  await nextTick()
  expect(addon.dispose).toHaveBeenCalledOnce()
  expect(terminal.element!.style.fontFeatureSettings).toBe('"calt" off, "liga" off')
  appearance.settings.terminalLigatures = true
  await nextTick()
  expect(ligatureAddons).toHaveLength(initialAddons + 2)
  expect(terminal.open).toHaveBeenCalledOnce()
  wrapper.unmount()
})

test("previews font and ligature drafts independently of saved terminal preferences", async () => {
  const appearance = useAppearanceStore()
  appearance.settings.terminalFont = '"Saved Font", monospace'
  appearance.settings.terminalLigatures = true
  const initialAddons = ligatureAddons.length
  const wrapper = mount(TerminalSurface, { props: { fontFamily: '"Draft Font", monospace', ligatures: false } })
  const terminal = terminals.at(-1)!
  expect(terminal.options.fontFamily).toBe('"Draft Font", monospace')
  expect(ligatureAddons).toHaveLength(initialAddons)
  await wrapper.setProps({ ligatures: true })
  expect(ligatureAddons).toHaveLength(initialAddons + 1)

  appearance.settings.terminalFont = "serif"
  appearance.settings.terminalLigatures = false
  await nextTick()
  expect(terminal.options.fontFamily).toBe('"Draft Font", monospace')
  expect(ligatureAddons.at(-1)!.dispose).not.toHaveBeenCalled()
  await wrapper.setProps({ fontFamily: undefined, ligatures: undefined })
  expect(terminal.options.fontFamily).toBe("serif")
  expect(ligatureAddons.at(-1)!.dispose).toHaveBeenCalledOnce()
  wrapper.unmount()
})
