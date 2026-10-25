import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { CatalogDirectory, CatalogWorktree, CatalogWorkspaceSession } from "@deskfleet/native"
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
      return { teamId: "1", machineId: "1", machineName: "test", workspaces: [{
        id: "1", name: "workspace", worktrees: [
          { id: "1", workspaceId: "1", directories },
          ...worktrees.values(),
        ],
      }] }
    },
    async createWorkspaceSession(workspaceId) {
      const value = { id: String(++nextId), workspaceId }
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
  await Promise.all([firstCatalog.init(), secondCatalog.init()])
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
        id: "7", workspaceId: "1",
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
