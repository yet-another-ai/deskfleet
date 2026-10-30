import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { openInMemoryCatalog, type CatalogDirectory, type CatalogWorktree, type CatalogWorkspaceSession } from "@deskfleet/native"
import { connectAcpProcess, type AgentProvider } from "./agents/acp.ts"
import { runAgent } from "./agent-cli.ts"
import { ManagedSessionWorktrees, type ManagedSessionCatalog, type ManagedWorkspaceSession } from "./session-worktrees.ts"
import { readWorktreeRoot, writeWorktreeRoot } from "./worktree-settings.ts"

const execute = promisify(execFile)
const git = async (directory: string, ...args: string[]) => (await execute("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trimEnd()

async function fixture(context: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "df-session-worktrees-")))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function repository(path: string): Promise<void> {
  await mkdir(join(path, "frontend"), { recursive: true })
  await mkdir(join(path, "backend"), { recursive: true })
  await writeFile(join(path, "frontend", "source.txt"), "original frontend\n")
  await writeFile(join(path, "backend", "source.txt"), "original backend\n")
  await git(path, "init", "--initial-branch=main")
  // Git for Windows otherwise checks LF blobs out as CRLF.
  await git(path, "config", "core.autocrlf", "false")
  await git(path, "add", ".")
  await git(path, "-c", "user.name=deskfleet test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "initial")
}

function catalogFixture(directories: CatalogDirectory[]) {
  const sessions = new Map<string, CatalogWorkspaceSession>()
  const worktrees = new Map<string, CatalogWorktree>()
  let nextId = 0
  let failAttachment = false
  const catalog: ManagedSessionCatalog = {
    async snapshot() {
      return { teamId: "1", machineId: "1", machineName: "test", sessions: [], workspaces: [{
        id: "1", name: "workspace", worktrees: [
          { id: "1", workspaceId: "1", directories },
          ...worktrees.values(),
        ],
      }] }
    },
    async createWorkspaceSession(workspaceId) {
      const value = { id: String(++nextId), machineId: "1", workspaceId }
      sessions.set(value.id, value)
      return value
    },
    async attachSessionWorktree(sessionId, bindings) {
      if (failAttachment) throw new Error("catalog attachment failed")
      const session = sessions.get(sessionId)!
      const value = { id: String(Number(sessionId) + 1), workspaceId: session.workspaceId, sessionId, directories: bindings }
      worktrees.set(sessionId, value)
      return value
    },
    async deleteWorkspaceSession(sessionId) {
      sessions.delete(sessionId)
      worktrees.delete(sessionId)
    },
  }
  return { catalog, sessions, worktrees, failAttachment: () => { failAttachment = true } }
}

test("managed sessions preserve directory order, share a checkout for one revision, and destroy only owned trees after restart", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  await repository(source)
  const state = catalogFixture([{ path: join(source, "backend") }, { path: source }, { path: join(source, "frontend") }])
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"))
  const session = await managed.create("1")
  const paths = session.worktree.directories.map(binding => binding.path)
  assert.equal(paths[0], join(paths[1]!, "backend"))
  assert.equal(paths[2], join(paths[1]!, "frontend"))
  assert.equal(dirname(paths[1]!), join(directory, "daemon", "session-worktrees", session.id))
  assert.equal((await git(source, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 2)
  await assert.rejects(git(paths[1]!, "symbolic-ref", "-q", "HEAD"))
  await writeFile(join(paths[0]!, "source.txt"), "session changes\n")
  await writeFile(join(paths[1]!, "untracked.txt"), "disposable\n")

  await new ManagedSessionWorktrees(state.catalog, join(directory, "daemon")).destroy(session.id)
  await assert.rejects(access(paths[1]!))
  assert.equal(await readFile(join(source, "backend", "source.txt"), "utf8"), "original backend\n")
  assert.equal((await git(source, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1)
  assert.equal(state.sessions.size, 0)
})

test("prepared session revisions stay pinned when the source branch advances", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  await repository(source)
  const prepared = await git(source, "rev-parse", "HEAD")
  await writeFile(join(source, "frontend", "source.txt"), "later commit\n")
  await git(source, "add", ".")
  await git(source, "-c", "user.name=deskfleet test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "later")
  const directories = [{ path: join(source, "frontend") }, { path: source }]
  const state = catalogFixture(directories)
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"))
  const session = await managed.create("1", undefined, undefined, directories.map(({ path }) => ({ path, revision: prepared })))
  assert.equal(await git(session.worktree.directories[0]!.path, "rev-parse", "HEAD"), prepared)
  assert.equal(await readFile(join(session.worktree.directories[0]!.path, "source.txt"), "utf8"), "original frontend\n")
  await assert.rejects(managed.create("1", undefined, undefined, [{ path: source, revision: prepared }]), /directories changed/u)
  await assert.rejects(managed.create("1", undefined, undefined, directories.map(({ path }) => ({ path, revision: "HEAD" }))), /Invalid prepared/u)
  assert.equal(state.sessions.size, 1)
  await managed.destroy(session.id)
})

test("managed sessions can check out a selected local or remote base branch", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  await repository(source)
  await git(source, "checkout", "-b", "feat/local")
  await writeFile(join(source, "frontend", "source.txt"), "local branch content\n")
  await git(source, "add", ".")
  await git(source, "-c", "user.name=deskfleet test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "local branch")
  const localRevision = await git(source, "rev-parse", "HEAD")
  await git(source, "checkout", "-b", "temp-remote")
  await writeFile(join(source, "frontend", "source.txt"), "remote branch content\n")
  await git(source, "add", ".")
  await git(source, "-c", "user.name=deskfleet test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "remote branch")
  const remoteRevision = await git(source, "rev-parse", "HEAD")
  await git(source, "update-ref", "refs/remotes/origin/release", remoteRevision)
  await git(source, "checkout", "main")
  await git(source, "branch", "-D", "temp-remote")

  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"))
  const fromLocal = await managed.create("1", undefined, "feat/local")
  assert.equal(await git(fromLocal.worktree.directories[0]!.path, "rev-parse", "HEAD"), localRevision)
  assert.equal(await readFile(join(fromLocal.worktree.directories[0]!.path, "frontend", "source.txt"), "utf8"), "local branch content\n")

  const fromRemote = await managed.create("1", undefined, "origin/release")
  assert.equal(await git(fromRemote.worktree.directories[0]!.path, "rev-parse", "HEAD"), remoteRevision)
  assert.equal(await readFile(join(fromRemote.worktree.directories[0]!.path, "frontend", "source.txt"), "utf8"), "remote branch content\n")

  await managed.destroy(fromLocal.id)
  await managed.destroy(fromRemote.id)
})

test("archive discards working files, retains commits across Git GC, and restores the captured context after restart", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const machine = join(directory, "daemon")
  await repository(source)
  const bindings = [{ path: join(source, "backend") }, { path: source }]
  const state = catalogFixture(bindings)
  const managed = new ManagedSessionWorktrees(state.catalog, machine)
  const session = await managed.create("1")
  const checkout = session.worktree.directories[1]!.path
  await writeFile(join(checkout, "backend", "source.txt"), "committed session work\n")
  await git(checkout, "add", ".")
  await git(checkout, "-c", "user.name=deskfleet test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "session work")
  const revision = await git(checkout, "rev-parse", "HEAD")
  await writeFile(join(checkout, "backend", "source.txt"), "discard this edit\n")
  await writeFile(join(checkout, "untracked.txt"), "discard this file\n")
  await managed.archive(session.id)
  await managed.archive(session.id)
  await assert.rejects(access(checkout))
  assert.equal(state.sessions.size, 1)
  assert.deepEqual(state.worktrees.get(session.id), session.worktree)
  assert.equal((await git(source, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1)
  assert.equal(await git(source, "for-each-ref", "--format=%(objectname)", "refs/deskfleet/sessions"), revision)
  await git(source, "reflog", "expire", "--expire=now", "--all")
  await git(source, "gc", "--prune=now")
  bindings.splice(0, bindings.length, { path: directory })

  const restarted = new ManagedSessionWorktrees(state.catalog, machine)
  await restarted.restore(session.id)
  assert.equal(await git(checkout, "rev-parse", "HEAD"), revision)
  assert.equal(await readFile(join(checkout, "backend", "source.txt"), "utf8"), "committed session work\n")
  await assert.rejects(access(join(checkout, "untracked.txt")))
  await writeFile(join(checkout, "keep-after-restore.txt"), "new work\n")
  await restarted.restore(session.id)
  assert.equal(await readFile(join(checkout, "keep-after-restore.txt"), "utf8"), "new work\n")
  await restarted.destroy(session.id)
  assert.equal(await git(source, "for-each-ref", "refs/deskfleet/sessions"), "")
  assert.equal(state.sessions.size, 0)
})

test("deleting an archived Session cleans owned files after its source repository is moved or deleted", async context => {
  for (const action of ["move", "delete"] as const) {
    await context.test(action, async t => {
      const directory = await fixture(t)
      const source = join(directory, "source")
      const machine = join(directory, "daemon")
      await repository(source)
      const state = catalogFixture([{ path: source }])
      const managed = new ManagedSessionWorktrees(state.catalog, machine)
      const session = await managed.create("1")
      const checkout = session.worktree.directories[0]!.path
      await managed.archive(session.id)
      await mkdir(checkout)
      await writeFile(join(checkout, "leftover.txt"), "owned cleanup residue\n")
      const moved = join(directory, "moved-source")
      if (action === "move") await rename(source, moved)
      else await rm(source, { recursive: true, force: true })

      await new ManagedSessionWorktrees(state.catalog, machine).destroy(session.id)
      await assert.rejects(access(checkout), { code: "ENOENT" })
      await assert.rejects(access(join(machine, "session-worktrees", session.id)), { code: "ENOENT" })
      assert.equal(state.sessions.size, 0)
      assert.equal(state.worktrees.size, 0)
      if (action === "move") assert.equal(await readFile(join(moved, "backend", "source.txt"), "utf8"), "original backend\n")
    })
  }
})

test("deleting an archived Session preserves retry state when an existing repository rejects Git access", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const machine = join(directory, "daemon")
  await repository(source)
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, machine)
  const session = await managed.create("1")
  await managed.archive(session.id)
  const checkout = session.worktree.directories[0]!.path
  await mkdir(checkout)
  await writeFile(join(checkout, "leftover.txt"), "retain until Git cleanup succeeds\n")
  const path = join(machine, "session-worktrees", session.id, "manifest.json")
  const original = await readFile(path, "utf8")
  const repositoryPath = join(source, ".git")
  const unavailable = join(source, "unavailable-git")
  await rename(repositoryPath, unavailable)
  await mkdir(repositoryPath)
  await assert.rejects(managed.destroy(session.id), /not a git repository/u)
  assert.equal(await readFile(path, "utf8"), original)
  assert.equal(await readFile(join(checkout, "leftover.txt"), "utf8"), "retain until Git cleanup succeeds\n")
  assert.equal(state.sessions.size, 1)

  await rm(repositoryPath, { recursive: true, force: true })
  await rename(unavailable, repositoryPath)
  await managed.destroy(session.id)
  assert.equal(state.sessions.size, 0)
  assert.equal(await git(source, "for-each-ref", "refs/deskfleet/sessions"), "")
})

test("archive preflight captures legacy checkout revisions and preserves final commits or a missing-checkout fallback", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const machine = join(directory, "daemon")
  await repository(source)
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, machine)
  const session = await managed.create("1")
  const checkout = session.worktree.directories[0]!.path
  const path = join(machine, "session-worktrees", session.id, "manifest.json")
  const manifest = JSON.parse(await readFile(path, "utf8"))
  delete manifest.worktrees[0].revision
  await writeFile(path, JSON.stringify(manifest))

  await managed.prepareArchive(session.id)
  const prepared = JSON.parse(await readFile(path, "utf8"))
  assert.equal(prepared.state, undefined)
  assert.equal(prepared.worktrees[0].revision, await git(checkout, "rev-parse", "HEAD"))
  assert.equal(await git(source, "rev-parse", prepared.worktrees[0].reference), prepared.worktrees[0].revision)
  await writeFile(join(checkout, "backend", "source.txt"), "final commit before shutdown\n")
  await git(checkout, "add", ".")
  await git(checkout, "-c", "user.name=deskfleet test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "final work")
  const finalRevision = await git(checkout, "rev-parse", "HEAD")
  await managed.archive(session.id)
  await managed.restore(session.id)
  assert.equal(await git(checkout, "rev-parse", "HEAD"), finalRevision)

  await managed.prepareArchive(session.id)
  await git(source, "worktree", "remove", "--force", checkout)
  await new ManagedSessionWorktrees(state.catalog, machine).archive(session.id)
  await managed.restore(session.id)
  assert.equal(await git(checkout, "rev-parse", "HEAD"), finalRevision)
  await managed.destroy(session.id)
})

test("archive preflight leaves every checkout and prior state intact when a legacy revision is unavailable", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const second = join(directory, "second")
  const machine = join(directory, "daemon")
  await repository(source)
  await repository(second)
  const state = catalogFixture([{ path: source }, { path: second }])
  const managed = new ManagedSessionWorktrees(state.catalog, machine)
  const session = await managed.create("1")
  const [firstPath, secondPath] = session.worktree.directories.map(binding => binding.path) as [string, string]
  const path = join(machine, "session-worktrees", session.id, "manifest.json")
  const manifest = JSON.parse(await readFile(path, "utf8"))
  for (const worktree of manifest.worktrees) delete worktree.revision
  const original = JSON.stringify(manifest)
  await writeFile(path, original)
  await writeFile(join(firstPath, "uncommitted.txt"), "keep this work\n")
  await git(second, "worktree", "remove", "--force", secondPath)
  await assert.rejects(managed.prepareArchive(session.id), /original Git revision is unavailable/u)
  await assert.rejects(managed.archive(session.id), /original Git revision is unavailable/u)
  assert.equal(await readFile(path, "utf8"), original)
  assert.equal(await readFile(join(firstPath, "uncommitted.txt"), "utf8"), "keep this work\n")
  assert.equal(await git(source, "for-each-ref", "refs/deskfleet/sessions"), "")

  await mkdir(secondPath)
  await writeFile(join(secondPath, "recoverable.txt"), "keep these remaining files\n")
  await assert.rejects(managed.archive(session.id), /original Git revision is unavailable/u)
  assert.equal(await readFile(join(secondPath, "recoverable.txt"), "utf8"), "keep these remaining files\n")
  assert.equal(await readFile(path, "utf8"), original)
  assert.equal(state.sessions.size, 1)
})

test("archive and restore resume partial multi-repository operations without resetting restored files", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const second = join(directory, "second")
  const machine = join(directory, "daemon")
  await repository(source)
  await repository(second)
  const state = catalogFixture([{ path: source }, { path: second }])
  const managed = new ManagedSessionWorktrees(state.catalog, machine)
  const session = await managed.create("1")
  const [firstPath, secondPath] = session.worktree.directories.map(binding => binding.path) as [string, string]
  await git(second, "worktree", "lock", secondPath)
  await assert.rejects(managed.archive(session.id), /locked/u)
  await assert.rejects(access(firstPath))
  await access(secondPath)
  await assert.rejects(managed.restore(session.id), /Finish archiving/u)
  await git(second, "worktree", "unlock", secondPath)
  // A process can exit after Git removes files but before it unregisters the
  // checkout. Retrying archive must read the retained HEAD without that path.
  await rm(secondPath, { recursive: true, force: true })
  assert.match(await git(second, "worktree", "list", "--porcelain"), /prunable/u)
  const restarted = new ManagedSessionWorktrees(state.catalog, machine)
  await restarted.archive(session.id)
  await assert.rejects(access(secondPath))

  const secondGit = join(second, ".git")
  const unavailableGit = join(second, "unavailable-git")
  await rename(secondGit, unavailableGit)
  await assert.rejects(restarted.restore(session.id), /not a git repository/u)
  await access(firstPath)
  await writeFile(join(firstPath, "new-work.txt"), "retained after retry\n")
  await rename(unavailableGit, secondGit)
  const nextRestart = new ManagedSessionWorktrees(state.catalog, machine)
  await nextRestart.restore(session.id)
  assert.equal(await readFile(join(firstPath, "new-work.txt"), "utf8"), "retained after retry\n")
  await access(secondPath)

  await nextRestart.archive(session.id)
  await rename(secondGit, unavailableGit)
  await assert.rejects(nextRestart.restore(session.id), /not a git repository/u)
  await rename(unavailableGit, secondGit)
  await nextRestart.archive(session.id)
  await assert.rejects(access(firstPath))
  await assert.rejects(access(secondPath))
  await nextRestart.destroy(session.id)
  for (const root of [source, second]) assert.equal(await git(root, "for-each-ref", "refs/deskfleet/sessions"), "")
  assert.equal(state.sessions.size, 0)
})

test("archive frees a custom root and restore uses its captured location after the setting changes", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const machine = join(directory, "daemon")
  const root = join(directory, "worktrees")
  await repository(source)
  await mkdir(root)
  const state = catalogFixture([{ path: source }])
  const storage = { originId: "origin", root: async (): Promise<string | null> => root }
  const managed = new ManagedSessionWorktrees(state.catalog, machine, storage)
  const session = await managed.create("1")
  const checkout = session.worktree.directories[0]!.path
  await managed.archive(session.id)
  await assert.rejects(access(dirname(checkout)))
  await access(join(machine, "session-worktrees", session.id, "manifest.json"))
  storage.root = async () => null
  const restarted = new ManagedSessionWorktrees(state.catalog, machine, storage)
  await restarted.restore(session.id)
  await access(checkout)
  await restarted.archive(session.id)
  await restarted.destroy(session.id)
  await assert.rejects(access(join(machine, "session-worktrees", session.id)))
  assert.equal(await git(source, "for-each-ref", "refs/deskfleet/sessions"), "")
})

test("restore finishes a checkout interrupted after Git registration", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const machine = join(directory, "daemon")
  await repository(source)
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, machine)
  const session = await managed.create("1")
  const checkout = session.worktree.directories[0]!.path
  await managed.archive(session.id)
  const path = join(machine, "session-worktrees", session.id, "manifest.json")
  const manifest = JSON.parse(await readFile(path, "utf8"))
  manifest.state = "restoring"
  await writeFile(path, JSON.stringify(manifest))
  await git(source, "worktree", "add", "--detach", "--no-checkout", checkout, manifest.worktrees[0].revision)
  await assert.rejects(access(join(checkout, "backend", "source.txt")))
  await new ManagedSessionWorktrees(state.catalog, machine).restore(session.id)
  assert.equal(await readFile(join(checkout, "backend", "source.txt"), "utf8"), "original backend\n")
  await managed.destroy(session.id)
})

