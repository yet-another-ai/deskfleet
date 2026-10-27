import { Bot } from "@lucide/vue"
import { flushPromises, mount } from "@vue/test-utils"
import { expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
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
