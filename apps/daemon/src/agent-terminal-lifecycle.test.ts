import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { openInMemoryCatalog, type NativeTerminal, type TerminalConfig } from "@deskfleet/native"
import { connectAcpProcess, type AgentClient, type AgentConnection, type AgentProvider } from "./agents/acp.ts"
import { AgentSessions } from "./agent-sessions.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { DaemonCatalog } from "./catalog.ts"
import { MachineRuntime } from "./machine-runtime.ts"
import { TerminalSessions } from "./terminals.ts"

const agentFixture = fileURLToPath(new URL("./fixtures/acp-extensions-agent.ts", import.meta.url))
type NativeEvent = Awaited<ReturnType<NativeTerminal["nextEvent"]>>

class FakeTerminal {
  readonly events: NativeEvent[] = []
  waiting?: (event: NativeEvent) => void
  closed = false

  emit(event: NativeEvent): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve(event)
    } else this.events.push(event)
  }

  nextEvent(): Promise<NativeEvent> {
    if (this.events.length) return Promise.resolve(this.events.shift()!)
    return new Promise(resolve => { this.waiting = resolve })
  }

  async write(): Promise<void> {}
  async resize(): Promise<void> {}
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit({ kind: "data", data: Buffer.from("final output\r\n") })
    this.emit({ kind: "exit", exitCode: 0 })
    this.emit(null)
  }
}

async function setup(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "df-agent-terminal-"))
  const repository = join(directory, "repository")
  await mkdir(repository)
  const catalog = new DaemonCatalog(join(directory, "daemon"))
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const workspace = await catalog.native.createWorkspace("Terminals", [{ path: repository }])
  const native: FakeTerminal[] = []
  const configs: TerminalConfig[] = []
  let spawnBarrier: Promise<void> | undefined
  let spawnStarted: (() => void) | undefined
  const terminals = new TerminalSessions({ directory: join(directory, "terminals"), factory: async config => {
    configs.push(config)
    spawnStarted?.()
    await spawnBarrier
    const terminal = new FakeTerminal()
    native.push(terminal)
    return terminal as NativeTerminal
  } })
  await terminals.init()
  let client!: AgentClient
  let connection!: AgentConnection
  const provider: AgentProvider = {
    id: "codex",
    async connect(_config, callbacks) {
      client = callbacks
      connection = await connectAcpProcess({ command: process.execPath, args: [agentFixture] }, callbacks)
      return connection
    },
  }
  const service = new AgentSessions(catalog, catalog.native, provider, undefined, undefined, terminals, new TestAgentQuotas())
  await service.init()
  service.onSessionArchive(worktreeId => terminals.stopOwned(worktreeId))
  const releases: (() => void)[] = []
  context.after(async () => {
    for (const release of releases) release()
    try { await service.close() }
    finally {
      try { await terminals.close() }
      finally { await catalog.close(); await rm(directory, { recursive: true, force: true }) }
    }
  })
  const actor = { ...service.actor(), kind: "user" as const, userId: "alice" }
  const snapshot = await service.handle("_deskfleet/session/create", {
    workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "directory",
  }, actor) as AgentSnapshot
  assert.equal(snapshot.session.lifecycle, "ready")
  assert.equal(snapshot.session.error, undefined)
  const sessionId = snapshot.session.id
  const providerSessionId = snapshot.session.providerSessionId!
  const worktree = await catalog.sessionWorktree(sessionId)
  assert.ok(worktree)
  async function createTerminal() {
    const result = await connection.prompt({
      sessionId: providerSessionId, prompt: [{ type: "text", text: "Run a command" }],
      _meta: { operation: { method: "terminal/create", params: { command: "fixture-command", args: ["one argument"] } } },
    })
    const callback = result._meta?.callback as { result?: { terminalId: string }; error?: unknown }
    assert.equal(callback.error, undefined)
    assert.ok(callback.result?.terminalId)
    return callback.result.terminalId
  }
  function holdSpawn() {
    let release!: () => void
    spawnBarrier = new Promise<void>(resolve => { release = resolve })
    releases.push(release)
    const started = new Promise<void>(resolve => { spawnStarted = resolve })
    return { started, release }
  }
  const archive = () => service.handle("_deskfleet/session/archive", { sessionId, operationId: randomUUID() }, actor) as Promise<AgentSnapshot>
  return { service, terminals, client, connection, repository, native, configs, sessionId, worktree, createTerminal, holdSpawn, archive }
}