test("changing or resetting the root affects new sessions and preserves cleanup after restart", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const host = join(directory, "daemon")
  const machine = join(host, "machine")
  const firstRoot = join(directory, "first disk")
  const secondRoot = join(directory, "second disk")
  await repository(source)
  const state = catalogFixture([{ path: join(source, "backend") }, { path: source }])
  const storage = { originId: "origin-a", root: () => readWorktreeRoot(host) }
  const managed = new ManagedSessionWorktrees(state.catalog, machine, storage)
  await writeWorktreeRoot(host, firstRoot)
  const first = await managed.create("1")
  assert.equal(first.worktree.directories[1]!.path, join(firstRoot, "origin-a", first.id, "repo-0"))
  await access(join(machine, "session-worktrees", first.id, "manifest.json"))
  await writeFile(join(first.worktree.directories[0]!.path, "source.txt"), "retained changes\n")

  await writeWorktreeRoot(host, secondRoot)
  const second = await managed.create("1")
  assert.equal(second.worktree.directories[1]!.path, join(secondRoot, "origin-a", second.id, "repo-0"))
  await writeWorktreeRoot(host, null)
  const third = await managed.create("1")
  assert.equal(third.worktree.directories[1]!.path, join(machine, "session-worktrees", third.id, "repo-0"))
  assert.equal(await readFile(join(first.worktree.directories[0]!.path, "source.txt"), "utf8"), "retained changes\n")

  const restarted = new ManagedSessionWorktrees(state.catalog, machine, storage)
  for (const session of [first, second, third]) {
    await restarted.destroy(session.id)
    await assert.rejects(access(session.worktree.directories[1]!.path))
    await assert.rejects(access(join(machine, "session-worktrees", session.id)))
  }
  assert.equal(await readFile(join(source, "backend", "source.txt"), "utf8"), "original backend\n")
  assert.equal((await git(source, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1)
})

test("catalog origins isolate equal session IDs in a shared custom root", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const root = join(directory, "worktrees")
  await repository(source)
  await mkdir(root)
  const firstState = catalogFixture([{ path: source }])
  const secondState = catalogFixture([{ path: source }])
  const first = new ManagedSessionWorktrees(firstState.catalog, join(directory, "machine"), { originId: "first-origin", root: async () => root })
  const second = new ManagedSessionWorktrees(secondState.catalog, join(directory, "next-machine"), { originId: "second-origin", root: async () => root })
  const firstSession = await first.create("1")
  const secondSession = await second.create("1")
  assert.equal(firstSession.id, secondSession.id)
  assert.notEqual(firstSession.worktree.directories[0]!.path, secondSession.worktree.directories[0]!.path)
  await first.destroy(firstSession.id)
  await access(secondSession.worktree.directories[0]!.path)
  await second.destroy(secondSession.id)
})

