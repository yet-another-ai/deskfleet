import { flushPromises } from "@vue/test-utils"
import { effectScope, nextTick, reactive, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { GitDiffRequest, GitFileChange, GitFileDiff, GitStatusSnapshot } from "../../../../apps/daemon/src/git-protocol.ts"
import { deferred } from "../test/desktop-media.ts"
import { gitDiffCardKey } from "../components/details/git-diff-card.ts"
import { useSessionGit } from "./useSessionGit.ts"

const service = reactive({
  state: "connected",
  gitStatus: vi.fn<(sessionId: string, force?: boolean) => Promise<GitStatusSnapshot>>(),
  gitDiff: vi.fn<(request: GitDiffRequest) => Promise<GitFileDiff>>(),
  watchGit: vi.fn<(sessionId: string, notify: (error?: string) => void) => Promise<() => void>>(),
})
const observations: { sessionId: string; notify(error?: string): void; stop: ReturnType<typeof vi.fn> }[] = []
const changed = (error?: string) => observations.at(-1)!.notify(error)
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
  observations.length = 0
  service.watchGit.mockReset().mockImplementation(async (sessionId, notify) => {
    const stop = vi.fn()
    observations.push({ sessionId, notify, stop })
    return stop
  })
})
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
})

test("refreshes status and every open diff even when file status and line counts stay the same", async () => {
  const { git } = setup()
  const second = { ...change, path: "second.txt" }
  await flushPromises()
  expect(git.snapshot.value?.sessionId).toBe("30")
  git.expand("repo", change)
  git.expand("repo", second)
  await flushPromises()
  const patch = (path: string) => git.cards.value.get(gitDiffCardKey("repo", path, "unstaged"))?.diff?.patch
  expect(patch("file.txt")).toBe("+first")
  expect(patch("second.txt")).toBe("+first")
  service.gitStatus.mockImplementation(async id => status(id, [change, second]))
  service.gitDiff.mockImplementation(async request => ({ ...request, patch: "+later", binary: false, truncated: false }))
  changed()
  await vi.advanceTimersByTimeAsync(300)
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
  expect(patch("file.txt")).toBe("+later")
  expect(patch("second.txt")).toBe("+later")
  service.gitStatus.mockResolvedValue(status("30", [second]))
  changed()
  await vi.advanceTimersByTimeAsync(300)
  expect(git.cards.value.has(gitDiffCardKey("repo", "file.txt", "unstaged"))).toBe(false)
  expect(patch("second.txt")).toBe("+later")
})

test("serializes invalidations and stops reads when its scope is disposed", async () => {
  const result = deferred<GitStatusSnapshot>()
  service.gitStatus.mockReturnValue(result.promise)
  const { scope, git } = setup()
  await flushPromises()
  changed()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  scope.stop()
  result.resolve(status())
  await flushPromises()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  expect(git.snapshot.value).toBeNull()
  expect(observations[0]!.stop).toHaveBeenCalledOnce()
})

test("late status responses cannot replace the newly selected Session", async () => {
  const old = deferred<GitStatusSnapshot>()
  service.gitStatus.mockReturnValueOnce(old.promise)
  const { sessionId, git } = setup()
  await flushPromises()
  sessionId.value = "31"
  await flushPromises()
  expect(git.snapshot.value?.sessionId).toBe("31")
  old.resolve(status("30"))
  await flushPromises()
  expect(git.snapshot.value?.sessionId).toBe("31")
  changed()
  await vi.advanceTimersByTimeAsync(300)
  expect(service.gitStatus.mock.calls.map(([id]) => id)).toEqual(["30", "31", "31"])
})

test("late diff responses cannot overwrite another file or reopen a collapsed card", async () => {
  const old = deferred<GitFileDiff>()
  const { git } = setup()
  await flushPromises()
  service.gitDiff.mockReturnValueOnce(old.promise)
  git.expand("repo", change)
  const oldRequest = service.gitDiff.mock.calls[0]![0]
  git.collapse("repo", change.path, change.kind)
  git.expand("repo", { ...change, path: "second.txt" })
  await flushPromises()
  const secondKey = gitDiffCardKey("repo", "second.txt", "unstaged")
  expect(git.cards.value.get(secondKey)?.diff?.path).toBe("second.txt")
  old.resolve({ ...oldRequest, patch: "old", binary: false, truncated: false })
  await flushPromises()
  expect(git.cards.value.has(gitDiffCardKey("repo", change.path, change.kind))).toBe(false)
  expect(git.cards.value.get(secondKey)?.diff?.path).toBe("second.txt")
  const closing = deferred<GitFileDiff>()
  service.gitDiff.mockReturnValueOnce(closing.promise)
  git.expand("repo", change)
  git.collapse("repo", change.path, change.kind)
  closing.resolve({ ...oldRequest, patch: "closed", binary: false, truncated: false })
  await flushPromises()
  expect(git.cards.value.has(gitDiffCardKey("repo", change.path, change.kind))).toBe(false)
})

test("retains the last snapshot with an error and recovers on the next refresh", async () => {
  const { git } = setup()
  await flushPromises()
  service.gitStatus.mockRejectedValueOnce(new Error("Git unavailable"))
  changed()
  await vi.advanceTimersByTimeAsync(300)
  expect(git.error.value).toBe("Git unavailable")
  expect(git.snapshot.value?.repositories).toHaveLength(1)
  await git.refresh()
  expect(git.error.value).toBeNull()
  expect(git.loading.value).toBe(false)
  expect(service.gitStatus).toHaveBeenLastCalledWith("30", true)
})

