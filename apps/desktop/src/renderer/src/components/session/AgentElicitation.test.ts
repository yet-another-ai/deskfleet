import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentElicitation as Elicitation } from "../../../../../../daemon/src/agent-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { actor, agentElicitation, agentSnapshot } from "../../test/agent.ts"
import AgentElicitation from "./AgentElicitation.vue"
import AgentConversation from "./AgentConversation.vue"

const wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia>
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia) })
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); disposePinia(pinia); vi.restoreAllMocks() })
function render(elicitation = agentElicitation(), disabled = false) {
  const view = mount(AgentElicitation, { props: { elicitation, disabled }, global: { plugins: [i18n] } })
  wrappers.push(view)
  return view
}
function question(properties: Record<string, unknown>, required: string[] = []): Elicitation {
  return agentElicitation({ request: { sessionId: "provider-session", mode: "form", message: "Please answer.", requestedSchema: { type: "object", properties, required } } as Elicitation["request"] })
}

test("renders choice descriptions, validates required answers and submits one structured response", async () => {
  const store = useAgentSessionsStore()
  const respond = vi.spyOn(store, "respondToElicitation").mockResolvedValue()
  const view = render()
  expect(view.text()).toContain("Try the changes first.")
  await view.get("form").trigger("submit")
  expect(respond).not.toHaveBeenCalled()
  expect(view.get('[role="alert"]').text()).toContain("required fields")
  await view.get('input[name="target"][value="staging"]').setValue(true)
  await view.get("form").trigger("submit")
  expect(respond).toHaveBeenCalledWith("30", "80", { action: "accept", content: { target: "staging" } })
})

test("collects multiple primitive fields, Other notes and optional selections while keeping false and zero", async () => {
  const store = useAgentSessionsStore()
  const respond = vi.spyOn(store, "respondToElicitation").mockResolvedValue()
  const view = render(question({
    target: { type: "string", oneOf: [{ const: "None of the above", title: "Other" }], _meta: { codex: { isOther: true } } },
    target_note: { type: "string", title: "Additional answer or note", _meta: { codex: { questionId: "target", role: "user_note" } } },
    enabled: { type: "boolean", title: "Enable deployment?" },
    retries: { type: "integer", title: "Retry count", minimum: 0, maximum: 3 },
    regions: { type: "array", title: "Regions", minItems: 1, items: { anyOf: [{ const: "us", title: "United States", description: "US servers" }, { const: "eu", title: "Europe" }] } },
    optional: { type: "string", enum: ["a", "b"] },
  }, ["target", "enabled", "retries", "regions"]))
  await view.get('input[name="target"]').setValue(true)
  await view.get('input[name="target_note"]').setValue("Use a preview environment")
  await view.get('input[name="enabled"][value="false"]').setValue(true)
  await view.get('input[name="retries"]').setValue("0")
  await view.get('input[name="regions"][value="eu"]').setValue(true)
  await view.get("form").trigger("submit")
  expect(respond).toHaveBeenCalledWith("30", "80", { action: "accept", content: { target: "None of the above", target_note: "Use a preview environment", enabled: false, retries: 0, regions: ["eu"] } })
  await view.get('input[name="retries"]').setValue("4")
  await view.get("form").trigger("submit")
  expect(respond).toHaveBeenCalledTimes(1)
})

test("drafts survive navigation, including optional values and defaults, until the request resolves", async () => {
  const elicitation = question({ notes: { type: "string" }, count: { type: "number", default: 1.5 } })
  const first = render(elicitation)
  await first.get('input[name="notes"]').setValue("Keep this draft")
  expect((first.get('input[name="count"]').element as HTMLInputElement).value).toBe("1.5")
  first.unmount()
  const second = render(elicitation)
  expect((second.get('input[name="notes"]').element as HTMLInputElement).value).toBe("Keep this draft")
  await second.setProps({ elicitation: { ...elicitation, state: "cancelled" } })
  expect(second.text()).toContain("Question cancelled")
  expect(second.find("input").exists()).toBe(false)
  expect(useAgentSessionsStore().elicitationDrafts).toEqual({})
})

test("password answers are sent to the agent but never displayed in resolved history", async () => {
  const store = useAgentSessionsStore()
  const respond = vi.spyOn(store, "respondToElicitation").mockResolvedValue()
  const elicitation = question({ token: { type: "string", title: "API token", _meta: { codex: { isSecret: true } } }, note: { type: "string" } }, ["token"])
  const view = render(elicitation)
  expect(view.get('input[name="token"]').attributes("type")).toBe("password")
  await view.get('input[name="token"]').setValue("sensitive-value")
  await view.get('input[name="note"]').setValue("Visible note")
  await view.get("form").trigger("submit")
  expect(respond).toHaveBeenCalledWith("30", "80", { action: "accept", content: { token: "sensitive-value", note: "Visible note" } })
  await view.setProps({ elicitation: { ...elicitation, state: "resolved", response: { action: "accept", content: { token: "sensitive-value", note: "Visible note" } }, actor } })
  expect(view.text()).toContain("Answered · Ada")
  expect(view.text()).toContain("Visible note")
  expect(view.html()).not.toContain("sensitive-value")
  expect(view.text()).not.toContain("API token")
  expect(store.elicitationDrafts).toEqual({})
})

test.each(["decline", "cancel"] as const)("%s sends no draft content, and disabled or uncertain forms cannot submit again", async action => {
  const store = useAgentSessionsStore()
  const respond = vi.spyOn(store, "respondToElicitation").mockResolvedValue()
  const view = render()
  await view.get(`[data-testid="elicitation-${action}"]`).trigger("click")
  expect(respond).toHaveBeenCalledWith("30", "80", { action })
  await view.setProps({ disabled: true })
  expect(view.get('[data-testid="elicitation-submit"]').attributes("disabled")).toBeDefined()
  expect((view.get('input[name="target"]').element as HTMLInputElement).closest("fieldset")!.disabled).toBe(true)
  await view.get("form").trigger("submit")
  expect(respond).toHaveBeenCalledTimes(1)
  await view.setProps({ disabled: false })
  store.operations["lost"] = { operationId: "lost", sessionId: "30", method: "_deskfleet/elicitation/respond", params: { elicitationId: "80" }, error: "Lost response" }
  await flushPromises()
  expect(view.get('[data-testid="elicitation-submit"]').attributes("disabled")).toBeDefined()
  expect(view.text()).toContain("operation result needs to be checked")
})

test("restored pending questions stay visible inside the active response and stop being actionable on another viewer's answer", async () => {
  const snapshot = agentSnapshot(); snapshot.elicitations = [agentElicitation()]
  snapshot.turns = [{ id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: new Date().toISOString() }]
  const view = mount(AgentConversation, { props: { snapshot, events: [], disabled: false }, global: { plugins: [i18n] } }); wrappers.push(view)
  expect(view.get('[data-testid="agent-elicitation"]').text()).toContain("Your input is needed")
  await view.setProps({ snapshot: { ...snapshot, elicitations: [agentElicitation({ state: "resolved", response: { action: "decline" }, actor: { ...actor, userId: "Grace" } })] } })
  expect(view.get('[data-testid="agent-elicitation"]').text()).toContain("Declined · Grace")
  expect(view.find('[data-testid="elicitation-submit"]').exists()).toBe(false)
})
