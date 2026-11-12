import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { promisify } from "node:util"
import { ManagedSessionWorktrees, type ManagedSessionCatalog } from "./session-worktrees.ts"
import { inspectWorktreeCleanup, worktreeCleanupFingerprint } from "./worktree-cleanup-inspection.ts"

const execute = promisify(execFile)
const git = async (path: string, ...args: string[]) => (await execute("git", ["-C", path, ...args], { encoding: "utf8" })).stdout.trimEnd()
const commit = (path: string, message = "changes") => git(path, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", message)

async function repository(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await git(path, "init", "--initial-branch=main")
  await git(path, "config", "core.autocrlf", "false")
  await writeFile(join(path, "source.txt"), "original\n")
  await writeFile(join(path, ".gitignore"), ".env\nbuild/\n")
  await git(path, "add", ".")
  await commit(path, "initial")
}

async function fixture(context: TestContext, count = 1) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "df-cleanup-")))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const sources: string[] = []
  for (let index = 0; index < count; index++) {
    const source = join(directory, `source-${index}`)
    await repository(source)
    sources.push(source)
  }
  let nextId = 0
  const catalog: ManagedSessionCatalog = {
    async snapshot() {
      return { teamId: "1", machineId: "1", machineName: "test", sessions: [], workspaces: [{
        id: "1", name: "workspace", worktrees: [{ id: "1", workspaceId: "1", directories: sources.map(path => ({ path })) }],
      }] }
    },
    async createWorkspaceSession(workspaceId) { return { id: String(++nextId), machineId: "1", workspaceId } },
    async attachSessionWorktree(sessionId, directories) { return { id: sessionId, workspaceId: "1", sessionId, directories } },
    async deleteWorkspaceSession() {},
  }
  const machine = join(directory, "daemon")
  const managed = new ManagedSessionWorktrees(catalog, machine)
  const session = await managed.create("1")
  const paths = session.worktree.directories.map(({ path }) => path)
  return { directory, sources, machine, catalog, managed, session, paths }
}

test("cleanup protects tracked edits and untracked files, with an explicit ignored-file policy", async context => {
  const { managed, session, paths: [path] } = await fixture(context)
  assert.equal((await managed.inspectCleanup(session.id, "uncommitted"))?.protected, false)
  await writeFile(join(path!, "source.txt"), "edited\n")
  assert.equal(await managed.cleanup(session.id, "uncommitted"), false)
  await git(path!, "checkout", "--", "source.txt")
  await writeFile(join(path!, "untracked.txt"), "keep\n")
  assert.equal(await managed.cleanup(session.id, "uncommitted"), false)
  await rm(join(path!, "untracked.txt"))
  await writeFile(join(path!, ".env"), "TOKEN=test\n")
  assert.equal((await managed.inspectCleanup(session.id, "uncommitted"))?.protected, false)
  assert.equal(await managed.cleanup(session.id, "all"), false)
  assert.equal(await readFile(join(path!, ".env"), "utf8"), "TOKEN=test\n")
  assert.equal(await managed.cleanup(session.id, "uncommitted"), true)
  await assert.rejects(access(path!), { code: "ENOENT" })
  assert.equal(await managed.cleanup(session.id, "uncommitted"), false)
})

test("one protected repository retains every checkout and restore leaves their local edits intact", async context => {
  const { managed, session, paths, sources } = await fixture(context, 2)
  await writeFile(join(paths[1]!, "source.txt"), "keep second repo\n")
  await managed.prepareArchive(session.id)
  assert.equal(await managed.cleanup(session.id, "uncommitted"), false)
  for (const path of paths) await access(path)
  await managed.restore(session.id)
  assert.equal(await readFile(join(paths[1]!, "source.txt"), "utf8"), "keep second repo\n")
  assert.equal(await managed.cleanup(session.id, "none"), true)
  for (const path of paths) await assert.rejects(access(path), { code: "ENOENT" })
  for (const source of sources) assert.equal(await readFile(join(source, "source.txt"), "utf8"), "original\n")
})

