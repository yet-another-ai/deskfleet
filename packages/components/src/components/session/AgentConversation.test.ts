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

test("live notices and authentication status stay outside replayed conversation history", async () => {
  const snapshot = agentSnapshot()
  const events = [agentEvent(1, "acp", { sessionId: "provider", update: { sessionUpdate: "notice", severity: "error", title: "Historical notice" } })]
  wrapper = mount(AgentConversation, { props: { snapshot, events, notices: [{ id: "live", severity: "warning", title: "Current warning", description: "Provider guidance" }] },
    slots: { live: '<div data-auth-status>Connected with account</div>' }, global: { plugins: [i18n] } })
  expect(wrapper.get("ol").text()).not.toContain("warning")
  expect(wrapper.text()).not.toContain("Historical notice")
  expect(wrapper.get("[data-live-notices]").text()).toContain("Current warning")
  expect(wrapper.get("[data-auth-status]").element.closest("ol")).toBeNull()
  await wrapper.get("[data-live-notices] button").trigger("click")
  expect(wrapper.emitted("dismissNotice")).toEqual([["live"]])
  await wrapper.setProps({ notices: [], events: [...events] })
  expect(wrapper.find("[data-live-notices]").exists()).toBe(false)
  expect(wrapper.text()).not.toContain("Historical notice")
})

test("out-of-turn wakeups render as live during active tools or uncommitted previews and settle once committed", async () => {
  const snapshot = agentSnapshot()
  const input = agentInput({ state: "delivered", turnId: "70", actualDelivery: "turn_start" })
  const turn = { id: "70", sessionId: "30", initialInputId: input.id, dispatchCommandId: "50", runGeneration: 1, state: "completed" as const, startedAt: "now", endedAt: "now" }
  snapshot.inputs = [input]
  snapshot.turns = [turn]
  snapshot.runs = [{ sessionId: "30", generation: 1, state: "running", startedAt: "now" }]
  const wakeup = (seq: number, update: Record<string, unknown>) => ({
    ...agentEvent(seq, "acp", { sessionId: "provider-session", update } as never),
    turnId: undefined,
  })
  const base = [agentEvent(1, "input", input), agentEvent(2, "turn", turn)]
  wrapper = mount(AgentConversation, {
    props: {
      snapshot: { ...snapshot, session: { ...snapshot.session, lastEventSeq: "3" } },
      canFork: true,
      events: [...base, wakeup(3, { sessionUpdate: "tool_call", toolCallId: "bg", title: "Check", status: "in_progress" })],
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.find('[aria-label="Running"]').exists()).toBe(true)
  expect(wrapper.find('[aria-label="Fork session"]').exists()).toBe(false)

  // Tool finishes and streams an uncommitted text preview (seq 4 > lastEventSeq 3): still live.
  const streamed = [
    ...base,
    wakeup(3, { sessionUpdate: "tool_call", toolCallId: "bg", title: "Check", status: "completed" }),
    wakeup(4, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }),
  ]
  await wrapper.setProps({ events: streamed })
  expect(wrapper.find('[aria-label="Fork session"]').exists()).toBe(false)

  // Once the stream flushes (lastEventSeq catches up to 4), the wakeup settles to idle even while run is running.
  await wrapper.setProps({ snapshot: { ...snapshot, session: { ...snapshot.session, lastEventSeq: "4" } } })
  expect(wrapper.find('[aria-label="Fork session"]').exists()).toBe(true)
})

test("long history mounts nearby messages, releases their media on exit, and restores offscreen targets", async () => {
  const viewport = document.createElement("div")
  viewport.dataset.sessionScrollViewport = ""
  document.body.appendChild(viewport)
  let intersect!: (row: Element, visible: boolean) => void
  const disconnect = vi.fn()
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      if (options?.root === viewport) {
        intersect = (target, isIntersecting) => callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
    }
    observe() {}
    unobserve() {}
    disconnect = disconnect
  })
  try {
    const readResource = vi.fn().mockResolvedValue({ data: new Uint8Array([1]), mimeType: "image/png" })
    client.files = { readResource } as unknown as FilesApi
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chart")
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    const projection = Array.from({ length: 30 }, (_, i) => [
      { id: `input-${i}`, kind: "input" as const, input: agentInput({ id: String(i), state: "delivered" }) },
      { id: `message-${i}`, kind: "message" as const, role: "assistant" as const,
        content: [{ type: "text" as const, text: i ? `Answer ${i}` : "![Chart](chart.png)" }] },
    ]).flat()
    wrapper = mount(AgentConversation, {
      attachTo: viewport, props: { sessionId: "30", projection, resourceTarget: { kind: "local" } },
      global: { plugins: [i18n], stubs: { PreviewViewer: true } },
    })
    await flushPromises()
    const rows = wrapper.findAll("ol > li")
    expect(rows).toHaveLength(60)
    expect(wrapper.findAll(".ui-markdown")).toHaveLength(1)
    expect(readResource).not.toHaveBeenCalled()

    const first = rows[1]!.get("div")
    intersect(first.element, true)
    await flushPromises()
    expect(readResource).toHaveBeenCalledOnce()
    expect(wrapper.findAll(".ui-markdown")).toHaveLength(2)
    vi.spyOn(first.element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 713))
    intersect(first.element, false)
    await flushPromises()
    expect(revoke).toHaveBeenCalledWith("blob:chart")
    expect(first.element.style.height).toBe("713px")

    await wrapper.setProps({ locateEntry: "message-0" })
    await flushPromises()
    expect(readResource).toHaveBeenCalledTimes(2)
    expect(rows[1]!.find(".ui-markdown").exists()).toBe(true)
    await wrapper.setProps({ locateEntry: undefined })
    expect(rows[1]!.find(".ui-markdown").exists()).toBe(false)
    window.dispatchEvent(new Event("beforeprint"))
    await flushPromises()
    expect(wrapper.findAll(".ui-markdown")).toHaveLength(30)
    window.dispatchEvent(new Event("afterprint"))
    await flushPromises()
    expect(wrapper.findAll(".ui-markdown")).toHaveLength(1)
  } finally {
    wrapper?.unmount()
    wrapper = undefined
    viewport.remove()
    vi.unstubAllGlobals()
  }
  expect(disconnect).toHaveBeenCalled()
})
