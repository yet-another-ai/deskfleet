import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, type PropType } from "vue"
import { afterEach, expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import type { ConversationResponse, ConversationStep, ConversationTool } from "../../services/agent-conversation.ts"
import { pendingMermaidLocate } from "../../stores/layout.ts"
import { agentElicitation, agentPermission } from "../../test/agent.ts"
import AgentResponse from "./AgentResponse.vue"

const wrappers: VueWrapper[] = []
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  pendingMermaidLocate.value = null
})

const contentStub = defineComponent({
  name: "AgentContent",
  props: { content: { type: Array as PropType<{ type: string; text?: string }[]>, required: true }, final: Boolean },
  setup: props => () => h("div", { "data-content": "", "data-final": String(props.final) }, props.content.map(block => block.text ?? "").join("")),
})

function message(id: string, role: "assistant" | "thought", text = id): ConversationStep {
  return { id, kind: "message", role, content: [{ type: "text", text }] }
}

function tool(id: string, overrides: Partial<ConversationTool> = {}): Extract<ConversationStep, { kind: "tool" }> {
  return { id, kind: "tool", tool: { toolCallId: id, title: id, kind: "read", status: "completed", rawInput: `Input for ${id}`, ...overrides } }
}

function response(steps: ConversationStep[], live = true): ConversationResponse {
  return {
    id: "response-1", kind: "response", turnId: "70", live, last: true, steps,
    turn: { id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: live ? "running" : "completed", startedAt: "2026-10-30T12:00:00Z" },
  }
}