test("ancestry cleanup requires all commits to exist in the recorded default branch", async context => {
  const { managed, session, paths: [path], sources: [source] } = await fixture(context)
  assert.equal((await managed.inspectCleanup(session.id, "uncommitted"))?.repositories[0]?.includedInDefault, true)
  await git(path!, "checkout", "-b", "feat/cleanup")
  await writeFile(join(path!, "source.txt"), "committed\n")
  await git(path!, "add", ".")
  await commit(path!)
  let repository = (await managed.inspectCleanup(session.id, "uncommitted"))!.repositories[0]!
  assert.equal(repository.branch, "feat/cleanup")
  assert.equal(repository.defaultBranch, "main")
  assert.equal(repository.includedInDefault, false)
  await git(source!, "merge", "--ff-only", "feat/cleanup")
  assert.equal((await managed.inspectCleanup(session.id, "uncommitted"))?.repositories[0]?.includedInDefault, true)

  await git(source!, "remote", "add", "origin", "https://example.invalid/repo.git")
  repository = (await managed.inspectCleanup(session.id, "uncommitted"))!.repositories[0]!
  assert.equal(repository.defaultBranch, undefined)
  assert.equal(repository.includedInDefault, false)
  await git(source!, "update-ref", "refs/remotes/origin/release", "HEAD")
  await git(source!, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release")
  repository = (await managed.inspectCleanup(session.id, "uncommitted"))!.repositories[0]!
  assert.equal(repository.defaultBranch, "origin/release")
  assert.equal(repository.includedInDefault, true)
})

test("cleanup preserves named branches and detached commits, restoring the saved HEAD", async context => {
  const { managed, session, paths: [path], sources: [source], machine, catalog } = await fixture(context)
  await git(path!, "checkout", "-b", "feat/retained")
  await writeFile(join(path!, "source.txt"), "committed work\n")
  await git(path!, "add", ".")
  await commit(path!)
  const revision = await git(path!, "rev-parse", "HEAD")
  assert.equal(await managed.cleanup(session.id, "uncommitted"), true)
  assert.equal(await git(source!, "rev-parse", "refs/heads/feat/retained"), revision)
  assert.equal(await git(source!, "for-each-ref", "--format=%(objectname)", "refs/deskfleet/sessions"), revision)
  await git(source!, "reflog", "expire", "--expire=now", "--all")
  await git(source!, "gc", "--prune=now")
  const restarted = new ManagedSessionWorktrees(catalog, machine)
  await restarted.restore(session.id)
  assert.equal(await git(path!, "rev-parse", "HEAD"), revision)
  await assert.rejects(git(path!, "symbolic-ref", "--short", "HEAD"))
  assert.equal(await readFile(join(path!, "source.txt"), "utf8"), "committed work\n")

  await git(path!, "checkout", "--detach")
  await writeFile(join(path!, "source.txt"), "detached work\n")
  await git(path!, "add", ".")
  await commit(path!)
  const detached = await git(path!, "rev-parse", "HEAD")
  assert.equal(await restarted.cleanup(session.id, "uncommitted"), true)
  await git(source!, "reflog", "expire", "--expire=now", "--all")
  await git(source!, "gc", "--prune=now")
  await restarted.restore(session.id)
  assert.equal(await git(path!, "rev-parse", "HEAD"), detached)
  await assert.rejects(git(path!, "symbolic-ref", "--short", "HEAD"))
})

test("default refresh follows the remote default and fetches its latest commits without changing source files", async context => {
  const { managed, session, paths: [path], sources: [source], directory } = await fixture(context)
  const remote = join(directory, "remote.git")
  await git(source!, "clone", "--bare", source!, remote)
  await git(source!, "remote", "add", "origin", remote)
  const original = await git(source!, "rev-parse", "HEAD")
  await managed.refreshCleanupDefaults(session.id)
  assert.equal((await managed.inspectCleanup(session.id, "uncommitted"))?.repositories[0]?.defaultBranch, "origin/main")
  await git(path!, "checkout", "-b", "feat/new-default")
  await writeFile(join(path!, "source.txt"), "new default contents\n")
  await git(path!, "add", ".")
  await commit(path!)
  const updated = await git(path!, "rev-parse", "HEAD")
  assert.equal((await managed.inspectCleanup(session.id, "uncommitted"))?.repositories[0]?.includedInDefault, false)
  await git(path!, "push", "origin", "HEAD:refs/heads/release")
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/release")
  await git(source!, "update-ref", "-d", "refs/remotes/origin/release")
  await managed.refreshCleanupDefaults(session.id)
  const inspected = (await managed.inspectCleanup(session.id, "uncommitted"))!.repositories[0]!
  assert.equal(inspected.defaultBranch, "origin/release")
  assert.equal(inspected.includedInDefault, true)
  assert.equal(await git(source!, "rev-parse", "refs/remotes/origin/release"), updated)
  assert.equal(await git(source!, "rev-parse", "HEAD"), original)
  assert.equal(await readFile(join(source!, "source.txt"), "utf8"), "original\n")
})

test("restoring a cleaned checkout never resets a branch advanced elsewhere", async context => {
  const { managed, session, paths: [path], sources: [source] } = await fixture(context)
  await git(path!, "checkout", "-b", "feat/moved")
  const retained = await git(path!, "rev-parse", "HEAD")
  assert.equal(await managed.cleanup(session.id, "uncommitted"), true)
  await git(source!, "checkout", "feat/moved")
  await writeFile(join(source!, "source.txt"), "advanced elsewhere\n")
  await git(source!, "add", ".")
  await commit(source!)
  const advanced = await git(source!, "rev-parse", "HEAD")
  await managed.restore(session.id)
  assert.equal(await git(path!, "rev-parse", "HEAD"), retained)
  await assert.rejects(git(path!, "symbolic-ref", "--short", "HEAD"))
  assert.equal(await git(source!, "rev-parse", "refs/heads/feat/moved"), advanced)
})

test("cleanup rejects a Git candidate whose branch, commits or default revision changed after inspection", async context => {
  const { managed, session, paths: [path], sources: [source] } = await fixture(context)
  const fingerprint = async () => worktreeCleanupFingerprint((await managed.inspectCleanup(session.id, "uncommitted"))!)
  const detached = await fingerprint()
  await git(path!, "checkout", "-b", "feat/new-branch")
  assert.equal(await managed.cleanup(session.id, "uncommitted", detached), false)
  const branched = await fingerprint()
  await writeFile(join(path!, "source.txt"), "new commit\n")
  await git(path!, "add", ".")
  await commit(path!)
  assert.equal(await managed.cleanup(session.id, "uncommitted", branched), false)
  const committed = await fingerprint()
  await git(source!, "merge", "--ff-only", "feat/new-branch")
  assert.equal(await managed.cleanup(session.id, "uncommitted", committed), false)
  assert.equal(await managed.cleanup(session.id, "uncommitted", await fingerprint()), true)
  await assert.rejects(access(path!), { code: "ENOENT" })
})

test("directory Sessions and missing or invalid Git state cannot be deleted by automatic cleanup", async context => {
  const { managed, paths: [path], catalog, sources: [source], session } = await fixture(context)
  const directorySession = await catalog.createWorkspaceSession("1")
  await managed.useDirectories(directorySession)
  assert.equal(await managed.inspectCleanup(directorySession.id, "none"), undefined)
  assert.equal(await managed.cleanup(directorySession.id, "none"), false)
  await access(source!)
  await rm(join(path!, ".git"))
  await assert.rejects(managed.cleanup(session.id, "uncommitted"), /not a git repository/u)
  assert.equal(await readFile(join(path!, "source.txt"), "utf8"), "original\n")
  assert.deepEqual(await inspectWorktreeCleanup([join(path!, "missing")], "uncommitted"), {
    hasCheckouts: false, protected: false, repositories: [{ path: join(path!, "missing"), includedInDefault: false }],
  })
})

test("retaining a partial archive restores removed checkouts and preserves protected files in surviving repositories", async context => {
  const { managed, session, paths, sources, catalog, machine } = await fixture(context, 2)
  await git(sources[1]!, "worktree", "lock", paths[1]!)
  await assert.rejects(managed.cleanup(session.id, "uncommitted"), /locked/u)
  await assert.rejects(access(paths[0]!), { code: "ENOENT" })
  await writeFile(join(paths[1]!, "source.txt"), "keep surviving edit\n")
  await writeFile(join(paths[1]!, "untracked.txt"), "keep surviving file\n")
  assert.equal(await managed.cleanup(session.id, "uncommitted"), false)
  const restarted = new ManagedSessionWorktrees(catalog, machine)
  await restarted.retainArchive(session.id)
  assert.equal(await readFile(join(paths[0]!, "source.txt"), "utf8"), "original\n")
  assert.equal(await readFile(join(paths[1]!, "source.txt"), "utf8"), "keep surviving edit\n")
  assert.equal(await readFile(join(paths[1]!, "untracked.txt"), "utf8"), "keep surviving file\n")
  await restarted.retainArchive(session.id)
  await restarted.restore(session.id)
  assert.equal(await readFile(join(paths[1]!, "source.txt"), "utf8"), "keep surviving edit\n")
  assert.equal(JSON.parse(await readFile(join(machine, "session-worktrees", session.id, "manifest.json"), "utf8")).state, undefined)
})

test("retaining a partial archive refuses unregistered nonempty paths without overwriting files", async context => {
  const { managed, session, paths, sources, machine } = await fixture(context, 2)
  await git(sources[1]!, "worktree", "lock", paths[1]!)
  await assert.rejects(managed.cleanup(session.id, "uncommitted"), /locked/u)
  await mkdir(paths[0]!)
  await writeFile(join(paths[0]!, "recover-me.txt"), "do not overwrite\n")
  await assert.rejects(managed.retainArchive(session.id), /move the unregistered files/u)
  assert.equal(await readFile(join(paths[0]!, "recover-me.txt"), "utf8"), "do not overwrite\n")
  assert.equal(await readFile(join(paths[1]!, "source.txt"), "utf8"), "original\n")
  assert.equal(JSON.parse(await readFile(join(machine, "session-worktrees", session.id, "manifest.json"), "utf8")).state, "archiving")
})

test("retaining a partial archive repairs only its missing registration, preserving unrelated missing worktrees", async context => {
  const { managed, session, paths, sources, directory } = await fixture(context, 2)
  const unrelated = join(directory, "unrelated")
  await git(sources[0]!, "worktree", "add", "--detach", unrelated, "HEAD")
  await rm(unrelated, { recursive: true })
  await git(sources[0]!, "worktree", "lock", paths[0]!)
  await assert.rejects(managed.cleanup(session.id, "uncommitted"), /locked/u)
  await git(sources[0]!, "worktree", "unlock", paths[0]!)
  await rm(paths[0]!, { recursive: true })
  await writeFile(join(paths[1]!, "source.txt"), "keep survivor\n")
  await managed.retainArchive(session.id)
  assert.equal(await readFile(join(paths[0]!, "source.txt"), "utf8"), "original\n")
  assert.equal(await readFile(join(paths[1]!, "source.txt"), "utf8"), "keep survivor\n")
  const listing = (await git(sources[0]!, "worktree", "list", "--porcelain")).replaceAll("\\", "/").toLowerCase()
  assert.ok(listing.includes(`worktree ${unrelated.replaceAll("\\", "/").toLowerCase()}`))
})
