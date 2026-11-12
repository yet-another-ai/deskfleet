import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import type { IProgressState } from "@xterm/addon-progress"
import type { Terminal } from "@xterm/xterm"
import { defineComponent, h, nextTick, ref, shallowRef } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import TerminalToolbar from "./TerminalToolbar.vue"
import { useTerminalAddons } from "./useTerminalAddons.ts"

vi.mock("./useTerminalAddons.ts", () => ({ useTerminalAddons: vi.fn() }))

let wrapper: VueWrapper | undefined
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  await flushPromises()
})

function fixture(options?: { interactive?: boolean }) {
  const selection = { text: "", changed: () => {}, dispose: vi.fn() }
  const modes = { applicationCursorKeysMode: false }
  const input = vi.fn()
  const focus = vi.fn()
  const terminal = {
    modes,
    input,
    focus,
    hasSelection: () => Boolean(selection.text),
    getSelection: () => selection.text,
    onSelectionChange: (listener: () => void) => { selection.changed = listener; return { dispose: selection.dispose } },
  } as unknown as Terminal
  const addons = {
    progress: shallowRef<IProgressState>({ state: 0, value: 0 }),
    pendingClipboard: ref<string | null>(null),
    serialize: vi.fn((format: "ansi" | "html") => format === "html" ? "<html>styled output</html>" : "\x1b[31moutput\x1b[0m"),
    reset: vi.fn(),
  }
  vi.mocked(useTerminalAddons).mockReturnValue(addons)
  const search = { open: vi.fn(), reset: vi.fn() }
  const SearchStub = defineComponent({
    setup(_, { expose }) { expose(search); return () => h("div") },
  })
  const view = mount(TerminalToolbar, {
    attachTo: document.body,
    props: { terminal, interactive: options?.interactive ?? true },
    global: { plugins: [i18n], stubs: { TerminalSearch: SearchStub } },
  })
  wrapper = view
  const exposed = view.vm as InstanceType<typeof TerminalToolbar>
  return { view, exposed, selection, addons, search, input, focus, modes }
}

test("copies the current selection on click, reports a denied write, and clears the error on retry", async () => {
  const copy = vi.spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("Write denied"))
    .mockResolvedValueOnce()
  const { view, selection } = fixture()
  const button = view.get<HTMLButtonElement>('[aria-label="Copy selection"]')
  expect(button.element.disabled).toBe(true)
  selection.text = "selected terminal output"
  selection.changed()
  await nextTick()
  expect(button.element.disabled).toBe(false)
  expect(copy).not.toHaveBeenCalled()
  await button.trigger("click")
  await flushPromises()
  expect(copy).toHaveBeenLastCalledWith("selected terminal output")
  expect(view.get('[role="alert"]').text()).toBe("Could not copy. Try again.")
  await button.trigger("click")
  await flushPromises()
  expect(copy).toHaveBeenCalledTimes(2)
  expect(view.find('[role="alert"]').exists()).toBe(false)
  selection.text = ""
  selection.changed()
  await nextTick()
  expect(button.element.disabled).toBe(true)
  view.unmount()
  wrapper = undefined
  expect(selection.dispose).toHaveBeenCalledOnce()
})

test("lets the user copy or dismiss a program request and preserves a newer request during a pending copy", async () => {
  let complete!: () => void
  const copy = vi.spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("Write denied"))
    .mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
    .mockResolvedValue()
  const { view, addons } = fixture()
  addons.pendingClipboard.value = "program text"
  await nextTick()
  const request = () => view.get('[role="status"]')
  expect(request().text()).toContain("program text")
  expect(copy).not.toHaveBeenCalled()
  await request().get("button").trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Could not copy. Try again.")
  expect(addons.pendingClipboard.value).toBe("program text")
  await request().get("button").trigger("click")
  expect(copy).toHaveBeenLastCalledWith("program text")
  expect(addons.pendingClipboard.value).toBe("program text")
  addons.pendingClipboard.value = "new request"
  complete()
  await flushPromises()
  expect(addons.pendingClipboard.value).toBe("new request")
  await view.get('[aria-label="Dismiss copy request"]').trigger("click")
  expect(view.find('[role="status"]').exists()).toBe(false)
  expect(copy).toHaveBeenCalledTimes(2)
  addons.pendingClipboard.value = "confirmed copy"
  await nextTick()
  await request().get("button").trigger("click")
  await flushPromises()
  expect(copy).toHaveBeenLastCalledWith("confirmed copy")
  expect(view.find('[role="status"]').exists()).toBe(false)
})

