import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import type { CatalogSnapshot } from "./catalog-protocol.ts"
import { GitHubBranches, githubRepository } from "./github-branches.ts"

const execute = promisify(execFile)
const git = async (root: string, ...args: string[]) => execute("git", ["-C", root, ...args], { encoding: "utf8" })
async function fixture(context: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-github-branches-")))
  const root = join(directory, "repo")
  await mkdir(root)
  await git(root, "init", "--initial-branch=main")
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial")
  let notifications = 0
  const observer = new GitHubBranches(() => { notifications++ })
  context.after(async () => { observer.close(); await rm(directory, { recursive: true, force: true }) })
  const catalog: CatalogSnapshot = {
    machineId: "1", machineName: "test", teamId: "1", sessions: [], sessionIds: ["3"],
    workspaces: [{ id: "1", name: "test", worktrees: [{ id: "2", sessionId: "3", workspaceId: "1", directories: [{ path: root }] }] }],
  }
  return { directory, root, observer, catalog, notifications: () => notifications }
}
async function eventually(read: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) { if (await read()) return; await delay(20) }
  assert.fail("GitHub branch projection did not update")
}

test("GitHub remote parsing accepts HTTPS and SSH while dropping credentials", () => {
  for (const value of ["git@github.com:Owner/Repo.git", "ssh://git@github.com/Owner/Repo.git", "https://user:secret@github.com/Owner/Repo.git", "https://github.com/Owner/Repo/"]) {
    assert.equal(githubRepository(value), "owner/repo")
  }
  for (const value of ["https://github.com.evil.test/owner/repo", "https://example.com/owner/repo", "/local/repo", "https://github.com/owner/repo/extra", "https://github.com/owner/repo?token=secret"]) {
    assert.equal(githubRepository(value), undefined)
  }
})

test("catalog projection shares checkout metadata and follows branch and remote changes", async context => {
  const f = await fixture(context)
  await git(f.root, "remote", "add", "origin", "git@github.com:owner/repo.git")
  const nested = join(f.root, "nested")
  await mkdir(nested)
  f.catalog.sessions.push({ id: "4", sessionId: "5", directories: [{ path: nested }, { path: f.root }] })
  const initial = await f.observer.snapshot(f.catalog)
  assert.equal(initial.length, 2)
  for (const session of initial) assert.deepEqual(session.repositories, [{ repository: "owner/repo", headRepository: "owner/repo", branch: "main" }])
  const before = f.notifications()
  await git(f.root, "switch", "-c", "feature/pr-status")
  await eventually(async () => f.notifications() > before && (await f.observer.snapshot(f.catalog)).every(session => session.repositories[0]?.branch === "feature/pr-status"))
  await git(f.root, "remote", "set-url", "origin", "https://token:secret@github.com/new/repo.git")
  await eventually(async () => (await f.observer.snapshot(f.catalog))[0]?.repositories[0]?.repository === "new/repo")
  const edits = f.notifications()
  await writeFile(join(f.root, "working-file.txt"), "working changes do not affect branch identity\n")
  await delay(200)
  assert.equal(f.notifications(), edits)
  assert.ok(!JSON.stringify(await f.observer.snapshot(f.catalog)).includes("secret"))
})

test("fork candidates preserve the tracked head and explicitly configured push remote", async context => {
  const f = await fixture(context)
  await git(f.root, "remote", "add", "origin", "git@github.com:contributor/repo.git")
  await git(f.root, "remote", "add", "upstream", "https://github.com/project/repo.git")
  await git(f.root, "config", "branch.main.remote", "origin")
  await git(f.root, "config", "branch.main.merge", "refs/heads/remote-feature")
  await git(f.root, "config", "push.default", "upstream")
  assert.deepEqual((await f.observer.snapshot(f.catalog))[0]?.repositories, [
    { repository: "contributor/repo", headRepository: "contributor/repo", branch: "remote-feature" },
    { repository: "project/repo", headRepository: "contributor/repo", branch: "remote-feature" },
  ])
  await git(f.root, "config", "branch.main.remote", "upstream")
  await git(f.root, "config", "branch.main.pushRemote", "origin")
  await eventually(async () => (await f.observer.snapshot(f.catalog))[0]?.repositories[1]?.branch === "main")
  assert.equal((await f.observer.snapshot(f.catalog))[0]?.repositories[1]?.headRepository, "contributor/repo")
  await git(f.root, "remote", "set-url", "--push", "origin", "git@github.com:another/repo.git")
  await eventually(async () => (await f.observer.snapshot(f.catalog))[0]?.repositories[1]?.headRepository === "another/repo")
})

test("a tag with the same name does not change the branch locator", async context => {
  const f = await fixture(context)
  await git(f.root, "remote", "add", "origin", "git@github.com:owner/repo.git")
  await git(f.root, "switch", "-c", "feature")
  await git(f.root, "tag", "feature")
  assert.deepEqual((await f.observer.snapshot(f.catalog))[0]?.repositories, [
    { repository: "owner/repo", headRepository: "owner/repo", branch: "feature" },
  ])
})

test("current and matching push modes retain the local branch name instead of its differently named upstream", async context => {
  const f = await fixture(context)
  await git(f.root, "remote", "add", "origin", "git@github.com:owner/repo.git")
  await git(f.root, "switch", "-c", "feature")
  await git(f.root, "config", "branch.feature.remote", "origin")
  await git(f.root, "config", "branch.feature.merge", "refs/heads/old-name")
  for (const mode of ["current", "matching"]) {
    await git(f.root, "config", "push.default", "upstream")
    await eventually(async () => (await f.observer.snapshot(f.catalog))[0]?.repositories[0]?.branch === "old-name")
    await git(f.root, "config", "push.default", mode)
    await eventually(async () => (await f.observer.snapshot(f.catalog))[0]?.repositories[0]?.branch === "feature")
  }
})

test("detached managed worktrees gain a locator only after creating a branch and inactive sessions release it", async context => {
  const f = await fixture(context)
  await git(f.root, "remote", "add", "origin", "git@github.com:owner/repo.git")
  const worktree = join(f.directory, "session")
  await git(f.root, "worktree", "add", "--detach", worktree, "HEAD")
  f.catalog.workspaces[0]!.worktrees[0]!.directories = [{ path: worktree }]
  assert.deepEqual(await f.observer.snapshot(f.catalog), [])
  await git(worktree, "switch", "-c", "worktree-feature")
  await eventually(async () => (await f.observer.snapshot(f.catalog))[0]?.repositories[0]?.branch === "worktree-feature")
  await git(f.root, "remote", "set-url", "origin", "git@github.com:owner/renamed.git")
  await eventually(async () => (await f.observer.snapshot(f.catalog))[0]?.repositories[0]?.repository === "owner/renamed")
  assert.deepEqual(await f.observer.snapshot(f.catalog, new Set(["3"])), [])
  const released = f.notifications()
  await git(worktree, "switch", "--detach")
  await delay(200)
  assert.equal(f.notifications(), released)
})
