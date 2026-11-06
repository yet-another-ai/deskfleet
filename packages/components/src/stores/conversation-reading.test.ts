import { mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { expect, test } from "vitest"
import { i18n } from "../i18n/index.ts"
import AgentToolCall from "../components/session/AgentToolCall.vue"
import { conversationReadingKey, useConversationReadingStore } from "./conversation-reading.ts"

test("tool disclosure choices survive unmounts and remain isolated by Session and journal entry", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const reading = useConversationReadingStore()
  const mountTool = (sessionId: string, disclosureId = "entry-1") => mount(AgentToolCall, {
    props: { disclosureId, tool: { toolCallId: "reused-provider-id", title: "Read file", rawInput: { path: "test.ts" } } },
    global: { plugins: [pinia, i18n], provide: { [conversationReadingKey as symbol]: () => reading.session(sessionId) } },
  })
  let wrapper = mountTool("a")
  try {
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("false")
    await wrapper.get("button").trigger("click")
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("true")
    wrapper.unmount()
    wrapper = mountTool("b")
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("false")
    wrapper.unmount()
    wrapper = mountTool("a")
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("true")
    wrapper.unmount()
    wrapper = mountTool("a", "entry-2")
    expect(wrapper.get("button").attributes("aria-expanded")).toBe("false")
  } finally { wrapper.unmount(); disposePinia(pinia) }
})
