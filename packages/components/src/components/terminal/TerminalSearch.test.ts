import { mount, type VueWrapper } from "@vue/test-utils"
import type { ISearchOptions, ISearchResultChangeEvent } from "@xterm/addon-search"
import { Terminal } from "@xterm/xterm"
import { markRaw, nextTick } from "vue"
import { createI18n } from "vue-i18n"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const addons: FakeSearchAddon[] = []
class FakeSearchAddon {
  findNext = vi.fn((_query: string, _options?: ISearchOptions) => true)
  findPrevious = vi.fn((_query: string, _options?: ISearchOptions) => true)
  clearDecorations = vi.fn()
  clearActiveDecoration = vi.fn()
  dispose = vi.fn()
  listener: (value: ISearchResultChangeEvent) => void = () => {}
  subscription = { dispose: vi.fn() }
  onDidChangeResults = vi.fn((listener: typeof this.listener) => {
    this.listener = listener
    return this.subscription
  })
  constructor() { addons.push(this) }
}
let addonFactory: () => object = () => new FakeSearchAddon()
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { constructor() { return addonFactory() } } }))
const { default: TerminalSearch } = await import("./TerminalSearch.vue")

let wrapper: VueWrapper<InstanceType<typeof TerminalSearch>> | undefined
let realTerminal: Terminal | undefined
beforeEach(() => { vi.useFakeTimers(); addons.length = 0; addonFactory = () => new FakeSearchAddon() })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; realTerminal?.dispose(); realTerminal = undefined; vi.useRealTimers() })

function render(selection = "") {
  const terminal = {
    loadAddon: vi.fn(),
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn(),
    focus: vi.fn(),
  }
  wrapper = mount(TerminalSearch, {
    props: { terminal: terminal as unknown as Terminal },
    attachTo: document.body,
    global: { plugins: [createI18n({
      legacy: false,
      locale: "en",
      messages: { en: { terminal: {
        searchLabel: "Find in terminal",
        searchPlaceholder: "Find in terminal",
        searchCaseSensitive: "Match case",
        searchWholeWord: "Match whole word",
        searchRegex: "Use regular expression",
        searchPrevious: "Previous match",
        searchNext: "Next match",
        searchClose: "Close search",
        searchNoResults: "No results",
        searchInvalidRegex: "Invalid regular expression",
        searchResults: "{index} of {count}",
        searchManyResults: "{count}+ matches",
      } } },
    })] },
  })
  return { view: wrapper, terminal }
}

test("opens search on demand, uses a single-line selection and reuses the addon", async () => {
  const { view, terminal } = render("warning")
  expect(view.find("[role=search]").exists()).toBe(false)
  expect(terminal.loadAddon).not.toHaveBeenCalled()

  await view.vm.open()
  const addon = addons[0]!
  expect(terminal.loadAddon).toHaveBeenCalledExactlyOnceWith(addon)
  expect(document.activeElement).toBe(view.get("input").element)
  expect((view.get("input").element as HTMLInputElement).value).toBe("warning")
  expect(addon.findNext).toHaveBeenCalledWith("warning", expect.objectContaining({ incremental: true, decorations: expect.any(Object) }))

  await view.get("button[aria-label='Close search']").trigger("click")
  expect(view.find("[role=search]").exists()).toBe(false)
  expect(addon.clearDecorations).toHaveBeenCalled()
  expect(terminal.focus).toHaveBeenCalledOnce()
  await view.vm.open()
  expect(addons).toHaveLength(1)
  expect(terminal.loadAddon).toHaveBeenCalledOnce()
})

