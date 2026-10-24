import { mount, type VueWrapper } from "@vue/test-utils"
import { computed, ref, shallowRef } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { GitDiffRequest, GitFileChange, GitFileDiff, GitStatusSnapshot } from "../../../../../apps/daemon/src/git-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import GitChanges from "./GitChanges.vue"
import GitDiffDialog from "./GitDiffDialog.vue"

const connected = ref(true)
const state = {
  snapshot: shallowRef<GitStatusSnapshot | null>(null), loading: ref(false), error: ref<string | null>(null), connected: computed(() => connected.value),
  selection: shallowRef<GitDiffRequest | null>(null), diff: shallowRef<GitFileDiff | null>(null), diffLoading: ref(false), diffError: ref<string | null>(null),
  refresh: vi.fn(async () => {}), select: vi.fn(), closeDiff: vi.fn(),
}
vi.mock("../../composables/useSessionGit.ts", () => ({ useSessionGit: () => state }))
const wrappers: VueWrapper[] = []
const global = { plugins: [i18n], stubs: { teleport: true } }
const change = (options: Partial<GitFileChange> = {}): GitFileChange => ({ path: "src/app.ts", kind: "unstaged", status: "modified", additions: 2, deletions: 1, ...options })
const selection: GitDiffRequest = { sessionId: "11", repositoryId: "repo", path: "src/app.ts", kind: "unstaged" }
const patch = [
  "diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -2,2 +2,3 @@",
  " same", "-previous", "+<script>alert('content')</script>", "+next", "@@ -10 +11 @@", "--- old", "+++ new", "",
].join("\n")
const fileDiff = (options: Partial<GitFileDiff> = {}): GitFileDiff => ({ ...selection, patch, binary: false, truncated: false, ...options })
function panel(enabled = true): VueWrapper {
  const view = mount(GitChanges, { props: { sessionId: "11", enabled }, global }); wrappers.push(view); return view
}
function dialog(options: Partial<InstanceType<typeof GitDiffDialog>["$props"]> = {}): VueWrapper {
  const view = mount(GitDiffDialog, { props: { selection, repository: "/code/repo", diff: fileDiff(), loading: false, error: null, connected: true, ...options }, global })
  wrappers.push(view); return view
}
beforeEach(() => {
  connected.value = true
  state.snapshot.value = null; state.loading.value = false; state.error.value = null
  state.selection.value = null; state.diff.value = null; state.diffLoading.value = false; state.diffError.value = null
  state.refresh.mockClear(); state.select.mockClear(); state.closeDiff.mockClear()
})
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount() })

test("lists each checkout once, separates staged and unstaged versions, and selects the exact diff", async () => {
  const staged = change({ kind: "staged", additions: 1, deletions: 0 })
  const unstaged = change()
  state.snapshot.value = {
    sessionId: "11",
    repositories: [
      { id: "repo", root: "/code/repo", branch: "main", head: "abcdef123456", changes: [staged, unstaged, change({ path: "new.txt", kind: "untracked", status: "untracked" })] },
      { id: "other", root: "/code/other", branch: null, head: "123456789012", changes: [] },
    ],
    directories: [{ path: "/code/repo/src", repositoryId: "repo" }, { path: "/code/repo/test", repositoryId: "repo" }, { path: "/notes", repositoryId: null }],
  }
  const view = panel()
  expect(view.findAll("[data-repository]")).toHaveLength(2)
  expect(view.get('[data-kind="staged"]').text()).toContain("Staged")
  expect(view.get('[data-kind="unstaged"]').text()).toContain("+2")
  expect(view.get('[data-kind="unstaged"]').text()).toContain("−1")
  expect(view.get('[data-kind="untracked"]').text()).toContain("new.txt")
  expect(view.text()).toContain("Detached HEAD12345678")
  expect(view.text()).toContain("No changes")
  expect(view.text()).toContain("Not a Git checkout")
  await view.get('button[data-git-path="src/app.ts"][data-git-kind="staged"]').trigger("click")
  expect(state.select).toHaveBeenLastCalledWith("repo", staged)
  await view.get('button[data-git-path="src/app.ts"][data-git-kind="unstaged"]').trigger("click")
  expect(state.select).toHaveBeenLastCalledWith("repo", unstaged)
})

