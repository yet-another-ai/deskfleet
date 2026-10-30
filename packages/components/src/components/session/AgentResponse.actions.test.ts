import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import type { ConversationResponse } from "../../services/agent-conversation.ts"
import AgentResponse from "./AgentResponse.vue"

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })
const global = { plugins: [i18n], stubs: { AgentContent: true } }

function response(): ConversationResponse {
  return {
    id: "response-1", kind: "response", turnId: "70", live: false, last: true,
    turn: { id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "completed", startedAt: "2026-10-30T12:00:00Z" },
    steps: [
      { id: "thought", kind: "message", role: "thought", content: [{ type: "text", text: "Private reasoning" }] },
      { id: "progress", kind: "message", role: "assistant", content: [{ type: "text", text: "Checking the files" }] },
      { id: "tool", kind: "tool", tool: { toolCallId: "read", title: "Read file", rawOutput: "Tool output" } },
      { id: "answer", kind: "message", role: "assistant", content: [
        { type: "text", text: "Fixed **the bug**.\n\n```ts\nconst count = 1\n```" },
        { type: "image", mimeType: "image/png", data: "image" },
        { type: "resource", resource: { uri: "deskfleet://pasted-text/result.txt", text: "Result details" } },
      ] },
    ],
  }
}

test("the Agent footer copies its final answer as source text without folded work or tool output", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
  wrapper = mount(AgentResponse, { props: { response: response() }, global })
  await wrapper.get('[aria-label="Copy message"]').trigger("click")
  await flushPromises()
  expect(writeText).toHaveBeenCalledExactlyOnceWith("Fixed **the bug**.\n\n```ts\nconst count = 1\n```\n\nResult details")
  expect(wrapper.find('[aria-label="Copied"]').exists()).toBe(true)
})

test("copy failure is visible and retrying can succeed while Session actions are disabled", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Denied")).mockResolvedValueOnce()
  wrapper = mount(AgentResponse, { props: { response: response(), disabled: true, canFork: true }, global })
  await wrapper.get('[aria-label="Copy message"]').trigger("click")
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe("Could not copy the message. Try again.")
  expect(wrapper.find('[aria-label="Copied"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Copy message"]').trigger("click")
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="Copied"]').exists()).toBe(true)
  await wrapper.get('[aria-label="Fork session"]').trigger("click")
  expect(wrapper.emitted("fork")).toBeUndefined()
})

test("fork is available only when enabled and a response has finished streaming", async () => {
  const current = response()
  wrapper = mount(AgentResponse, { props: { response: { ...current, live: true }, canFork: true }, global })
  expect(wrapper.find('[aria-label="Copy message"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="Fork session"]').exists()).toBe(false)
  await wrapper.setProps({ response: current })
  await wrapper.get('[aria-label="Fork session"]').trigger("click")
  expect(wrapper.emitted("fork")).toEqual([[]])
  await wrapper.setProps({ forkDisabled: true })
  await wrapper.get('[aria-label="Fork session"]').trigger("click")
  expect(wrapper.emitted("fork")).toHaveLength(1)
  await wrapper.setProps({ canFork: false })
  expect(wrapper.find('[aria-label="Fork session"]').exists()).toBe(false)
})

test("a response with only thoughts and tools offers no copy action", () => {
  const current = response()
  current.steps = current.steps.filter(step => step.kind !== "message" || step.role === "thought")
  wrapper = mount(AgentResponse, { props: { response: current, canFork: true }, global })
  expect(wrapper.find('[aria-label="Copy message"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="Fork session"]').exists()).toBe(true)
})
