import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { agentInput } from "../../test/agent.ts"
import AgentUserMessage from "./AgentUserMessage.vue"

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test("copy writes all message text and shows confirmation only after it succeeds", async () => {
  vi.useFakeTimers()
  let complete!: () => void
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
  wrapper = mount(AgentUserMessage, {
    props: { input: agentInput({ content: [
      { type: "text", text: "First paragraph" },
      { type: "image", mimeType: "image/png", data: "image" },
      { type: "text", text: "Second paragraph" },
    ] }) },
    global: { plugins: [i18n] },
  })
  await wrapper.get('[aria-label="Copy message"]').trigger("click")
  expect(writeText).toHaveBeenCalledExactlyOnceWith("First paragraph\n\nSecond paragraph")
  expect(wrapper.find('[aria-label="Copied"]').exists()).toBe(false)
  complete()
  await flushPromises()
  expect(wrapper.find('[aria-label="Copied"]').exists()).toBe(true)
  await vi.advanceTimersByTimeAsync(1500)
  expect(wrapper.find('[aria-label="Copy message"]').exists()).toBe(true)
})

test("a denied clipboard write shows an error and a successful retry clears it", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("Write permission denied"))
    .mockResolvedValueOnce()
  wrapper = mount(AgentUserMessage, { props: { input: agentInput() }, global: { plugins: [i18n] } })
  await wrapper.get('[aria-label="Copy message"]').trigger("click")
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe("Could not copy the message. Try again.")
  expect(wrapper.find('[aria-label="Copied"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Copy message"]').trigger("click")
  await flushPromises()
  expect(writeText).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.find('[aria-label="Copied"]').exists()).toBe(true)
})