test("debounces typing, applies search modes, and displays live result counts", async () => {
  const { view } = render()
  await view.vm.open()
  const addon = addons[0]!
  await view.get("input").setValue("warn")
  await view.get("input").setValue("warning")
  await view.get("button[aria-label='Match case']").trigger("click")
  await view.get("button[aria-label='Match whole word']").trigger("click")
  await view.get("button[aria-label='Use regular expression']").trigger("click")
  expect(addon.findNext).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(120)
  expect(addon.findNext).toHaveBeenCalledExactlyOnceWith("warning", expect.objectContaining({ caseSensitive: true, wholeWord: true, regex: true, incremental: true }))
  expect(view.get("button[aria-label='Match case']").attributes("aria-pressed")).toBe("true")
  addon.listener({ resultIndex: 1, resultCount: 4 })
  await nextTick()
  expect(view.get("[role=status]").text()).toBe("2 of 4")
  addon.listener({ resultIndex: -1, resultCount: 1000 })
  await nextTick()
  expect(view.get("[role=status]").text()).toBe("1000+ matches")
  addon.listener({ resultIndex: -1, resultCount: 0 })
  await nextTick()
  expect(view.get("[role=status]").text()).toBe("No results")
})

test("recomputes real addon matches when modes change without changing the query", async () => {
  const { SearchAddon } = await vi.importActual<typeof import("@xterm/addon-search")>("@xterm/addon-search")
  addonFactory = () => new SearchAddon()
  realTerminal = markRaw(new Terminal({ allowProposedApi: true, cols: 50, rows: 5 }))
  // Exercise the real buffer and decoration API; selecting needs a rendered terminal.
  realTerminal.select = vi.fn()
  const written = new Promise<void>(resolve => realTerminal!.write("Foo foo food f.o", resolve))
  await vi.advanceTimersByTimeAsync(1)
  await written
  const { view } = render()
  await view.setProps({ terminal: realTerminal })
  await view.vm.open()
  await view.get("input").setValue("foo")
  await vi.advanceTimersByTimeAsync(120)
  expect(view.get("[role=status]").text()).toBe("1 of 3")

  await view.get("button[aria-label='Match case']").trigger("click")
  await vi.advanceTimersByTimeAsync(120)
  expect(view.get("[role=status]").text()).toBe("1 of 2")
  await view.get("button[aria-label='Match whole word']").trigger("click")
  await vi.advanceTimersByTimeAsync(120)
  expect(view.get("[role=status]").text()).toBe("1 of 1")

  await view.get("input").setValue("f.o")
  await view.get("button[aria-label='Match whole word']").trigger("click")
  await vi.advanceTimersByTimeAsync(120)
  expect(view.get("[role=status]").text()).toBe("1 of 1")
  await view.get("button[aria-label='Use regular expression']").trigger("click")
  await vi.advanceTimersByTimeAsync(120)
  expect(view.get("[role=status]").text()).toBe("1 of 3")
})

test.each([false, true])("whole-word navigation skips invalid substrings on the same line (regex: %s)", async regex => {
  const { SearchAddon } = await vi.importActual<typeof import("@xterm/addon-search")>("@xterm/addon-search")
  addonFactory = () => new SearchAddon()
  realTerminal = markRaw(new Terminal({ allowProposedApi: true, cols: 50, rows: 5 }))
  let selected: ReturnType<Terminal["getSelectionPosition"]>
  const select = vi.fn((column: number, row: number, length: number) => {
    selected = { start: { x: column, y: row }, end: { x: column + length, y: row } }
  })
  // Keep selection state without requiring the canvas/DOM renderer in this buffer-level test.
  realTerminal.select = select
  realTerminal.getSelectionPosition = () => selected
  realTerminal.clearSelection = () => { selected = undefined }
  const written = new Promise<void>(resolve => realTerminal!.write("中 food foo foobar\r\nfood foo foobar", resolve))
  await vi.advanceTimersByTimeAsync(1)
  await written
  const { view } = render()
  await view.setProps({ terminal: realTerminal })
  await view.vm.open()
  await view.get("input").setValue(regex ? "f.o" : "foo")
  await view.get("button[aria-label='Match whole word']").trigger("click")
  if (regex) await view.get("button[aria-label='Use regular expression']").trigger("click")
  await vi.advanceTimersByTimeAsync(120)
  expect(view.get("[role=status]").text()).toBe("1 of 2")
  expect(select).toHaveBeenLastCalledWith(8, 0, 3)
  await view.get("button[aria-label='Next match']").trigger("click")
  expect(view.get("[role=status]").text()).toBe("2 of 2")
  expect(select).toHaveBeenLastCalledWith(5, 1, 3)
  await view.get("button[aria-label='Next match']").trigger("click")
  expect(select).toHaveBeenLastCalledWith(8, 0, 3)
  await view.get("button[aria-label='Previous match']").trigger("click")
  expect(select).toHaveBeenLastCalledWith(5, 1, 3)
  await view.get("button[aria-label='Previous match']").trigger("click")
  expect(select).toHaveBeenLastCalledWith(8, 0, 3)
})

