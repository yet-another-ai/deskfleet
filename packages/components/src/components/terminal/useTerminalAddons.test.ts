import { mount } from "@vue/test-utils"
import { Terminal } from "@xterm/xterm"
import { defineComponent, h, onBeforeUnmount, ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { useTerminalAddons } from "./useTerminalAddons.ts"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture() {
  const terminal = new Terminal({ allowProposedApi: true, cols: 30, rows: 5 })
  const interactive = ref(false)
  let addons!: ReturnType<typeof useTerminalAddons>
  const wrapper = mount(defineComponent({
    setup() {
      addons = useTerminalAddons(terminal, () => interactive.value)
      onBeforeUnmount(() => terminal.dispose())
      return () => h("div")
    },
  }))
  cleanups.push(() => wrapper.unmount())
  return {
    terminal,
    interactive,
    addons,
    write: (value: string) => new Promise<void>(resolve => terminal.write(value, resolve)),
  }
}

test("stages live OSC 52 copies for a local click without reading or writing the clipboard", async () => {
  const { terminal, interactive, addons, write } = fixture()
  const read = vi.spyOn(navigator.clipboard, "readText")
  const copy = vi.spyOn(navigator.clipboard, "writeText")
  const input = vi.fn()
  terminal.onData(input)

  // Initial replay is read-only, even if its transcript contains copy commands.
  await write("\x1b]52;c;aGVsbG8=\x07")
  expect(addons.pendingClipboard.value).toBeNull()
  interactive.value = true
  await write("\x1b]52;c;aGVsbG8=\x07")
  expect(addons.pendingClipboard.value).toBe("hello")
  await write("\x1b]52;c;?\x07")
  expect(input).toHaveBeenLastCalledWith("\x1b]52;c;\x07")
  expect(read).not.toHaveBeenCalled()
  expect(copy).not.toHaveBeenCalled()

  interactive.value = false
  expect(addons.pendingClipboard.value).toBeNull()
  await write("\x1b]52;c;aGVsbG8=\x07")
  expect(addons.pendingClipboard.value).toBeNull()
})

test("resets progress and pending copies before history is replayed again", async () => {
  const { addons, interactive, write } = fixture()
  interactive.value = true
  await write("\x1b]9;4;1;42\x07\x1b]52;c;aGVsbG8=\x07")
  expect(addons.progress.value).toEqual({ state: 1, value: 42 })
  expect(addons.pendingClipboard.value).toBe("hello")
  addons.reset()
  expect(addons.progress.value).toEqual({ state: 0, value: 0 })
  expect(addons.pendingClipboard.value).toBeNull()
  await write("\x1b]9;4;3\x07")
  expect(addons.progress.value.state).toBe(3)
})

test("exports styled terminal content without restoring terminal input modes", async () => {
  const { addons, write } = fixture()
  await write("\x1b[?2004h\x1b[31merror <example> 你好\x1b[0m")
  const ansi = addons.serialize("ansi")
  expect(ansi).toContain("error <example>")
  expect(ansi).toContain("\x1b[31m")
  expect(ansi).not.toContain("\x1b[?2004h")
  const html = addons.serialize("html")
  const document = new DOMParser().parseFromString(html, "text/html")
  expect(document.body.textContent).toContain("error <example> 你好")
  expect(document.querySelector("meta")?.getAttribute("charset")).toBe("utf-8")
  expect(html).toContain("<html>")
})

test("uses Unicode 11 widths and opens only HTTP(S) links without an opener", () => {
  const { terminal } = fixture()
  expect(terminal.unicode.activeVersion).toBe("11")
  const open = vi.spyOn(window, "open").mockReturnValue(null)
  const activate = terminal.options.linkHandler!.activate
  const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }
  for (const uri of ["javascript:alert(1)", "file:///tmp/example", "data:text/html,test", "./relative"]) {
    activate(new MouseEvent("click"), uri, range)
  }
  expect(open).not.toHaveBeenCalled()
  activate(new MouseEvent("click"), "https://example.com/path", range)
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/path", "_blank", "noopener,noreferrer")
})
