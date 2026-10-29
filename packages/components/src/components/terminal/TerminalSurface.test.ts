import { mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { APPEARANCE_STORAGE_KEY, useAppearanceStore } from "../../stores/appearance.ts"

let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  pinia = createPinia()
  setActivePinia(pinia)
  webglFactory = () => new FakeWebglAddon()
})
afterEach(() => { disposePinia(pinia); localStorage.removeItem(APPEARANCE_STORAGE_KEY) })

const terminals: FakeTerminal[] = []
const fits: { fit: ReturnType<typeof vi.fn> }[] = []
const ligatureAddons: { dispose: ReturnType<typeof vi.fn> }[] = []
const webglAddons: FakeWebglAddon[] = []
const imageAddons: FakeImageAddon[] = []
let webglFactory: () => FakeWebglAddon = () => new FakeWebglAddon()

class FakeWebglAddon {
  dispose = vi.fn()
  loseContext = vi.fn()
  lost: () => void = () => {}
  onContextLoss = vi.fn((listener: () => void) => { this.lost = listener })
  // Mirrors @xterm/addon-webgl internals used to force-release the GPU context.
  _renderer = {
    _gl: {
      getExtension: vi.fn((name: string) => name === "WEBGL_lose_context" ? { loseContext: this.loseContext } : null),
    },
  }
  constructor() { webglAddons.push(this) }
}

class FakeImageAddon {
  dispose = vi.fn()
  options: Record<string, unknown>
  constructor(options: Record<string, unknown> = {}) {
    this.options = options
    imageAddons.push(this)
  }
}

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
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() { return webglFactory() }
  },
}))
vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class {
    constructor(options: Record<string, unknown> = {}) { return new FakeImageAddon(options) }
  },
}))

const { default: TerminalSurface } = await import("./TerminalSurface.vue")

test("opens a read-only xterm.js terminal that fits its container", () => {
  const wrapper = mount(TerminalSurface, { props: { banner: "first\nsecond" } })
  const [terminal] = terminals
  const [fit] = fits
  const [webgl] = webglAddons
  const [image] = imageAddons

  // Input stays disabled until a session transport exists.
  expect(terminal!.options.disableStdin).toBe(true)
  terminal!.input("pasted command\r")
  expect(wrapper.emitted("input")).toBeUndefined()
  expect(terminal!.loadAddon).toHaveBeenCalledWith(fit)
  expect(terminal!.open).toHaveBeenCalledWith(wrapper.element)
  expect(terminal!.loadAddon).toHaveBeenCalledWith(webgl)
  expect(terminal!.loadAddon).toHaveBeenCalledWith(image)
  expect(image!.options).toEqual({
    enableSizeReports: true,
    pixelLimit: 16_777_216,
    storageLimit: 64,
  })
  expect(webgl!.onContextLoss).toHaveBeenCalledOnce()
  expect(fit!.fit).toHaveBeenCalled()
  expect(terminal!.write).toHaveBeenNthCalledWith(1, "\x1b[?25l")
  // xterm.js needs carriage returns to start the next line at column zero.
  expect(terminal!.write).toHaveBeenNthCalledWith(2, "first\r\nsecond")
  expect(wrapper.emitted("ready")).toEqual([[{ cols: 100, rows: 30 }]])

  wrapper.unmount()
  expect(image!.dispose).toHaveBeenCalledOnce()
  expect(webgl!.dispose).toHaveBeenCalledOnce()
  expect(webgl!.loseContext).toHaveBeenCalledOnce()
  expect(webgl!._renderer._gl.getExtension).toHaveBeenCalledWith("WEBGL_lose_context")
  expect(terminal!.dispose).toHaveBeenCalledOnce()
})

