import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import type { NativeTerminal, TerminalConfig } from "@deskfleet/native"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { connectAcpProcess, type AgentConnection } from "./agents/acp.ts"
import { AcpTerminals } from "./agents/terminals.ts"
import { TerminalSessions } from "./terminals.ts"

type NativeEvent = Awaited<ReturnType<NativeTerminal["nextEvent"]>>

class CommandTerminal {
  readonly events: NativeEvent[] = []
  waiting?: (event: NativeEvent) => void
  closed = false

  emit(event: NativeEvent): void {
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(event) }
    else this.events.push(event)
  }
  async nextEvent(): Promise<NativeEvent> {
    if (this.events.length) return this.events.shift()!
    return new Promise(resolve => { this.waiting = resolve })
  }
  async write(): Promise<void> { throw new Error("ACP commands have no human input") }
  async resize(): Promise<void> { throw new Error("ACP command sizes are fixed") }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit({ kind: "exit", exitCode: 0 })
    this.emit(null)
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Terminal test condition timed out")
    await delay(2)
  }
}

async function fixture(context: TestContext, launchGate?: Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "df-acp-terminal-"))
  const commands: CommandTerminal[] = []
  const configs: TerminalConfig[] = []
  const sessions = new TerminalSessions({ directory: join(cwd, "history"), factory: async config => {
    configs.push(config)
    await launchGate
    const command = new CommandTerminal()
    commands.push(command)
    return command as NativeTerminal
  } })
  const connections: AgentConnection[] = []
  const helpers: AcpTerminals[] = []
  context.after(async () => {
    await Promise.all(connections.map(connection => connection.close()))
    await Promise.all(helpers.map(helper => helper.close()))
    await sessions.close()
    await rm(cwd, { recursive: true, force: true })
  })
  const connect = async (enabled = true, mode?: string) => {
    const connection = await connectAcpProcess({
      command: process.execPath, args: [fileURLToPath(new URL("./fixtures/acp-terminal-agent.ts", import.meta.url))],
      env: { DESKFLEET_TEST_TERMINAL_MODE: mode },
    }, { onUpdate() {}, ...(enabled ? { terminals: { sessions, cwd, worktreeId: "42" } } : {}) })
    connections.push(connection)
    return connection
  }
  const helper = () => {
    const terminals = new AcpTerminals({ sessions, cwd, worktreeId: "42" }, sessionId => assert.equal(sessionId, "session"))
    helpers.push(terminals)
    return terminals
  }
  return { cwd, sessions, commands, configs, connect, helper }
}

async function callback(connection: AgentConnection, sessionId: string, method: string, params: Record<string, unknown> = {}) {
  const response = await connection.prompt({ sessionId, prompt: [], _meta: { operation: { method, params } } })
  return response._meta?.callback as { result?: unknown; error?: { code: number; message: string } }
}

test("ACP terminal capability is only enabled with its daemon service", { timeout: 15_000 }, async context => {
  const f = await fixture(context)
  const connection = await f.connect(false)
  assert.equal((connection.initialization._meta?.clientCapabilities as acp.ClientCapabilities).terminal, false)
  const { sessionId } = await connection.newSession({ cwd: f.cwd, mcpServers: [] })
  assert.equal((await callback(connection, sessionId, "terminal/create", { command: "unused" })).error?.code, -32601)
  assert.equal(f.commands.length, 0)
})

test("ACP creates, reads, waits, kills and releases only its own commands", { timeout: 15_000 }, async context => {
  const f = await fixture(context)
  const connection = await f.connect()
  assert.equal((connection.initialization._meta?.clientCapabilities as acp.ClientCapabilities).terminal, true)
  const { sessionId } = await connection.newSession({ cwd: f.cwd, mcpServers: [] })
  for (const params of [{ cwd: "." }, { outputByteLimit: -1 }]) {
    assert.equal((await callback(connection, sessionId, "terminal/create", { command: "invalid", ...params })).error?.code, -32602)
  }
  const created = await callback(connection, sessionId, "terminal/create", {
    command: "fixture-command", args: ["literal $(value)"], env: [{ name: "TEST_VALUE", value: "exact" }], outputByteLimit: 3,
  })
  const { terminalId } = created.result as acp.CreateTerminalResponse
  assert.deepEqual(f.configs[0], { cwd: f.cwd, cols: 80, rows: 24, command: "fixture-command", args: ["literal $(value)"], env: { TEST_VALUE: "exact" } })
  assert.equal(f.sessions.snapshot(terminalId).summary.kind, "acp")
  assert.equal(f.sessions.snapshot(terminalId).summary.worktreeId, "42")
  f.commands[0]!.emit({ kind: "data", data: Buffer.from("old€x") })
  await until(() => f.sessions.snapshot(terminalId).end === 7)
  assert.deepEqual((await callback(connection, sessionId, "terminal/output", { terminalId })).result, { output: "x", truncated: true })
  for (const method of ["terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release"]) {
    assert.equal((await callback(connection, sessionId, method, { terminalId, sessionId: "other-session" })).error?.code, -32602)
    assert.equal((await callback(connection, sessionId, method, { terminalId: "other-terminal" })).error?.code, -32602)
  }
  let finished = false
  const waiting = callback(connection, sessionId, "terminal/wait_for_exit", { terminalId }).then(result => { finished = true; return result })
  f.commands[0]!.emit({ kind: "exit", exitCode: 7 })
  await until(() => f.sessions.snapshot(terminalId).summary.status === "exited")
  await delay(10)
  assert.equal(finished, false)
  f.commands[0]!.emit(null)
  assert.deepEqual((await waiting).result, { exitCode: 7 })
  assert.deepEqual((await callback(connection, sessionId, "terminal/output", { terminalId })).result, { output: "x", truncated: true, exitStatus: { exitCode: 7 } })
  assert.deepEqual((await callback(connection, sessionId, "terminal/release", { terminalId })).result, {})
  assert.equal((await callback(connection, sessionId, "terminal/output", { terminalId })).error?.code, -32602)
  assert.equal(f.sessions.snapshot(terminalId).end, 7)
  const running = (await callback(connection, sessionId, "terminal/create", { command: "running-command", cwd: tmpdir() })).result as acp.CreateTerminalResponse
  assert.equal(f.configs[1]!.cwd, tmpdir())
  assert.deepEqual((await callback(connection, sessionId, "terminal/kill", running)).result, {})
  assert.equal(f.commands[1]!.closed, true)
  assert.deepEqual((await callback(connection, sessionId, "terminal/wait_for_exit", running)).result, { exitCode: 0 })
  assert.deepEqual((await callback(connection, sessionId, "terminal/output", running)).result, { output: "", truncated: false, exitStatus: { exitCode: 0 } })
  const released = (await callback(connection, sessionId, "terminal/create", { command: "release-running" })).result as acp.CreateTerminalResponse
  const releasedCommand = f.commands.at(-1)!
  assert.deepEqual((await callback(connection, sessionId, "terminal/release", released)).result, {})
  assert.equal(releasedCommand.closed, true)
  assert.equal((await callback(connection, sessionId, "terminal/output", released)).error?.code, -32602)
  assert.equal(f.sessions.snapshot(released.terminalId).summary.kind, "acp")
  const human = await f.sessions.dial({ mode: "create", terminalId: "human-shell", cols: 80, rows: 24, cwd: f.cwd })
  const humanCommand = f.commands.at(-1)!
  assert.equal((await callback(connection, sessionId, "terminal/kill", { terminalId: human.id })).error?.code, -32602)
  await callback(connection, sessionId, "terminal/create", { command: "close-running" })
  const ownedCommand = f.commands.at(-1)!
  await connection.close()
  assert.equal(ownedCommand.closed, true)
  assert.equal(humanCommand.closed, false)
})

