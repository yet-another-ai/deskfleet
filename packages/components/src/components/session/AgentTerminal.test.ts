import { Bot } from "@lucide/vue"
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent } from "vue"
import { expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import type { AgentTerminalOutput } from "../../services/agent-conversation.ts"
import AgentTerminal from "./AgentTerminal.vue"
import AgentToolCall from "./AgentToolCall.vue"

const liveTerminal = {
  name: "LiveTerminal", props: { terminalId: String, readOnly: Boolean, independent: Boolean }, emits: ["connection", "title"], template: '<div data-terminal />',
}

test("agent output has a distinct icon, read-only viewer, status and reconnect without a process control", async () => {
  const wrapper = mount(AgentTerminal, { props: { terminalId: "command-1" }, global: { plugins: [i18n], stubs: { LiveTerminal: liveTerminal } } })
  const live = () => wrapper.getComponent({ name: "LiveTerminal" })
  expect(wrapper.findComponent(Bot).exists()).toBe(true)
  expect(wrapper.text()).toContain("Read only")
  expect(live().props()).toEqual({ terminalId: "command-1", readOnly: true, independent: true })
  live().vm.$emit("connection", "ended", "Process exited (0)")
  await flushPromises()
  expect(wrapper.get('[role="status"]').text()).toBe("Process exited (0)")
  expect(wrapper.find("button").exists()).toBe(false)
  const mounted = live().vm
  live().vm.$emit("connection", "error", "Peer disconnected")
  await flushPromises()
  await wrapper.get('[aria-label="Reconnect"]').trigger("click")
  expect(live().vm).not.toBe(mounted)
  wrapper.unmount()
})

test("terminal tool content renders an agent terminal viewer instead of a JSON block", async () => {
  const wrapper = mount(AgentToolCall, {
    props: { tool: { toolCallId: "tool-1", title: "Run checks", kind: "execute", content: [{ type: "terminal", terminalId: "command-1" }] } },
    global: { plugins: [i18n], stubs: { AgentTerminal: { name: "AgentTerminal", props: ["terminalId"], template: '<div data-agent-terminal :data-id="terminalId" />' } } },
  })
  expect(wrapper.findComponent(Bot).exists()).toBe(true)
  await wrapper.get("button").trigger("click")
  await flushPromises()
  expect(wrapper.get("[data-agent-terminal]").attributes("data-id")).toBe("command-1")
  expect(wrapper.find("pre").exists()).toBe(false)
  wrapper.unmount()
})

test("provider output replays and streams without connecting to a daemon terminal", async () => {
  const write = vi.fn()
  const reset = vi.fn()
  const surface = defineComponent({
    name: "TerminalSurface", props: { interactive: Boolean, convertEol: Boolean },
    setup(_props, { expose }) { expose({ write, reset }) },
    template: '<div data-recorded-terminal />',
  })
  const output: AgentTerminalOutput = { terminalId: "codex-call", output: "检查\n", status: "running" }
  const options = {
    props: { terminalId: output.terminalId, output, live: true },
    global: { plugins: [i18n], stubs: { LiveTerminal: liveTerminal, TerminalSurface: surface } },
  }
  const wrapper = mount(AgentTerminal, options)
  await flushPromises()
  expect(wrapper.findComponent({ name: "LiveTerminal" }).exists()).toBe(false)
  expect(wrapper.getComponent({ name: "TerminalSurface" }).props()).toEqual({ interactive: false, convertEol: true })
  expect(write).toHaveBeenCalledExactlyOnceWith(new TextEncoder().encode("检查\n"))
  expect(wrapper.get('[role="status"]').text()).toBe("Connected")
  await wrapper.setProps({ output: { ...output, output: "检查\npassed\n" } })
  expect(write).toHaveBeenLastCalledWith(new TextEncoder().encode("passed\n"))
  await wrapper.setProps({ output: { ...output, output: "检查\npassed\n", status: "exited", exitCode: 0 }, live: false })
  expect(write).toHaveBeenCalledTimes(2)
  expect(reset).not.toHaveBeenCalled()
  expect(wrapper.get('[role="status"]').text()).toBe("Process exited (0)")
  expect(wrapper.find("button").exists()).toBe(false)
  wrapper.unmount()

  write.mockClear()
  const reopened = mount(AgentTerminal, options)
  await flushPromises()
  expect(write).toHaveBeenCalledExactlyOnceWith(new TextEncoder().encode("检查\n"))
  await reopened.setProps({ output: { ...output, output: "replacement\n" } })
  expect(reset).toHaveBeenCalledOnce()
  expect(write).toHaveBeenLastCalledWith(new TextEncoder().encode("replacement\n"))
  await reopened.setProps({ live: false })
  expect(reopened.get('[role="status"]').attributes("data-connection")).toBe("ended")
  await reopened.setProps({ output: { ...output, status: "exited", exitCode: null } })
  expect(reopened.get('[role="status"]').text()).toBe("Process ended")
  reopened.unmount()
})

test("tool calls pass their own recorded output to the terminal viewer", async () => {
  const output: AgentTerminalOutput = { terminalId: "codex-call", output: "saved output", status: "exited", exitCode: 7 }
  const wrapper = mount(AgentToolCall, {
    props: { tool: { toolCallId: "tool-1", title: "Run checks", kind: "execute", content: [{ type: "terminal", terminalId: output.terminalId }], terminals: { [output.terminalId]: output } }, live: false },
    global: { plugins: [i18n], stubs: { AgentTerminal: { name: "AgentTerminal", props: ["terminalId", "output", "live"], template: '<div data-agent-terminal />' } } },
  })
  await wrapper.get("button").trigger("click")
  await flushPromises()
  expect(wrapper.getComponent({ name: "AgentTerminal" }).props()).toEqual({ terminalId: output.terminalId, output, live: false })
  wrapper.unmount()
})