test("real catalogs read host preferences live and keep separate origins in the same root", async context => {
  const { DaemonCatalog } = await import("./catalog.ts")
  const directory = await realpath(await mkdtemp(join(tmpdir(), "df-worktree-catalogs-")))
  const host = join(directory, "daemon")
  const firstMachine = join(host, "machine")
  const secondMachine = join(host, "machines", "next-registration")
  const firstCatalog = new DaemonCatalog(firstMachine, host)
  const secondCatalog = new DaemonCatalog(secondMachine, host)
  context.after(async () => {
    await Promise.all([firstCatalog.close(), secondCatalog.close()])
    await rm(directory, { recursive: true, force: true })
  })
  await Promise.all([mkdir(firstMachine, { recursive: true }), mkdir(secondMachine, { recursive: true })])
  await Promise.all([
    firstCatalog.init((_path, name) => openInMemoryCatalog(name)),
    secondCatalog.init((_path, name) => openInMemoryCatalog(name)),
  ])
  const firstOrigin = JSON.parse(await firstCatalog.native.agentIdentity()).originId as string
  const secondOrigin = JSON.parse(await secondCatalog.native.agentIdentity()).originId as string
  assert.notEqual(firstOrigin, secondOrigin)
  const source = join(directory, "source")
  await repository(source)
  const firstWorkspace = await firstCatalog.native.createWorkspace("first", [{ path: source }])
  const secondWorkspace = await secondCatalog.native.createWorkspace("second", [{ path: source }])
  const root = join(directory, "other disk")
  await writeWorktreeRoot(host, root)
  const first = await firstCatalog.handle({ method: "workspaceSessionCreate", params: { workspaceId: firstWorkspace.id } }) as ManagedWorkspaceSession
  const second = await secondCatalog.handle({ method: "workspaceSessionCreate", params: { workspaceId: secondWorkspace.id } }) as ManagedWorkspaceSession
  assert.equal(first.id, second.id)
  assert.equal(first.worktree.directories[0]!.path, join(root, firstOrigin, first.id, "repo-0"))
  assert.equal(second.worktree.directories[0]!.path, join(root, secondOrigin, second.id, "repo-0"))

  const nextRoot = join(directory, "next disk")
  await writeWorktreeRoot(host, nextRoot)
  const next = await firstCatalog.handle({ method: "workspaceSessionCreate", params: { workspaceId: firstWorkspace.id } }) as ManagedWorkspaceSession
  assert.equal(next.worktree.directories[0]!.path, join(nextRoot, firstOrigin, next.id, "repo-0"))
  await access(first.worktree.directories[0]!.path)
  await access(second.worktree.directories[0]!.path)
  await writeWorktreeRoot(host, null)
  for (const [catalog, session] of [[firstCatalog, first], [secondCatalog, second], [firstCatalog, next]] as const) {
    await catalog.handle({ method: "workspaceSessionDestroy", params: { sessionId: session.id } })
    await assert.rejects(access(session.worktree.directories[0]!.path))
  }
})