test("navigates with buttons and scoped Enter keys without sending them to the terminal", async () => {
  const { view } = render("needle")
  await view.vm.open()
  const addon = addons[0]!
  addon.findNext.mockClear()
  await view.get("input").trigger("keydown", { key: "Enter" })
  await view.get("input").trigger("keydown", { key: "Enter", shiftKey: true })
  await view.get("button[aria-label='Next match']").trigger("click")
  await view.get("button[aria-label='Previous match']").trigger("click")
  expect(addon.findNext).toHaveBeenCalledTimes(2)
  expect(addon.findPrevious).toHaveBeenCalledTimes(2)
  expect(addon.findNext).toHaveBeenLastCalledWith("needle", expect.objectContaining({ incremental: false }))
  await view.get("input").trigger("keydown", { key: "Enter", isComposing: true })
  expect(addon.findNext).toHaveBeenCalledTimes(2)
})

test("invalid regex clears stale highlights and can be corrected without closing search", async () => {
  const { view } = render("needle")
  await view.vm.open()
  const addon = addons[0]!
  await view.get("button[aria-label='Use regular expression']").trigger("click")
  await view.get("input").setValue("[")
  addon.findNext.mockClear()
  await vi.advanceTimersByTimeAsync(120)
  expect(addon.findNext).not.toHaveBeenCalled()
  expect(addon.clearDecorations).toHaveBeenCalled()
  expect(view.get("input").attributes("aria-invalid")).toBe("true")
  expect(view.get("[role=status]").text()).toBe("Invalid regular expression")
  expect(view.get("button[aria-label='Next match']").attributes("disabled")).toBeDefined()
  await view.get("input").setValue("[ab]")
  await vi.advanceTimersByTimeAsync(120)
  expect(view.get("input").attributes("aria-invalid")).toBeUndefined()
  expect(addon.findNext).toHaveBeenCalledExactlyOnceWith("[ab]", expect.objectContaining({ regex: true }))
})

test("history reset and closing cancel pending searches and clear matches", async () => {
  const { view, terminal } = render("first\nsecond")
  await view.vm.open()
  expect((view.get("input").element as HTMLInputElement).value).toBe("")
  const addon = addons[0]!
  await view.get("input").setValue("queued")
  view.vm.reset()
  await vi.advanceTimersByTimeAsync(120)
  expect(addon.findNext).not.toHaveBeenCalled()
  expect(terminal.focus).not.toHaveBeenCalled()
  expect(view.get("[role=status]").text()).toBe("")
  expect((view.get("input").element as HTMLInputElement).value).toBe("")

  await view.get("input").setValue("cancelled")
  await view.get("input").trigger("keydown", { key: "Escape" })
  await vi.advanceTimersByTimeAsync(120)
  expect(addon.findNext).not.toHaveBeenCalled()
  expect(view.find("[role=search]").exists()).toBe(false)
  expect(terminal.focus).toHaveBeenCalledOnce()
})

test("unmount releases the search subscription and addon and cancels delayed work", async () => {
  const { view } = render()
  await view.vm.open()
  const addon = addons[0]!
  await view.get("input").setValue("pending")
  view.unmount()
  wrapper = undefined
  await vi.advanceTimersByTimeAsync(120)
  expect(addon.findNext).not.toHaveBeenCalled()
  expect(addon.subscription.dispose).toHaveBeenCalledOnce()
  expect(addon.dispose).toHaveBeenCalledOnce()
})
