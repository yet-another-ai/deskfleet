import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { h } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import AgentConversation from "../components/session/AgentConversation.vue"
import SessionConversationPane from "../components/session/SessionConversationPane.vue"
import { i18n } from "../i18n/index.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { agentEvent, agentInput, agentSnapshot } from "../test/agent.ts"
import SessionView from "./SessionView.vue"

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); localStorage.clear() })

test.each(["active", "archived"] as const)("a search result in an %s session waits for history, opens a collapsed assistant message, and locates another message", async archiveState => {
  const pinia = createPinia()
  setActivePinia(pinia)
  cleanup.push(() => disposePinia(pinia))
  const agents = useAgentSessionsStore()
  vi.spyOn(agents, "open").mockResolvedValue()
  const snapshot = agentSnapshot()
  snapshot.session.archiveState = archiveState
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

test.each([
  { scrollUp: 0, hitRemainsVisible: true, anchor: "the centered search hit" },
  { scrollUp: 32, hitRemainsVisible: true, anchor: "the visible hit at the reader's chosen offset" },
  { scrollUp: 600, hitRemainsVisible: false, anchor: "the reader's new position after scrolling away" },
])("remounting a tall neighbor preserves $anchor", async ({ scrollUp, hitRemainsVisible }) => {
  let deliverIntersection!: (target: Element) => void
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      if (options?.root instanceof Element && options.root.hasAttribute("data-session-scroll-viewport")) {
        deliverIntersection = target => callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
      }
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  cleanup.push(() => vi.unstubAllGlobals())

  const projection = Array.from({ length: 24 }, (_, index) => [
    { id: `input-${index}`, kind: "input" as const, input: agentInput({ id: String(index), state: "delivered" }) },
    { id: `message-${index}`, kind: "message" as const, role: "assistant" as const,
      content: [{ type: "text" as const, text: `Answer ${index}` }] },
  ]).flat()
  const pinia = createPinia()
  cleanup.push(() => disposePinia(pinia))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/sessions/30", component: SessionConversationPane }] })
  await router.push("/sessions/30")
  const wrapper = mount(SessionConversationPane, {
    props: { sessionId: "30", readingId: "30", ready: true }, attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: { ReadingSpotlight: true } },
    slots: { default: ({ focusedEntry }: { focusedEntry?: string }) => h(AgentConversation, { sessionId: "30", projection, locateEntry: focusedEntry }) },
  })
  cleanup.push(() => wrapper.unmount())
  await flushPromises()

  const viewport = wrapper.get<HTMLElement>("[data-session-scroll-viewport]").element
  const rows = wrapper.findAll<HTMLElement>("ol > li").map(row => row.element)
  const targetRow = rows[25]!
  const neighbor = rows[24]!.firstElementChild!
  // The viewport is 400px tall. The row immediately above the hit grows by 300px on mount.
  Object.defineProperties(viewport, { clientHeight: { value: 400 }, scrollHeight: { value: 6000 } })
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 400))
  for (const [index, row] of rows.entries()) {
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
      const growth = neighbor.childElementCount ? 300 : 0
      const top = index * 80 + (index > 24 ? growth : 0) - viewport.scrollTop
      return new DOMRect(0, top, 600, 80 + (index === 24 ? growth : 0))
    })
  }
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    expect(this.dataset.conversationEntry).toBe("message-12")
    vi.spyOn(this, "getBoundingClientRect").mockImplementation(() => targetRow.getBoundingClientRect())
    viewport.scrollTop += this.getBoundingClientRect().top + 40 - 200
  })
  await router.push("/sessions/30?entry=message-12")
  await flushPromises()
  const hit = wrapper.get<HTMLElement>("[data-conversation-located]").element
  expect(neighbor.childElementCount).toBe(0)
  expect(hit.getBoundingClientRect().top).toBe(160)
  if (scrollUp) {
    viewport.scrollTop -= scrollUp
    viewport.dispatchEvent(new Event("scroll"))
  }
  const previousTop = viewport.scrollTop
  deliverIntersection(neighbor)
  await flushPromises()
  expect(neighbor.childElementCount).toBeGreaterThan(0)
  if (hitRemainsVisible) expect(hit.getBoundingClientRect().top).toBe(160 + scrollUp)
  else expect(viewport.scrollTop).toBe(previousTop)
})