test("keeps the default renderer when WebGL fails to attach", () => {
  const initialWebgl = webglAddons.length
  const initialImages = imageAddons.length
  webglFactory = () => { throw new Error("WebGL2 unavailable") }
  const wrapper = mount(TerminalSurface, { props: { banner: "fallback" } })
  const terminal = terminals.at(-1)!
  const fit = fits.at(-1)!
  const image = imageAddons.at(-1)!
  expect(webglAddons).toHaveLength(initialWebgl)
  expect(imageAddons).toHaveLength(initialImages + 1)
  expect(terminal.open).toHaveBeenCalledWith(wrapper.element)
  expect(terminal.loadAddon).toHaveBeenCalledWith(fit)
  expect(terminal.loadAddon).toHaveBeenCalledWith(image)
  expect(terminal.write).toHaveBeenCalledWith("fallback")
  expect(wrapper.emitted("ready")).toEqual([[{ cols: 100, rows: 30 }]])
  wrapper.unmount()
  expect(image.dispose).toHaveBeenCalledOnce()
})

test("releases the WebGL context when loadAddon fails after constructing the addon", () => {
  webglFactory = () => {
    const addon = new FakeWebglAddon()
    const terminal = terminals.at(-1)!
    const loadAddon = terminal.loadAddon
    terminal.loadAddon = vi.fn((loaded) => {
      if (loaded === addon) throw new Error("activate failed")
      return loadAddon(loaded)
    })
    return addon
  }
  const wrapper = mount(TerminalSurface, { props: { banner: "partial" } })
  const addon = webglAddons.at(-1)!
  expect(addon.dispose).toHaveBeenCalledOnce()
  expect(addon.loseContext).toHaveBeenCalledOnce()
  expect(wrapper.emitted("ready")).toEqual([[{ cols: 100, rows: 30 }]])
  wrapper.unmount()
})

test("disposes the WebGL addon on context loss so the canvas renderer remains", () => {
  const wrapper = mount(TerminalSurface)
  const terminal = terminals.at(-1)!
  const webgl = webglAddons.at(-1)!
  expect(terminal.loadAddon).toHaveBeenCalledWith(webgl)
  webgl.lost()
  expect(webgl.dispose).toHaveBeenCalledOnce()
  expect(webgl.loseContext).toHaveBeenCalledOnce()
  wrapper.unmount()
  // Unmount must not release the already-dropped context a second time.
  expect(webgl.dispose).toHaveBeenCalledOnce()
  expect(webgl.loseContext).toHaveBeenCalledOnce()
})

test("releases each remounted surface's WebGL context so tab switches do not accumulate GPU slots", () => {
  const first = mount(TerminalSurface)
  const firstWebgl = webglAddons.at(-1)!
  const firstImage = imageAddons.at(-1)!
  first.unmount()
  expect(firstWebgl.dispose).toHaveBeenCalledOnce()
  expect(firstWebgl.loseContext).toHaveBeenCalledOnce()
  expect(firstImage.dispose).toHaveBeenCalledOnce()

  const second = mount(TerminalSurface)
  const secondWebgl = webglAddons.at(-1)!
  const secondImage = imageAddons.at(-1)!
  expect(secondWebgl).not.toBe(firstWebgl)
  expect(secondImage).not.toBe(firstImage)
  second.unmount()
  expect(secondWebgl.dispose).toHaveBeenCalledOnce()
  expect(secondWebgl.loseContext).toHaveBeenCalledOnce()
  expect(secondImage.dispose).toHaveBeenCalledOnce()
  expect(firstWebgl.loseContext).toHaveBeenCalledOnce()
  expect(firstImage.dispose).toHaveBeenCalledOnce()
})

test("loads the image addon after WebGL and disposes it on unmount", () => {
  const wrapper = mount(TerminalSurface)
  const terminal = terminals.at(-1)!
  const webgl = webglAddons.at(-1)!
  const image = imageAddons.at(-1)!
  const loaded = terminal.loadAddon.mock.calls.map(([addon]) => addon)
  expect(loaded.indexOf(webgl)).toBeGreaterThan(-1)
  expect(loaded.indexOf(image)).toBeGreaterThan(loaded.indexOf(webgl))
  expect(image.options.enableSizeReports).toBe(true)
  wrapper.unmount()
  expect(image.dispose).toHaveBeenCalledOnce()
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
