import { mount, type VueWrapper } from "@vue/test-utils"
import type { AgentEvent } from "../../../../../../daemon/src/agent-protocol.ts"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { agentEvent, agentInput, agentPermission, agentSnapshot, actor } from "../../test/agent.ts"
import AgentConversation from "./AgentConversation.vue"
import AgentBacklog from "./AgentBacklog.vue"
import AgentPermissions from "./AgentPermissions.vue"
import SessionComposer from "../composer/SessionComposer.vue"
const wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia>
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia) })
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); disposePinia(pinia) })
const button = (view: VueWrapper, name: string) => view.findAll("button").find(button => button.text() === name || button.attributes("aria-label") === name)!
test("message times render in every app locale", () => {
  const input = agentInput({ state: "delivered", deliveredAt: "2026-10-06T12:33:00Z" })
  const snapshot = agentSnapshot(); snapshot.inputs = [input]
  try {
    for (const locale of i18n.global.availableLocales) {
      i18n.global.locale.value = locale
      const view = mount(AgentConversation, { props: { snapshot, events: [agentEvent(1, "input", input)] }, global: { plugins: [i18n] } }); wrappers.push(view)
      expect(view.get("time").attributes("datetime")).toBe("2026-10-06T12:33:00Z")
      expect(view.text()).toContain("Fix the tests")
    }
  } finally { i18n.global.locale.value = "en-US" }
})
test("backlog exposes steer/withdraw only for candidates and retry only for confirmed failures", async () => {
  const view = mount(AgentBacklog, { props: { inputs: [agentInput(), agentInput({ id: "41", state: "failed" }), agentInput({ id: "42", state: "uncertain" }), agentInput({ id: "43", state: "delivered" })], canSteer: true, disabled: false }, global: { plugins: [i18n] } }); wrappers.push(view)
  expect(view.findAll("li")).toHaveLength(3)
  await button(view, "Steer now").trigger("click"); expect(view.emitted("steer")).toEqual([["40"]])
  await button(view, "Withdraw").trigger("click"); expect(view.emitted("withdraw")).toEqual([["40"]])
  await button(view, "Retry delivery").trigger("click"); expect(view.emitted("retry")).toEqual([["41"]])
  expect(view.get('[data-input-id="42"]').find("button").exists()).toBe(false)
  await view.setProps({ canSteer: false }); expect(view.text()).not.toContain("Steer now")
})
test("only pending permissions are actionable and an answer is recorded on its tool call with the winning actor", async () => {
  const view = mount(AgentPermissions, { props: { permissions: [agentPermission()], disabled: false }, global: { plugins: [i18n] } }); wrappers.push(view)
  await button(view, "Allow once").trigger("click"); expect(view.emitted("respond")).toEqual([["60", "allow"]])
  const resolved = agentPermission({ state: "resolved", optionId: "deny", actor: { ...actor, userId: "Grace" } })
  await view.setProps({ permissions: [resolved] })
  expect(view.find("section").exists()).toBe(false)
  const snapshot = agentSnapshot(); snapshot.permissions = [resolved]
  const conversation = mount(AgentConversation, { props: { snapshot, events: [agentEvent(1, "permission", agentPermission())] }, global: { plugins: [i18n] } }); wrappers.push(conversation)
  expect(conversation.get('[data-permission-id="60"]').text()).toContain("Run checks")
  expect(conversation.get('[data-permission-id="60"]').text()).toContain("Reject · Grace")
  expect(conversation.findAll("button").some(item => item.text() === "Reject")).toBe(false)
})
test("composer uses explicit submit and steer and protects IME composition", async () => {
  const location = { machine: { id: "10", name: "Host", local: true, online: true, desktop: false, workspaces: [], terminals: [] }, workspace: { id: "20", name: "Workspace", directories: [], sessions: [], terminals: [] } }
  const view = mount(SessionComposer, { props: { location, modelValue: "Draft", activeTurn: true, canSteer: true }, global: { plugins: [i18n] } }); wrappers.push(view)
  await view.get("textarea").trigger("keydown", { key: "Enter", isComposing: true }); expect(view.emitted("submit")).toBeUndefined()
  await view.get("textarea").trigger("keydown", { key: "Enter", shiftKey: true }); expect(view.emitted("submit")).toBeUndefined()
  await view.get("textarea").trigger("keydown", { key: "Enter" }); expect(view.emitted("submit")).toEqual([["backlog"]])
  await button(view, "Steer now").trigger("click"); expect(view.emitted("submit")?.at(-1)).toEqual(["steer"])
  expect((view.get("textarea").element as HTMLTextAreaElement).value).toBe("Draft")
  await view.setProps({ submitting: true }); await view.get("textarea").trigger("keydown", { key: "Enter" }); expect(view.emitted("submit")).toHaveLength(2)
})
test("an empty composer offers to cancel the active turn instead of sending", async () => {
  const location = { machine: { id: "10", name: "Host", local: true, online: true, desktop: false, workspaces: [], terminals: [] }, workspace: { id: "20", name: "Workspace", directories: [], sessions: [], terminals: [] } }
  const view = mount(SessionComposer, { props: { location, modelValue: "", activeTurn: true, canCancel: true }, global: { plugins: [i18n] } }); wrappers.push(view)
  await button(view, "Cancel turn").trigger("click"); expect(view.emitted("cancel")).toHaveLength(1)
  expect(view.find('[aria-label="Add to backlog"]').exists()).toBe(false)
  await view.setProps({ modelValue: "Next" })
  expect(view.find('[aria-label="Cancel turn"]').exists()).toBe(false)
  expect(view.get('[aria-label="Add to backlog"]').attributes("disabled")).toBeUndefined()
})


