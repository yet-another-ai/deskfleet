import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { AgentChannel, type AgentChannelSessions } from "./agent-channel.ts"
import { AGENT_CHUNK_BYTES, AGENT_MESSAGE_BYTES, type AgentActor, type AgentElicitation, type AgentEvent, type AgentMethod, type AgentPermission, type AgentSnapshot } from "./agent-protocol.ts"

type Message = { id?: string | number | null; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
const actor: AgentActor = { kind: "local_token", sourceMachine: { originId: "origin", id: "machine" }, deviceId: "first" }
const now = "2026-10-23T00:00:00Z"
const snapshot: AgentSnapshot = {
  session: { id: "1", workspaceId: "2", title: "Test", provider: "codex", context: "worktree", lifecycle: "ready", lastEventSeq: "0", createdAt: now, updatedAt: now },
  runs: [], inputs: [], turns: [], permissions: [], elicitations: [],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function permission(id = "permission"): AgentPermission {
  return { id, sessionId: "1", runGeneration: 1, state: "pending", createdAt: now, request: {
    sessionId: "provider-session", toolCall: { toolCallId: "tool", title: "Read file" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
  } }
}
function event(seq: string, value: AgentPermission = permission()): AgentEvent {
  return { sessionId: "1", seq, kind: "permission", payload: value, createdAt: now }
}
function wire(message: Message & { jsonrpc?: string }): Buffer { return Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n") }

class Sessions implements AgentChannelSessions {
  readonly journal = { identity: { originId: "origin", machineId: "machine" } }
  readonly listeners = new Set<(event: AgentEvent) => void>()
  readonly calls: { method: AgentMethod; params: unknown; actor: AgentActor }[] = []
  handler: (method: AgentMethod, params: any, actor: AgentActor) => Promise<unknown> = async method => method === "_deskfleet/session/subscribe" ? snapshot : null
  async handle(method: AgentMethod, params: unknown, actor: AgentActor): Promise<unknown> {
    this.calls.push({ method, params, actor })
    return this.handler(method, params, actor)
  }
  onEvent(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  emit(value: AgentEvent): void { for (const listener of this.listeners) listener(value) }
}
function attach(sessions = new Sessions(), identity = actor, send?: (chunk: Uint8Array) => Promise<void>) {
  const messages: Message[] = []
  const chunks: Buffer[] = []
  const failures: unknown[] = []
  let buffer = Buffer.alloc(0)
  const channel = new AgentChannel(sessions, identity, async chunk => {
    if (send) await send(chunk)
    chunks.push(Buffer.from(chunk))
    buffer = Buffer.concat([buffer, chunk])
    let newline = buffer.indexOf(10)
    while (newline >= 0) {
      messages.push(JSON.parse(buffer.subarray(0, newline).toString("utf8")))
      buffer = buffer.subarray(newline + 1)
      newline = buffer.indexOf(10)
    }
  }, error => failures.push(error))
  async function waitFor(predicate: (message: Message) => boolean): Promise<Message> {
    const deadline = Date.now() + 2_000
    for (;;) {
      const message = messages.find(predicate)
      if (message) return message
      assert.ok(Date.now() < deadline, "Timed out waiting for channel message")
      await delay(1)
    }
  }
  return {
    channel, sessions, messages, chunks, failures, waitFor,
    request: (id: string | number | null, method: string, params: unknown = {}) => channel.receive(wire({ id, method, params })),
    async initialize() {
      channel.receive(wire({ id: "initialize", method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }))
      return waitFor(message => message.id === "initialize")
    },
    async subscribe(id = "subscribe") {
      channel.receive(wire({ id, method: "_deskfleet/session/subscribe", params: { sessionId: "1" } }))
      return waitFor(message => message.id === id)
    },
  }
}

test("AgentChannel reconstructs fragmented Unicode and sends ordered binary chunks", async t => {
  const h = attach()
  t.after(() => h.channel.close())
  const initialized = await h.initialize()
  assert.equal(initialized.result.protocolVersion, 1)
  assert.deepEqual(initialized.result._meta.deskfleet.identity, h.sessions.journal.identity)
  const text = "你好🌍".repeat(4_000)
  h.sessions.handler = async (_method, params) => ({ text: params.text })
  const input = wire({ id: 1, method: "_deskfleet/session/create", params: { text, actor: { kind: "system" } } })
  // The first non-ASCII character is deliberately split after one UTF-8 byte.
  const split = input.indexOf(Buffer.from("你")) + 1
  h.channel.receive(input.subarray(0, split))
  h.channel.receive(input.subarray(split, split + 2))
  for (let offset = split + 2; offset < input.length; offset += 997) h.channel.receive(input.subarray(offset, offset + 997))
  h.request(2, "_deskfleet/session/list", { text: "next" })
  assert.equal((await h.waitFor(message => message.id === 1)).result.text, text)
  assert.equal((await h.waitFor(message => message.id === 2)).result.text, "next")
  assert.deepEqual(h.sessions.calls.map(call => call.actor), [actor, actor])
  assert.ok(h.chunks.length > 3)
  assert.ok(h.chunks.every(chunk => chunk.length <= AGENT_CHUNK_BYTES))
  assert.deepEqual(h.failures, [])
})

test("AgentChannel forwards Git reads through the authenticated viewer without requiring a history subscription", async t => {
  const h = attach()
  t.after(() => h.channel.close())
  await h.initialize()
  const status = { sessionId: "1", repositories: [], directories: [] }
  const request = { sessionId: "1", repositoryId: "checkout", path: "中文 file.txt", kind: "unstaged" }
  const diff = { ...request, patch: "@@ -1 +1 @@\n-old\n+new\n", binary: false, truncated: false }
  h.sessions.handler = async method => method === "_deskfleet/git/status" ? status : diff
  h.request("status", "_deskfleet/git/status", { sessionId: "1" })
  h.request("diff", "_deskfleet/git/diff", request)
  assert.deepEqual((await h.waitFor(message => message.id === "status")).result, status)
  assert.deepEqual((await h.waitFor(message => message.id === "diff")).result, diff)
  assert.deepEqual(h.sessions.calls, [
    { method: "_deskfleet/git/status", params: { sessionId: "1" }, actor },
    { method: "_deskfleet/git/diff", params: request, actor },
  ])
  assert.deepEqual(h.failures, [])
})

test("AgentChannel shares user questions through snapshots and events and authenticates answers", async t => {
  const sessions = new Sessions()
  const first = attach(sessions)
  const second = attach(sessions, { ...actor, deviceId: "second" })
  t.after(() => { first.channel.close(); second.channel.close() })
  let question: AgentElicitation = {
    id: "3", sessionId: "1", runGeneration: 1, state: "pending", createdAt: now,
    request: { sessionId: "provider-session", mode: "form", message: "Choose a branch", requestedSchema: {
      type: "object", properties: { branch: { type: "string" } }, required: ["branch"],
    } },
  }
  sessions.handler = async (method, params, identity) => {
    if (method === "_deskfleet/session/subscribe") return { ...snapshot, elicitations: [question] }
    assert.equal(method, "_deskfleet/elicitation/respond")
    assert.equal(params.elicitationId, question.id)
    question = { ...question, state: "resolved", response: params.response, actor: identity }
    sessions.emit({ sessionId: "1", seq: "1", kind: "elicitation", payload: question, createdAt: now })
    return question
  }
  await Promise.all([first.initialize(), second.initialize()])
  const attached = await Promise.all([first.subscribe(), second.subscribe()])
  assert.ok(attached.every(message => message.result.elicitations[0].state === "pending"))
  first.request("answer", "_deskfleet/elicitation/respond", {
    sessionId: "1", elicitationId: "3", operationId: "answer-operation", response: { action: "accept", content: { branch: "main" } },
  })
  const result = await first.waitFor(message => message.id === "answer")
  assert.deepEqual(result.result.actor, actor)
  const mirrored = await second.waitFor(message => message.method === "_deskfleet/session/event")
  assert.equal(mirrored.params.payload.state, "resolved")
  assert.deepEqual(mirrored.params.payload.response, { action: "accept", content: { branch: "main" } })
  const reattached = await second.subscribe("reattach")
  assert.equal(reattached.result.elicitations[0].state, "resolved")
  assert.deepEqual([...first.failures, ...second.failures], [])
})

test("AgentChannel handles approvals and cancellation while another request awaits", async t => {
  const h = attach()
  t.after(() => h.channel.close())
  await h.initialize()
  await h.subscribe()
  const pending = deferred<unknown>()
  h.sessions.handler = async method => method === "_deskfleet/input/submit" ? pending.promise : { accepted: true }
  h.request("submit", "_deskfleet/input/submit", { sessionId: "1", operationId: "submit" })
  h.sessions.emit(event("1"))
  const approval = await h.waitFor(message => message.method === "session/request_permission")
  h.channel.receive(Buffer.concat([
    wire({ id: approval.id, result: { outcome: { outcome: "selected", optionId: "allow" } } }),
    wire({ id: "cancel", method: "_deskfleet/turn/cancel", params: { sessionId: "1", turnId: "turn", operationId: "cancel" } }),
  ]))
  await h.waitFor(message => message.method === "_deskfleet/permission/receipt")
  await h.waitFor(message => message.id === "cancel")
  assert.equal(h.messages.some(message => message.id === "submit"), false)
  assert.deepEqual(h.sessions.calls.slice(-3).map(call => call.method), ["_deskfleet/input/submit", "_deskfleet/permission/respond", "_deskfleet/turn/cancel"])
  const decision = h.sessions.calls.find(call => call.method === "_deskfleet/permission/respond")!
  assert.match((decision.params as { operationId: string }).operationId, /^[0-9a-f-]{36}$/u)
  pending.resolve({ delivered: true })
  assert.equal((await h.waitFor(message => message.id === "submit")).result.delivered, true)
})

test("AgentChannel subscribes before its snapshot and pages history without losing live events", async t => {
  const h = attach()
  t.after(() => h.channel.close())
  await h.initialize()
  const reading = deferred<unknown>()
  const events = [event("1", { ...permission(), state: "resolved" }), event("2", { ...permission(), state: "cancelled" })]
  h.sessions.handler = async method => method === "_deskfleet/session/subscribe" ? reading.promise : events
  h.request("subscribe", "_deskfleet/session/subscribe", { sessionId: "1" })
  for (const value of events) h.sessions.emit(value)
  h.sessions.emit({ ...event("3"), sessionId: "another" })
  assert.equal(h.messages.some(message => message.method === "_deskfleet/session/event"), false)
  reading.resolve(snapshot)
  await h.waitFor(message => message.method === "_deskfleet/session/event" && message.params.seq === "2")
  h.request("history", "_deskfleet/session/history", { sessionId: "1", afterSeq: "0", limit: 100 })
  assert.deepEqual((await h.waitFor(message => message.id === "history")).result, events)
  assert.deepEqual(h.messages.filter(message => message.method === "_deskfleet/session/event").map(message => message.params.seq), ["1", "2"])
  assert.ok(h.messages.findIndex(message => message.id === "subscribe") < h.messages.findIndex(message => message.method === "_deskfleet/session/event"))
  h.sessions.emit(event("3", { ...permission(), state: "resolved" }))
  await h.waitFor(message => message.method === "_deskfleet/session/event" && message.params.seq === "3")
  assert.deepEqual(h.failures, [])
})

test("AgentChannel does not re-open stale snapshot permissions resolved during first or repeated subscription", async t => {
  const h = attach()
  t.after(() => h.channel.close())
  await h.initialize()
  for (const id of ["first", "again"]) {
    const reading = deferred<unknown>()
    h.sessions.handler = async () => reading.promise
    h.request(id, "_deskfleet/session/subscribe", { sessionId: "1" })
    h.sessions.emit(event("1", { ...permission(), state: "resolved" }))
    reading.resolve({ ...snapshot, permissions: [permission()] })
    await h.waitFor(message => message.id === id)
  }
  assert.equal(h.messages.some(message => message.method === "session/request_permission"), false)
})

test("AgentChannel publishes neither events nor permissions from a rejected subscription", async t => {
  const h = attach()
  t.after(() => h.channel.close())
  await h.initialize()
  const reading = deferred<unknown>()
  h.sessions.handler = async () => reading.promise
  h.request("denied", "_deskfleet/session/subscribe", { sessionId: "1" })
  h.sessions.emit(event("1"))
  reading.reject(new Error("Session is not accessible"))
  assert.match((await h.waitFor(message => message.id === "denied")).error!.message, /not accessible/)
  h.sessions.emit(event("2"))
  assert.equal(h.messages.some(message => message.method), false)
  h.sessions.handler = async () => snapshot
  assert.deepEqual((await h.subscribe()).result, snapshot)
})

test("AgentChannel fans permissions out per viewer and audits late decisions with authenticated actors", async t => {
  const sessions = new Sessions()
  const otherActor = { ...actor, deviceId: "second" }
  const first = attach(sessions)
  const second = attach(sessions, otherActor)
  t.after(() => { first.channel.close(); second.channel.close() })
  await Promise.all([first.initialize(), second.initialize()])
  await Promise.all([first.subscribe(), second.subscribe()])
  const shared = permission()
  let winner: AgentPermission | undefined
  sessions.handler = async (_method, params, identity) => {
    if (winner) throw new Error("Permission already resolved")
    winner = { ...shared, state: "resolved", optionId: params.optionId, actor: identity }
    sessions.emit(event("2", winner))
    return winner
  }
  sessions.emit(event("1", shared))
  const [left, right] = await Promise.all([first.waitFor(message => message.method === "session/request_permission"), second.waitFor(message => message.method === "session/request_permission")])
  assert.equal(left.params.sessionId, "1")
  assert.equal(left.params._meta.deskfleet.permissionId, shared.id)
  const operationId = "40f1e456-362e-484c-a541-64d1c12cd474"
  first.channel.receive(wire({ id: left.id, result: { outcome: { outcome: "selected", optionId: "allow" }, _meta: { deskfleet: { operationId } } } }))
  await second.waitFor(message => message.method === "$/cancel_request")
  second.channel.receive(wire({ id: right.id, result: { outcome: { outcome: "selected", optionId: "deny" }, _meta: { deskfleet: { operationId: "late" } } } }))
  assert.equal((await first.waitFor(message => message.method === "_deskfleet/permission/receipt")).params.operationId, operationId)
  assert.match((await second.waitFor(message => message.method === "_deskfleet/permission/receipt")).params.error, /already resolved/)
  const decisions = sessions.calls.filter(call => call.method === "_deskfleet/permission/respond")
  assert.equal(decisions.length, 2)
  assert.deepEqual(decisions.map(call => call.actor), [actor, otherActor])
  assert.equal(winner!.optionId, "allow")
})

test("AgentChannel detaches without cancelling shared work or permissions and reissues pending requests on reconnect", async t => {
  const sessions = new Sessions()
  sessions.handler = async () => ({ ...snapshot, permissions: [permission()] })
  const first = attach(sessions)
  await first.initialize()
  await first.subscribe()
  await first.waitFor(message => message.method === "session/request_permission")
  first.channel.close()
  first.channel.close()
  assert.equal(sessions.listeners.size, 0)
  assert.deepEqual(sessions.calls.map(call => call.method), ["_deskfleet/session/subscribe"])
  const second = attach(sessions)
  t.after(() => second.channel.close())
  await second.initialize()
  await second.subscribe()
  await second.waitFor(message => message.method === "session/request_permission")
  assert.deepEqual(sessions.calls.map(call => call.method), ["_deskfleet/session/subscribe", "_deskfleet/session/subscribe"])
})

test("AgentChannel retries native backpressure without dropping or reordering chunks", async t => {
  let attempts = 0
  const h = attach(undefined, actor, async () => { if (++attempts <= 2) throw new Error("data channel send buffer is full") })
  t.after(() => h.channel.close())
  await h.initialize()
  h.request("first", "_deskfleet/session/list")
  h.request("second", "_deskfleet/session/list")
  await h.waitFor(message => message.id === "second")
  assert.deepEqual(h.messages.map(message => message.id), ["initialize", "first", "second"])
  assert.equal(attempts, 5)
  assert.deepEqual(h.failures, [])
})

test("AgentChannel rejects malformed envelopes and bounds messages and slow viewers", async t => {
  await t.test("invalid IDs, methods and JSON cannot reach the service", async t => {
    const h = attach()
    t.after(() => h.channel.close())
    await h.initialize()
    h.channel.receive(Buffer.from('{"jsonrpc":"2.0","id":{},"method":"_deskfleet/session/list"}\n'))
    h.channel.receive(Buffer.from('{broken}\n'))
    h.request("unknown", "session/prompt", {})
    await h.waitFor(message => message.id === "unknown")
    assert.deepEqual(h.messages.filter(message => message.error).map(message => message.error!.code), [-32600, -32700, -32601])
    assert.equal(h.sessions.calls.length, 0)
  })
  await t.test("oversized incomplete input closes only the viewer", () => {
    const h = attach()
    h.channel.receive(new Uint8Array(AGENT_MESSAGE_BYTES + 1).fill(32))
    assert.match(String(h.failures[0]), /byte limit/)
    assert.equal(h.sessions.listeners.size, 0)
    assert.equal(h.sessions.calls.length, 0)
  })
  await t.test("malformed responses close the viewer without responding to a response", async () => {
    const h = attach()
    await h.initialize()
    const count = h.messages.length
    h.channel.receive(wire({ id: "invalid", result: {}, error: { code: -1, message: "both" } }))
    assert.match(String(h.failures[0]), /Invalid JSON-RPC response/)
    assert.equal(h.messages.length, count)
    assert.equal(h.sessions.calls.length, 0)
  })
  await t.test("bounded output detaches a stalled viewer while the service continues", async () => {
    const sessions = new Sessions()
    const blocked = deferred<void>()
    // This attachment uses a blocked native writer; its initialize response
    // remains queued while journal events fill the bounded viewer output queue.
    const slow = attach(sessions, actor, () => blocked.promise)
    slow.request("initialize", "initialize", { protocolVersion: 1 })
    slow.request("subscribe", "_deskfleet/session/subscribe", { sessionId: "1" })
    await delay(0)
    const text = "x".repeat(2 * 1024 * 1024)
    for (let seq = 1; seq <= 34; seq++) sessions.emit({ sessionId: "1", seq: String(seq), kind: "acp", createdAt: now, payload: { sessionId: "provider", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } })
    assert.equal(slow.failures.length, 1)
    assert.match(String(slow.failures[0]), /output byte limit/)
    assert.equal(sessions.calls.some(call => call.method === "_deskfleet/turn/cancel" || call.method === "_deskfleet/permission/respond"), false)
    slow.channel.close()
    blocked.resolve()
    const fresh = attach(sessions)
    await fresh.initialize()
    assert.deepEqual((await fresh.subscribe()).result, snapshot)
    fresh.channel.close()
  })
})
