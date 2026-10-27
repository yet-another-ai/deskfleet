import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import test from "node:test"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { AgentClient, AgentConnection, AgentProvider } from "./agents/acp.ts"
import { AgentSessions } from "./agent-sessions.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { DaemonCatalog } from "./catalog.ts"

const execute = promisify(execFile)
class ForkProvider implements AgentProvider {
  id = "codex"
  supported = true
  failFork = false
  created = 0
  closed: string[] = []
  forks: acp.ForkSessionRequest[] = []
  resumes: string[] = []
  promptBarrier?: Promise<void>
  forkBarrier?: Promise<void>
  async connect(_config: unknown, client: AgentClient): Promise<AgentConnection> {
    let id = ""
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, additionalDirectories: {}, ...(this.supported ? { fork: {} } : {}) } } },
      newSession: async () => ({ sessionId: id = `original-${++this.created}` }),
      forkSession: async params => {
        this.forks.push(structuredClone(params))
        await this.forkBarrier
        if (this.failFork) throw new Error("Fork failed at provider")
        return { sessionId: id = `fork-${this.forks.length}` }
      },
      resume: async params => { id = params.sessionId; this.resumes.push(id); return {} },
      setConfigOption: async () => ({ configOptions: [] }),
      prompt: async params => {
        await this.promptBarrier
        await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "An inherited answer" } } })
        return { stopReason: "end_turn" }
      },
      steer: async () => ({ outcome: "inactive" }), cancel: async () => {}, close: async () => { this.closed.push(id) },
    }
  }
}

