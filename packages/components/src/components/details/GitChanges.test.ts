import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { computed, ref, shallowRef } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { GitFileChange, GitFileDiff, GitStatusSnapshot } from "../../../../../apps/daemon/src/git-protocol.ts"
import { gitDiffCardKey, type GitDiffCard } from "./git-diff-card.ts"
import { i18n } from "../../i18n/index.ts"
import GitChanges from "./GitChanges.vue"

const connected = ref(true)
const state = {
  snapshot: shallowRef<GitStatusSnapshot | null>(null), loading: ref(false), error: ref<string | null>(null), connected: computed(() => connected.value),
  cards: shallowRef(new Map<string, GitDiffCard>()),
  refresh: vi.fn(async () => {}), expand: vi.fn(), collapse: vi.fn(),
}
vi.mock("../../composables/useSessionGit.ts", () => ({ useSessionGit: () => state }))
const wrappers: VueWrapper[] = []
const global = { plugins: [i18n], stubs: { teleport: { inheritAttrs: false, template: "<slot />" } } }
const change = (options: Partial<GitFileChange> = {}): GitFileChange => ({ path: "src/app.ts", kind: "unstaged", status: "modified", additions: 2, deletions: 1, ...options })
const patch = [
  "diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -2,2 +2,3 @@",
  " same", "-previous", "+<script>alert('content')</script>", "+next", "@@ -10 +11 @@", "--- old", "+++ new", "",
].join("\n")
const fileDiff = (options: Partial<GitFileDiff> = {}): GitFileDiff => ({ sessionId: "11", repositoryId: "repo", path: "src/app.ts", kind: "unstaged", patch, binary: false, truncated: false, ...options })
function storeCard(diff: GitFileDiff | null, options: { loading?: boolean; error?: string | null } = {}): void {
  const next = new Map(state.cards.value)
  if (!diff) { state.cards.value = next; return }
  next.set(gitDiffCardKey(diff.repositoryId, diff.path, diff.kind), { request: diff, diff, loading: options.loading ?? false, error: options.error ?? null })
  state.cards.value = next
}
function panel(enabled = true): VueWrapper {
  const view = mount(GitChanges, { props: { sessionId: "11", enabled }, global }); wrappers.push(view); return view
}
async function inlineDiff(options: { diff?: GitFileDiff | null; loading?: boolean; error?: string | null; diffError?: string | null; connected?: boolean } = {}): Promise<VueWrapper> {
  const diff = options.diff === undefined ? fileDiff() : options.diff
  if (!state.snapshot.value && diff) {
    state.snapshot.value = { sessionId: "11", repositories: [{ id: "repo", root: "/code/repo", branch: "main", head: "abcdef123456", changes: [change({ path: diff.path, kind: diff.kind })] }], directories: [] }
  }
  if (diff) storeCard(diff, { loading: options.loading, error: options.diffError })
  state.error.value = options.error ?? null
  if (options.connected !== undefined) connected.value = options.connected
  const view = panel()
  await view.get(`[data-git-cards] button[data-git-path="${diff?.path ?? "src/app.ts"}"][data-git-kind="${diff?.kind ?? "unstaged"}"]`).trigger("click")
  await flushPromises()
  return view
}
beforeEach(() => {
  connected.value = true
  state.snapshot.value = null; state.loading.value = false; state.error.value = null
  state.cards.value = new Map()
  state.refresh.mockClear(); state.expand.mockClear(); state.collapse.mockClear()
})
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount() })