test("failed provisioning rolls back custom checkouts and stable ownership records", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const host = join(directory, "daemon")
  const root = join(directory, "worktrees")
  await repository(source)
  await writeWorktreeRoot(host, root)
  const state = catalogFixture([{ path: source }])
  state.failAttachment()
  const managed = new ManagedSessionWorktrees(state.catalog, host, { originId: "origin", root: () => readWorktreeRoot(host) })
  await assert.rejects(managed.create("1"), /catalog attachment failed/u)
  assert.equal(state.sessions.size, 0)
  await assert.rejects(access(join(root, "origin", "1")))
  await assert.rejects(access(join(host, "session-worktrees", "1")))
  assert.equal((await git(source, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1)
})

test("unavailable custom roots fail without falling back or allocating a session", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const host = join(directory, "daemon")
  const root = join(directory, "worktrees")
  await repository(source)
  await writeWorktreeRoot(host, root)
  await rm(root, { recursive: true })
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, host, { originId: "origin", root: () => readWorktreeRoot(host) })
  await assert.rejects(managed.create("1"), { code: "ENOENT" })
  assert.equal(state.sessions.size, 0)
  await assert.rejects(access(join(host, "session-worktrees")))
})

test("custom creation does not claim or remove an existing session directory", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const root = join(directory, "worktrees")
  const existing = join(root, "origin", "1")
  await repository(source)
  await mkdir(existing, { recursive: true })
  await writeFile(join(existing, "keep.txt"), "unowned")
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"), { originId: "origin", root: async () => root })
  await assert.rejects(managed.create("1"), { code: "EEXIST" })
  assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "unowned")
  assert.equal(state.sessions.size, 0)
})

