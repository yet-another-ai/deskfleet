import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import type { ConversationStep } from "../../services/agent-conversation.ts"
import { i18n } from "../../i18n/index.ts"
import AgentProtocolActivity from "./AgentProtocolActivity.vue"

const wrappers: VueWrapper[] = []
afterEach(() => { for (const view of wrappers.splice(0)) view.unmount() })
function render(step: ConversationStep) {
  const view = mount(AgentProtocolActivity, {
    props: { step, live: true },
    global: { plugins: [i18n], stubs: {
      AgentContent: { props: ["content"], template: '<div data-content>{{ content.map(block => block.text ?? "").join("") }}</div>' },
      AgentResourceLink: { props: ["uri", "name"], template: '<button :data-resource-link="uri">{{ name }}</button>' },
    } },
  })
  wrappers.push(view)
  return view
}

test("structured plans render markdown and use the existing resource flow for file plans", async () => {
  const view = render({ id: "plan", kind: "structured_plan", plan: { type: "markdown", planId: "p", content: "Review the diff" } })
  expect(view.get("[data-structured-plan]").attributes("data-plan-id")).toBe("p")
  expect(view.get("[data-content]").text()).toBe("Review the diff")
  await view.setProps({ step: { id: "plan", kind: "structured_plan", plan: { type: "file", planId: "p", uri: "file:///workspace/PLAN.md" } } })
  expect(view.get("[data-resource-link]").attributes("data-resource-link")).toBe("file:///workspace/PLAN.md")
})

test("compaction errors and replacement summaries remain inspectable", async () => {
  const view = render({ id: "c", kind: "compaction", compaction: { compactionId: "compact", status: "failed", error: "Provider failed", summary: [{ type: "text", text: "Retained decisions" }] } })
  await flushPromises()
  expect(view.text()).toContain("Provider failed")
  expect(view.get("[data-content]").text()).toBe("Retained decisions")
  await view.setProps({ step: { id: "c", kind: "compaction", compaction: { compactionId: "compact", status: "completed", summary: [{ type: "text", text: "Updated decisions" }] } }, locateEntry: "c" })
  await flushPromises()
  expect(view.text()).not.toContain("Provider failed")
  expect(view.get("[data-content]").text()).toBe("Updated decisions")
})

test("locating a nested child message opens every containing child session", async () => {
  const view = render({ id: "child", kind: "subagent", session: { sessionId: "child", title: "Reviewer", state: { state: "idle" } }, steps: [
    { id: "nested", kind: "subagent", session: { sessionId: "nested", title: "Tests", state: { state: "idle" } }, steps: [
      { id: "answer", kind: "message", role: "assistant", content: [{ type: "text", text: "All checks passed" }] },
    ] },
  ] })
  expect(view.find('[data-conversation-entry="answer"]').exists()).toBe(false)
  await view.setProps({ locateEntry: "answer" })
  await flushPromises()
  expect(view.get('[data-conversation-entry="answer"]').text()).toBe("All checks passed")
  expect(view.findAll("[data-subagent]")).toHaveLength(2)
})

test("directed messages label sender and recipient separately from assistant messages", async () => {
  const view = render({ id: "dispatch", kind: "session_message", message: { messageId: "request-1", senderSessionId: "parent", recipientSessionId: "child", content: [{ type: "text", text: "Review this patch" }] } })
  await view.setProps({ sessionLabels: { parent: "Implementation", child: "Reviewer" } })
  expect(view.get("[data-session-message]").text()).toContain("Implementation")
  expect(view.get("[data-session-message]").text()).toContain("Reviewer")
  expect(view.get("[data-content]").text()).toBe("Review this patch")
})

test("Cursor cancelled todos display cancellation instead of a completed check", () => {
  const view = render({ id: "p", kind: "structured_plan", plan: { type: "items", planId: "plan", entries: [
    { content: "Finished task", status: "completed", priority: "medium" },
    { content: "Skipped task", status: "completed", priority: "medium", _meta: { cursor: { status: "cancelled" } } },
  ] } })
  expect(view.get('[data-plan-status="completed"]').text()).toBe("Finished task")
  expect(view.get('[data-plan-status="cancelled"]').text()).toContain("Skipped task")
  expect(view.get('[data-plan-status="cancelled"]').text()).toContain("Cancelled")
})
