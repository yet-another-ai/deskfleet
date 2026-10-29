import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import type { NativeTerminal } from "@deskfleet/native"
import { TerminalSessions } from "./terminals.ts"
import { MAX_TERMINAL_HISTORY_READ_BYTES, TerminalHistory } from "./terminal-history.ts"
import type { TerminalSessionEvent } from "./terminal-protocol.ts"

type NativeEvent = Awaited<ReturnType<NativeTerminal["nextEvent"]>>

class FakeTerminal {
  readonly events: NativeEvent[] = []
  waiting: ((event: NativeEvent) => void) | undefined
  closed = false
  readonly writes: Buffer[] = []

  emit(event: NativeEvent): void {
    if (this.waiting) {
      const waiting = this.waiting
      this.waiting = undefined
      waiting(event)
    } else this.events.push(event)
  }

  async nextEvent(): Promise<NativeEvent> {
    if (this.events.length) return this.events.shift()!
    return new Promise(resolve => { this.waiting = resolve })
  }

  async write(data: Buffer): Promise<void> { this.writes.push(data) }
  async resize(): Promise<void> {}
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit(null)
  }
}

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "df-terminal-history-"))
  const spawned: FakeTerminal[] = []
  const sessions = new TerminalSessions({
    directory,
    factory: async () => {
      const terminal = new FakeTerminal()
      spawned.push(terminal)
      return terminal as NativeTerminal
    },
  })
  const registries = [sessions]
  const track = (registry: TerminalSessions) => { registries.push(registry) }
  context.after(async () => {
    await Promise.all(registries.map(registry => registry.close()))
    await rm(directory, { recursive: true, force: true })
  })
  await sessions.init()
  return { directory, sessions, spawned, track }
}

function waitFor(sessions: TerminalSessions, id: string, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const stop = sessions.subscribe(id, () => {
      if (predicate()) { stop(); resolve() }
      else if (sessions.snapshot(id).error) { stop(); reject(new Error(sessions.snapshot(id).error)) }
    })
  })
}

async function readAll(sessions: TerminalSessions, id: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  const end = sessions.snapshot(id).end
  for (let offset = 0; offset < end;) {
    const data = await sessions.read(id, offset, MAX_TERMINAL_HISTORY_READ_BYTES)
    assert.ok(data.length > 0)
    chunks.push(data)
    offset += data.length
  }
  return Buffer.concat(chunks)
}

// Windows CI datasyncs each 16 KiB append under parallel suite load; 10s is sometimes tight.
test("full output survives detached clients and daemon restart until explicit hangup", { timeout: process.platform === "win32" ? 30_000 : 10_000 }, async context => {
  const f = await fixture(context)
  const terminal = await f.sessions.dial({ mode: "create", terminalId: "long-session", cols: 80, rows: 24 })
  const pieces = Array.from({ length: 40 }, (_, index) => Buffer.alloc(16 * 1024, index))
  const content = Buffer.concat(pieces)
  const persisted = waitFor(f.sessions, terminal.id, () => f.sessions.snapshot(terminal.id).end === content.length)
  for (const piece of pieces) f.spawned[0]!.emit({ kind: "data", data: piece })
  await persisted
  assert.ok(content.length > 256 * 1024)
  assert.deepEqual(await readAll(f.sessions, terminal.id), content)
  assert.deepEqual(await readFile(join(f.directory, terminal.id, "output.bin")), content)
  if (process.platform !== "win32") {
    assert.equal((await stat(join(f.directory, terminal.id))).mode & 0o777, 0o700)
    assert.equal((await stat(join(f.directory, terminal.id, "output.bin"))).mode & 0o777, 0o600)
    assert.equal((await stat(join(f.directory, terminal.id, "session.json"))).mode & 0o777, 0o600)
  }
  await f.sessions.resize(terminal.id, 110, 35)
  await f.sessions.close()
  assert.equal(f.spawned[0]!.closed, true)

  const recovered = new TerminalSessions({ directory: f.directory, factory: async () => { throw new Error("Must not spawn on resume") } })
  f.track(recovered)
  await recovered.init()
  assert.deepEqual(await recovered.dial({ mode: "resume", terminalId: terminal.id }), {
    ...terminal, cols: 110, rows: 35, status: "interrupted",
  })
  assert.deepEqual(await readAll(recovered, terminal.id), content)
  await assert.rejects(recovered.input(terminal.id, Buffer.from("pwd\r")), /not running/)
  await recovered.hangup(terminal.id)
  assert.deepEqual(recovered.list(), [])
  assert.deepEqual(await readdir(f.directory), [".shell-bin"])
  await recovered.hangup(terminal.id)
})

test("dial retries are idempotent and hanging up one shell preserves the others and their history", { timeout: 10_000 }, async context => {
  const f = await fixture(context)
  const changed: TerminalSessionEvent[] = []
  f.sessions.onChange(event => changed.push(event))
  const options = { mode: "create" as const, terminalId: "first", cols: 80, rows: 24 }
  const [first, duplicate] = await Promise.all([f.sessions.dial(options), f.sessions.dial(options)])
  assert.deepEqual(first, duplicate)
  assert.equal(f.spawned.length, 1)
  const second = await f.sessions.dial({ ...options, terminalId: "second" })
  const firstWritten = waitFor(f.sessions, first.id, () => f.sessions.snapshot(first.id).end === 5)
  const secondWritten = waitFor(f.sessions, second.id, () => f.sessions.snapshot(second.id).end === 6)
  f.spawned[0]!.emit({ kind: "data", data: Buffer.from("first") })
  f.spawned[1]!.emit({ kind: "data", data: Buffer.from("second") })
  await Promise.all([firstWritten, secondWritten])
  let hungup = false
  f.sessions.subscribe(first.id, change => { if (change === "hangup") hungup = true })
  await f.sessions.hangup(first.id)
  assert.equal(hungup, true)
  assert.equal(f.spawned[0]!.closed, true)
  assert.equal(f.spawned[1]!.closed, false)
  assert.deepEqual((await readdir(f.directory)).sort(), [".shell-bin", second.id])
  assert.deepEqual(await readAll(f.sessions, second.id), Buffer.from("second"))
  assert.deepEqual(changed.at(-1), { kind: "terminalHungup", terminalId: first.id })
  await assert.rejects(f.sessions.dial({ mode: "resume", terminalId: first.id }), /Unknown terminal/)
})

