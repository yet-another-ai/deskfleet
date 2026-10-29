import assert from "node:assert/strict"
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import { TerminalChannel } from "./terminal-channel.ts"
import { TERMINAL_CHUNK_BYTES, TERMINAL_OUTPUT_WINDOW_BYTES, type TerminalEvent, type TerminalMessage } from "./terminal-protocol.ts"
import type { TerminalChange, TerminalSessions, TerminalSnapshot } from "./terminals.ts"

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(1)
  assert.equal(predicate(), true)
}

function fixture(context: TestContext, initial: Buffer, expectedErrors: unknown[] = []) {
  let bytes = initial
  let changed: ((change: TerminalChange) => void) | undefined
  let send: (message: TerminalMessage) => Promise<void> = async () => {}
  const state: TerminalSnapshot = {
    summary: { id: "terminal", title: "Shell", cwd: "/", cols: 80, rows: 24, status: "running" },
    end: bytes.length,
  }
  const sessions = {
    snapshot: () => ({ ...state, summary: { ...state.summary } }),
    read: async (_id: string, offset: number, length: number) => bytes.subarray(offset, offset + length),
    claim: () => {},
    release: () => {},
    subscribe: (_id: string, listener: (change: TerminalChange) => void) => {
      changed = listener
      return () => { changed = undefined }
    },
  }
  const messages: TerminalMessage[] = []
  const errors: unknown[] = []
  const channel = new TerminalChannel(sessions as unknown as TerminalSessions, async text => {
    const message = JSON.parse(text) as TerminalMessage
    await send(message)
    messages.push(message)
  }, error => errors.push(error), id => id === state.summary.id)
  context.after(() => {
    channel.close()
    assert.deepEqual(errors, expectedErrors)
  })
  const receive = (message: unknown) => channel.receive(Buffer.from(JSON.stringify(message)), true)
  let requestId = 0
  const events = () => messages.flatMap(message => "event" in message ? [message.event] : [])
  const output = () => events().filter((event): event is Extract<TerminalEvent, { kind: "output" }> => event.kind === "output")
  return {
    state,
    messages,
    errors,
    events,
    output,
    close: () => channel.close(),
    attach: () => receive({ id: ++requestId, method: "attach", params: { sessionId: state.summary.id } }),
    detach: () => receive({ id: ++requestId, method: "detach", params: { sessionId: state.summary.id } }),
    ack: (offset: number) => receive({ ack: { sessionId: state.summary.id, offset } }),
    onSend: (handler: typeof send) => { send = handler },
    append: (data: Buffer) => {
      bytes = Buffer.concat([bytes, data])
      state.end = bytes.length
      changed?.("output")
    },
    exit: (error?: string) => {
      state.summary.status = "exited"
      state.summary.exitCode = 7
      state.error = error
      changed?.("state")
    },
  }
}

test("output pipelines a bounded raw-byte window and cumulative consumption replenishes only its credit", async context => {
  const bytes = Buffer.alloc(TERMINAL_OUTPUT_WINDOW_BYTES * 3, 65)
  const f = fixture(context, bytes)
  await f.attach()
  await nextTurn()
  assert.equal(f.output().length, TERMINAL_OUTPUT_WINDOW_BYTES / TERMINAL_CHUNK_BYTES)
  assert.equal(f.output().at(-1)!.offset, TERMINAL_OUTPUT_WINDOW_BYTES)
  assert.ok(f.output().every(event => Buffer.from(event.data, "base64").length === TERMINAL_CHUNK_BYTES))
  await nextTurn()
  assert.equal(f.output().at(-1)!.offset, TERMINAL_OUTPUT_WINDOW_BYTES, "a stalled viewer must stop the pump")

  // One cumulative ACK can cover many chunks, including a partial last chunk.
  const consumed = TERMINAL_OUTPUT_WINDOW_BYTES / 2 + 3
  await f.ack(consumed)
  await nextTurn()
  const sent = f.output().at(-1)!.offset
  assert.equal(sent - consumed, TERMINAL_OUTPUT_WINDOW_BYTES)
  assert.equal(Buffer.from(f.output().at(-1)!.data, "base64").length, 3)
  assert.deepEqual(Buffer.concat(f.output().map(event => Buffer.from(event.data, "base64"))), bytes.subarray(0, sent))

  const count = f.output().length
  await f.ack(consumed)
  await f.ack(consumed - 1)
  await f.ack(sent + 1)
  await nextTurn()
  assert.equal(f.output().length, count, "duplicate, stale, and unsent ACKs must not grant credit")
  assert.equal(f.events().some(event => event.kind === "ready"), false)
})

test("an old ACK beyond a reattached viewer's sent range is ignored without granting credit", async context => {
  const f = fixture(context, Buffer.alloc(TERMINAL_OUTPUT_WINDOW_BYTES * 3, 65))
  await f.attach()
  await nextTurn()
  await f.ack(TERMINAL_CHUNK_BYTES)
  await nextTurn()
  const oldOffset = f.output().at(-1)!.offset
  assert.equal(oldOffset, TERMINAL_OUTPUT_WINDOW_BYTES + TERMINAL_CHUNK_BYTES)
  await f.detach()
  await f.attach()
  await nextTurn()
  const count = f.output().length
  assert.equal(f.output().at(-1)!.offset, TERMINAL_OUTPUT_WINDOW_BYTES)
  await f.ack(oldOffset)
  await nextTurn()
  assert.equal(f.output().length, count)
  await f.ack(TERMINAL_CHUNK_BYTES)
  await nextTurn()
  assert.equal(f.output().length, count + 1, "the new viewer can still acknowledge its own output")
})

