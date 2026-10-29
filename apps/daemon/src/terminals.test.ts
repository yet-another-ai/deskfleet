import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import type { NativeTerminal, TerminalConfig } from "@deskfleet/native"
import { TerminalChannel } from "./terminal-channel.ts"
import { TERMINAL_CHUNK_BYTES, TERMINAL_OUTPUT_WINDOW_BYTES, type TerminalMessage } from "./terminal-protocol.ts"
import { TerminalSessions } from "./terminals.ts"

type NativeEvent = Awaited<ReturnType<NativeTerminal["nextEvent"]>>

class FakeTerminal {
  readonly writes: Buffer[] = []
  readonly sizes: Array<[number, number]> = []
  readonly events: NativeEvent[] = []
  waiting: ((event: NativeEvent) => void) | undefined
  writeWait: Promise<void> | undefined
  closed = false

  emit(event: NativeEvent): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve(event)
    } else this.events.push(event)
  }

  async nextEvent(): Promise<NativeEvent> {
    if (this.events.length) return this.events.shift()!
    return new Promise(resolve => { this.waiting = resolve })
  }

  async write(data: Buffer): Promise<void> { this.writes.push(data); await this.writeWait }
  async resize(cols: number, rows: number): Promise<void> { this.sizes.push([cols, rows]) }
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
    await delay(5)
  }
}

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "df-terminal-channel-"))
  const spawned: FakeTerminal[] = []
  const configs: TerminalConfig[] = []
  const sessions = new TerminalSessions({ directory, factory: async config => {
    configs.push(config)
    const terminal = new FakeTerminal()
    spawned.push(terminal)
    return terminal as NativeTerminal
  } })
  await sessions.init()
  const channels: TerminalChannel[] = []
  context.after(async () => {
    for (const channel of channels) channel.close()
    try { await sessions.close() }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const client = () => {
    const dialed = new Set<string>()
    const messages: TerminalMessage[] = []
    const errors: unknown[] = []
    const channel = new TerminalChannel(sessions, async text => { messages.push(JSON.parse(text) as TerminalMessage) }, error => errors.push(error), id => dialed.has(id))
    channels.push(channel)
    let id = 0
    const request = async (method: string, params: unknown = {}) => {
      const requestId = ++id
      await channel.receive(Buffer.from(JSON.stringify({ id: requestId, method, params })), true)
      const response = messages.findLast(message => "id" in message && message.id === requestId)
      assert.ok(response && "id" in response)
      if (response.error) throw new Error(response.error)
      return response.result
    }
    const ack = (sessionId: string, offset: number) => channel.receive(Buffer.from(JSON.stringify({ ack: { sessionId, offset } })), true)
    return { channel, dialed, messages, errors, request, ack }
  }
  const dial = () => sessions.dial({ mode: "create", terminalId: randomUUID(), cols: 80, rows: 24 })
  return { sessions, spawned, configs, client, dial, directory }
}

function output(messages: TerminalMessage[]) {
  return messages.flatMap(message => "event" in message && message.event.kind === "output" ? [message.event] : [])
}

test("setup commands keep exact launch arguments outside their machine-terminal history", async context => {
  const f = await fixture(context)
  const options = {
    terminalId: randomUUID(), title: "Codex login", command: "/tools/codex with spaces",
    args: ["login", "literal $(command)"], env: { CODEX_HOME: "/private/settings", API_KEY: "secret", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    cwd: homedir(), cols: 80, rows: 24,
  }
  const terminal = await f.sessions.run(options)
  assert.equal(terminal.title, "Codex login")
  assert.equal(terminal.worktreeId, undefined)
  assert.deepEqual(f.configs, [{
    cwd: options.cwd, cols: 80, rows: 24, command: options.command, args: options.args, env: options.env,
  }])
  assert.equal(JSON.stringify(f.sessions.snapshot(terminal.id)).includes("secret"), false)
  assert.deepEqual(await f.sessions.dial({ mode: "resume", terminalId: terminal.id }), terminal)
  assert.equal(f.spawned.length, 1)
  const native = f.spawned[0]!
  const bytes = Buffer.from("Visit the authorization URL\r\n")
  native.emit({ kind: "data", data: bytes })
  native.emit({ kind: "exit", exitCode: 0 })
  native.emit(null)
  await until(() => f.sessions.snapshot(terminal.id).summary.status === "exited")
  assert.deepEqual(await f.sessions.read(terminal.id, 0, bytes.length), bytes)
  assert.equal(f.sessions.snapshot(terminal.id).summary.exitCode, 0)
  assert.equal((await readFile(join(f.directory, terminal.id, "session.json"), "utf8")).includes("secret"), false)
})

test("public terminal dial cannot select the internal setup command fields", async context => {
  const f = await fixture(context)
  const params = {
    mode: "create" as const, terminalId: randomUUID(), cols: 80, rows: 24,
    command: "/tools/not-a-shell", args: ["login"], env: { API_KEY: "not-an-override" }, title: "Not a shell", kind: "acp" as const,
  }
  const terminal = await f.sessions.dial(params)
  const { env, ...config } = f.configs[0]!
  assert.deepEqual(config, { cwd: homedir(), cols: 80, rows: 24 })
  assert.equal(env?.TERM_PROGRAM, "deskfleet")
  assert.equal(env?.API_KEY, undefined)
  assert.ok(env?.PATH?.startsWith(join(f.directory, ".shell-bin")))
  assert.notEqual(terminal.title, params.title)
  assert.equal(terminal.kind, undefined)
})

test("concurrent first dials share helper initialization and spawn one terminal", async context => {
  const f = await fixture(context)
  const params = { mode: "create" as const, terminalId: randomUUID(), cols: 80, rows: 24 }
  const terminals = await Promise.all([f.sessions.dial(params), f.sessions.dial(params), f.sessions.dial(params)])
  assert.equal(f.spawned.length, 1)
  assert.deepEqual(terminals[1], terminals[0])
  assert.deepEqual(terminals[2], terminals[0])
  assert.equal(f.configs[0]?.env?.TERM_PROGRAM, "deskfleet")
  const launcher = join(f.directory, ".shell-bin", process.platform === "win32" ? "icat.cmd" : "icat")
  if (process.platform === "win32") {
    assert.ok(Object.values(f.configs[0]!.env!).includes("--deskfleet-icat"))
    assert.match(await readFile(launcher, "utf8"), /DESKFLEET_ICAT_ARG_0/u)
  } else assert.match(await readFile(launcher, "utf8"), /--deskfleet-icat/u)
})

test("ACP terminals allow concurrent viewers but reject every human control path", async context => {
  const f = await fixture(context)
  const terminal = await f.sessions.run({
    terminalId: randomUUID(), title: "Agent tests", command: "test-runner", cols: 80, rows: 24,
    worktreeId: "40", kind: "acp",
  })
  const first = f.client()
  const second = f.client()
  for (const viewer of [first, second]) {
    viewer.dialed.add(terminal.id)
    assert.equal((await viewer.request("attach", { sessionId: terminal.id }) as { kind: string }).kind, "acp")
    await assert.rejects(viewer.request("input", { sessionId: terminal.id, data: Buffer.from("\x03").toString("base64") }), /read-only/u)
    await assert.rejects(viewer.request("resize", { sessionId: terminal.id, cols: 100, rows: 40 }), /read-only/u)
  }
  await assert.rejects(f.sessions.input(terminal.id, Buffer.from("paste\r")), /read-only/u)
  await assert.rejects(f.sessions.hangup(terminal.id), /read-only/u)
  const bytes = Buffer.from("\x1b[32mAgent output 你好\x1b[0m\r\n")
  f.spawned[0]!.emit({ kind: "data", data: bytes })
  assert.deepEqual(await receiveAll(first, terminal.id, bytes.length), bytes)
  assert.deepEqual(await receiveAll(second, terminal.id, bytes.length), bytes)
  first.channel.close()
  second.channel.close()
  assert.equal(f.spawned[0]!.closed, false)
  assert.deepEqual(f.spawned[0]!.writes, [])
  assert.deepEqual(f.spawned[0]!.sizes, [])
  await f.sessions.stop(terminal.id)
  await f.sessions.waitForExit(terminal.id)
  assert.equal(f.spawned[0]!.closed, true)
  assert.equal(f.sessions.snapshot(terminal.id).summary.status, "exited")
  assert.deepEqual(await f.sessions.read(terminal.id, 0, bytes.length), bytes)
  await f.sessions.close()
  const restored = new TerminalSessions({ directory: f.directory, factory: async () => { throw new Error("Replay must not spawn") } })
  context.after(() => restored.close())
  await restored.init()
  assert.equal(restored.snapshot(terminal.id).summary.kind, "acp")
  assert.equal(restored.snapshot(terminal.id).summary.worktreeId, "40")
  await assert.rejects(restored.hangup(terminal.id), /read-only/u)
  await restored.hangupOwned("40")
  assert.equal(restored.list().length, 0)
})

test("waitForExit includes final output after an exit notification", async context => {
  const f = await fixture(context)
  const terminal = await f.dial()
  let completed = false
  const waiting = f.sessions.waitForExit(terminal.id).then(() => { completed = true })
  f.spawned[0]!.emit({ kind: "exit", exitCode: 7 })
  await until(() => f.sessions.snapshot(terminal.id).summary.status === "exited")
  assert.equal(completed, false)
  const bytes = Buffer.from("final buffered bytes\r\n")
  f.spawned[0]!.emit({ kind: "data", data: bytes })
  f.spawned[0]!.emit(null)
  await waiting
  assert.equal(completed, true)
  assert.deepEqual(await f.sessions.read(terminal.id, 0, bytes.length), bytes)
})

test("archiving stops only owned PTYs and retains their final output and identity across restart", async context => {
  const f = await fixture(context)
  const owned = await f.sessions.dial({ mode: "create", terminalId: randomUUID(), cols: 80, rows: 24, worktreeId: "30" })
  const unrelated = await f.dial()
  assert.equal(owned.cwd, unrelated.cwd)
  const events: string[] = []
  f.sessions.onChange(event => events.push(event.kind))
  const bytes = Buffer.from("retained before archive\r\n")
  const tail = Buffer.from("final output while closing\r\n")
  const native = f.spawned[0]!
  native.emit({ kind: "data", data: bytes })
  const close = native.close.bind(native)
  native.close = async () => { if (!native.closed) native.emit({ kind: "data", data: tail }); await close() }
  await f.sessions.stopOwned("30")
  assert.equal(native.closed, true)
  assert.equal(f.spawned[1]!.closed, false)
  assert.equal(f.sessions.list().length, 2)
  assert.equal(f.sessions.snapshot(owned.id).summary.status, "interrupted")
  assert.deepEqual(await f.sessions.read(owned.id, 0, bytes.length + tail.length), Buffer.concat([bytes, tail]))
  assert.equal(events.includes("terminalHungup"), false)
  await assert.rejects(f.sessions.input(owned.id, Buffer.from("ignored")), /not running/u)
  await f.sessions.dial({ mode: "resume", terminalId: owned.id })
  assert.equal(f.spawned.length, 2)
  await f.sessions.stopOwned("30")
  await f.sessions.close()
  const restored = new TerminalSessions({ directory: f.directory, factory: async () => { throw new Error("Reading must not spawn a PTY") } })
  context.after(() => restored.close())
  await restored.init()
  assert.equal(restored.snapshot(owned.id).summary.worktreeId, "30")
  assert.deepEqual(await restored.read(owned.id, 0, bytes.length + tail.length), Buffer.concat([bytes, tail]))
})

test("a failed archive terminal stop retains the record and can be retried", async context => {
  const f = await fixture(context)
  const owned = await f.sessions.dial({ mode: "create", terminalId: randomUUID(), cols: 80, rows: 24, worktreeId: "31" })
  const native = f.spawned[0]!
  const close = native.close.bind(native)
  let failures = 1
  native.close = async () => { if (failures-- > 0) throw new Error("Temporary close failure"); await close() }
  await assert.rejects(f.sessions.stopOwned("31"), /Could not stop/u)
  assert.equal(native.closed, false)
  assert.equal(f.sessions.list().length, 1)
  await f.sessions.stopOwned("31")
  assert.equal(native.closed, true)
  assert.equal(f.sessions.snapshot(owned.id).summary.status, "interrupted")
})

test("archive waits for a Session terminal being created before stopping it", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-terminal-archive-"))
  const native = new FakeTerminal()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let creating = false
  const sessions = new TerminalSessions({ directory, factory: async () => {
    creating = true
    await barrier
    return native as NativeTerminal
  } })
  context.after(async () => { release(); await sessions.close(); await rm(directory, { recursive: true, force: true }) })
  const dial = sessions.dial({ mode: "create", terminalId: randomUUID(), cols: 80, rows: 24, worktreeId: "32" })
  await until(() => creating)
  let completed = false
  const stop = sessions.stopOwned("32").then(() => { completed = true })
  assert.equal(completed, false)
  release()
  const terminal = await dial
  await stop
  assert.equal(native.closed, true)
  assert.equal(sessions.snapshot(terminal.id).summary.status, "interrupted")
})

async function receiveAll(client: ReturnType<Awaited<ReturnType<typeof fixture>>["client"]>, sessionId: string, end: number): Promise<Buffer> {
  let index = 0
  const chunks: Buffer[] = []
  while (chunks.reduce((size, chunk) => size + chunk.length, 0) < end) {
    await until(() => output(client.messages).length > index)
    const event = output(client.messages)[index++]!
    chunks.push(Buffer.from(event.data, "base64"))
    await client.ack(sessionId, event.offset)
  }
  return Buffer.concat(chunks)
}

test("terminal input, resize and full replay remain byte exact across client detach and reattach", async context => {
  const f = await fixture(context)
  const terminal = await f.dial()
  const { env: _env, ...config } = f.configs[0]!
  assert.deepEqual(config, { cwd: homedir(), cols: 80, rows: 24 })
  const first = f.client()
  first.dialed.add(terminal.id)
  await first.request("attach", { sessionId: terminal.id })
  const bytes = Buffer.from("你好\r\n")
  f.spawned[0]!.emit({ kind: "data", data: bytes.subarray(0, 2) })
  f.spawned[0]!.emit({ kind: "data", data: bytes.subarray(2) })
  await until(() => f.sessions.snapshot(terminal.id).end === bytes.length)
  assert.deepEqual(await receiveAll(first, terminal.id, bytes.length), bytes)
  await first.request("input", { sessionId: terminal.id, data: Buffer.from("pwd\r").toString("base64") })
  await first.request("resize", { sessionId: terminal.id, cols: 100, rows: 40 })
  assert.deepEqual(f.spawned[0]!.writes, [Buffer.from("pwd\r")])
  assert.deepEqual(f.spawned[0]!.sizes, [[100, 40]])
  first.channel.close()
  assert.equal(f.spawned[0]!.closed, false)

  const detached = Buffer.from("detached\r\n")
  f.spawned[0]!.emit({ kind: "data", data: detached })
  await until(() => f.sessions.snapshot(terminal.id).end === bytes.length + detached.length)
  const second = f.client()
  await f.sessions.dial({ mode: "resume", terminalId: terminal.id })
  second.dialed.add(terminal.id)
  await second.request("attach", { sessionId: terminal.id })
  assert.equal(f.spawned.length, 1)
  assert.deepEqual(await receiveAll(second, terminal.id, bytes.length + detached.length), Buffer.concat([bytes, detached]))
  await until(() => second.messages.some(message => "event" in message && message.event.kind === "ready"))
  await f.sessions.hangup(terminal.id)
  assert.equal(f.spawned[0]!.closed, true)
  assert.deepEqual(f.sessions.list(), [])
  assert.ok(second.messages.some(message => "event" in message && message.event.kind === "hungup"))
  assert.deepEqual(first.errors, [])
  assert.deepEqual(second.errors, [])
})

test("slow clients replay history larger than the former tail without loss and only become ready after acknowledgements", async context => {
  const f = await fixture(context)
  const terminal = await f.dial()
  const bytes = Buffer.concat([Buffer.from("retained beginning\r\n"), Buffer.alloc(TERMINAL_OUTPUT_WINDOW_BYTES + TERMINAL_CHUNK_BYTES, 65)])
  f.spawned[0]!.emit({ kind: "data", data: bytes })
  await until(() => f.sessions.snapshot(terminal.id).end === bytes.length)
  const client = f.client()
  client.dialed.add(terminal.id)
  await client.request("attach", { sessionId: terminal.id })
  const windowChunks = TERMINAL_OUTPUT_WINDOW_BYTES / TERMINAL_CHUNK_BYTES
  await until(() => output(client.messages).length === windowChunks)
  assert.equal(Buffer.from(output(client.messages)[0]!.data, "base64").length, TERMINAL_CHUNK_BYTES)
  assert.equal(client.messages.some(message => "event" in message && message.event.kind === "ready"), false)
  const more = Buffer.from("live after attach\r\n")
  f.spawned[0]!.emit({ kind: "data", data: more })
  await until(() => f.sessions.snapshot(terminal.id).end === bytes.length + more.length)
  assert.equal(output(client.messages).length, windowChunks)
  assert.deepEqual(await receiveAll(client, terminal.id, bytes.length + more.length), Buffer.concat([bytes, more]))
  await until(() => client.messages.some(message => "event" in message && message.event.kind === "ready"))
  assert.equal(client.messages.filter(message => "event" in message && message.event.kind === "reset").length, 1)
  assert.equal(client.messages.filter(message => "event" in message && message.event.kind === "ready").length, 1)
})

test("data channels require a signaled dial, reject lifecycle operations and admit one controller", async context => {
  const f = await fixture(context)
  const first = f.client()
  const second = f.client()
  const terminal = await f.dial()
  await assert.rejects(first.request("attach", { sessionId: terminal.id }), /Dial the terminal/)
  await assert.rejects(first.request("input", { sessionId: terminal.id, data: "YQ==" }), /Attach to the terminal/)
  for (const method of ["create", "list", "terminate"]) {
    await assert.rejects(first.request(method, { sessionId: terminal.id, cols: 80, rows: 24 }), /Unknown terminal operation/)
  }
  first.dialed.add(terminal.id)
  second.dialed.add(terminal.id)
  await first.request("attach", { sessionId: terminal.id })
  await first.request("attach", { sessionId: terminal.id })
  await assert.rejects(second.request("attach", { sessionId: terminal.id }), /another client/)
  await assert.rejects(first.request("input", { sessionId: terminal.id, data: "not base64!" }), /Invalid terminal input/)
  await assert.rejects(first.channel.receive(Buffer.from("{}"), false), /Invalid terminal message/)
  assert.equal(f.spawned[0]!.writes.length, 0)
  await first.request("detach", { sessionId: terminal.id })
  await second.request("attach", { sessionId: terminal.id })
  assert.equal(f.spawned.length, 1)
})

test("output acknowledgements proceed while a PTY write waits, without reordering commands", async context => {
  const f = await fixture(context)
  const client = f.client()
  const terminal = await f.dial()
  client.dialed.add(terminal.id)
  await client.request("attach", { sessionId: terminal.id })
  let written!: () => void
  f.spawned[0]!.writeWait = new Promise(resolve => { written = resolve })
  const writing = client.request("input", { sessionId: terminal.id, data: "YQ==" })
  const resizing = client.request("resize", { sessionId: terminal.id, cols: 100, rows: 40 })
  const windowChunks = TERMINAL_OUTPUT_WINDOW_BYTES / TERMINAL_CHUNK_BYTES
  f.spawned[0]!.emit({ kind: "data", data: Buffer.alloc(TERMINAL_OUTPUT_WINDOW_BYTES + TERMINAL_CHUNK_BYTES, 65) })
  await until(() => output(client.messages).length === windowChunks)
  assert.equal(f.spawned[0]!.writes.length, 1)
  assert.equal(f.spawned[0]!.sizes.length, 0)
  await client.ack(terminal.id, output(client.messages)[0]!.offset)
  await until(() => output(client.messages).length === windowChunks + 1)
  written()
  await Promise.all([writing, resizing])
  assert.deepEqual(f.spawned[0]!.sizes, [[100, 40]])
})

test("signaled hangup completes while a data-channel PTY write is blocked", async context => {
  const f = await fixture(context)
  const client = f.client()
  const terminal = await f.dial()
  client.dialed.add(terminal.id)
  await client.request("attach", { sessionId: terminal.id })
  let written!: () => void
  f.spawned[0]!.writeWait = new Promise(resolve => { written = resolve })
  const writing = client.request("input", { sessionId: terminal.id, data: "YQ==" })
  await until(() => f.spawned[0]!.writes.length === 1)
  await f.sessions.hangup(terminal.id)
  assert.equal(f.spawned[0]!.closed, true)
  assert.deepEqual(f.sessions.list(), [])
  assert.ok(client.messages.some(message => "event" in message && message.event.kind === "hungup"))
  written()
  await writing
})

test("a Worktree terminal keeps its owner across restart and ends with that Worktree only", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-terminal-owner-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const factory = async () => new FakeTerminal() as unknown as NativeTerminal
  const first = new TerminalSessions({ directory, factory })
  const owned = await first.dial({ mode: "create", terminalId: randomUUID(), cols: 80, rows: 24, cwd: homedir(), worktreeId: "7" })
  const other = await first.dial({ mode: "create", terminalId: randomUUID(), cols: 80, rows: 24, cwd: homedir(), worktreeId: "8" })
  const machine = await first.dial({ mode: "create", terminalId: randomUUID(), cols: 80, rows: 24 })
  assert.equal(owned.worktreeId, "7")
  assert.equal(machine.worktreeId, undefined)
  await first.close()
  const restarted = new TerminalSessions({ directory, factory })
  context.after(() => restarted.close())
  await restarted.init()
  assert.equal(restarted.list().find(value => value.id === owned.id)?.worktreeId, "7", "ownership must survive restart")
  await restarted.hangupOwned("7")
  assert.deepEqual(restarted.list().map(value => value.id).sort(), [other.id, machine.id].sort())
})
