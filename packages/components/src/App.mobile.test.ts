import { client as platformClient } from "@deskfleet/client/platform"
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import App from "./App.vue"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import { useLayoutStore } from "./stores/layout.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { useTerminalsStore } from "./stores/terminals.ts"
import { agentSnapshot } from "./test/agent.ts"
import { catalogFixture, sessionId, sessionWorktreeId, workspaceId } from "./test/catalog.ts"

let wrapper: VueWrapper | undefined
let pinia: ReturnType<typeof createPinia>
let setWidth: (width: number) => void

beforeAll(async () => {
  await Promise.all([import("./views/NewSessionView.vue"), import("./views/SessionView.vue"), import("./views/ArchivedSessionsView.vue"), import("./components/terminal/TerminalShellWindow.vue")])
})
beforeEach(() => {
  window.localStorage.clear()
  pinia = createPinia()
  let width = 390
  const queries: (EventTarget & { matches: boolean; media: string })[] = []
  vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const media = Object.assign(new EventTarget(), { matches: query.includes("max-width") && width < 1024, media: query })
    queries.push(media)
    return media as MediaQueryList
  })
  setWidth = value => {
    width = value
    for (const media of queries) {
      media.matches = media.media.includes("max-width") && width < 1024
      media.dispatchEvent(Object.assign(new Event("change"), { matches: media.matches }))
    }
  }
  vi.spyOn(platformClient.catalog, "list").mockResolvedValue(catalogFixture())
  vi.spyOn(platformClient.desktop, "target").mockResolvedValue({ id: "local-daemon", name: "test-host", online: true, desktop: true })
})
afterEach(async () => {
  wrapper?.unmount()
  wrapper = undefined
  disposePinia(pinia)
  await router.replace("/")
  vi.restoreAllMocks()
})

async function mountApp(path = "/") {
  await router.push(path)
  wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], stubs: { LiveTerminal: { props: ["terminalId"], template: '<div data-terminal :data-id="terminalId" />' } } },
  })
  await flushPromises()
  return new DOMWrapper(document.body)
}

test("compact drawers preserve desktop sidebar state across viewport changes", async () => {
  window.localStorage.setItem("deskfleet.sidebar-open", "false")
  window.localStorage.setItem("deskfleet.sidebar-width", "420")
  const view = await mountApp(`/sessions/${sessionId}`)
  const layout = useLayoutStore(pinia)
  expect(view.find("aside").exists()).toBe(false)
  await view.get('main [aria-label="Show sidebar"]').trigger("click")
  expect(view.get<HTMLElement>('[role="dialog"] aside').element.style.width).toBe("100%")
  expect(view.find('[role="separator"]').exists()).toBe(false)
  layout.toggleDetails()
  await flushPromises()
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  expect(view.get('[data-mobile-view="changes"]').attributes("aria-hidden")).toBe("false")
  expect(view.find('[role="separator"]').exists()).toBe(false)
  expect(window.localStorage.getItem("deskfleet.sidebar-open")).toBe("false")
  expect(window.localStorage.getItem("deskfleet.sidebar-width")).toBe("420")

  setWidth(1024)
  await flushPromises()
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  expect(view.findAll("aside")).toHaveLength(1)
  expect(view.get('aside[aria-label="Changes"]').classes()).toContain("w-full")
  layout.toggleSidebar()
  await flushPromises()
  expect(view.get<HTMLElement>("aside:not([aria-label])").element.style.width).toBe("420px")
  setWidth(768)
  await flushPromises()
  expect(view.find("aside").exists()).toBe(false)
  setWidth(1280)
  await flushPromises()
  expect(view.findAll("aside")).toHaveLength(2)
})

test("Escape closes a compact drawer and returns focus to its visible opener", async () => {
  const view = await mountApp()
  const opener = view.get<HTMLButtonElement>('main [aria-label="Show sidebar"]')
  opener.element.focus()
  await opener.trigger("click")
  await vi.waitFor(() => expect(view.get('[role="dialog"]').element.contains(document.activeElement)).toBe(true))
  await view.get('[role="dialog"]').trigger("keydown", { key: "Escape" })
  await vi.waitFor(() => expect(view.find('[role="dialog"]').exists()).toBe(false))
  await vi.waitFor(() => expect(document.activeElement).toBe(opener.element))
})