test("lists each checkout once, separates staged and unstaged versions, and expands each diff card", async () => {
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
  expect(view.findAll("[data-git-cards] article")).toHaveLength(3)
  expect(view.find("[data-git-diff]").exists()).toBe(false)
  await view.get('[data-kind="staged"]').get('button[aria-label="Show diff for src/app.ts"]').trigger("click")
  expect(state.expand).toHaveBeenLastCalledWith("repo", staged)
  await view.get('[data-kind="unstaged"]').get('button[aria-label="Show diff for src/app.ts"]').trigger("click")
  expect(state.expand).toHaveBeenLastCalledWith("repo", unstaged)
  expect(view.get('[data-kind="staged"]').get("button").attributes("aria-expanded")).toBe("true")
  expect(view.get('[data-kind="unstaged"]').get("button").attributes("aria-expanded")).toBe("true")
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

test("renders the selected diff inline, without a dialog, and closes it from the patch", async () => {
  state.snapshot.value = {
    sessionId: "11",
    repositories: [{ id: "repo", root: "/code/repo", branch: "main", head: "abcdef123456", changes: [change()] }],
    directories: [],
  }
  const view = await inlineDiff()
  expect(view.find("[role=dialog]").exists()).toBe(false)
  expect(view.find("script").exists()).toBe(false)
  const preview = view.get("[data-git-diff]")
  expect(preview.attributes("data-git-path")).toBe("src/app.ts")
  expect(preview.text()).toContain("<script>alert('content')</script>")
  const removed = preview.findAll('[data-line-kind="deleted"]')
  expect(removed).toHaveLength(2)
  expect(removed[0]!.findAll(".git-diff-number").map(cell => cell.text())).toEqual(["3", ""])
  expect(removed[1]!.findAll(".git-diff-number").map(cell => cell.text())).toEqual(["10", ""])
  expect(removed[1]!.get(".git-diff-text").text()).toBe("--- old")
  const added = preview.findAll('[data-line-kind="added"]')
  expect(added[0]!.findAll(".git-diff-number").map(cell => cell.text())).toEqual(["", "3"])
  expect(added[2]!.findAll(".git-diff-number").map(cell => cell.text())).toEqual(["", "11"])
  storeCard(fileDiff({ patch: patch.replace("previous", "updated previous") }))
  await view.vm.$nextTick()
  expect(view.text()).toContain("updated previous")
  expect(preview.get("button").attributes("aria-expanded")).toBe("true")
  await preview.get("button").trigger("click")
  expect(state.collapse).toHaveBeenCalledWith("repo", "src/app.ts", "unstaged")
  expect(view.find("[data-git-diff]").exists()).toBe(false)
})

test("explains binary and truncated diffs and keeps stale content visible on failure", async () => {
  const view = await inlineDiff({ diff: fileDiff({ binary: true, patch: "Binary files differ" }) })
  expect(view.find("[role=dialog]").exists()).toBe(false)
  expect(view.text()).toContain("Binary file changed")
  expect(view.find(".git-diff-content").exists()).toBe(false)
  storeCard(fileDiff({ truncated: true }))
  state.error.value = "Read failed"
  connected.value = false
  await view.vm.$nextTick()
  expect(view.text()).toContain("Only the first part is shown")
  expect(view.text()).toContain("Read failed")
  expect(view.text()).toContain("Live updates paused")
  expect(view.text()).toContain("Showing the last loaded changes")
  expect(view.find(".git-diff-content").exists()).toBe(true)
  await view.get('button[aria-label="Refresh Git changes"]').trigger("click")
  expect(state.refresh).toHaveBeenCalledOnce()
  storeCard(fileDiff({ patch: "" }))
  state.error.value = null
  connected.value = true
  await view.vm.$nextTick()
  expect(view.text()).toContain("No changes remain in this diff")
})

test("keeps the file tree collapsed until toggled, then jumps to that file's diff card", async () => {
  state.snapshot.value = {
    sessionId: "11",
    repositories: [{
      id: "repo",
      root: "/code/repo",
      branch: "main",
      head: "abcdef123456",
      changes: [
        change({ path: "src/app.ts" }),
        change({ path: "src/lib/util.ts", additions: 4, deletions: 0 }),
        change({ path: "new.txt", kind: "untracked", status: "untracked", additions: 1, deletions: 0 }),
        change({ path: "src/app.ts", kind: "staged", additions: 1, deletions: 0 }),
      ],
    }],
    directories: [],
  }
  const view = panel()
  expect(view.find('[aria-label="Changed files"]').exists()).toBe(false)
  expect(view.findAll("[data-git-cards] article")).toHaveLength(4)
  const toggle = view.get('button[aria-label="Show file tree"]')
  await toggle.trigger("click")
  expect(view.find('button[aria-label="Hide file tree"]').exists()).toBe(true)
  expect(view.findAll("[data-git-cards] article")).toHaveLength(4)
  const tree = view.get('[aria-label="Changed files"]')
  const cards = view.get("[data-git-cards]")
  const unstaged = tree.get('[data-kind="unstaged"]')
  expect(unstaged.get('[data-git-directory="src"]').attributes("aria-expanded")).toBe("true")
  expect(unstaged.find('[data-git-directory="src/lib"]').exists()).toBe(true)
  const nested = unstaged.get('button[data-git-path="src/lib/util.ts"][data-git-kind="unstaged"]')
  expect(nested.text()).toContain("util.ts")
  expect(nested.text()).not.toContain("src/lib")
  const nestedCard = cards.get('article[data-git-path="src/lib/util.ts"][data-git-kind="unstaged"]')
  const scroll = vi.spyOn(nestedCard.element, "scrollIntoView").mockImplementation(() => {})
  await nested.trigger("click")
  expect(state.expand).toHaveBeenCalledWith("repo", expect.objectContaining({ path: "src/lib/util.ts", kind: "unstaged" }))
  expect(nestedCard.get("button").attributes("aria-expanded")).toBe("true")
  expect(scroll).toHaveBeenCalledWith({ block: "start" })
  expect(view.find("[role=dialog]").exists()).toBe(false)
  await tree.get('[data-kind="staged"]').get('button[aria-label="View Staged diff for src/app.ts"]').trigger("click")
  expect(state.expand).toHaveBeenLastCalledWith("repo", expect.objectContaining({ path: "src/app.ts", kind: "staged" }))
  expect(cards.get('[data-kind="staged"] button').attributes("aria-expanded")).toBe("true")
  expect(nestedCard.get("button").attributes("aria-expanded")).toBe("true")
  await unstaged.get('[data-git-directory="src"]').trigger("click")
  expect(unstaged.get('[data-git-directory="src"]').attributes("aria-expanded")).toBe("false")
  expect(unstaged.find('[data-git-path="src/lib/util.ts"]').exists()).toBe(false)
  expect(unstaged.find('[data-git-directory="src/lib"]').exists()).toBe(false)
  expect(tree.find('[data-git-path="new.txt"]').exists()).toBe(true)
  await view.get('button[aria-label="Hide file tree"]').trigger("click")
  expect(view.find('[aria-label="Changed files"]').exists()).toBe(false)
  expect(view.findAll("[data-git-cards] article")).toHaveLength(4)
  await cards.get('article[data-git-path="src/lib/util.ts"] button').trigger("click")
  expect(state.collapse).toHaveBeenCalledWith("repo", "src/lib/util.ts", "unstaged")
  expect(cards.get('article[data-git-path="src/lib/util.ts"] button').attributes("aria-expanded")).toBe("false")
  expect(cards.get('[data-kind="staged"] button').attributes("aria-expanded")).toBe("true")
})