test("managed ACP terminals use the Session context and archive retains their output without stopping a machine shell", { timeout: 15_000 }, async context => {
  const f = await setup(context)
  assert.equal(f.client.terminals?.sessions, f.terminals)
  assert.equal(f.client.terminals?.cwd, f.repository)
  assert.equal(f.client.terminals?.worktreeId, f.worktree.id)
  const capabilities = f.connection.initialization._meta?.clientCapabilities as { terminal?: boolean }
  assert.equal(capabilities.terminal, true)
  const terminalId = await f.createTerminal()
  const terminal = f.terminals.snapshot(terminalId).summary
  assert.equal(terminal.kind, "acp")
  assert.equal(terminal.cwd, f.repository)
  assert.equal(terminal.worktreeId, f.worktree.id)
  assert.equal(f.configs[0]?.command, "fixture-command")
  assert.deepEqual(f.configs[0]?.args, ["one argument"])
  const shell = await f.terminals.dial({ mode: "create", terminalId: randomUUID(), cwd: f.repository, cols: 80, rows: 24 })
  assert.equal((await f.archive()).session.archiveState, "archived")
  assert.equal(f.native[0]?.closed, true)
  assert.equal(f.native[1]?.closed, false)
  assert.notEqual(f.terminals.snapshot(terminalId).summary.status, "running")
  assert.equal((await f.terminals.read(terminalId, 0, 64)).toString(), "final output\r\n")
  assert.equal(f.terminals.snapshot(shell.id).summary.status, "running")
})

test("archive waits for an ACP terminal being spawned and retains its final transcript", { timeout: 15_000 }, async context => {
  const f = await setup(context)
  const barrier = f.holdSpawn()
  const creating = f.createTerminal().then(value => ({ value }), error => ({ error }))
  await barrier.started
  const archiving = new Promise<void>(resolve => {
    const unsubscribe = f.service.onEvent(event => {
      if (event.sessionId === f.sessionId && event.kind === "session"
        && (event.payload as AgentSnapshot["session"]).archiveState === "archiving") {
        unsubscribe()
        resolve()
      }
    })
  })
  let completed = false
  const archived = f.archive().then(snapshot => { completed = true; return snapshot })
  await archiving
  assert.equal(completed, false)
  barrier.release()
  assert.equal((await archived).session.archiveState, "archived")
  await creating
  assert.equal(f.native.length, 1)
  assert.equal(f.native[0]?.closed, true)
  const terminal = f.terminals.list().find(value => value.kind === "acp")
  assert.ok(terminal)
  assert.equal(terminal.worktreeId, f.worktree.id)
  assert.notEqual(terminal.status, "running")
  assert.equal((await f.terminals.read(terminal.id, 0, 64)).toString(), "final output\r\n")
})

test("machine shutdown releases ACP terminal handles before closing their registry", { timeout: 15_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-machine-acp-terminal-"))
  const repository = join(directory, "repository")
  await mkdir(repository)
  const history = join(directory, "terminal-history")
  const native = new FakeTerminal()
  const terminals = new TerminalSessions({ directory: history, factory: async () => native as NativeTerminal })
  let connection!: AgentConnection
  let providerClosed = false
  const provider: AgentProvider = {
    id: "codex",
    async connect(_config, callbacks) {
      connection = await connectAcpProcess({ command: process.execPath, args: [agentFixture] }, callbacks)
      return { ...connection, close: async () => { await connection.close(); providerClosed = true } }
    },
  }
  const runtime = new MachineRuntime(directory, {
    agentProvider: provider, terminals, agentQuotas: new TestAgentQuotas(),
    peers: { create: async () => { throw new Error("Unexpected peer creation") }, close: async () => {} },
    capabilities: async () => ({ displays: [], audio: false }),
    openCatalog: (_path, name) => openInMemoryCatalog(name),
  })
  context.after(async () => {
    try { await runtime.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  await runtime.init()
  const machine = runtime.current
  const workspace = await machine.catalog.native.createWorkspace("Shutdown", [{ path: repository }])
  const created = await machine.agents.handle("_deskfleet/session/create", {
    workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "directory",
  }, machine.agents.actor()) as AgentSnapshot
  assert.equal(created.session.error, undefined)
  const result = await connection.prompt({
    sessionId: created.session.providerSessionId!, prompt: [{ type: "text", text: "Run a command" }],
    _meta: { operation: { method: "terminal/create", params: { command: "fixture-command" } } },
  })
  const callback = result._meta?.callback as { result?: { terminalId: string }; error?: unknown }
  assert.equal(callback.error, undefined)
  const terminalId = callback.result!.terminalId
  const closeTerminals = terminals.close.bind(terminals)
  context.mock.method(terminals, "close", async () => {
    assert.equal(providerClosed, true, "Provider cleanup still needs its terminal handles and history")
    await closeTerminals()
  })
  await runtime.stop()
  assert.equal(native.closed, true)
  assert.equal(await readFile(join(history, terminalId, "output.bin"), "utf8"), "final output\r\n")
  const metadata = JSON.parse(await readFile(join(history, terminalId, "session.json"), "utf8"))
  assert.equal(metadata.terminal.kind, "acp")
  assert.notEqual(metadata.terminal.status, "running")
})