test("ready waits for the replay tail and exit or error waits for all live output to be consumed", async context => {
  const history = Buffer.alloc(TERMINAL_CHUNK_BYTES * 2 + 17, 65)
  const live = Buffer.from("final live output\r\n")
  const f = fixture(context, history)
  await f.attach()
  await nextTurn()
  assert.equal(f.output().at(-1)!.offset, history.length)
  f.append(live)
  f.exit("terminal failed after output")
  await f.ack(history.length - 1)
  await nextTurn()
  assert.equal(f.output().at(-1)!.offset, history.length)
  assert.deepEqual(f.events().map(event => event.kind), ["reset", "output", "output", "output"])

  await f.ack(history.length)
  await nextTurn()
  assert.equal(f.output().at(-1)!.offset, history.length + live.length)
  assert.deepEqual(f.events().map(event => event.kind), ["reset", "output", "output", "output", "ready", "output"])
  await f.ack(history.length + live.length - 1)
  await nextTurn()
  assert.equal(f.events().some(event => event.kind === "exit" || event.kind === "error"), false)

  await f.ack(history.length + live.length)
  await nextTurn()
  assert.deepEqual(f.events().slice(-2), [
    { kind: "error", sessionId: "terminal", error: "terminal failed after output" },
    { kind: "exit", sessionId: "terminal", exitCode: 7 },
  ])
  await nextTurn()
  assert.equal(f.events().filter(event => event.kind === "ready").length, 1)
  assert.equal(f.events().filter(event => event.kind === "exit").length, 1)
})

test("ACKs arriving before send resolves keep the window advancing through the final replay event", async context => {
  const bytes = Buffer.alloc(TERMINAL_OUTPUT_WINDOW_BYTES * 2 + 19, 65)
  const f = fixture(context, bytes)
  f.exit()
  f.onSend(async message => {
    if ("event" in message && message.event.kind === "output") await f.ack(message.event.offset)
  })
  await f.attach()
  await nextTurn()
  assert.equal(f.output().at(-1)!.offset, bytes.length)
  assert.deepEqual(Buffer.concat(f.output().map(event => Buffer.from(event.data, "base64"))), bytes)
  assert.deepEqual(f.events().slice(-2), [
    { kind: "ready", sessionId: "terminal" },
    { kind: "exit", sessionId: "terminal", exitCode: 7 },
  ])
})

test("native backpressure retries the same output and preserves queued response and byte order", async context => {
  const bytes = Buffer.alloc(TERMINAL_CHUNK_BYTES * 3 + 19, 65)
  const f = fixture(context, bytes)
  const attempts: TerminalMessage[] = []
  f.onSend(async message => {
    if ("event" in message && message.event.kind === "output" && message.event.offset === TERMINAL_CHUNK_BYTES) {
      attempts.push(message)
      if (attempts.length === 1) throw new Error("native backpressure")
      if (attempts.length === 2) throw new Error("data channel send buffer is full")
    }
  })
  await f.attach()
  await until(() => attempts.length === 1)
  const response = f.attach()
  await response
  await until(() => f.output().at(-1)?.offset === bytes.length)
  assert.equal(attempts.length, 3)
  assert.deepEqual(attempts, [attempts[0], attempts[0], attempts[0]])
  assert.deepEqual(Buffer.concat(f.output().map(event => Buffer.from(event.data, "base64"))), bytes)
  const firstOutput = f.messages.findIndex(message => "event" in message && message.event.kind === "output")
  const queuedResponse = f.messages.findIndex(message => "id" in message && message.id === 2)
  assert.ok(queuedResponse > firstOutput, "a response must not overtake output waiting for native capacity")
})

test("closing a terminal channel cancels native backpressure retries", async context => {
  const f = fixture(context, Buffer.alloc(TERMINAL_CHUNK_BYTES * 2, 65))
  let attempts = 0
  f.onSend(async message => {
    if ("event" in message && message.event.kind === "output") {
      attempts++
      throw new Error("data channel send buffer is full")
    }
  })
  await f.attach()
  await until(() => attempts === 1)
  f.close()
  await delay(25)
  assert.equal(attempts, 1)
  assert.deepEqual(f.output(), [])
})

test("non-backpressure send failures close the viewer without retrying or skipping output", async context => {
  const failure = new Error("native transport failed")
  const f = fixture(context, Buffer.alloc(TERMINAL_CHUNK_BYTES * 2, 65), [failure])
  let attempts = 0
  f.onSend(async message => {
    if ("event" in message && message.event.kind === "output") {
      attempts++
      throw failure
    }
  })
  await f.attach()
  await until(() => f.errors.length === 1)
  f.append(Buffer.from("later output"))
  await nextTurn()
  assert.equal(attempts, 1)
  assert.deepEqual(f.output(), [])
})