test("natural shell exit keeps its transcript and status across a registry reload", { timeout: 10_000 }, async context => {
  const f = await fixture(context)
  const terminal = await f.sessions.dial({ mode: "create", terminalId: "finished", cols: 80, rows: 24 })
  const exited = waitFor(f.sessions, terminal.id, () => f.sessions.snapshot(terminal.id).summary.status === "exited")
  f.spawned[0]!.emit({ kind: "data", data: Buffer.from("last output\r\n") })
  f.spawned[0]!.emit({ kind: "exit", exitCode: 7 })
  f.spawned[0]!.emit(null)
  await exited
  await f.sessions.close()
  const recovered = new TerminalSessions({ directory: f.directory })
  f.track(recovered)
  await recovered.init()
  assert.equal(recovered.list()[0]!.status, "exited")
  assert.equal(recovered.list()[0]!.exitCode, 7)
  assert.equal((await readAll(recovered, terminal.id)).toString(), "last output\r\n")
})

test("shutdown while dialing closes the late shell and preserves its interrupted history", { timeout: 10_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-terminal-race-"))
  let recovered: TerminalSessions | undefined
  context.after(async () => {
    await recovered?.close()
    await rm(directory, { recursive: true, force: true })
  })
  let spawned!: () => void
  const spawning = new Promise<void>(resolve => { spawned = resolve })
  let created!: (terminal: NativeTerminal) => void
  const sessions = new TerminalSessions({ directory, factory: () => {
    spawned()
    return new Promise(resolve => { created = resolve })
  } })
  const dialing = sessions.dial({ mode: "create", terminalId: "racing", cols: 80, rows: 24 })
  const rejected = assert.rejects(dialing, /sessions are closed/)
  await spawning
  const closing = sessions.close()
  const native = new FakeTerminal()
  native.emit({ kind: "data", data: Buffer.from("before shutdown") })
  created(native as NativeTerminal)
  await Promise.all([closing, rejected])
  assert.equal(native.closed, true)
  recovered = new TerminalSessions({ directory })
  await recovered.init()
  assert.equal(recovered.list()[0]!.status, "interrupted")
  assert.equal((await readAll(recovered, "racing")).toString(), "before shutdown")
})

test("closing an uninitialized registry does not touch another daemon's history", async context => {
  const f = await fixture(context)
  await f.sessions.dial({ mode: "create", terminalId: "running", cols: 80, rows: 24 })
  const path = join(f.directory, "running", "session.json")
  const before = await readFile(path, "utf8")
  const unowned = new TerminalSessions({ directory: f.directory })
  await unowned.close()
  await assert.rejects(unowned.dial({ mode: "resume", terminalId: "running" }), /sessions are closed/)
  assert.equal(await readFile(path, "utf8"), before)
  assert.equal(f.spawned[0]!.closed, false)
})

test("recovery keeps committed history while cleaning interrupted create and hangup artifacts", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-terminal-recover-"))
  const sessions = new TerminalSessions({ directory })
  context.after(async () => { await sessions.close(); await rm(directory, { recursive: true, force: true }) })
  const history = await TerminalHistory.create(directory, {
    id: "survivor", title: "shell", cwd: tmpdir(), cols: 80, rows: 24, status: "running",
  })
  await history.append(Buffer.from("before interruption"))
  await history.close()
  const creating = join(directory, ".creating-00000000-0000-4000-8000-000000000001")
  const hungup = join(directory, ".hungup-00000000-0000-4000-8000-000000000002")
  await mkdir(creating)
  await mkdir(hungup)
  await writeFile(join(creating, "output.bin"), "incomplete")
  await writeFile(join(hungup, "session.json"), "cleanup interrupted")
  await sessions.init()
  assert.deepEqual(await readdir(directory), ["survivor"])
  assert.equal(sessions.list()[0]!.status, "interrupted")
  assert.equal((await readAll(sessions, "survivor")).toString(), "before interruption")
  const saved = JSON.parse(await readFile(join(directory, "survivor", "session.json"), "utf8")) as { terminal: { status: string } }
  assert.equal(saved.terminal.status, "interrupted")
})

test("history write failure interrupts the PTY and reports the failure without advertising unpersisted bytes", async context => {
  const f = await fixture(context)
  const terminal = await f.sessions.dial({ mode: "create", terminalId: "disk-failure", cols: 80, rows: 24 })
  context.mock.method(TerminalHistory.prototype, "append", async () => { throw new Error("ENOSPC: disk full") })
  const interrupted = waitFor(f.sessions, terminal.id, () => f.sessions.snapshot(terminal.id).summary.status === "interrupted")
  f.spawned[0]!.emit({ kind: "data", data: Buffer.from("unpersisted") })
  await interrupted
  assert.equal(f.spawned[0]!.closed, true)
  assert.equal(f.sessions.snapshot(terminal.id).end, 0)
  assert.match(f.sessions.snapshot(terminal.id).error!, /ENOSPC/)
  const saved = JSON.parse(await readFile(join(f.directory, terminal.id, "session.json"), "utf8")) as { error: string }
  assert.match(saved.error, /ENOSPC/)
})
