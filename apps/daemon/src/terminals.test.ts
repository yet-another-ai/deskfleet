import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import type { NativeTerminal } from "@deskfleet/native"
import { TerminalChannel } from "./terminal-channel.ts"
import { TERMINAL_CHUNK_BYTES, type TerminalMessage } from "./terminal-protocol.ts"
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
  const configs: Array<{ cwd: string; cols: number; rows: number }> = []
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
  return { sessions, spawned, configs, client, dial }
}

function output(messages: TerminalMessage[]) {
  return messages.flatMap(message => "event" in message && message.event.kind === "output" ? [message.event] : [])
}

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
  assert.deepEqual(f.configs, [{ cwd: homedir(), cols: 80, rows: 24 }])
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
  const bytes = Buffer.concat([Buffer.from("retained beginning\r\n"), Buffer.alloc(300 * 1024, 65)])
  f.spawned[0]!.emit({ kind: "data", data: bytes })
  await until(() => f.sessions.snapshot(terminal.id).end === bytes.length)
  const client = f.client()
  client.dialed.add(terminal.id)
  await client.request("attach", { sessionId: terminal.id })
  await until(() => output(client.messages).length === 1)
  assert.equal(Buffer.from(output(client.messages)[0]!.data, "base64").length, TERMINAL_CHUNK_BYTES)
  assert.equal(client.messages.some(message => "event" in message && message.event.kind === "ready"), false)
  const more = Buffer.from("live after attach\r\n")
  f.spawned[0]!.emit({ kind: "data", data: more })
  await until(() => f.sessions.snapshot(terminal.id).end === bytes.length + more.length)
  assert.equal(output(client.messages).length, 1)
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
  f.spawned[0]!.emit({ kind: "data", data: Buffer.alloc(TERMINAL_CHUNK_BYTES * 2, 65) })
  await until(() => output(client.messages).length === 1)
  assert.equal(f.spawned[0]!.writes.length, 1)
  assert.equal(f.spawned[0]!.sizes.length, 0)
  await client.ack(terminal.id, output(client.messages)[0]!.offset)
  await until(() => output(client.messages).length === 2)
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
