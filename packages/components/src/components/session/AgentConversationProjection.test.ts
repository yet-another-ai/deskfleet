import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { defineComponent, h, nextTick, ref } from "vue"
import { expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import * as projectors from "../../services/conversation-projector.ts"
import { useConversationProjection } from "../../composables/useConversationProjection.ts"
import { agentEvent, agentInput, agentSnapshot } from "../../test/agent.ts"
import AgentConversation from "./AgentConversation.vue"
import AgentOutline from "./AgentOutline.vue"
import AgentResponse from "./AgentResponse.vue"

test("conversation and outline share one incremental projection and update together after appended events", async () => {
  const project = vi.fn(projectors.createConversationProjector())
  const factory = vi.spyOn(projectors, "createConversationProjector").mockReturnValue(project)
  const input = agentInput({ state: "delivered", content: [{ type: "text", text: "First question" }] })
  const snapshot = ref({ ...agentSnapshot(), inputs: [input] })
  const events = ref([
    agentEvent(1, "input", input),
    agentEvent(2, "acp", { sessionId: "provider", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First answer" } } }),
  ])
  const view = mount(defineComponent({
    setup() {
      const projection = useConversationProjection(events, snapshot)
      return () => h("div", [
        h(AgentConversation, { events: events.value, snapshot: snapshot.value, projection: projection.value }),
        h(AgentOutline, { events: events.value, snapshot: snapshot.value, projection: projection.value }),
      ])
    },
  }), { global: { plugins: [createPinia(), i18n], stubs: { AgentResponse: true, AgentUserMessage: true } } })
  try {
    expect(project).toHaveBeenCalledTimes(1)
    expect(view.findComponent(AgentResponse).props("response").steps[0]).toMatchObject({ kind: "message", content: [{ type: "text", text: "First answer" }] })
    expect(view.find('nav button[aria-label="First question"]').exists()).toBe(true)

    const next = agentInput({ id: "41", state: "delivered", content: [{ type: "text", text: "Next question" }] })
    snapshot.value.inputs.push(next)
    events.value.push(
      agentEvent(3, "input", next),
      agentEvent(4, "acp", { sessionId: "provider", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Next answer" } } }),
    )
    await nextTick()
    expect(project).toHaveBeenCalledTimes(2)
    expect(view.findAllComponents(AgentResponse).at(-1)!.props("response").steps[0]).toMatchObject({ kind: "message", content: [{ type: "text", text: "Next answer" }] })
    expect(view.find('nav button[aria-label="Next question"]').exists()).toBe(true)
  } finally {
    view.unmount()
    factory.mockRestore()
  }
})
