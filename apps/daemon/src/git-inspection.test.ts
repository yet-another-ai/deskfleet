import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { promisify } from "node:util"
import { GitInspection } from "./git-inspection.ts"
import type { GitChangeKind, GitStatusSnapshot } from "./git-protocol.ts"

const execute = promisify(execFile)
const git = async (root: string, ...args: string[]) => (await execute("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trimEnd()
const inspection = new GitInspection()

async function fixture(context: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-git-")))
  context.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function repository(root: string, initial = true): Promise<void> {
  await mkdir(root, { recursive: true })
  await git(root, "init", "--initial-branch=main")
  await git(root, "config", "core.autocrlf", "false")
  await git(root, "config", "user.name", "deskfleet test")
  await git(root, "config", "user.email", "test@example.invalid")
  if (initial) {
    await writeFile(join(root, "source.txt"), "first\nsecond\n")
    await git(root, "add", ".")
    await git(root, "commit", "--no-gpg-sign", "-m", "initial")
  }
}

function request(snapshot: GitStatusSnapshot, path: string, kind: GitChangeKind, index = 0) {
  return { sessionId: snapshot.sessionId, repositoryId: snapshot.repositories[index]!.id, path, kind }
}

test("live inspection separates index and worktree changes and rereads selected file content", async context => {
  const root = await fixture(context)
  await repository(root)
  await writeFile(join(root, "source.txt"), "first\nstaged\n")
  await git(root, "add", "source.txt")
  await writeFile(join(root, "source.txt"), "first\nworking\n")
  const snapshot = await inspection.status("1", [root])
  const checkout = snapshot.repositories[0]!
  assert.equal(checkout.branch, "main")
  assert.equal(checkout.head, await git(root, "rev-parse", "HEAD"))
  assert.deepEqual(checkout.changes, [
    { path: "source.txt", status: "modified", kind: "staged", additions: 1, deletions: 1 },
    { path: "source.txt", status: "modified", kind: "unstaged", additions: 1, deletions: 1 },
  ])
  const staged = await inspection.diff(request(snapshot, "source.txt", "staged"), [root])
  const unstaged = await inspection.diff(request(snapshot, "source.txt", "unstaged"), [root])
  assert.match(staged.patch, /-second\n\+staged/u)
  assert.match(unstaged.patch, /-staged\n\+working/u)
  await writeFile(join(root, "source.txt"), "first\nchanged\n")
  assert.match((await inspection.diff(request(snapshot, "source.txt", "unstaged"), [root])).patch, /\+changed/u)
  assert.deepEqual((await inspection.status("1", [root])).repositories[0]!.changes, checkout.changes)
})

test("directory bindings share a checkout while independent worktrees, non-Git and missing paths stay distinct", async context => {
  const base = await fixture(context)
  const source = join(base, "source")
  const detached = join(base, "detached")
  const plain = join(base, "plain")
  await repository(source)
  await mkdir(join(source, "nested"))
  await mkdir(plain)
  await git(source, "worktree", "add", "--detach", detached, "HEAD")
  await writeFile(join(detached, "source.txt"), "session-only\n")
  const snapshot = await inspection.status("1", [join(source, "nested"), source, detached, plain, join(base, "missing")])
  assert.equal(snapshot.repositories.length, 2)
  assert.equal(snapshot.directories[0]!.repositoryId, snapshot.directories[1]!.repositoryId)
  assert.notEqual(snapshot.directories[1]!.repositoryId, snapshot.directories[2]!.repositoryId)
  assert.equal(snapshot.repositories[0]!.changes.length, 0)
  assert.equal(snapshot.repositories[1]!.branch, null)
  assert.equal(snapshot.repositories[1]!.changes.length, 1)
  assert.equal(snapshot.directories[3]!.repositoryId, null)
  assert.equal(snapshot.directories[3]!.error, undefined)
  assert.match(snapshot.directories[4]!.error!, /ENOENT/u)
})

test("linked worktree status and diffs stay on that checkout while the primary is dirty", async context => {
  const base = await fixture(context)
  const primary = join(base, "primary")
  const session = join(base, "session")
  await repository(primary)
  const head = await git(primary, "rev-parse", "HEAD")
  await git(primary, "worktree", "add", "--detach", session, head)
  await writeFile(join(primary, "source.txt"), "primary-dirty\n")
  await writeFile(join(session, "source.txt"), "session-edit\n")
  await writeFile(join(session, "only-session.txt"), "new\n")

  const primarySnapshot = await inspection.status("primary", [primary])
  const sessionSnapshot = await inspection.status("session", [session])
  assert.notEqual(primarySnapshot.repositories[0]!.id, sessionSnapshot.repositories[0]!.id)
  assert.equal(sessionSnapshot.repositories[0]!.root, await realpath(session))
  assert.equal(sessionSnapshot.repositories[0]!.head, head)
  assert.equal(sessionSnapshot.repositories[0]!.branch, null)
  assert.equal(sessionSnapshot.repositories[0]!.changes.some(change => change.path === "source.txt" && change.kind === "unstaged"), true)
  assert.equal(sessionSnapshot.repositories[0]!.changes.some(change => change.path === "only-session.txt" && change.kind === "untracked"), true)

  const sessionDiff = await inspection.diff(request(sessionSnapshot, "source.txt", "unstaged"), [session])
  assert.match(sessionDiff.patch, /\+session-edit/u)
  assert.doesNotMatch(sessionDiff.patch, /primary-dirty/u)
  const primaryDiff = await inspection.diff(request(primarySnapshot, "source.txt", "unstaged"), [primary])
  assert.match(primaryDiff.patch, /\+primary-dirty/u)
  assert.doesNotMatch(primaryDiff.patch, /session-edit/u)
})

test("subdirectory session bindings inspect the linked worktree toplevel, not the primary checkout", async context => {
  const base = await fixture(context)
  const primary = join(base, "primary")
  const session = join(base, "session")
  await mkdir(join(primary, "frontend"), { recursive: true })
  await mkdir(join(primary, "backend"), { recursive: true })
  await repository(primary, false)
  await writeFile(join(primary, "frontend", "app.ts"), "frontend-v1\n")
  await writeFile(join(primary, "backend", "api.ts"), "backend-v1\n")
  await git(primary, "add", ".")
  await git(primary, "commit", "--no-gpg-sign", "-m", "tree")
  const head = await git(primary, "rev-parse", "HEAD")
  await git(primary, "worktree", "add", "--detach", session, head)
  await writeFile(join(primary, "frontend", "app.ts"), "frontend-primary\n")
  await writeFile(join(session, "frontend", "app.ts"), "frontend-session\n")

  const bindings = [join(session, "frontend"), join(session, "backend")]
  const snapshot = await inspection.status("session", bindings)
  assert.equal(snapshot.repositories.length, 1)
  assert.equal(snapshot.repositories[0]!.root, await realpath(session))
  assert.equal(snapshot.directories[0]!.repositoryId, snapshot.directories[1]!.repositoryId)
  assert.deepEqual(snapshot.repositories[0]!.changes.map(change => change.path), ["frontend/app.ts"])
  const diff = await inspection.diff(request(snapshot, "frontend/app.ts", "unstaged"), bindings)
  assert.match(diff.patch, /-frontend-v1\n\+frontend-session/u)
  assert.doesNotMatch(diff.patch, /frontend-primary/u)
})

test("a worktree pinned to an older revision diffs against that HEAD after the primary advances", async context => {
  const base = await fixture(context)
  const primary = join(base, "primary")
  const session = join(base, "session")
  await repository(primary, false)
  await writeFile(join(primary, "source.txt"), "first\n")
  await git(primary, "add", ".")
  await git(primary, "commit", "--no-gpg-sign", "-m", "first")
  const first = await git(primary, "rev-parse", "HEAD")
  await writeFile(join(primary, "source.txt"), "second\n")
  await git(primary, "commit", "-am", "advance", "--no-gpg-sign")
  await git(primary, "worktree", "add", "--detach", session, first)
  await writeFile(join(session, "source.txt"), "from-first\n")

  const snapshot = await inspection.status("session", [session])
  assert.equal(snapshot.repositories[0]!.head, first)
  assert.notEqual(snapshot.repositories[0]!.head, await git(primary, "rev-parse", "HEAD"))
  const diff = await inspection.diff(request(snapshot, "source.txt", "unstaged"), [session])
  assert.match(diff.patch, /-first\n\+from-first/u)
  assert.doesNotMatch(diff.patch, /second/u)
})

test("host GIT_DIR and GIT_WORK_TREE do not redirect linked worktree inspection", async context => {
  const base = await fixture(context)
  const primary = join(base, "primary")
  const session = join(base, "session")
  await repository(primary)
  await git(primary, "worktree", "add", "--detach", session, "HEAD")
  await writeFile(join(primary, "source.txt"), "via-env-primary\n")
  await writeFile(join(session, "source.txt"), "via-session\n")
  const previous = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  }
  process.env.GIT_DIR = join(primary, ".git")
  process.env.GIT_WORK_TREE = primary
  process.env.GIT_COMMON_DIR = join(primary, ".git")
  process.env.GIT_INDEX_FILE = join(primary, ".git", "index")
  try {
    const snapshot = await inspection.status("session", [session])
    assert.equal(snapshot.repositories[0]!.root, await realpath(session))
    const diff = await inspection.diff(request(snapshot, "source.txt", "unstaged"), [session])
    assert.match(diff.patch, /\+via-session/u)
    assert.doesNotMatch(diff.patch, /via-env-primary/u)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("unborn repositories and untracked text, binary and empty files have useful previews", async context => {
  const root = await fixture(context)
  await repository(root, false)
  await writeFile(join(root, "staged.txt"), "staged before first commit\n")
  await git(root, "add", ".")
  await writeFile(join(root, "new.txt"), "first\nlast")
  await writeFile(join(root, "empty.txt"), "")
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]))
  const snapshot = await inspection.status("1", [root])
  assert.equal(snapshot.repositories[0]!.head, null)
  assert.equal(snapshot.repositories[0]!.branch, "main")
  assert.equal(snapshot.repositories[0]!.error, undefined)
  assert.match((await inspection.diff(request(snapshot, "staged.txt", "staged"), [root])).patch, /\+staged before first commit/u)
  assert.match((await inspection.diff(request(snapshot, "new.txt", "untracked"), [root])).patch, /\+first\n\+last\n\\ No newline/u)
  assert.equal(snapshot.repositories[0]!.changes.find(file => file.path === "new.txt")!.additions, 2)
  assert.equal(snapshot.repositories[0]!.changes.find(file => file.path === "empty.txt")!.additions, 0)
  assert.equal((await inspection.diff(request(snapshot, "empty.txt", "untracked"), [root])).patch.includes("new file mode"), true)
  assert.equal((await inspection.diff(request(snapshot, "binary.bin", "untracked"), [root])).binary, true)
})

test("renames, deletions and unusual filenames retain exact paths and line counts", async context => {
  const root = await fixture(context)
  await repository(root)
  await writeFile(join(root, "deleted.txt"), "remove\n")
  const unusual = process.platform === "win32" ? "with spaces.txt" : "with\ttabs\nand lines.txt"
  await writeFile(join(root, unusual), "old\n")
  await git(root, "add", ".")
  await git(root, "commit", "--no-gpg-sign", "-m", "more files")
  await rename(join(root, "source.txt"), join(root, "renamed.txt"))
  await rm(join(root, "deleted.txt"))
  await writeFile(join(root, unusual), "new\n")
  await git(root, "add", "-A")
  await git(root, "config", "status.renames", "false")
  await git(root, "config", "diff.renames", "false")
  const snapshot = await inspection.status("1", [root])
  assert.deepEqual(snapshot.repositories[0]!.changes.find(file => file.path === "renamed.txt"), {
    path: "renamed.txt", previousPath: "source.txt", kind: "staged", status: "renamed", additions: 0, deletions: 0,
  })
  assert.equal(snapshot.repositories[0]!.changes.find(file => file.path === "deleted.txt")!.status, "deleted")
  assert.equal(snapshot.repositories[0]!.changes.find(file => file.path === unusual)!.additions, 1)
  assert.match((await inspection.diff(request(snapshot, "renamed.txt", "staged"), [root])).patch, /rename from source.txt\nrename to renamed.txt/u)
  assert.match((await inspection.diff(request(snapshot, unusual, "staged"), [root])).patch, /-old\n\+new/u)
})

test("conflicts stay visible and can be inspected", async context => {
  const root = await fixture(context)
  await repository(root)
  await git(root, "checkout", "-b", "other")
  await writeFile(join(root, "source.txt"), "other\n")
  await git(root, "commit", "-am", "other", "--no-gpg-sign")
  await git(root, "checkout", "main")
  await writeFile(join(root, "source.txt"), "main\n")
  await git(root, "commit", "-am", "main", "--no-gpg-sign")
  await assert.rejects(git(root, "merge", "other"))
  const snapshot = await inspection.status("1", [root])
  assert.deepEqual(snapshot.repositories[0]!.changes, [{ path: "source.txt", kind: "unstaged", status: "conflicted", additions: null, deletions: null }])
  assert.match((await inspection.diff(request(snapshot, "source.txt", "unstaged"), [root])).patch, /<<<<<<< HEAD/u)
})

test("diff requests reject unrelated repositories, traversal, pathspec magic and stale changes", async context => {
  const base = await fixture(context)
  const root = join(base, "owned")
  const other = join(base, "other")
  await repository(root)
  await repository(other)
  await writeFile(join(root, "source.txt"), "modified\n")
  const snapshot = await inspection.status("1", [root])
  const otherSnapshot = await inspection.status("2", [other])
  await assert.rejects(inspection.diff(request(otherSnapshot, "source.txt", "unstaged"), [root]), /does not belong/u)
  await assert.rejects(inspection.diff(request(snapshot, "../other/source.txt", "unstaged"), [root]), /Invalid Git file path/u)
  await assert.rejects(inspection.diff(request(snapshot, ":(glob)*", "unstaged"), [root]), /no longer present/u)
  if (process.platform !== "win32") {
    await writeFile(join(root, ":(glob)*"), "literal\n")
    assert.match((await inspection.diff(request(snapshot, ":(glob)*", "untracked"), [root])).patch, /\+literal/u)
  }
  await git(root, "checkout", "--", "source.txt")
  await assert.rejects(inspection.diff(request(snapshot, "source.txt", "unstaged"), [root]), /no longer present/u)
})

test("binary and oversized patches are explicit, and configured external diff commands are not run", async context => {
  const root = await fixture(context)
  await repository(root)
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1]))
  await git(root, "add", ".")
  await git(root, "commit", "--no-gpg-sign", "-m", "binary")
  await git(root, "config", "diff.external", "deskfleet-nonexistent-external-diff")
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 2]))
  await writeFile(join(root, "source.txt"), "x".repeat(2 * 1024 * 1024))
  await writeFile(join(root, "new.txt"), "x".repeat(2 * 1024 * 1024))
  const snapshot = await inspection.status("1", [root])
  assert.equal(snapshot.repositories[0]!.error, undefined)
  assert.equal((await inspection.diff(request(snapshot, "binary.bin", "unstaged"), [root])).binary, true)
  for (const [path, kind] of [["source.txt", "unstaged"], ["new.txt", "untracked"]] as const) {
    const diff = await inspection.diff(request(snapshot, path, kind), [root])
    assert.equal(diff.truncated, true)
    assert.ok(Buffer.byteLength(diff.patch) <= 1024 * 1024)
  }
})

