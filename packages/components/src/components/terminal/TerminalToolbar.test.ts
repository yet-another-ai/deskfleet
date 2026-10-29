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

function fixture() {
  const selection = { text: "", changed: () => {}, dispose: vi.fn() }
  const terminal = {
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
  wrapper = mount(TerminalToolbar, {
    attachTo: document.body,
    props: { terminal, interactive: true },
    global: { plugins: [i18n], stubs: { TerminalSearch: SearchStub } },
  })
  return { view: wrapper, selection, addons, search }
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
