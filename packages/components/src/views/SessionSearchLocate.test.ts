import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../i18n/index.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { agentEvent, agentInput, agentSnapshot } from "../test/agent.ts"
import SessionView from "./SessionView.vue"

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); localStorage.clear() })

test("a search result waits for history, opens a collapsed assistant message, and locates another message in the same session", async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  cleanup.push(() => disposePinia(pinia))
  const agents = useAgentSessionsStore()
  vi.spyOn(agents, "open").mockResolvedValue()
  const snapshot = agentSnapshot()
  const input = agentInput({ state: "delivered", turnId: "70" })
  snapshot.inputs = [input]
  snapshot.turns = [{ id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "completed", startedAt: "2026-10-31T12:00:00Z", endedAt: "2026-10-31T12:01:00Z" }]
  agents.views["30"] = { snapshot, events: [], loading: true, error: null, historySeq: "0", snapshotSeq: "5" }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/sessions/:sessionId", name: "session", component: SessionView }] })
  await router.push("/sessions/30?entry=message-2")
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {})
  const wrapper = mount(SessionView, {
    props: { sessionId: "30" }, attachTo: document.body, global: { plugins: [pinia, router, i18n], stubs: {
      PaneHeader: { template: "<header><slot /></header>" }, AgentOutline: true,
      AgentContent: { props: ["content"], template: "<div>{{ content.map(block => block.text ?? '').join('') }}</div>" },
    } },
  })
  cleanup.push(() => wrapper.unmount())
  await flushPromises()
  expect(scroll).not.toHaveBeenCalled()
  agents.views["30"]!.events = [
    agentEvent(1, "input", input),
    agentEvent(2, "acp", { sessionId: "provider-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier reply" } } }),
    agentEvent(3, "acp", { sessionId: "provider-session", update: { sessionUpdate: "tool_call", toolCallId: "read", title: "Read file", status: "completed" } }),
    agentEvent(4, "acp", { sessionId: "provider-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final reply" } } }),
    agentEvent(5, "turn", snapshot.turns[0]!),
  ]
  agents.views["30"]!.loading = false
  await flushPromises()
  const reply = wrapper.get('[data-conversation-entry="message-2"]')
  expect(reply.text()).toBe("Earlier reply")
  expect(reply.attributes("data-conversation-located")).toBe("true")
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center", behavior: "instant" })

  agents.views["30"]!.events.push(agentEvent(6, "input", input))
  await flushPromises()
  expect(scroll).toHaveBeenCalledOnce()
  await router.push("/sessions/30?entry=input-40")
  await flushPromises()
  expect(reply.attributes("data-conversation-located")).toBeUndefined()
  expect(wrapper.get('[data-conversation-entry="input-40"]').attributes("data-conversation-located")).toBe("true")
  expect(scroll).toHaveBeenCalledTimes(2)
})