test("shows progress percentage and state, leaving indeterminate progress without a numeric value", async () => {
  const { view, addons } = fixture()
  expect(view.find('[role="progressbar"]').exists()).toBe(false)
  for (const [state, label] of [[1, "Running · 42%"], [2, "Failed · 42%"], [4, "Paused · 42%"]] as const) {
    addons.progress.value = { state, value: 42 }
    await nextTick()
    expect(view.get('[role="progressbar"]').attributes("aria-label")).toBe(label)
    expect(view.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("42")
  }
  addons.progress.value = { state: 3, value: 42 }
  await nextTick()
  expect(view.get('[role="progressbar"]').attributes("aria-label")).toBe("Running…")
  expect(view.get('[role="progressbar"]').attributes("aria-valuenow")).toBeUndefined()
  addons.progress.value = { state: 0, value: 0 }
  await nextTick()
  expect(view.find('[role="progressbar"]').exists()).toBe(false)
})

test("downloads ANSI and HTML buffers and releases their URLs on replacement and teardown", async () => {
  const { view, addons } = fixture()
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:ansi").mockReturnValueOnce("blob:html")
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const downloads: { href: string; filename: string }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, filename: this.download })
  })
  for (const [format, label, type] of [["ansi", "Download ANSI transcript", "text/plain;charset=utf-8"], ["html", "Download styled HTML", "text/html;charset=utf-8"]] as const) {
    await view.get('[aria-label="Export terminal buffer"]').trigger("keydown", { key: "Enter" })
    await flushPromises()
    const page = new DOMWrapper(document.body)
    const item = page.findAll('[role="menuitem"]').find(item => item.text() === label)!
    expect(item).toBeDefined()
    await item.trigger("click")
    await flushPromises()
    expect(addons.serialize).toHaveBeenLastCalledWith(format)
    const blob = createUrl.mock.calls.at(-1)![0] as Blob
    expect(blob.type).toBe(type)
    expect(await blob.text()).toBe(format === "html" ? "<html>styled output</html>" : "\x1b[31moutput\x1b[0m")
    expect(page.find('[role="menu"]').exists()).toBe(false)
  }
  expect(downloads[0]!.href).toBe("blob:ansi")
  expect(downloads[0]!.filename).toMatch(/^terminal-.*\.ans$/)
  expect(downloads[1]!.href).toBe("blob:html")
  expect(downloads[1]!.filename).toMatch(/^terminal-.*\.html$/)
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:ansi")
  view.unmount()
  wrapper = undefined
  expect(revokeUrl).toHaveBeenNthCalledWith(2, "blob:html")
})

test("opens search from the toolbar button", async () => {
  const { view, search } = fixture()
  expect(search.open).not.toHaveBeenCalled()
  await view.get('[aria-label="Search terminal"]').trigger("click")
  expect(search.open).toHaveBeenCalledOnce()
})

test("toggles the terminal keypad, sends primary and expanded keys, and respects application cursor mode", async () => {
  const { view, input, focus, modes } = fixture()
  expect(view.find("[data-terminal-keypad]").exists()).toBe(false)
  const toggle = view.get('[data-terminal-keypad-toggle]')
  expect(toggle.attributes("aria-pressed")).toBe("false")

  await toggle.trigger("click")
  expect(toggle.attributes("aria-pressed")).toBe("true")
  expect(view.find("[data-terminal-keypad]").exists()).toBe(true)
  expect(focus).toHaveBeenCalledOnce()

  await view.get('[data-key="Escape"]').trigger("click")
  await view.get('[data-key="Tab"]').trigger("click")
  await view.get('[data-key="ArrowLeft"]').trigger("click")
  await view.get('[data-key="ArrowUp"]').trigger("click")
  expect(input.mock.calls.map(([seq]) => seq)).toEqual(["\x1b", "\t", "\x1b[D", "\x1b[A"])

  modes.applicationCursorKeysMode = true
  input.mockClear()
  await view.get('[data-key="ArrowDown"]').trigger("click")
  await view.get('[data-key="ArrowRight"]').trigger("click")
  expect(input.mock.calls.map(([seq]) => seq)).toEqual(["\x1bOB", "\x1bOC"])

  modes.applicationCursorKeysMode = false
  input.mockClear()
  expect(view.find("[data-terminal-keypad-expanded]").exists()).toBe(false)
  await view.get("[data-keypad-expand]").trigger("click")
  expect(view.find("[data-terminal-keypad-expanded]").exists()).toBe(true)

  for (const key of ["Home", "End", "PageUp", "PageDown", "|", "/", "-", "~", "_", "*", "F1", "F5", "F12"]) {
    await view.get(`[data-key="${key}"]`).trigger("click")
  }
  expect(input.mock.calls.map(([seq]) => seq)).toEqual([
    "\x1b[H", "\x1b[F", "\x1b[5~", "\x1b[6~",
    "|", "/", "-", "~", "_", "*",
    "\x1bOP", "\x1b[15~", "\x1b[24~",
  ])

  await view.setProps({ interactive: false })
  expect(view.find("[data-terminal-keypad]").exists()).toBe(false)
  expect(view.find("[data-terminal-keypad-toggle]").exists()).toBe(false)
})

