import { flushPromises } from "@vue/test-utils"
import { effectScope, nextTick, reactive, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { GitDiffRequest, GitFileChange, GitFileDiff, GitStatusSnapshot } from "../../../../apps/daemon/src/git-protocol.ts"
import { deferred } from "../test/desktop-media.ts"
import { useSessionGit } from "./useSessionGit.ts"

const service = reactive({
  state: "connected",
  gitStatus: vi.fn<(sessionId: string) => Promise<GitStatusSnapshot>>(),
  gitDiff: vi.fn<(request: GitDiffRequest) => Promise<GitFileDiff>>(),
})
vi.mock("../stores/agent-sessions.ts", () => ({ useAgentSessionsStore: () => service }))
const change: GitFileChange = { path: "file.txt", kind: "unstaged", status: "modified", additions: 1, deletions: 1 }
const status = (sessionId = "30", changes = [change]): GitStatusSnapshot => ({
  sessionId, directories: [{ path: "/repo", repositoryId: "repo" }],
  repositories: [{ id: "repo", root: "/repo", branch: "main", head: "abc123", changes }],
})
const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  const sessionId = ref("30")
  const enabled = ref(true)
  const git = scope.run(() => useSessionGit(sessionId, enabled))!
  return { scope, sessionId, enabled, git }
}
beforeEach(() => {
  vi.useFakeTimers()
  service.state = "connected"
  service.gitStatus.mockReset().mockImplementation(async id => status(id))
  service.gitDiff.mockReset().mockImplementation(async request => ({ ...request, patch: "+first", binary: false, truncated: false }))
})
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
})

test("refreshes status and the open diff even when file status and line counts stay the same", async () => {
  const { git } = setup()
  await flushPromises()
  expect(git.snapshot.value?.sessionId).toBe("30")
  git.select("repo", change)
  await flushPromises()
  expect(git.diff.value?.patch).toBe("+first")
  service.gitDiff.mockImplementation(async request => ({ ...request, patch: "+later", binary: false, truncated: false }))
  await vi.advanceTimersByTimeAsync(1_500)
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
  expect(git.diff.value?.patch).toBe("+later")
  service.gitStatus.mockResolvedValue(status("30", []))
  await vi.advanceTimersByTimeAsync(1_500)
  expect(git.selection.value).toBeNull()
  expect(git.diff.value).toBeNull()
})

test("serializes refreshes and stops polling when its scope is disposed", async () => {
  const result = deferred<GitStatusSnapshot>()
  service.gitStatus.mockReturnValue(result.promise)
  const { scope, git } = setup()
  const refresh = git.refresh()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  scope.stop()
  result.resolve(status())
  await refresh
  await vi.advanceTimersByTimeAsync(5_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  expect(git.snapshot.value).toBeNull()
})

test("late status responses cannot replace the newly selected Session", async () => {
  const old = deferred<GitStatusSnapshot>()
  service.gitStatus.mockReturnValueOnce(old.promise)
  const { sessionId, git } = setup()
  sessionId.value = "31"
  await flushPromises()
  expect(git.snapshot.value?.sessionId).toBe("31")
  old.resolve(status("30"))
  await flushPromises()
  expect(git.snapshot.value?.sessionId).toBe("31")
  await vi.advanceTimersByTimeAsync(1_500)
  expect(service.gitStatus.mock.calls.map(([id]) => id)).toEqual(["30", "31", "31"])
})

test("late diff responses cannot overwrite another file or reopen a dismissed preview", async () => {
  const old = deferred<GitFileDiff>()
  const { git } = setup()
  await flushPromises()
  service.gitDiff.mockReturnValueOnce(old.promise)
  git.select("repo", change)
  const oldRequest = service.gitDiff.mock.calls[0]![0]
  git.select("repo", { ...change, path: "second.txt" })
  await flushPromises()
  expect(git.diff.value?.path).toBe("second.txt")
  old.resolve({ ...oldRequest, patch: "old", binary: false, truncated: false })
  await flushPromises()
  expect(git.diff.value?.path).toBe("second.txt")
  const closing = deferred<GitFileDiff>()
  service.gitDiff.mockReturnValueOnce(closing.promise)
  git.select("repo", change)
  git.closeDiff()
  closing.resolve({ ...oldRequest, patch: "closed", binary: false, truncated: false })
  await flushPromises()
  expect(git.diff.value).toBeNull()
})

test("retains the last snapshot with an error and recovers on the next refresh", async () => {
  const { git } = setup()
  await flushPromises()
  service.gitStatus.mockRejectedValueOnce(new Error("Git unavailable"))
  await vi.advanceTimersByTimeAsync(1_500)
  expect(git.error.value).toBe("Git unavailable")
  expect(git.snapshot.value?.repositories).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1_500)
  expect(git.error.value).toBeNull()
  expect(git.loading.value).toBe(false)
})

test("disabling a target stops reads and reconnecting refreshes the active target immediately", async () => {
  const { enabled, git } = setup()
  await flushPromises()
  enabled.value = false
  await nextTick()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  expect(git.snapshot.value).toBeNull()
  enabled.value = true
  await flushPromises()
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
  service.state = "error"
  await nextTick()
  service.state = "connected"
  await flushPromises()
  expect(service.gitStatus).toHaveBeenCalledTimes(3)
})

test("hidden windows suspend polling and refresh as soon as they become visible", async () => {
  const { git } = setup()
  await flushPromises()
  const visibility = vi.spyOn(document, "visibilityState", "get")
  visibility.mockReturnValue("hidden")
  document.dispatchEvent(new Event("visibilitychange"))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  visibility.mockReturnValue("visible")
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
  expect(git.snapshot.value?.sessionId).toBe("30")
})
