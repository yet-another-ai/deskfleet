import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import type { GitPreparationSnapshot } from "../../../../../apps/daemon/src/git-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import type { WorkspaceLocation } from "../../stores/fleet.ts"
import { deferred } from "../../test/desktop-media.ts"
import SessionPreparation from "./SessionPreparation.vue"
import SessionComposer from "./SessionComposer.vue"

const location: WorkspaceLocation = {
  machine: { id: "first-machine", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] },
  workspace: { id: "1", name: "Workspace", directories: [{ path: "/repo" }], sessions: [], terminals: [] },
}
const ready: GitPreparationSnapshot = {
  workspaceId: "1", context: "worktree", status: "ready", repositories: [{ root: "/repo", branch: "main", changes: [] }],
  baseRevisions: [{ path: "/repo", revision: "a".repeat(40) }],
}
const dirty: GitPreparationSnapshot = {
  workspaceId: "1", context: "directory", status: "confirmation_required", confirmationToken: "observed-changes",
  repositories: [{ root: "/repo", branch: "main", changes: ["src/app.ts", "README.md"] }],
}
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper
afterEach(() => { wrapper?.unmount(); if (pinia) disposePinia(pinia); vi.restoreAllMocks() })
const page = () => new DOMWrapper(document.body)
function setup(context: "directory" | "worktree" = "worktree") {
  pinia = createPinia()
  const prepare = vi.spyOn(useAgentSessionsStore(pinia), "prepareGit")
  wrapper = mount(SessionPreparation, { props: { location, context }, attachTo: document.body, global: { plugins: [pinia, i18n] } })
  return prepare
}

test("preparation keeps pinned revisions across catalog refreshes and clears them when the execution context changes", async () => {
  const prepare = setup().mockResolvedValue(ready)
  await wrapper.get("[data-prepare-session]").trigger("click")
  await flushPromises()
  expect(prepare).toHaveBeenCalledExactlyOnceWith("1", "worktree")
  expect(wrapper.emitted("update:baseRevisions")?.at(-1)).toEqual([ready.baseRevisions])
  expect(wrapper.emitted("update:branches")?.at(-1)).toEqual([["main"]])
  expect(wrapper.get("[data-prepare-session]").attributes("aria-label")).toBe("Ready")
  await wrapper.setProps({ location: structuredClone(location) })
  expect(wrapper.emitted("update:baseRevisions")?.at(-1)).toEqual([ready.baseRevisions])
  expect(wrapper.get("[data-prepare-session]").attributes("aria-label")).toBe("Ready")
  await wrapper.setProps({ context: "directory" })
  expect(wrapper.emitted("update:baseRevisions")?.at(-1)).toEqual([undefined])
  expect(wrapper.get("[data-prepare-session]").attributes("aria-label")).toBe("Prepare")
})

test("directory preparation lists changed files and cancellation never sends the destructive request", async () => {
  const prepare = setup("directory").mockResolvedValue(dirty)
  await wrapper.get("[data-prepare-session]").trigger("click")
  await flushPromises()
  expect(page().get('[role="dialog"]').text()).toContain("src/app.ts")
  expect(page().get('[role="dialog"]').text()).toContain("other sessions")
  await wrapper.setProps({ location: structuredClone(location) })
  expect(page().get('[role="dialog"]').text()).toContain("src/app.ts")
  expect(wrapper.get("[data-prepare-session]").attributes("disabled")).toBeDefined()
  await page().get("[data-prepare-cancel]").trigger("click")
  await flushPromises()
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  expect(wrapper.get("[data-prepare-session]").attributes("disabled")).toBeUndefined()
})

test("discard confirmation sends the exact observed token and accepts refreshed changes for another confirmation", async () => {
  const prepare = setup("directory").mockResolvedValueOnce(dirty)
    .mockResolvedValueOnce({ ...dirty, confirmationToken: "new-changes", repositories: [{ root: "/repo", branch: "main", changes: ["new-edit.ts"] }] })
    .mockResolvedValueOnce({ ...ready, context: "directory", baseRevisions: undefined })
  await wrapper.get("[data-prepare-session]").trigger("click")
  await flushPromises()
  await page().get("[data-prepare-confirm]").trigger("click")
  await flushPromises()
  expect(prepare).toHaveBeenNthCalledWith(2, "1", "directory", "observed-changes")
  expect(page().get('[role="dialog"]').text()).toContain("new-edit.ts")
  await page().get("[data-prepare-confirm]").trigger("click")
  await flushPromises()
  expect(prepare).toHaveBeenNthCalledWith(3, "1", "directory", "new-changes")
  expect(wrapper.get("[data-prepare-session]").attributes("aria-label")).toBe("Ready")
  expect(wrapper.emitted("update:baseRevisions")?.at(-1)?.[0]).toBeUndefined()
})

test("a failed fetch is visible and does not leave the action blocked", async () => {
  setup().mockRejectedValue(new Error("Remote is unavailable"))
  await wrapper.get("[data-prepare-session]").trigger("click")
  await flushPromises()
  expect(page().get('[role="alert"]').text()).toBe("Remote is unavailable")
  expect(wrapper.get("[data-prepare-session]").attributes("disabled")).toBeUndefined()
})