test("custom ownership manifests cannot redirect removal to workspace directories", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const host = join(directory, "daemon")
  const root = join(directory, "worktrees")
  await repository(source)
  await writeWorktreeRoot(host, root)
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, host, { originId: "origin", root: () => readWorktreeRoot(host) })
  const session = await managed.create("1")
  const path = join(host, "session-worktrees", session.id, "manifest.json")
  const original = await readFile(path, "utf8")
  const manifest = JSON.parse(original)
  manifest.directory = source
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(managed.destroy(session.id), /ownership manifest/u)
  await access(join(source, "frontend", "source.txt"))
  await writeFile(path, original)
  await managed.destroy(session.id)
})

test("directory sessions ignore worktree storage settings and never remove workspace files", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  await mkdir(source)
  await writeFile(join(source, "keep.txt"), "workspace")
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"), {
    originId: "origin", root: async () => { throw new Error("Storage settings must not be read") },
  })
  const allocated = await state.catalog.createWorkspaceSession("1")
  const session = await managed.useDirectories(allocated)
  assert.equal(session.worktree.directories[0]!.path, source)
  await managed.archive(session.id)
  await managed.restore(session.id)
  assert.equal(await readFile(join(source, "keep.txt"), "utf8"), "workspace")
  assert.equal(state.sessions.size, 1)
  await managed.destroy(session.id)
  assert.equal(await readFile(join(source, "keep.txt"), "utf8"), "workspace")
})

