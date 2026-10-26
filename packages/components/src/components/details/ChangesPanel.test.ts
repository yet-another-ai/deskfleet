import { flushPromises, mount } from "@vue/test-utils"
import { reactive, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
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
beforeEach(() => {
  service.sessions["30"] = agentSnapshot().session
  service.gitStatus.mockClear()
  service.watchGit.mockClear()
  stop.mockClear()
})
afterEach(() => { unmount?.(); unmount = undefined })

test("archiving and restoring the same Session release and recreate Git observation", async () => {
  const wrapper = mount(ChangesPanel, { global: { plugins: [i18n] } })
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
  const wrapper = mount(ChangesPanel, { global: { plugins: [i18n] } })
  unmount = () => wrapper.unmount()
  await flushPromises()
  expect(service.watchGit).not.toHaveBeenCalled()
  service.sessions["30"].lifecycle = "ready"
  await flushPromises()
  expect(service.watchGit).toHaveBeenCalledOnce()
})