test("an active initial prompt shows progress while an unconfirmed steer still shows sending", () => {
  const initial = agentInput({ state: "dispatching", actualDelivery: "turn_start" })
  const steer = agentInput({ id: "41", state: "dispatching", requestedDelivery: "steer" })
  const snapshot = agentSnapshot(); snapshot.inputs = [initial, steer]
  const view = mount(AgentConversation, { props: { snapshot, events: [agentEvent(1, "input", initial), agentEvent(2, "input", steer)] }, global: { plugins: [i18n] } }); wrappers.push(view)
  expect(view.get('[data-conversation-entry="input-40"]').text()).toContain("In progress")
  expect(view.get('[data-conversation-entry="input-41"]').text()).toContain("Sending")
  expect(view.text()).not.toContain("Steered the turn")
})

test("a finished turn folds its work behind a duration and keeps the final answer visible", async () => {
  const update = (seq: number, value: Record<string, unknown>) => agentEvent(seq, "acp", { sessionId: "provider", update: value } as AgentEvent["payload"])
  const input = agentInput({ state: "delivered", turnId: "70", actualDelivery: "turn_start" })
  const turn = { id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "completed" as const, startedAt: "2026-10-06T20:30:00Z", endedAt: "2026-10-06T20:33:22Z" }
  const snapshot = agentSnapshot(); snapshot.inputs = [input]; snapshot.turns = [turn]
  const events = [agentEvent(1, "input", input), update(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking around" } }), update(3, { sessionUpdate: "tool_call", toolCallId: "t1", title: "pnpm test", kind: "execute", status: "completed" }), update(4, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit a.ts", kind: "edit", status: "completed", locations: [{ path: "a.ts" }] }), update(5, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixed `a.ts`." } }), agentEvent(6, "turn", turn)]
  const view = mount(AgentConversation, { props: { snapshot, events }, global: { plugins: [i18n] } }); wrappers.push(view)
  expect(view.text()).toContain("Worked for 3m 22s")
  expect(view.text()).toContain("Ran 1 command · Edited 1 file")
  expect(view.get(".ui-markdown code").text()).toBe("a.ts")
  expect(view.text()).not.toContain("Looking around")
  expect(view.text()).not.toContain("Turn completed")
  await button(view, "Worked for 3m 22s").trigger("click")
  expect(view.text()).toContain("Looking around")
  expect(view.text()).toContain("pnpm test")
})

test("only a new Session offers its context, and an existing directory Session is labelled as such", async () => {
  const machine = { id: "10", name: "Host", local: true, online: true, desktop: false, workspaces: [], terminals: [] }
  const workspace = { id: "20", name: "Workspace", directories: [], sessions: [], terminals: [] }
  const fresh = mount(SessionComposer, { props: { location: { machine, workspace }, showTarget: true, context: "worktree" }, global: { plugins: [i18n] } }); wrappers.push(fresh)
  await button(fresh, "Session context: New worktree").trigger("click")
  const options = fresh.findAll('[role="menuitemradio"]')
  expect(options.map(option => option.attributes("aria-checked"))).toEqual(["true", "false"])
  await options[1]!.trigger("click")
  expect(fresh.emitted("update:context")).toEqual([["directory"]])
  const worktree = { id: "31", directories: [{ path: "/code/web" }], terminals: [] }
  const existing = mount(SessionComposer, { props: { location: { machine, workspace, worktree, session: { id: "30", context: "directory" } } }, global: { plugins: [i18n], stubs: { RouterLink: { template: "<a><slot /></a>" } } } }); wrappers.push(existing)
  expect(existing.find('[aria-label^="Session context:"]').exists()).toBe(false)
  expect(existing.text()).toContain("Working directory")
})