test("disabling a target stops reads and reconnecting refreshes the active target immediately", async () => {
  const { enabled, git } = setup()
  await flushPromises()
  enabled.value = false
  await nextTick()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  expect(git.snapshot.value).toBeNull()
  expect(observations[0]!.stop).toHaveBeenCalledOnce()
  enabled.value = true
  await flushPromises()
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
  service.state = "error"
  await nextTick()
  service.state = "connected"
  await flushPromises()
  expect(service.gitStatus).toHaveBeenCalledTimes(3)
  expect(service.watchGit).toHaveBeenCalledTimes(3)
})

test("hidden windows release subscriptions and refresh as soon as they become visible", async () => {
  const { git } = setup()
  await flushPromises()
  const visibility = vi.spyOn(document, "visibilityState", "get")
  visibility.mockReturnValue("hidden")
  document.dispatchEvent(new Event("visibilitychange"))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  expect(observations[0]!.stop).toHaveBeenCalledOnce()
  visibility.mockReturnValue("visible")
  document.dispatchEvent(new Event("visibilitychange"))
  await flushPromises()
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
  expect(git.snapshot.value?.sessionId).toBe("30")
  expect(service.watchGit).toHaveBeenCalledTimes(2)
})

test("idle panels do not poll, bursts debounce, and sustained changes have a bounded wait", async () => {
  setup()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  for (let index = 0; index < 5; index++) {
    changed()
    await vi.advanceTimersByTimeAsync(100)
  }
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(200)
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
  for (let index = 0; index < 10; index++) {
    changed()
    await vi.advanceTimersByTimeAsync(200)
  }
  expect(service.gitStatus).toHaveBeenCalledTimes(3)
})

test("changes during an in-flight status read cause one subsequent refresh", async () => {
  const result = deferred<GitStatusSnapshot>()
  service.gitStatus.mockReturnValueOnce(result.promise)
  const { git } = setup()
  await flushPromises()
  changed()
  changed()
  await vi.advanceTimersByTimeAsync(300)
  expect(service.gitStatus).toHaveBeenCalledTimes(1)
  service.gitStatus.mockResolvedValue(status("30", []))
  result.resolve(status())
  await flushPromises()
  expect(service.gitStatus).toHaveBeenCalledTimes(2)
  expect(git.snapshot.value?.repositories[0]?.changes).toEqual([])
})

test("context switches cancel debounced refreshes and release late subscriptions", async () => {
  const subscription = deferred<() => void>()
  const stop = vi.fn()
  service.watchGit.mockReturnValueOnce(subscription.promise)
  const { sessionId, git } = setup()
  await flushPromises()
  expect(service.gitStatus).not.toHaveBeenCalled()
  sessionId.value = "31"
  await flushPromises()
  subscription.resolve(stop)
  await flushPromises()
  expect(stop).toHaveBeenCalledOnce()
  expect(service.gitStatus.mock.calls.map(([id]) => id)).toEqual(["31"])
  changed()
  sessionId.value = "32"
  await flushPromises()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(service.gitStatus.mock.calls.map(([id]) => id)).toEqual(["31", "32"])
  expect(git.snapshot.value?.sessionId).toBe("32")
})

test("watch errors remain visible with a usable snapshot and manual refresh can reattach", async () => {
  service.watchGit.mockRejectedValueOnce(new Error("Watch limit reached"))
  const { git } = setup()
  await flushPromises()
  expect(git.error.value).toBe("Watch limit reached")
  expect(git.snapshot.value?.sessionId).toBe("30")
  await git.refresh()
  expect(git.error.value).toBeNull()
  changed("Watcher stopped")
  await vi.advanceTimersByTimeAsync(300)
  expect(git.error.value).toBe("Watcher stopped")
  expect(git.snapshot.value?.sessionId).toBe("30")
  await git.refresh()
  expect(observations[0]!.stop).toHaveBeenCalledOnce()
  expect(service.watchGit).toHaveBeenCalledTimes(3)
  expect(git.error.value).toBeNull()
})

test("initial connection completion does not open a second subscription", async () => {
  service.state = "idle"
  const subscription = deferred<() => void>()
  service.watchGit.mockReturnValueOnce(subscription.promise)
  setup()
  service.state = "connected"
  await nextTick()
  subscription.resolve(vi.fn())
  await flushPromises()
  expect(service.watchGit).toHaveBeenCalledOnce()
  expect(service.gitStatus).toHaveBeenCalledOnce()
})

test("an invalidation rereads a selected diff that was already in flight", async () => {
  const { git } = setup()
  await flushPromises()
  const old = deferred<GitFileDiff>()
  service.gitDiff.mockReturnValueOnce(old.promise)
  git.expand("repo", change)
  const request = service.gitDiff.mock.calls[0]![0]
  changed()
  await vi.advanceTimersByTimeAsync(300)
  service.gitDiff.mockResolvedValue({ ...request, patch: "+latest", binary: false, truncated: false })
  old.resolve({ ...request, patch: "+old", binary: false, truncated: false })
  await flushPromises()
  expect(service.gitDiff).toHaveBeenCalledTimes(2)
  expect(git.cards.value.get(gitDiffCardKey("repo", change.path, change.kind))?.diff?.patch).toBe("+latest")
})