test("separate revisions of the same Git repository receive separate session trees", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const prior = join(directory, "prior")
  await repository(source)
  await git(source, "worktree", "add", "--detach", prior, "HEAD")
  await writeFile(join(source, "frontend", "source.txt"), "new revision\n")
  await git(source, "add", ".")
  await git(source, "-c", "user.name=deskfleet test", "-c", "user.email=test@example.invalid", "commit", "--no-gpg-sign", "-m", "second")
  const state = catalogFixture([{ path: source }, { path: prior }])
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"))
  const session = await managed.create("1")
  const [current, previous] = session.worktree.directories
  assert.notEqual(current!.path, previous!.path)
  assert.equal(await readFile(join(current!.path, "frontend", "source.txt"), "utf8"), "new revision\n")
  assert.equal(await readFile(join(previous!.path, "frontend", "source.txt"), "utf8"), "original frontend\n")
  await managed.destroy(session.id)
  await access(prior)
})

test("failed attachment rolls back created Git checkouts and the session record", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  await repository(source)
  const state = catalogFixture([{ path: source }])
  state.failAttachment()
  await assert.rejects(new ManagedSessionWorktrees(state.catalog, join(directory, "daemon")).create("1"), /catalog attachment failed/u)
  assert.equal(state.sessions.size, 0)
  assert.equal((await git(source, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1)
  await access(join(source, "frontend", "source.txt"))
})

test("partial multi-repository creation rolls back when a bound directory is absent from HEAD", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  const second = join(directory, "second")
  await repository(source)
  await repository(second)
  const untracked = join(second, "untracked-directory")
  await mkdir(untracked)
  const state = catalogFixture([{ path: source }, { path: untracked }])
  await assert.rejects(new ManagedSessionWorktrees(state.catalog, join(directory, "daemon")).create("1"), /ENOENT|committed Git tree/u)
  assert.equal(state.sessions.size, 0)
  for (const root of [source, second]) assert.equal((await git(root, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1)
  await access(untracked)
})

test("non-Git directories cannot allocate an isolated session", async context => {
  const directory = await fixture(context)
  const state = catalogFixture([{ path: directory }])
  await assert.rejects(new ManagedSessionWorktrees(state.catalog, join(directory, "daemon")).create("1"), /Git working tree with a committed HEAD/u)
  assert.equal(state.sessions.size, 0)
})

test("destroy rejects an ownership manifest redirected at a source checkout", async context => {
  const directory = await fixture(context)
  const source = join(directory, "source")
  await repository(source)
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"))
  const session = await managed.create("1")
  const path = join(directory, "daemon", "session-worktrees", session.id, "manifest.json")
  const original = await readFile(path, "utf8")
  const manifest = JSON.parse(original)
  manifest.worktrees[0].path = source
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(managed.destroy(session.id), /ownership manifest/u)
  await access(join(source, "frontend", "source.txt"))
  await writeFile(path, original)
  await managed.destroy(session.id)
})

test("workspace CLI passes ordered directories to ACP and destroys them only after the agent process exits", { timeout: 20_000 }, async context => {
  context.mock.method(console, "log", () => {})
  const directory = await fixture(context)
  const source = join(directory, "source")
  await repository(source)
  const state = catalogFixture([{ path: join(source, "backend") }, { path: join(source, "frontend") }])
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"))
  const exitFile = join(directory, "agent-exit")
  let created: ManagedWorkspaceSession | undefined
  let disconnected = false
  const provider: AgentProvider = {
    id: "fixture",
    async connect(_config, client) {
      const connection = await connectAcpProcess({
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))],
        env: { DESKFLEET_TEST_EXIT_FILE: exitFile },
      }, client)
      return {
        ...connection,
        async setConfigOption() { return { configOptions: [] } },
        async newSession(params) {
          assert.equal(params.cwd, created!.worktree.directories[0]!.path)
          assert.deepEqual(params.additionalDirectories, [created!.worktree.directories[1]!.path])
          return connection.newSession(params)
        },
      }
    },
  }
  await runAgent(["codex", "--workspace-id", "1", "--prompt", "test"], {
    provider,
    workspaceSessions: async () => ({
      create: async id => created = await managed.create(id),
      destroy: async id => {
        assert.equal(await readFile(exitFile, "utf8"), "0")
        await access(created!.worktree.directories[0]!.path)
        await managed.destroy(id)
      },
      close: () => { disconnected = true },
    }),
  })
  assert.equal(state.sessions.size, 0)
  assert.equal(disconnected, true)
  await assert.rejects(access(created!.worktree.directories[0]!.path))
})

