import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { windowHeaderActionsTargetKey } from "../components/chrome/windowHeaderActions.ts"
import { i18n } from "../i18n/index.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { actor, agentEvent, agentInput, agentSnapshot } from "../test/agent.ts"
import SessionView from "./SessionView.vue"

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

test.each([
  { via: "mcp", sender: "AI", icon: "bot", otherVia: "super_agent_mcp", creator: "Super Agent", creatorIcon: "orbit" },
  { via: "super_agent_mcp", sender: "Super Agent", icon: "orbit", otherVia: "mcp", creator: "AI", creatorIcon: "bot" },
] as const)("distinguishes $sender prompts from the $creator that created the Session", async ({ via, sender, icon, otherVia, creator, creatorIcon }) => {
  const pinia = createPinia()
  cleanup.push(() => disposePinia(pinia))
  const agents = useAgentSessionsStore(pinia)
  vi.spyOn(agents, "open").mockResolvedValue()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/sessions/:sessionId", name: "session", component: SessionView }] })
  await router.push("/sessions/30")
  const snapshot = agentSnapshot()
  const delegated = { ...actor, userId: "Ada Lovelace", via }
  snapshot.session.createdBy = { ...delegated, via: otherVia }
  const sent = agentInput({ author: delegated, state: "delivered" })
  const manual = agentInput({ id: "41", state: "delivered" })
  const queued = agentInput({ id: "42", author: { kind: "local_token", via } })
  snapshot.inputs = [sent, manual, queued]
  agents.views["30"] = { snapshot, events: snapshot.inputs.map((input, i) => agentEvent(i + 1, "input", input)), loading: false, error: null, historySeq: "3", snapshotSeq: "3" }
  const view = mount(SessionView, { props: { sessionId: "30" }, attachTo: document.body, global: {
    plugins: [pinia, router, i18n], provide: { [windowHeaderActionsTargetKey as symbol]: null }, stubs: {
      PaneHeader: { template: '<header><slot /><slot name="actions" /></header>' },
      SessionConversationPane: { template: '<main><slot :focused-entry="undefined" /><slot name="notices" /></main>' },
    },
  } })
  cleanup.push(() => view.unmount())
  await flushPromises()

  const badge = view.get(`header button[aria-label="Session created by ${creator} · Authorized by Ada Lovelace"]`)
  expect(badge.text()).toBe("A")
  expect(badge.find(`.lucide-${creatorIcon}`).exists()).toBe(true)
  const message = view.get('[data-conversation-entry="input-40"]')
  expect(message.get("[data-user-message-meta] .font-medium").text()).toBe(sender)
  expect(view.get('[data-conversation-entry="input-41"] [data-user-message-meta] .font-medium').text()).toBe("Ada")
  expect(view.find(`[data-input-id="42"] button[aria-label="Sent by ${sender}"] .lucide-${icon}`).exists()).toBe(true)
  const author = message.get(`button[aria-label="Sent by ${sender} · Authorized by Ada Lovelace"]`)
  expect(author.find(`.lucide-${icon}`).exists()).toBe(true)
  await author.trigger("click")
  await flushPromises()
  expect(document.querySelector(`[role="dialog"][aria-label="Sent by ${sender}"]`)?.textContent).toContain("Authorized by Ada Lovelace")
})
