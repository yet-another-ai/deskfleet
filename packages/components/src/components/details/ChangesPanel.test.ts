import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { reactive, ref } from "vue"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import * as mermaidService from "../../services/mermaid.ts"
import { openMermaidSidebarTab, resetMermaidSidebarTabs } from "../../stores/layout.ts"
import { agentSnapshot } from "../../test/agent.ts"
import ChangesPanel from "./ChangesPanel.vue"

const context = ref({ session: { id: "30", archiveState: "active" }, machine: { online: true } })
const stop = vi.fn()
const service = reactive({
  state: "connected",
  sessions: { "30": agentSnapshot().session },
  gitStatus: vi.fn(async () => ({ sessionId: "30", directories: [], repositories: [] })),
  gitDiff: vi.fn(),
  watchGit: vi.fn(async () => stop),
})
vi.mock("../../composables/useRouteWorktree.ts", () => ({ useRouteWorktree: () => context }))
vi.mock("../../stores/agent-sessions.ts", () => ({ useAgentSessionsStore: () => service }))
let unmount: (() => void) | undefined
let pinia: ReturnType<typeof createPinia> | undefined

// locateMermaidInMainView may navigate to the session route; compile it once so a cold
// import cannot consume the default 5s test deadline under macOS CI contention.
beforeAll(async () => {
  await import("../../views/SessionView.vue")
})

/** Prefer microtask drains over wall-clock waitFor when asserting post-render Mermaid UI. */
async function settled(probe: () => void): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      probe()
      return
    } catch (reason) {
      failure = reason
    }
    await flushPromises()
  }
  throw failure
}

beforeEach(() => {
  window.localStorage.clear()
  pinia = createPinia()
  resetMermaidSidebarTabs()
  service.sessions["30"] = agentSnapshot().session
  service.gitStatus.mockClear()
  service.watchGit.mockClear()
  stop.mockClear()
})
afterEach(async () => {
  unmount?.()
  unmount = undefined
  if (pinia) disposePinia(pinia)
  pinia = undefined
  resetMermaidSidebarTabs()
  await router.replace("/")
  vi.restoreAllMocks()
})

test("archiving and restoring the same Session release and recreate Git observation", async () => {
  const wrapper = mount(ChangesPanel, { global: { plugins: [pinia!, i18n] } })
  unmount = () => wrapper.unmount()
  await flushPromises()
  expect(service.watchGit).toHaveBeenCalledOnce()
  service.sessions["30"].archiveState = "archiving"
  await flushPromises()
  expect(stop).toHaveBeenCalledOnce()
  expect(wrapper.text()).toContain("Archiving this session")
  service.sessions["30"].archiveState = "archived"
  await flushPromises()
  expect(service.watchGit).toHaveBeenCalledOnce()
  service.sessions["30"].archiveState = "active"
  await flushPromises()
  expect(service.watchGit).toHaveBeenCalledTimes(2)
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
})

test("opening the file tree keeps the Changes panel width", async () => {
  const wrapper = mount(ChangesPanel, { global: { plugins: [pinia!, i18n] } })
  unmount = () => wrapper.unmount()
  await flushPromises()
  const aside = wrapper.get('aside[aria-label="Changes"]')
  const width = aside.attributes("style")
  expect(wrapper.find("[data-git-tree]").exists()).toBe(false)
  await wrapper.get("[data-git-tree-toggle]").trigger("click")
  expect(wrapper.find("[data-git-tree]").exists()).toBe(true)
  expect(wrapper.find("[data-git-split]").exists()).toBe(true)
  expect(aside.attributes("style")).toBe(width)
  await wrapper.get("[data-git-tree-toggle]").trigger("click")
  expect(wrapper.find("[data-git-tree]").exists()).toBe(false)
  expect(aside.attributes("style")).toBe(width)
})

test("only ready execution contexts attach Git observation", async () => {
  service.sessions["30"].lifecycle = "provisioning"
  const wrapper = mount(ChangesPanel, { global: { plugins: [pinia!, i18n] } })
  unmount = () => wrapper.unmount()
  await flushPromises()
  expect(service.watchGit).not.toHaveBeenCalled()
  service.sessions["30"].lifecycle = "ready"
  await flushPromises()
  expect(service.watchGit).toHaveBeenCalledOnce()
})

test("displays opened Mermaid diagrams in a dedicated right sidebar tab, locates original message, and closes cleanly", async () => {
  // Mock before navigation/mount so MermaidViewer never starts a real mermaid import.
  vi.spyOn(mermaidService, "renderMermaidDiagram").mockResolvedValue('<svg data-test-sidebar-mermaid="ok"></svg>')
  await router.push("/sessions/30")
  const messageEntry = document.createElement("div")
  messageEntry.dataset.conversationEntry = "message-7"
  const inlineMermaid = document.createElement("div")
  inlineMermaid.dataset.mermaid = "0"
  inlineMermaid.dataset.mermaidMode = "inline"
  inlineMermaid.dataset.mermaidCode = "graph TD\n  A --> B"
  const scrollIntoView = vi.fn()
  inlineMermaid.scrollIntoView = scrollIntoView
  messageEntry.appendChild(inlineMermaid)
  document.body.appendChild(messageEntry)

  const wrapper = mount(ChangesPanel, { attachTo: document.body, global: { plugins: [pinia!, i18n, router] } })
  unmount = () => {
    wrapper.unmount()
    messageEntry.remove()
  }
  await flushPromises()
  openMermaidSidebarTab("graph TD\n  A --> B", { sessionId: "30", entryId: "message-7", diagramId: "0" })
  await settled(() => {
    expect(wrapper.find('[data-mermaid-tab="mermaid-1"]').exists()).toBe(true)
    expect(wrapper.find('svg[data-test-sidebar-mermaid="ok"]').exists()).toBe(true)
  })

  const locateButton = wrapper.get('[data-mermaid-action="locate-message"]')
  await locateButton.trigger("click")
  await settled(() => {
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" })
    expect(inlineMermaid.dataset.mermaidLocated).toBe("true")
  })

  await wrapper.get("[data-mermaid-tab-close]").trigger("click")
  await settled(() => expect(wrapper.find('[data-mermaid-tab="mermaid-1"]').exists()).toBe(false))
})