async function setup(t: { after(action: () => Promise<void>): void }, supported = true) {
  const directory = await mkdtemp(join(tmpdir(), "df-fork-"))
  const repository = join(directory, "repo")
  await mkdir(repository)
  await execute("git", ["init", repository])
  await writeFile(join(repository, "README.md"), "committed\n")
  await execute("git", ["-C", repository, "add", "."])
  await execute("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"])
  const catalog = new DaemonCatalog(directory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const workspace = await catalog.native.createWorkspace("Fork", [{ path: repository }])
  const provider = new ForkProvider()
  provider.supported = supported
  const sessions = new AgentSessions(catalog, catalog.native, provider)
  await sessions.init()
  t.after(async () => { await sessions.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const actor = sessions.actor()
  const source = await sessions.handle("_deskfleet/session/create", {
    workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "directory", title: "Original",
  }, actor) as AgentSnapshot
  const fork = (context: "directory" | "worktree" = "directory", operationId = randomUUID()) => sessions.handle("_deskfleet/session/fork", { sessionId: source.session.id, operationId, context }, actor) as Promise<AgentSnapshot>
  return { catalog, sessions, actor, provider, source, fork, repository }
}

async function until(read: () => Promise<AgentSnapshot>, ready: (snapshot: AgentSnapshot) => boolean): Promise<AgentSnapshot> {
  for (let n = 0; n < 300; n++) { const value = await read(); if (ready(value)) return value; await delay(10) }
  throw new Error("Agent state did not settle")
}

test("fork creates an independent conversation, history and owned context, and retries reuse it", async t => {
  const f = await setup(t)
  assert.equal(f.source.session.capabilities?.fork, true)
  await f.sessions.handle("_deskfleet/input/submit", { sessionId: f.source.session.id, operationId: randomUUID(), content: [{ type: "text", text: "Remember this" }], delivery: "backlog" }, f.actor)
  const original = await until(() => f.sessions.journal.read(f.source.session.id), value => value.turns.at(-1)?.state === "completed")
  const operationId = randomUUID()
  const child = await f.fork("worktree", operationId)
  assert.equal(child.session.lifecycle, "ready")
  assert.notEqual(child.session.id, original.session.id)
  assert.notEqual(child.session.providerSessionId, original.session.providerSessionId)
  assert.equal(child.session.provider, original.session.provider)
  assert.equal(child.session.workspaceId, original.session.workspaceId)
  assert.equal(f.provider.created, 1, "fork must never fall back to a blank conversation")
  assert.equal(f.provider.forks[0]!.sessionId, original.session.providerSessionId)
  const tree = await f.catalog.sessionWorktree(child.session.id)
  assert.ok(tree)
  assert.notEqual(tree.directories[0]!.path, f.repository)
  assert.equal(f.provider.forks[0]!.cwd, tree.directories[0]!.path)
  const history = await f.sessions.journal.history(child.session.id, "0", 200)
  assert.ok(history.some(event => event.kind === "input" && JSON.stringify(event.payload).includes("Remember this")))
  assert.ok(history.some(event => event.kind === "acp" && JSON.stringify(event.payload).includes("An inherited answer")))
  assert.equal(child.inputs.length, 0, "inherited inputs cannot enter the new backlog")
  assert.ok(child.runs.at(-1)!.generation > original.runs.at(-1)!.generation)
  assert.deepEqual((await f.fork("worktree", operationId)).session, child.session)
  assert.equal(f.provider.forks.length, 1)
  await assert.rejects(f.fork("directory", operationId), /reused/)
  await f.sessions.handle("_deskfleet/session/stop", { sessionId: child.session.id, operationId: randomUUID() }, f.actor)
  await f.sessions.handle("_deskfleet/session/resume", { sessionId: child.session.id, operationId: randomUUID() }, f.actor)
  assert.equal(f.provider.resumes.at(-1), child.session.providerSessionId)
  assert.equal(f.provider.closed.includes(original.session.providerSessionId!), false)
  assert.deepEqual((await f.sessions.journal.read(original.session.id)).inputs, original.inputs)
})

test("machine-scoped Sessions cannot fork into a worktree context", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-fork-home-"))
  const catalog = new DaemonCatalog(directory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const provider = new ForkProvider()
  const sessions = new AgentSessions(catalog, catalog.native, provider)
  await sessions.init()
  t.after(async () => { await sessions.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const actor = sessions.actor()
  const source = await sessions.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider: "codex", context: "directory", title: "Home",
  }, actor) as AgentSnapshot
  assert.equal(source.session.workspaceId, undefined)
  await assert.rejects(
    sessions.handle("_deskfleet/session/fork", { sessionId: source.session.id, operationId: randomUUID(), context: "worktree" }, actor),
    /home directory/,
  )
  assert.equal((await sessions.journal.list()).length, 1)
})

test("unsupported and busy source sessions cannot allocate a fork", async t => {
  const unsupported = await setup(t, false)
  const unsupportedOperation = randomUUID()
  await assert.rejects(unsupported.fork("directory", unsupportedOperation), /does not support/)
  await assert.rejects(unsupported.fork("directory", unsupportedOperation), /does not support/)
  assert.equal((await unsupported.sessions.journal.list()).length, 1)
  const f = await setup(t)
  let release!: () => void
  f.provider.promptBarrier = new Promise(resolve => { release = resolve })
  await f.sessions.handle("_deskfleet/input/submit", { sessionId: f.source.session.id, operationId: randomUUID(), content: [{ type: "text", text: "Work" }], delivery: "backlog" }, f.actor)
  await until(() => f.sessions.journal.read(f.source.session.id), value => value.turns.at(-1)?.state === "running")
  const busyOperation = randomUUID()
  try {
    await assert.rejects(f.fork("directory", busyOperation), /Wait for the current/)
    await assert.rejects(f.fork("directory", busyOperation), /Wait for the current/)
    assert.equal((await f.sessions.journal.list()).length, 1)
  }
  finally { release() }
})

test("failed fork remains failed and cannot turn into a blank conversation after retry or restart", async t => {
  const f = await setup(t)
  f.provider.failFork = true
  const operationId = randomUUID()
  const child = await f.fork("directory", operationId)
  assert.equal(child.session.lifecycle, "provision_failed")
  assert.match(child.session.error!, /Fork failed at provider/)
  assert.equal(child.session.providerSessionId, undefined)
  assert.equal((await f.fork("directory", operationId)).session.id, child.session.id)
  await assert.rejects(f.sessions.handle("_deskfleet/session/resume", { sessionId: child.session.id, operationId: randomUUID() }, f.actor), /no usable execution context/)
  await f.sessions.init()
  await assert.rejects(f.sessions.handle("_deskfleet/input/submit", { sessionId: child.session.id, operationId: randomUUID(), content: [{ type: "text", text: "Continue" }], delivery: "backlog" }, f.actor), /no usable execution context/)
  assert.equal(f.provider.created, 1)
  assert.equal(f.provider.forks.length, 1)
})