test("late responses cannot prepare another machine with the same workspace ID", async () => {
  const pending = deferred<GitPreparationSnapshot>()
  setup().mockReturnValue(pending.promise)
  await wrapper.get("[data-prepare-session]").trigger("click")
  await wrapper.setProps({ location: { ...location, machine: { ...location.machine, id: "second-machine" } } })
  pending.resolve(ready)
  await flushPromises()
  expect(wrapper.get("[data-prepare-session]").attributes("aria-label")).toBe("Prepare")
  expect((wrapper.emitted("update:baseRevisions") ?? []).every(args => args[0] === undefined)).toBe(true)
  await wrapper.setProps({ location: { ...location, machine: { ...location.machine, online: false } } })
  expect(wrapper.get("[data-prepare-session]").attributes("disabled")).toBeDefined()
})

test("changing workspace directories invalidates prepared revisions and refreshes branch choices", async () => {
  pinia = createPinia()
  const agents = useAgentSessionsStore(pinia)
  const branches = vi.spyOn(agents, "gitBranches")
    .mockResolvedValueOnce({ workspaceId: "1", currentBranch: "feature", branches: ["feature", "main"] })
    .mockResolvedValueOnce({ workspaceId: "1", currentBranch: "release", branches: ["release"] })
  vi.spyOn(agents, "prepareGit").mockResolvedValue(ready)
  wrapper = mount(SessionComposer, { props: { location, showTarget: true, context: "worktree" }, attachTo: document.body,
    global: { plugins: [pinia, i18n, router], stubs: { AgentConfigurationSelector: true } } })
  await flushPromises()
  await wrapper.get("[data-prepare-session]").trigger("click")
  await flushPromises()
  await wrapper.setProps({ location: { ...location, workspace: { ...location.workspace, directories: [{ path: "/other-repo" }] } } })
  await flushPromises()
  expect(branches).toHaveBeenCalledTimes(2)
  expect(wrapper.emitted("update:baseRevisions")?.at(-1)).toEqual([undefined])
  expect(wrapper.get("[data-prepare-session]").attributes("aria-label")).toBe("Prepare")
  expect(wrapper.get("[data-composer-branch]").text()).toBe("release")
})

test.each(["directory", "worktree"] as const)("delayed branch discovery preserves %s preparation", async context => {
  pinia = createPinia()
  const agents = useAgentSessionsStore(pinia)
  const pending = deferred<Awaited<ReturnType<typeof agents.gitBranches>>>()
  const branches = vi.spyOn(agents, "gitBranches").mockReturnValue(pending.promise)
  vi.spyOn(agents, "prepareGit").mockResolvedValue(context === "worktree" ? ready : dirty)
  wrapper = mount(SessionComposer, { props: { location, showTarget: true, context, modelValue: "Next task" }, attachTo: document.body,
    global: { plugins: [pinia, i18n, router], stubs: { AgentConfigurationSelector: true } } })
  await wrapper.get("[data-prepare-session]").trigger("click")
  await flushPromises()
  await wrapper.setProps({ location: structuredClone(location) })
  expect(branches).toHaveBeenCalledExactlyOnceWith("1")
  pending.resolve({ workspaceId: "1", currentBranch: "feature", branches: ["feature", "main"] })
  await flushPromises()
  if (context === "worktree") {
    expect(wrapper.get("[data-prepare-session]").attributes("aria-label")).toBe("Ready")
    expect(wrapper.get("[data-composer-branch]").text()).toBe("Latest main")
    expect(wrapper.emitted("update:baseRevisions")?.at(-1)).toEqual([ready.baseRevisions])
  } else {
    expect(page().get('[role="dialog"]').text()).toContain("src/app.ts")
    expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeDefined()
    await page().get("[data-prepare-cancel]").trigger("click")
  }
})

test("preparation blocks submitting and changing execution context until it completes", async () => {
  pinia = createPinia()
  const agents = useAgentSessionsStore(pinia)
  const pending = deferred<GitPreparationSnapshot>()
  vi.spyOn(agents, "prepareGit").mockReturnValue(pending.promise)
  vi.spyOn(agents, "gitBranches").mockResolvedValue({ workspaceId: "1", currentBranch: "feature", branches: ["feature", "main"] })
  wrapper = mount(SessionComposer, { props: { location, showTarget: true, context: "worktree", modelValue: "Next task" }, attachTo: document.body,
    global: { plugins: [pinia, i18n, router], stubs: { AgentConfigurationSelector: true } } })
  await flushPromises()
  await wrapper.get("[data-prepare-session]").trigger("click")
  expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeDefined()
  expect(wrapper.get('[aria-label="New worktree"]').attributes("disabled")).toBeDefined()
  expect(wrapper.get("[data-composer-branch]").attributes("disabled")).toBeDefined()
  await wrapper.get("textarea").trigger("keydown", { key: "Enter" })
  expect(wrapper.emitted("submit")).toBeUndefined()
  pending.resolve(ready)
  await flushPromises()
  expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeUndefined()
  expect(wrapper.get("[data-composer-branch]").text()).toBe("Latest main")
  await wrapper.get("[data-composer-branch]").trigger("click")
  await flushPromises()
  await page().findAll('[role="menuitemradio"]').find(item => item.text() === "feature")!.trigger("click")
  await flushPromises()
  expect(wrapper.get("[data-composer-branch]").text()).toBe("feature")
  expect(wrapper.emitted("update:baseRevisions")?.at(-1)).toEqual([undefined])
})