test("ACP snapshots read complete history in chunks and trim only at UTF-8 boundaries", async context => {
  const f = await fixture(context)
  const terminals = f.helper()
  const { terminalId } = await terminals.create({ sessionId: "session", command: "test" })
  const bytes = Buffer.concat([Buffer.alloc(70_000, "a"), Buffer.from("中")])
  f.commands[0]!.emit({ kind: "data", data: bytes.subarray(0, bytes.length - 1) })
  await until(() => f.sessions.snapshot(terminalId).end === bytes.length - 1)
  assert.deepEqual(await terminals.output({ sessionId: "session", terminalId }), { output: "a".repeat(70_000), truncated: false })
  f.commands[0]!.emit({ kind: "data", data: bytes.subarray(bytes.length - 1) })
  await until(() => f.sessions.snapshot(terminalId).end === bytes.length)
  assert.equal((await terminals.output({ sessionId: "session", terminalId })).output, bytes.toString("utf8"))
  const empty = await terminals.create({ sessionId: "session", command: "test", outputByteLimit: 0 })
  f.commands[1]!.emit({ kind: "data", data: Buffer.from("hidden") })
  await until(() => f.sessions.snapshot(empty.terminalId).end > 0)
  assert.deepEqual(await terminals.output({ sessionId: "session", ...empty }), { output: "", truncated: true })
})

test("cancelling an ACP exit wait leaves its command running", async context => {
  const f = await fixture(context)
  const terminals = f.helper()
  const terminal = await terminals.create({ sessionId: "session", command: "test" })
  const controller = new AbortController()
  const waiting = terminals.waitForExit({ sessionId: "session", ...terminal }, controller.signal)
  controller.abort(new Error("wait cancelled"))
  await assert.rejects(waiting, /wait cancelled/u)
  assert.equal(f.commands[0]!.closed, false)
  assert.equal(f.sessions.snapshot(terminal.terminalId).summary.status, "running")
  await terminals.kill({ sessionId: "session", ...terminal })
  assert.deepEqual(await terminals.waitForExit({ sessionId: "session", ...terminal }), { exitCode: 0 })
})

test("ACP close waits for in-flight creates and stops them while preserving transcripts", async context => {
  let launch!: () => void
  const f = await fixture(context, new Promise<void>(resolve => { launch = resolve }))
  const terminals = f.helper()
  const creating = terminals.create({ sessionId: "session", command: "test" })
  await until(() => f.configs.length === 1)
  const expected = { code: -32602, data: { details: "ACP terminals are closed" } }
  const rejected = assert.rejects(creating, expected)
  let closed = false
  const closing = terminals.close().then(() => { closed = true })
  try {
    await assert.rejects(terminals.create({ sessionId: "session", command: "late" }), expected)
    assert.equal(closed, false)
  } finally { launch() }
  await Promise.all([rejected, closing])
  assert.equal(f.commands[0]!.closed, true)
  assert.equal(f.sessions.list().length, 1)
  assert.notEqual(f.sessions.list()[0]!.status, "running")
})

test("failed ACP session setup stops commands from early callbacks", { timeout: 15_000 }, async context => {
  for (const mode of ["opening-failure", "opening-mismatch"]) await context.test(mode, async nested => {
    const f = await fixture(nested)
    const connection = await f.connect(true, mode)
    await assert.rejects(connection.newSession({ cwd: f.cwd, mcpServers: [] }))
    assert.equal(f.commands[0]!.closed, true)
    assert.notEqual(f.sessions.list()[0]!.status, "running")
    assert.equal(f.sessions.list()[0]!.kind, "acp")
  })
})
