import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { defineComponent, onMounted } from "vue"
import { expect, test, vi } from "vitest"
import type { TerminalSummary } from "../../../../../apps/daemon/src/terminal-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import type { TerminalListener } from "../../services/terminal-client.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import { deferred } from "../../test/desktop-media.ts"
import LiveTerminal from "./LiveTerminal.vue"

function setup(readOnly = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const terminals = useTerminalsStore()
  const pending = deferred<TerminalSummary>()
  const detach = vi.fn()
  let listener: TerminalListener = () => {}
  vi.spyOn(terminals, "attach").mockImplementation((_id, receive) => {
    listener = receive
    return { ready: pending.promise, detach }
  })
  vi.spyOn(terminals, "resize").mockResolvedValue(null)
  vi.spyOn(terminals, "input").mockResolvedValue()
  vi.spyOn(terminals, "hangup").mockResolvedValue()
  const write = vi.fn<(data: Uint8Array, consumed: () => void) => void>()
  const reset = vi.fn()
  const focus = vi.fn()
  const surface = defineComponent({
    name: "TerminalSurface",
    props: ["interactive"],
    emits: ["ready", "input", "resize", "title"],
    setup(_props, { emit, expose }) {
      expose({ write, reset, focus, title: (value: string) => emit("title", value) })
      onMounted(() => emit("ready", { cols: 100, rows: 30 }))
    },
    template: '<div data-surface :data-interactive="interactive" />',
  })
  const wrapper = mount(LiveTerminal, {
    props: { terminalId: "terminal-1", readOnly },
    global: { plugins: [pinia, i18n], stubs: { TerminalSurface: surface } },
  })
  const resolve = (status: TerminalSummary["status"] = "running") => pending.resolve({ id: "terminal-1", title: "zsh", cwd: "/home/user", cols: 80, rows: 24, status })
  const connection = () => wrapper.emitted("connection")?.at(-1)
  return { wrapper, terminals, detach, write, reset, focus, resolve, connection, emit: (...args: Parameters<TerminalListener>) => listener(...args) }
}

test("renders byte output and acknowledges only when xterm consumed it; leaving detaches the running shell", async () => {
  const fixture = setup()
  await flushPromises()
  expect(fixture.connection()).toEqual(["connecting", "Connecting…"])
  fixture.resolve()
  await flushPromises()
  expect(fixture.wrapper.get("[data-surface]").attributes("data-interactive")).toBe("false")
  expect(fixture.connection()).toEqual(["replaying", "Restoring terminal history…"])
  expect(fixture.terminals.resize).not.toHaveBeenCalled()
  fixture.emit({ kind: "ready", sessionId: "terminal-1" }, () => {})
  await flushPromises()
  expect(fixture.terminals.resize).toHaveBeenCalledWith("terminal-1", 100, 30)
  expect(fixture.wrapper.get("[data-surface]").attributes("data-interactive")).toBe("true")
  expect(fixture.connection()?.[0]).toBe("connected")
  fixture.emit({ kind: "reset", sessionId: "terminal-1" }, () => {})
  expect(fixture.reset).toHaveBeenCalledOnce()
  const acknowledge = vi.fn()
  fixture.emit({ kind: "output", sessionId: "terminal-1", data: "aGk=", offset: 2 }, acknowledge)
  expect(fixture.write.mock.calls[0]![0]).toEqual(new Uint8Array([104, 105]))
  expect(acknowledge).not.toHaveBeenCalled()
  fixture.write.mock.calls[0]![1]()
  expect(acknowledge).toHaveBeenCalledOnce()
  fixture.wrapper.unmount()
  expect(fixture.detach).toHaveBeenCalledOnce()
  expect(fixture.terminals.hangup).not.toHaveBeenCalled()
})