function render(value: ConversationResponse) {
  const wrapper = mount(AgentResponse, {
    props: { response: value },
    global: {
      plugins: [i18n],
      stubs: {
        AgentContent: contentStub,
        AgentElicitation: { props: ["elicitation"], template: '<div data-question>{{ elicitation.request.message }}</div>' },
      },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

test("consecutive tools and thoughts collapse together, while messages, plans, and questions separate groups", async () => {
  const view = render(response([
    tool("read-1"), message("thought-1", "thought"), tool("read-2"),
    message("body", "assistant", "Here is the progress update."),
    message("thought-2", "thought"), message("thought-3", "thought"),
    { id: "plan", kind: "plan", entries: [{ content: "Verify the result", status: "pending" }] },
    tool("read-3"), tool("read-4"),
    { id: "question", kind: "elicitation", elicitation: agentElicitation() },
    message("thought-4", "thought"), tool("read-5"),
  ]))
  await flushPromises()

  expect(view.findAll("[data-activity-group]").map(group => group.attributes("data-activity-group"))).toEqual(["read-1", "thought-2", "read-3", "thought-4"])
  expect(view.get('[data-activity-group="read-1"] [data-activity-trigger]').text()).toBe("2 tool calls · 1 thought")
  expect(view.findAll("[data-activity-trigger]").every(trigger => trigger.attributes("aria-expanded") === "false")).toBe(true)
  expect(view.get('[data-conversation-entry="body"]').text()).toBe("Here is the progress update.")
  expect(view.get('[data-conversation-entry="plan"]').text()).toContain("Verify the result")
  expect(view.get("[data-question]").text()).toBe("Choose the deployment target.")
  expect(view.find('[data-conversation-entry="thought-1"]').exists()).toBe(false)
})

test("opening a group reveals thoughts in order and preserves each tool's detail disclosure", async () => {
  const view = render(response([message("thought-a", "thought", "Inspect the files."), tool("read-a"), message("thought-b", "thought", "Compare the results.")]))
  await view.get("[data-activity-trigger]").trigger("click")
  await flushPromises()

  expect(view.get("[data-activity-trigger]").attributes("aria-expanded")).toBe("true")
  expect(view.findAll("[data-conversation-entry]").map(entry => entry.attributes("data-conversation-entry"))).toEqual(["thought-a", "read-a", "thought-b"])
  expect(view.text()).toContain("Inspect the files.")
  expect(view.text()).toContain("Compare the results.")
  expect(view.text()).not.toContain("Input for read-a")
  await view.get('[data-conversation-entry="read-a"] button').trigger("click")
  expect(view.text()).toContain("Input for read-a")
  await view.get("[data-activity-trigger]").trigger("click")
  expect(view.text()).not.toContain("Inspect the files.")
})

test("streamed content and appended steps preserve the group's chosen expansion state", async () => {
  const initial = response([message("thought", "thought", "Checking"), tool("read")])
  const view = render(initial)
  await view.get("[data-activity-trigger]").trigger("click")
  const group = view.get("[data-activity-group]").element
  const expanded = response([message("thought", "thought", "Checking the updated files."), tool("read"), tool("search", { kind: "search" })])
  await view.setProps({ response: expanded })

  expect(view.get("[data-activity-group]").element).toBe(group)
  expect(view.get("[data-activity-trigger]").attributes("aria-expanded")).toBe("true")
  expect(view.text()).toContain("Checking the updated files.")
  expect(view.get("[data-activity-trigger]").text()).toBe("2 tool calls · 1 thought")
  await view.get("[data-activity-trigger]").trigger("click")
  await view.setProps({ response: response([...expanded.steps, tool("another-read")]) })
  expect(view.get("[data-activity-trigger]").attributes("aria-expanded")).toBe("false")
  expect(view.get("[data-activity-trigger]").text()).toBe("3 tool calls · 1 thought")
})

test("a finished response keeps the answer visible and stops stale running indicators", async () => {
  const steps = [message("thought", "thought"), tool("running", { status: "in_progress" })]
  const view = render(response(steps))
  expect(view.find('[data-activity-trigger] [aria-label="Running"]').exists()).toBe(true)
  await view.setProps({ response: response([...steps, message("answer", "assistant", "All done.")], false) })

  expect(view.get('[data-conversation-entry="answer"]').text()).toBe("All done.")
  expect(view.get("[data-turn-work]").attributes("aria-expanded")).toBe("false")
  await view.get("[data-turn-work]").trigger("click")
  expect(view.find('[data-activity-trigger] [aria-label="Running"]').exists()).toBe(false)
  await view.get("[data-activity-trigger]").trigger("click")
  expect(view.find('[aria-label="Running"]').exists()).toBe(false)
})

test("pending approval and failed tools remain visible in a collapsed activity summary", () => {
  const pending = tool("approve")
  pending.permission = agentPermission()
  const view = render(response([pending, tool("failed", { status: "failed" })]))

  expect(view.get("[data-activity-trigger]").attributes("aria-expanded")).toBe("false")
  expect(view.get("[data-activity-trigger]").text()).toContain("Awaiting approval")
  expect(view.get("[data-activity-trigger]").text()).toContain("Failed")
  expect(view.find('[data-conversation-entry="failed"]').exists()).toBe(false)
})

test.each([true, false])("locating a thought diagram opens its response and group (entry ID: %s)", async withEntryId => {
  const code = "graph TD\nA --> B"
  const view = render(response([
    tool("read"), message("diagram", "thought", `\`\`\`mermaid\n${code}\n\`\`\``),
    message("progress", "assistant"), tool("other-read"), message("other-thought", "thought"),
    message("answer", "assistant"),
  ], false))
  expect(view.get("[data-turn-work]").attributes("aria-expanded")).toBe("false")

  pendingMermaidLocate.value = { id: 1, code, ...(withEntryId ? { entryId: "diagram" } : {}) }
  await flushPromises()

  expect(view.get("[data-turn-work]").attributes("aria-expanded")).toBe("true")
  expect(view.get('[data-activity-group="read"] [data-activity-trigger]').attributes("aria-expanded")).toBe("true")
  expect(view.get('[data-conversation-entry="diagram"]').text()).toContain(code)
  expect(view.get('[data-activity-group="other-read"] [data-activity-trigger]').attributes("aria-expanded")).toBe("false")
})

test("isolated tools and thoughts keep their existing disclosure controls", async () => {
  const view = render(response([tool("single-tool"), message("body", "assistant"), message("single-thought", "thought", "Single thought details")]))
  expect(view.find("[data-activity-group]").exists()).toBe(false)
  expect(view.get('[data-conversation-entry="single-tool"]').text()).toContain("single-tool")
  expect(view.get('[data-conversation-entry="single-thought"] button').text()).toBe("Thinking")
  expect(view.text()).not.toContain("Single thought details")
  await view.get('[data-conversation-entry="single-thought"] button').trigger("click")
  expect(view.text()).toContain("Single thought details")
})

test("only the last response step remains streaming, including thoughts at group boundaries", async () => {
  const view = render(response([
    tool("first-tool"), message("earlier-thought", "thought"),
    message("body", "assistant"),
    tool("last-tool"), message("last-thought", "thought"),
  ]))
  for (const trigger of view.findAll("[data-activity-trigger]")) await trigger.trigger("click")

  expect(view.get('[data-conversation-entry="earlier-thought"] [data-content]').attributes("data-final")).toBe("true")
  expect(view.get('[data-conversation-entry="body"] [data-content]').attributes("data-final")).toBe("true")
  expect(view.get('[data-conversation-entry="last-thought"] [data-content]').attributes("data-final")).toBe("false")
})
