import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { actor, agentPlanApproval, agentSnapshot } from "../../test/agent.ts"
import AgentConversation from "./AgentConversation.vue"
import AgentElicitation from "./AgentElicitation.vue"

const wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia>
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia) })
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); disposePinia(pinia); vi.restoreAllMocks() })

function render(elicitation = agentPlanApproval(), disabled = false) {
  const view = mount(AgentElicitation, { props: { elicitation, disabled }, global: { plugins: [i18n] } })
  wrappers.push(view)
  return view
}

test("renders Cursor plan approval with name, overview, todos, and awaiting badge", () => {
  const view = render()
  expect(view.get('[data-testid="agent-plan-approval"]').text()).toContain("Plan approval required")
  expect(view.text()).toContain("Awaiting approval")
  expect(view.text()).toContain("Refactor tabs layout")
  expect(view.text()).toContain("Tighten layout behavior and preserve existing UX.")
  expect(view.text()).toContain("Inspect current tab sizing logic")
  expect(view.text()).toContain("Update layout calculations")
  expect(view.find('[data-testid="agent-elicitation"]').exists()).toBe(false)
})

test("approve, reject, and cancel send the matching elicitation responses", async () => {
  const store = useAgentSessionsStore()
  const respond = vi.spyOn(store, "respondToElicitation").mockResolvedValue()
  const view = render()
  await view.get('[data-testid="plan-approval-accept"]').trigger("click")
  expect(respond).toHaveBeenCalledWith("30", "80", { action: "accept", content: {} })
  respond.mockClear()
  await view.get('[data-testid="plan-approval-reject"]').trigger("click")
  expect(respond).toHaveBeenCalledWith("30", "80", { action: "decline" })
  respond.mockClear()
  await view.get('[data-testid="plan-approval-cancel"]').trigger("click")
  expect(respond).toHaveBeenCalledWith("30", "80", { action: "cancel" })
})

test("resolved plan approvals show the deciding actor and stop being actionable", async () => {
  const view = render(agentPlanApproval({ state: "resolved", response: { action: "accept", content: {} }, actor }))
  expect(view.text()).toContain("Plan approved · Ada")
  expect(view.find('[data-testid="plan-approval-accept"]').exists()).toBe(false)
  expect(view.text()).not.toContain("Awaiting approval")
})

test("pending Cursor plans stay in the conversation and clear actions after another viewer decides", async () => {
  const snapshot = agentSnapshot(); snapshot.elicitations = [agentPlanApproval()]
  snapshot.turns = [{ id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: new Date().toISOString() }]
  const view = mount(AgentConversation, { props: { snapshot, events: [], disabled: false }, global: { plugins: [i18n] } }); wrappers.push(view)
  expect(view.get('[data-testid="agent-plan-approval"]').text()).toContain("Plan approval required")
  await view.setProps({ snapshot: { ...snapshot, elicitations: [agentPlanApproval({ state: "resolved", response: { action: "decline" }, actor: { ...actor, userId: "Grace" } })] } })
  await flushPromises()
  expect(view.get('[data-testid="agent-plan-approval"]').text()).toContain("Plan rejected · Grace")
  expect(view.find('[data-testid="plan-approval-accept"]').exists()).toBe(false)
})
