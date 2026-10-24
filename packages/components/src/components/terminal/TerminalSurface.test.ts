import { mount } from "@vue/test-utils"
import { expect, test, vi } from "vitest"

const terminals: FakeTerminal[] = []
const fits: { fit: ReturnType<typeof vi.fn> }[] = []

class FakeTerminal {
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
  open = vi.fn()
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

const { default: TerminalSurface } = await import("./TerminalSurface.vue")

test("opens a read-only xterm.js terminal that fits its container", () => {
  const wrapper = mount(TerminalSurface, { props: { banner: "first\nsecond" } })
  const [terminal] = terminals
  const [fit] = fits

  // Input stays disabled until a session transport exists.
  expect(terminal!.options.disableStdin).toBe(true)
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
