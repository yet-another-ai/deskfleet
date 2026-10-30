import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { promisify } from "node:util"
import { prepareGitWorkspace } from "./git-preparation.ts"

const execute = promisify(execFile)
const git = async (root: string, ...args: string[]) => (await execute("git", ["-C", root, ...args], {
  encoding: "utf8", windowsHide: true,
})).stdout.trimEnd()

async function fixture(context: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-git-preparation-")))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function repository(directory: string, name = "repo", branch = "main") {
  const remote = join(directory, `${name}.git`)
  const writer = join(directory, `${name}-writer`)
  const source = join(directory, name)
  await git(directory, "init", "--bare", `--initial-branch=${branch}`, remote)
  // Configure line endings before checkout so Windows host defaults cannot make
  // the fixture dirty when LF assertions and subsequent Git commands run.
  await git(directory, "clone", "--config", "core.autocrlf=false", remote, writer)
  await mkdir(join(writer, "nested"))
  await writeFile(join(writer, "source.txt"), "initial\n")
  await writeFile(join(writer, "nested", "file.txt"), "nested\n")
  await commit(writer, "initial")
  await git(writer, "push", "origin", branch)
  await git(directory, "clone", "--config", "core.autocrlf=false", remote, source)
  const initial = await git(source, "rev-parse", "HEAD")
  return { source, writer, remote, initial, branch }
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, "add", ".")
  await git(root, "-c", "user.name=deskfleet test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", message)
  return git(root, "rev-parse", "HEAD")
}

async function advance(repo: Awaited<ReturnType<typeof repository>>, path = "source.txt", content = "latest\n"): Promise<string> {
  await writeFile(join(repo.writer, path), content)
  const revision = await commit(repo.writer, "remote update")
  await git(repo.writer, "push", "origin", repo.branch)
  return revision
}

test("worktree preparation pins the latest default commit while preserving the source branch and all edits", async context => {
  const repo = await repository(await fixture(context))
  await git(repo.source, "switch", "-c", "feature")
  await writeFile(join(repo.source, "source.txt"), "unfinished\n")
  await writeFile(join(repo.source, "notes.txt"), "personal notes\n")
  const before = await git(repo.source, "status", "--porcelain=v1")
  const revision = await advance(repo)

  const result = await prepareGitWorkspace("1", [{ path: repo.source }], "worktree")

  assert.equal(result.status, "ready")
  assert.equal(result.context, "worktree")
  assert.equal(result.repositories[0]?.branch, "main")
  assert.deepEqual(result.baseRevisions, [{ path: repo.source, revision }])
  assert.equal(await git(repo.source, "branch", "--show-current"), "feature")
  assert.equal(await git(repo.source, "rev-parse", "HEAD"), repo.initial)
  assert.equal(await git(repo.source, "status", "--porcelain=v1"), before)
  assert.equal(await readFile(join(repo.source, "source.txt"), "utf8"), "unfinished\n")
  assert.equal(await readFile(join(repo.source, "notes.txt"), "utf8"), "personal notes\n")
})

test("clean directory preparation switches to the default branch and fast-forwards to its latest commit", async context => {
  const repo = await repository(await fixture(context))
  await git(repo.source, "switch", "-c", "finished-task")
  const revision = await advance(repo)

  const result = await prepareGitWorkspace("1", [{ path: repo.source }], "directory")

  assert.equal(result.status, "ready")
  assert.equal(result.confirmationToken, undefined)
  assert.equal(await git(repo.source, "branch", "--show-current"), "main")
  assert.equal(await git(repo.source, "rev-parse", "HEAD"), revision)
  assert.equal(await readFile(join(repo.source, "source.txt"), "utf8"), "latest\n")
})

test("directory changes remain intact until their confirmation is submitted and untracked files survive", async context => {
  const repo = await repository(await fixture(context))
  await git(repo.source, "switch", "-c", "feature")
  await writeFile(join(repo.source, "source.txt"), "staged\n")
  await git(repo.source, "add", "source.txt")
  await writeFile(join(repo.source, "source.txt"), "unstaged\n")
  await writeFile(join(repo.source, "notes.txt"), "keep me\n")
  const before = await git(repo.source, "status", "--porcelain=v1")
  const revision = await advance(repo)

  const preview = await prepareGitWorkspace("1", [{ path: repo.source }], "directory")

  assert.equal(preview.status, "confirmation_required")
  assert.ok(preview.confirmationToken)
  assert.ok(preview.repositories[0]?.changes.includes("source.txt"))
  assert.equal(await git(repo.source, "branch", "--show-current"), "feature")
  assert.equal(await git(repo.source, "status", "--porcelain=v1"), before)
  assert.equal(await readFile(join(repo.source, "source.txt"), "utf8"), "unstaged\n")

  const result = await prepareGitWorkspace("1", [{ path: repo.source }], "directory", preview.confirmationToken)

  assert.equal(result.status, "ready")
  assert.equal(await git(repo.source, "branch", "--show-current"), "main")
  assert.equal(await git(repo.source, "rev-parse", "HEAD"), revision)
  assert.equal(await git(repo.source, "diff", "--name-only", "HEAD"), "")
  assert.equal(await readFile(join(repo.source, "notes.txt"), "utf8"), "keep me\n")
})

