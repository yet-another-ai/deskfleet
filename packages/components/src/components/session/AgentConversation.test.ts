import { client } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent } from "../../../../client/src/central.ts"
import type { FilesApi, FileTarget } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import { agentEvent, agentInput, agentSnapshot } from "../../test/agent.ts"
import AgentConversation from "./AgentConversation.vue"

const originalFiles = client.files, originalCentral = client.central
let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; client.files = originalFiles; client.central = originalCentral })

function setup(target: FileTarget = { kind: "local" }) {
  let event!: (value: CentralEvent) => void
  const unsubscribe = vi.fn()
  client.central = { onEvent: (listener: (value: CentralEvent) => void) => { event = listener; return unsubscribe } } as unknown as CentralApi
  const readResource = vi.fn().mockRejectedValue(new Error("No image data in this fixture"))
  client.files = { readResource } as unknown as FilesApi
  const snapshot = agentSnapshot()
  const events = [agentEvent(1, "acp", { sessionId: "provider-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "![Chart](chart.png)" } } })]
  wrapper = mount(AgentConversation, { props: { snapshot, events, resourceTarget: target }, global: { plugins: [i18n] } })
  return { view: wrapper, snapshot, readResource, event, unsubscribe }
}

test("local previews load automatically and keep their Session context across streamed snapshots", async () => {
  const { view, snapshot, readResource, event, unsubscribe } = setup()
  await flushPromises()
  expect(readResource).toHaveBeenCalledExactlyOnceWith({ target: { kind: "local" }, sessionId: snapshot.session.id, uri: "chart.png" })
  await view.setProps({ snapshot: structuredClone(snapshot) })
  expect(readResource).toHaveBeenCalledOnce()
  expect(view.text()).not.toContain("Allow local file previews")
  event({ type: "accountChanged" })
  await flushPromises()
  expect(readResource).toHaveBeenCalledOnce()
  expect(view.get("[data-resource-retry]").attributes("title")).toContain("unavailable")
  wrapper!.unmount(); wrapper = undefined
  expect(unsubscribe).toHaveBeenCalledOnce()
})

test("a Session change reads its resources automatically with the new context", async () => {
  const { view, snapshot, readResource } = setup()
  await flushPromises()
  await view.setProps({ snapshot: { ...snapshot, session: { ...snapshot.session, id: "other" } } })
  await flushPromises()
  expect(readResource).toHaveBeenLastCalledWith({ target: { kind: "local" }, sessionId: "other", uri: "chart.png" })
  expect(readResource).toHaveBeenCalledTimes(2)
  expect(view.text()).not.toContain("Allow local file previews")
})

test("remote previews retain their existing automatic read flow", async () => {
  const remote = { kind: "machine", machineId: "machine", teamId: "team" } as const
  const { view, readResource, snapshot } = setup(remote)
  await flushPromises()
  expect(readResource).toHaveBeenCalledExactlyOnceWith({ target: remote, sessionId: snapshot.session.id, uri: "chart.png" })
  expect(view.text()).not.toContain("Allow local file previews")
})

test("only the final response offers a fork, including responses split by steering", async () => {
  const snapshot = agentSnapshot()
  const first = agentInput({ state: "delivered", turnId: "70", actualDelivery: "turn_start" })
  const steered = agentInput({ id: "41", state: "delivered", turnId: "70", actualDelivery: "steer" })
  snapshot.inputs = [first, steered]
  snapshot.turns = [{ id: "70", sessionId: "30", initialInputId: first.id, dispatchCommandId: "50", runGeneration: 1, state: "completed", startedAt: "now", endedAt: "now" }]
  const events = [
    agentEvent(1, "input", first),
    agentEvent(2, "acp", { sessionId: "provider-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before steering" } } }),
    agentEvent(3, "input", steered),
    agentEvent(4, "acp", { sessionId: "provider-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final answer" } } }),
    agentEvent(5, "turn", snapshot.turns[0]!),
  ]
  wrapper = mount(AgentConversation, { props: { snapshot, events, canFork: true }, global: { plugins: [i18n] } })
  const entries = wrapper.findAll("ol > li")
  expect(entries).toHaveLength(4)
  expect(entries[1]!.find('[aria-label="Fork session"]').exists()).toBe(false)
  expect(entries[3]!.find('[aria-label="Fork session"]').exists()).toBe(true)
  await wrapper.setProps({ forkDisabled: true })
  await wrapper.get('[aria-label="Fork session"]').trigger("click")
  expect(wrapper.emitted("fork")).toBeUndefined()
  await wrapper.setProps({ forkDisabled: false })
  await wrapper.get('[aria-label="Fork session"]').trigger("click")
  expect(wrapper.emitted("fork")).toEqual([[]])
  await wrapper.setProps({ events: [...events, agentEvent(6, "input", agentInput({ id: "42", state: "delivered" }))] })
  expect(wrapper.find('[aria-label="Fork session"]').exists()).toBe(false)
  await wrapper.setProps({ events, canFork: false })
  expect(wrapper.find('[aria-label="Fork session"]').exists()).toBe(false)
})