test("compact navigation closes on both a new destination and the current destination", async () => {
  const view = await mountApp()
  await view.get('main [aria-label="Show sidebar"]').trigger("click")
  await view.get('[role="dialog"] a[aria-label="Conversations"]').trigger("click")
  await flushPromises()
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  await view.get('main [aria-label="Show sidebar"]').trigger("click")
  await view.get('[data-archived-sessions]').trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  expect(window.localStorage.getItem("deskfleet.sidebar-open")).toBe("true")
})

test("unmounting a machine surface clears its compact drawer before the runtime is reused", async () => {
  const view = await mountApp()
  await view.get('main [aria-label="Show sidebar"]').trigger("click")
  wrapper!.unmount()
  wrapper = undefined
  const remounted = await mountApp()
  expect(remounted.find('[role="dialog"]').exists()).toBe(false)
  expect(remounted.find("aside").exists()).toBe(false)
})

test("the overview switches flat views without remounting the conversation or hanging up shells", async () => {
  const agents = useAgentSessionsStore(pinia)
  agents.sessions[sessionId] = { ...agentSnapshot().session, id: sessionId, workspaceId, title: "Mobile conversation" }
  agents.drafts[sessionId] = "Unsent draft"
  vi.spyOn(agents, "refresh").mockResolvedValue()
  vi.spyOn(platformClient.terminal, "list").mockResolvedValue([
    { id: "shell-1", title: "Build shell", worktreeId: sessionWorktreeId, cwd: "/worktree", cols: 80, rows: 24, status: "running" },
    { id: "shell-2", title: "Test shell", worktreeId: sessionWorktreeId, cwd: "/worktree", cols: 80, rows: 24, status: "running" },
  ])
  const hangup = vi.spyOn(platformClient.terminal, "hangup")
  const submit = vi.spyOn(agents, "submit")
  const view = await mountApp(`/sessions/${sessionId}`)
  const conversation = view.get('[data-mobile-view="chat"] textarea').element
  const originalParent = conversation.parentElement
  expect(view.find("[data-terminal]").exists()).toBe(false)
  const terminals = useTerminalsStore(pinia)
  terminals.titles["shell-1"] = "Build shell"
  terminals.titles["shell-2"] = "Test shell"
  await view.get("[data-open-overview]").trigger("click")
  await flushPromises()
  expect(view.get('[data-view-overview] [data-mobile-view="chat"] textarea').element).toBe(conversation)
  expect(conversation.parentElement).toBe(originalParent)
  expect(view.find("[data-terminal]").exists()).toBe(false)
  expect(view.findAll("[data-unopened-terminal]")).toHaveLength(2)
  agents.drafts[sessionId] = "Updated while in overview"
  await flushPromises()
  expect(view.get<HTMLTextAreaElement>('[data-view-overview] textarea').element.value).toBe("Updated while in overview")
  expect(view.find('[role="tablist"]').exists()).toBe(false)
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  expect(view.get("[data-open-overview]").attributes("aria-expanded")).toBe("true")
  await view.get('[data-view-overview] [aria-label="Build shell"]').trigger("click")
  await flushPromises()
  const terminal = view.get('[data-terminal][data-id="shell-1"]').element
  expect(view.find('[data-terminal][data-id="shell-2"]').exists()).toBe(false)
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  expect(view.get('[data-mobile-view="terminal:shell-1"]').attributes("aria-hidden")).toBe("false")
  await view.get("[data-open-overview]").trigger("click")
  expect(view.get('[data-terminal][data-id="shell-1"]').element).toBe(terminal)
  expect(view.find('[data-terminal][data-id="shell-2"]').exists()).toBe(false)
  await view.get('[data-view-overview] [aria-label="Test shell"]').trigger("click")
  await flushPromises()
  expect(view.get('[data-terminal][data-id="shell-1"]').element).toBe(terminal)
  await view.get("[data-open-overview]").trigger("click")
  await view.get('[data-view-overview] [aria-label="Mobile conversation"]').trigger("click")
  await flushPromises()
  expect(view.get('[data-mobile-view="chat"] textarea').element).toBe(conversation)
  expect(agents.drafts[sessionId]).toBe("Updated while in overview")
  expect(hangup).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

test("preview requests open a mobile view that can be closed from the overview", async () => {
  const view = await mountApp(`/sessions/${sessionId}`)
  expect(useLayoutStore(pinia).requestSessionWindow({ kind: "preview", item: { kind: "image", title: "Screenshot", content: "https://example.com/image.png", source: { sessionId } } })).toBe(true)
  await flushPromises()
  const preview = view.get('[data-mobile-view^="preview:"]')
  expect(preview.attributes("aria-hidden")).toBe("false")
  expect(view.find('[role="dialog"]').exists()).toBe(false)
  await view.get("[data-open-overview]").trigger("click")
  await view.get('[data-view-overview] [aria-label="Close Screenshot"]').trigger("click")
  expect(view.find('[data-mobile-view^="preview:"]').exists()).toBe(false)
  expect(view.find('[data-view-overview]').exists()).toBe(true)
  await view.get('[data-mobile-windows]').trigger('keydown', { key: 'Escape' })
  await flushPromises()
  expect(view.find('[data-view-overview]').exists()).toBe(false)
  expect(view.get('[data-mobile-view="chat"]').attributes("aria-hidden")).toBe("false")
  expect(document.activeElement).toBe(view.get('[data-open-overview]').element)
})

test("content swipes navigate horizontally, bounce at the boundary, and cancel interrupted gestures", async () => {
  const view = await mountApp(`/sessions/${sessionId}`)
  const viewport = view.get<HTMLElement>("[data-mobile-viewport]").element
  Object.defineProperty(viewport, "clientWidth", { value: 390 })
  expect(view.find("[data-viewport-edge]").exists()).toBe(false)
  const active = () => view.findAll("[data-mobile-view]").find(pane => pane.attributes("aria-hidden") === "false")!.attributes("data-mobile-view")
  async function swipe(selector: string, dx: number, dy = 0, end = "pointerup") {
    const target = view.get<HTMLElement>(selector)
    target.element.setPointerCapture = vi.fn()
    const event = { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 200, clientY: 200 }
    await target.trigger("pointerdown", event)
    await target.trigger("pointermove", { ...event, clientX: 200 + dx, clientY: 200 + dy })
    await target.trigger(end, { ...event, clientX: 200 + dx, clientY: 200 + dy })
    await flushPromises()
  }
  await swipe('[data-mobile-view="chat"]', 120)
  expect(active()).toBe("chat")
  await swipe('[data-mobile-view="chat"]', -10, 150)
  expect(active()).toBe("chat")
  await swipe('[data-mobile-view="chat"]', -150, 0, "pointercancel")
  expect(active()).toBe("chat")
  await swipe('[data-mobile-view="chat"]', -150)
  expect(active()).toBe("changes")
  await swipe('[data-mobile-view="changes"]', -150)
  expect(active()).toBe("changes")
  await swipe('[data-mobile-view="changes"]', 150)
  expect(active()).toBe("chat")

  const terminals = useTerminalsStore(pinia)
  terminals.sessions = [{ id: "shell-1", title: "Build shell", worktreeId: sessionWorktreeId, cwd: "/worktree", cols: 80, rows: 24, status: "running" }]
  await flushPromises()
  await swipe('[data-mobile-view="chat"]', -150)
  expect(active()).toBe("changes")
  await swipe('[data-mobile-view="changes"]', -150, 0, "pointercancel")
  expect(active()).toBe("changes")
  expect(view.find("[data-terminal]").exists()).toBe(false)
  await swipe('[data-mobile-view="changes"]', -150)
  expect(active()).toBe("terminal:shell-1")
  expect(view.find('[data-terminal][data-id="shell-1"]').exists()).toBe(true)
})