test("arms and locks Ctrl and Alt modifiers for both virtual keys and soft-keyboard input", async () => {
  const { view, exposed, input } = fixture()
  await view.get("[data-terminal-keypad-toggle]").trigger("click")
  const ctrl = view.get('[data-modifier="ctrl"]')
  const alt = view.get('[data-modifier="alt"]')

  // One-shot (armed) Ctrl modifies the next soft-keyboard character and resets,
  // while leaving multi-character pastes, swipe words, and IME commits untouched.
  await ctrl.trigger("click")
  expect(ctrl.attributes("data-modifier-state")).toBe("armed")
  expect(exposed.transformInput("status")).toBe("status")
  expect(exposed.transformInput("中")).toBe("中")
  expect(exposed.transformInput("9")).toBe("9")
  await nextTick()
  expect(ctrl.attributes("data-modifier-state")).toBe("armed")
  expect(exposed.transformInput("c")).toBe("\x03")
  await nextTick()
  expect(ctrl.attributes("data-modifier-state")).toBe("off")
  expect(exposed.transformInput("c")).toBe("c")

  // Locked Ctrl stays active across multiple inputs until toggled off or reset.
  await ctrl.trigger("click")
  await ctrl.trigger("click")
  expect(ctrl.attributes("data-modifier-state")).toBe("locked")
  expect(exposed.transformInput("n")).toBe("\x0e")
  expect(exposed.transformInput("p")).toBe("\x10")
  await view.get('[data-key="ArrowLeft"]').trigger("click")
  expect(input).toHaveBeenLastCalledWith("\x1b[1;5D")
  expect(ctrl.attributes("data-modifier-state")).toBe("locked")
  await ctrl.trigger("click")
  expect(ctrl.attributes("data-modifier-state")).toBe("off")

  // Alt modifies word navigation arrows and soft-keyboard characters.
  await alt.trigger("click")
  expect(alt.attributes("data-modifier-state")).toBe("armed")
  await view.get('[data-key="ArrowLeft"]').trigger("click")
  expect(input).toHaveBeenLastCalledWith("\x1bb")
  expect(alt.attributes("data-modifier-state")).toBe("off")

  await alt.trigger("click")
  expect(exposed.transformInput("f")).toBe("\x1bf")
  await nextTick()
  expect(alt.attributes("data-modifier-state")).toBe("off")

  // Reset clears any armed/locked modifiers.
  await ctrl.trigger("click")
  await alt.trigger("click")
  exposed.reset()
  await nextTick()
  expect(ctrl.attributes("data-modifier-state")).toBe("off")
  expect(alt.attributes("data-modifier-state")).toBe("off")
})

test("repeats navigation keys when held down and stops on release", async () => {
  vi.useFakeTimers()
  try {
    const { view, input } = fixture()
    await view.get("[data-terminal-keypad-toggle]").trigger("click")
    const left = view.get('[data-key="ArrowLeft"]')

    await left.trigger("pointerdown", { button: 0 })
    vi.advanceTimersByTime(399)
    expect(input).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(input).toHaveBeenCalledTimes(1)
    expect(input).toHaveBeenLastCalledWith("\x1b[D")

    vi.advanceTimersByTime(130)
    expect(input).toHaveBeenCalledTimes(3)

    await left.trigger("pointerup")
    await left.trigger("click")
    vi.advanceTimersByTime(200)
    expect(input).toHaveBeenCalledTimes(3)
  } finally {
    vi.useRealTimers()
  }
})

test("opens the terminal keypad automatically on coarse-pointer touch devices while allowing manual toggle", async () => {
  const originalMatchMedia = window.matchMedia
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  try {
    const { view } = fixture()
    expect(view.find("[data-terminal-keypad]").exists()).toBe(true)
    const toggle = view.get("[data-terminal-keypad-toggle]")
    expect(toggle.attributes("aria-pressed")).toBe("true")

    await toggle.trigger("click")
    expect(view.find("[data-terminal-keypad]").exists()).toBe(false)
    expect(toggle.attributes("aria-pressed")).toBe("false")
  } finally {
    window.matchMedia = originalMatchMedia
  }
})