test("provider initialization failure cleans up its allocated workspace session", async context => {
  context.mock.method(console, "log", () => {})
  const directory = await fixture(context)
  const source = join(directory, "source")
  await repository(source)
  const state = catalogFixture([{ path: source }])
  const managed = new ManagedSessionWorktrees(state.catalog, join(directory, "daemon"))
  await assert.rejects(runAgent(["codex", "--workspace-id", "1", "--prompt", "test"], {
    provider: { id: "fixture", connect: async () => { throw new Error("provider initialization failed") } },
    workspaceSessions: async () => ({ create: id => managed.create(id), destroy: id => managed.destroy(id), close() {} }),
  }), /provider initialization failed/u)
  assert.equal(state.sessions.size, 0)
  assert.equal((await git(source, "worktree", "list", "--porcelain")).match(/^worktree /gmu)?.length, 1)
  await assert.rejects(runAgent(["codex", "--workspace-id", "1", "--cwd", source, "--prompt", "test"]), /mutually exclusive/u)
})

test("interruptions during checkout or provider initialization still clean up the allocated session", async context => {
  context.mock.method(console, "log", () => {})
  for (const phase of ["checkout", "provider"] as const) {
    await context.test(phase, async () => {
      let notifyStarted!: () => void
      let resumeStartup!: () => void
      const started = new Promise<void>(resolve => { notifyStarted = resolve })
      const continueStartup = new Promise<void>(resolve => { resumeStartup = resolve })
      const events: string[] = []
      const session: ManagedWorkspaceSession = {
        id: "7", machineId: "1", workspaceId: "1",
        worktree: { id: "8", workspaceId: "1", sessionId: "7", directories: [{ path: process.cwd() }] },
      }
      const signal = phase === "checkout" ? "SIGINT" : "SIGTERM"
      const listenerCount = process.listenerCount(signal)
      const pending = runAgent(["codex", "--workspace-id", "1", "--prompt", "test"], {
        workspaceSessions: async () => ({
          create: async () => {
            if (phase === "checkout") { notifyStarted(); await continueStartup }
            return session
          },
          destroy: async id => { assert.equal(id, session.id); events.push("destroy") },
          close: () => { events.push("client-close") },
        }),
        provider: {
          id: "fixture",
          async connect() {
            assert.equal(phase, "provider", "An interrupted checkout must not launch a provider")
            notifyStarted()
            await continueStartup
            return {
              initialization: { protocolVersion: 1 },
              setConfigOption: async () => ({ configOptions: [] }),
              newSession: async () => assert.fail("An interrupted initialization must not create an ACP session"),
              resume: async () => assert.fail("An interrupted initialization must not resume an ACP session"),
              steer: async () => assert.fail("An interrupted initialization must not steer"),
              prompt: async () => assert.fail("An interrupted initialization must not prompt"),
              cancel: async () => assert.fail("No ACP session exists to cancel"),
              close: async () => { await Promise.resolve(); events.push("provider-close") },
            }
          },
        },
      })
      await started
      assert.equal(process.emit(signal), true)
      resumeStartup()
      await pending
      assert.deepEqual(events, phase === "checkout" ? ["destroy", "client-close"] : ["provider-close", "destroy", "client-close"])
      assert.equal(process.listenerCount(signal), listenerCount)
    })
  }
})
