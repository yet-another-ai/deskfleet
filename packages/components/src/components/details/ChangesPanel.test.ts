import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { reactive, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
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
beforeEach(() => {
  window.localStorage.clear()
  pinia = createPinia()
  resetMermaidSidebarTabs()
  service.sessions["30"] = agentSnapshot().session
  service.gitStatus.mockClear()
  service.watchGit.mockClear()
  stop.mockClear()
})
afterEach(() => {
  unmount?.()
  unmount = undefined
  if (pinia) disposePinia(pinia)
  pinia = undefined
  resetMermaidSidebarTabs()
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
  await router.push("/sessions/30")
  vi.spyOn(mermaidService, "renderMermaidDiagram").mockResolvedValue('<svg data-test-sidebar-mermaid="ok"></svg>')
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
  await flushPromises()
  expect(wrapper.find('[data-mermaid-tab="mermaid-1"]').exists()).toBe(true)
  expect(wrapper.find('svg[data-test-sidebar-mermaid="ok"]').exists()).toBe(true)

  const locateButton = wrapper.get('[data-mermaid-action="locate-message"]')
  await locateButton.trigger("click")
  await flushPromises()
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" })
  expect(inlineMermaid.dataset.mermaidLocated).toBe("true")

  await wrapper.get("[data-mermaid-tab-close]").trigger("click")
  await flushPromises()
  expect(wrapper.find('[data-mermaid-tab="mermaid-1"]').exists()).toBe(false)
})
