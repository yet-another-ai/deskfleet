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
              newSession: async () => assert.fail("An interrupted initialization must not create an ACP session"),
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