test("untracked symlinks show the target name without exposing target contents", { skip: process.platform === "win32" }, async context => {
  const base = await fixture(context)
  const root = join(base, "source")
  await repository(root)
  await writeFile(join(base, "outside.txt"), "private target contents\n")
  await symlink("../outside.txt", join(root, "link.txt"))
  const snapshot = await inspection.status("1", [root])
  const diff = await inspection.diff(request(snapshot, "link.txt", "untracked"), [root])
  assert.match(diff.patch, /new file mode 120000/u)
  assert.match(diff.patch, /\+\.\.\/outside.txt/u)
  assert.equal(diff.patch.includes("private target contents"), false)
  assert.equal(await readFile(join(base, "outside.txt"), "utf8"), "private target contents\n")
})

test("branches lists local and remote branches without remote HEAD symrefs and orders currentBranch first", async context => {
  const base = await fixture(context)
  const root = join(base, "source")
  const plain = join(base, "plain")
  await repository(root)
  await mkdir(plain)
  await git(root, "branch", "feat/alpha")
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
  await git(root, "update-ref", "refs/remotes/origin/feat/remote", "HEAD")
  await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
  await git(root, "checkout", "feat/alpha")
  assert.deepEqual(await inspection.branches("1", root), {
    workspaceId: "1",
    currentBranch: "feat/alpha",
    branches: ["feat/alpha", "main", "origin/feat/remote", "origin/main"],
  })
  assert.deepEqual(await inspection.branches("1", plain), {
    workspaceId: "1",
    currentBranch: null,
    branches: [],
  })
})