test("changing an already listed file invalidates its discard confirmation", async context => {
  const repo = await repository(await fixture(context))
  await writeFile(join(repo.source, "source.txt"), "first edit\n")
  const preview = await prepareGitWorkspace("1", [{ path: repo.source }], "directory")
  assert.equal(preview.status, "confirmation_required")
  await writeFile(join(repo.source, "source.txt"), "second edit\n")

  const result = await prepareGitWorkspace("1", [{ path: repo.source }], "directory", preview.confirmationToken)

  assert.equal(result.status, "confirmation_required")
  assert.ok(result.confirmationToken)
  assert.notEqual(result.confirmationToken, preview.confirmationToken)
  assert.equal(await readFile(join(repo.source, "source.txt"), "utf8"), "second edit\n")
})

test("a diverged local default branch is rejected before discarding current edits", async context => {
  const repo = await repository(await fixture(context))
  await writeFile(join(repo.source, "local.txt"), "local commit\n")
  const local = await commit(repo.source, "unpublished local commit")
  await git(repo.source, "switch", "-c", "feature")
  await writeFile(join(repo.source, "source.txt"), "unfinished work\n")
  await advance(repo)

  await assert.rejects(prepareGitWorkspace("1", [{ path: repo.source }], "directory"))

  assert.equal(await git(repo.source, "branch", "--show-current"), "feature")
  assert.equal(await git(repo.source, "rev-parse", "main"), local)
  assert.equal(await readFile(join(repo.source, "source.txt"), "utf8"), "unfinished work\n")
})

test("untracked files obstructing the default branch are preserved along with tracked edits", async context => {
  const repo = await repository(await fixture(context))
  await git(repo.source, "switch", "-c", "feature")
  await writeFile(join(repo.source, "source.txt"), "unfinished work\n")
  await writeFile(join(repo.source, "incoming.txt"), "local untracked content\n")
  await advance(repo, "incoming.txt", "remote tracked content\n")

  await assert.rejects(prepareGitWorkspace("1", [{ path: repo.source }], "directory"))

  assert.equal(await git(repo.source, "branch", "--show-current"), "feature")
  assert.equal(await readFile(join(repo.source, "source.txt"), "utf8"), "unfinished work\n")
  assert.equal(await readFile(join(repo.source, "incoming.txt"), "utf8"), "local untracked content\n")
})

test("incoming tracked files can share a directory with untracked and ignored siblings", async context => {
  const repo = await repository(await fixture(context))
  await mkdir(join(repo.source, "docs"))
  await writeFile(join(repo.source, "docs", "notes.txt"), "local notes\n")
  await writeFile(join(repo.source, "docs", "local.cache"), "ignored content\n")
  await writeFile(join(repo.source, ".git", "info", "exclude"), "docs/local.cache\n")
  await mkdir(join(repo.writer, "docs"))
  const revision = await advance(repo, "docs/README.md", "upstream documentation\n")

  const result = await prepareGitWorkspace("1", [{ path: repo.source }], "directory")

  assert.equal(result.status, "ready")
  assert.equal(await git(repo.source, "rev-parse", "HEAD"), revision)
  assert.equal(await readFile(join(repo.source, "docs", "README.md"), "utf8"), "upstream documentation\n")
  assert.equal(await readFile(join(repo.source, "docs", "notes.txt"), "utf8"), "local notes\n")
  assert.equal(await readFile(join(repo.source, "docs", "local.cache"), "utf8"), "ignored content\n")
})

test("worktree preparation resolves each repository default and preserves ordered directory bindings", async context => {
  const directory = await fixture(context)
  const primary = await repository(directory, "primary")
  const secondary = await repository(directory, "secondary", "trunk")
  const primaryRevision = await advance(primary)
  const secondaryRevision = await advance(secondary)
  const directories = [{ path: join(primary.source, "nested") }, { path: secondary.source }, { path: primary.source }]

  const result = await prepareGitWorkspace("1", directories, "worktree")

  assert.equal(result.status, "ready")
  assert.deepEqual(result.repositories.map(repository => repository.branch), ["main", "trunk"])
  assert.deepEqual(result.baseRevisions, [
    { path: directories[0]!.path, revision: primaryRevision },
    { path: directories[1]!.path, revision: secondaryRevision },
    { path: directories[2]!.path, revision: primaryRevision },
  ])
  assert.equal(await git(primary.source, "rev-parse", "HEAD"), primary.initial)
  assert.equal(await git(secondary.source, "rev-parse", "HEAD"), secondary.initial)
})