test("shows unavailable, initial load, per-directory failure and stale state without calling it clean", async () => {
  const view = panel(false)
  expect(view.text()).toContain("online local machine")
  expect(view.find('button[aria-label="Refresh Git changes"]').exists()).toBe(false)
  state.loading.value = true
  await view.setProps({ enabled: true })
  expect(view.text()).toContain("Loading Git changes")
  state.loading.value = false
  state.snapshot.value = { sessionId: "11", repositories: [{ id: "repo", root: "/code/repo", branch: "new", head: null, changes: [], error: "Git failed" }], directories: [{ path: "/missing", repositoryId: null, error: "Directory missing" }] }
  state.error.value = "Connection unavailable"
  connected.value = false
  await view.vm.$nextTick()
  expect(view.text()).toContain("Live updates paused")
  expect(view.text()).toContain("Showing the last loaded changes")
  expect(view.text()).toContain("No commits yet")
  expect(view.text()).toContain("Git failed")
  expect(view.text()).toContain("Directory missing")
  expect(view.text()).not.toContain("No changes")
  expect(view.text()).not.toContain("Not a Git checkout")
  await view.get('button[aria-label="Refresh Git changes"]').trigger("click")
  expect(state.refresh).toHaveBeenCalledOnce()
})

test("renders unified diff lines safely with old and new line numbers, and updates the open preview", async () => {
  const view = dialog()
  expect(view.get("dialog").attributes("open")).toBeDefined()
  expect(view.find("script").exists()).toBe(false)
  expect(view.get(".git-diff-content").text()).toContain("<script>alert('content')</script>")
  const removed = view.findAll('[data-line-kind="deleted"]')
  expect(removed).toHaveLength(2)
  expect(removed[0]!.findAll(".git-diff-number").map(cell => cell.text())).toEqual(["3", ""])
  expect(removed[1]!.findAll(".git-diff-number").map(cell => cell.text())).toEqual(["10", ""])
  expect(removed[1]!.get(".git-diff-text").text()).toBe("--- old")
  const added = view.findAll('[data-line-kind="added"]')
  expect(added[0]!.findAll(".git-diff-number").map(cell => cell.text())).toEqual(["", "3"])
  expect(added[2]!.findAll(".git-diff-number").map(cell => cell.text())).toEqual(["", "11"])
  await view.setProps({ diff: fileDiff({ patch: patch.replace("previous", "updated previous") }) })
  expect(view.text()).toContain("updated previous")
  await view.get("dialog").trigger("cancel")
  expect(view.emitted("close")).toEqual([[]])
})

test("explains binary and truncated diffs and keeps stale content visible on failure", async () => {
  const view = dialog({ diff: fileDiff({ binary: true, patch: "Binary files differ" }) })
  expect(view.text()).toContain("Binary file changed")
  expect(view.find(".git-diff-content").exists()).toBe(false)
  await view.setProps({ diff: fileDiff({ truncated: true }), error: "Read failed", connected: false })
  expect(view.text()).toContain("Only the first part is shown")
  expect(view.text()).toContain("Read failed")
  expect(view.text()).toContain("Live updates paused")
  expect(view.text()).toContain("Showing the last loaded changes")
  expect(view.find(".git-diff-content").exists()).toBe(true)
  await view.get('button[aria-label="Refresh Git changes"]').trigger("click")
  expect(view.emitted("refresh")).toEqual([[]])
  await view.setProps({ diff: fileDiff({ patch: "" }), error: null, connected: true })
  expect(view.text()).toContain("No changes remain in this diff")
})
