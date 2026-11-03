import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { reactive, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
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