test("a transport error disables input and is reported as the connection state", async () => {
  const fixture = setup()
  fixture.resolve()
  await flushPromises()
  fixture.emit({ kind: "ready", sessionId: "terminal-1" }, () => {})
  fixture.emit({ kind: "error", sessionId: "terminal-1", error: "Peer disconnected" }, () => {})
  await flushPromises()
  expect(fixture.wrapper.get("[data-surface]").attributes("data-interactive")).toBe("false")
  expect(fixture.connection()).toEqual(["error", "Peer disconnected"])
  fixture.wrapper.unmount()
})

test("an archived context replays retained output without resizing or accepting input", async () => {
  const fixture = setup(true)
  fixture.resolve("interrupted")
  await flushPromises()
  fixture.emit({ kind: "output", sessionId: "terminal-1", data: "aGk=", offset: 2 }, () => {})
  fixture.emit({ kind: "ready", sessionId: "terminal-1" }, () => {})
  await flushPromises()
  fixture.wrapper.getComponent({ name: "TerminalSurface" }).vm.$emit("input", "blocked")
  expect(fixture.write).toHaveBeenCalled()
  expect(fixture.terminals.resize).not.toHaveBeenCalled()
  expect(fixture.terminals.input).not.toHaveBeenCalled()
  expect(fixture.wrapper.get("[data-surface]").attributes("data-interactive")).toBe("false")
  fixture.wrapper.unmount()
})

test("an unknown exit code stays unknown and interrupted history is read-only", async () => {
  const ended = setup()
  ended.resolve()
  await flushPromises()
  ended.emit({ kind: "ready", sessionId: "terminal-1" }, () => {})
  ended.emit({ kind: "exit", sessionId: "terminal-1" }, () => {})
  await flushPromises()
  expect(ended.connection()).toEqual(["ended", "Process ended"])
  ended.wrapper.unmount()
  const interrupted = setup()
  interrupted.resolve("interrupted")
  await flushPromises()
  interrupted.emit({ kind: "ready", sessionId: "terminal-1" }, () => {})
  await flushPromises()
  expect(interrupted.connection()?.[0]).toBe("ended")
  expect(interrupted.connection()?.[1]).toContain("Shell interrupted")
  expect(interrupted.wrapper.get("[data-surface]").attributes("data-interactive")).toBe("false")
  expect(interrupted.terminals.resize).not.toHaveBeenCalled()
  interrupted.wrapper.unmount()
})

test("the title the running program sets is passed to the tab", async () => {
  const fixture = setup()
  await flushPromises()
  await fixture.wrapper.getComponent({ name: "TerminalSurface" }).vm.$emit("title", "vim README.md")
  expect(fixture.wrapper.emitted("title")).toEqual([["vim README.md"]])
  fixture.wrapper.unmount()
})

test("a late attachment response does not resize or focus a terminal after its view has left", async () => {
  const fixture = setup()
  fixture.wrapper.unmount()
  fixture.resolve()
  await flushPromises()
  expect(fixture.detach).toHaveBeenCalledOnce()
  expect(fixture.terminals.resize).not.toHaveBeenCalled()
  expect(fixture.focus).not.toHaveBeenCalled()
})

test("reports its connection in the supported Chinese locale", async () => {
  const previousLocale = i18n.global.locale.value
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  try {
    const fixture = setup()
    try {
      await flushPromises()
      expect(fixture.connection()).toEqual(["connecting", "连接中…"])
      expect(fixture.wrapper.find("[data-surface]").exists()).toBe(true)
    } finally { fixture.wrapper.unmount() }
  } finally { i18n.global.locale.value = previousLocale }
})

test("an exit delivered before attachment completes is not overwritten by a stale running summary", async () => {
  const fixture = setup()
  await flushPromises()
  fixture.emit({ kind: "exit", sessionId: "terminal-1", exitCode: 0 }, () => {})
  fixture.resolve()
  fixture.emit({ kind: "ready", sessionId: "terminal-1" }, () => {})
  await flushPromises()
  expect(fixture.connection()).toEqual(["ended", "Process exited (0)"])
  expect(fixture.wrapper.get("[data-surface]").attributes("data-interactive")).toBe("false")
  fixture.wrapper.unmount()
})
