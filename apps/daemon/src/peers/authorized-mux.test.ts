import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { NativePeer, PeerEvent } from "@deskfleet/native"
import { MuxConnection, type MuxStream } from "@deskfleet/client/mux/connection"
import { MUX_LABELS, type MuxLane, type MuxPurpose } from "@deskfleet/protocol/mux"
import { AuthorizedPeers } from "./authorized-peers.ts"
import type { AgentChannelSessions } from "../agent/channel.ts"
import type { AgentActor } from "@deskfleet/protocol/agent"
import type { PeerAuthorization } from "@deskfleet/protocol/central"
import type { TerminalSessions, TerminalChange } from "../terminals/terminals.ts"
import { encodeFileFrame, FileFrameDecoder } from "@deskfleet/protocol/files-wire"
import { FilesService } from "../files/service.ts"

const sdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=ice-ufrag:test\r\n"
const actions = ["agent:read", "agent:execute", "git:read", "terminal:read", "terminal:write", "files:read", "files:write"]

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(1)
  assert.equal(predicate(), true)
}

async function fixture(t: TestContext, permissions = actions) {
  let now = Date.now(), closed = false, created = 0, backpressured = false
  const grant: PeerAuthorization = {
    peerId: "mux", serverId: "server", teamId: "team", purpose: "mux", transport: "webrtc",
    actor: { kind: "user", userId: "user", deviceId: "login" },
    targetMachine: { id: "machine", originId: "origin", localMachineId: "1" },
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), actions: permissions,
  }
  const pending: PeerEvent[] = [], calls: { method: string; actor: AgentActor }[] = []
  const lanes: MuxLane[] = [], signals: unknown[] = [], errors: Error[] = []
  const blockedSends = new Map<MuxLane, number>()
  const agentListeners = new Set<unknown>(), terminalListeners = new Set<(change: TerminalChange) => void>()
  let waiting: ((event: PeerEvent | null) => void) | undefined
  const push = (event: PeerEvent) => {
    if (waiting) { const ready = waiting; waiting = undefined; ready(event) } else pending.push(event)
  }
  const client = new MuxConnection({
    role: "client",
    send: async (lane, bytes) => { push({ kind: "data", label: MUX_LABELS[lane], data: Buffer.from(bytes), isString: false }) },
    failed: error => errors.push(error),
  })
  const native = {
    answerOffer: async () => sdp,
    sendData: async (label: string, bytes: Buffer) => {
      const lane = (Object.keys(MUX_LABELS) as MuxLane[]).find(lane => MUX_LABELS[lane] === label)!
      if (backpressured) { blockedSends.set(lane, Date.now()); throw new Error("send buffer is full") }
      blockedSends.delete(lane)
      lanes.push(lane); client.receive(lane, bytes)
    },
    nextEvent: async () => pending.shift() ?? (closed ? null : new Promise<PeerEvent | null>(resolve => { waiting = resolve })),
  } as unknown as NativePeer
  const agents: AgentChannelSessions = {
    journal: { identity: { originId: "origin", machineId: "1" } },
    onEvent: listener => { agentListeners.add(listener); return () => { agentListeners.delete(listener) } },
    handle: async (method, _params, actor) => { calls.push({ method, actor }); return [{ deviceId: actor.deviceId }] },
  }
  let transcript = Buffer.from("previous output\r\n")
  const summary = { id: "shell", title: "Shell", cwd: "/", cols: 80, rows: 24, status: "running", kind: "acp" }
  const terminals = {
    list: () => [summary], snapshot: () => ({ summary, end: transcript.length }),
    read: async (_id: string, offset: number, length: number) => transcript.subarray(offset, offset + length),
    release: () => {}, claim: () => {},
    subscribe: (_id: string, listener: (change: TerminalChange) => void) => {
      terminalListeners.add(listener); return () => { terminalListeners.delete(listener) }
    },
  } as unknown as TerminalSessions
  const server = new AuthorizedPeers({
    peers: {
      create: async () => { created++; return native },
      close: async () => { closed = true; waiting?.(null); client.close(new Error("peer closed")) },
    },
    agents, terminals, identity: { originId: "origin", machineId: "1" }, now: () => now,
    signal: (_id, event) => signals.push(event),
  })
  server.bind({ serverUrl: "https://backend.test", serverId: "server", teamId: "team", machineId: "machine", token: "token" })
  t.after(async () => { client.close(); await server.closeAll() })
  await server.offer({ peerId: "mux", sdp, authorization: grant, iceServers: [] })
  for (const label of Object.values(MUX_LABELS)) push({ kind: "dataChannelOpen", label })
  function open(purpose: MuxPurpose) {
    const stream = client.open(purpose)
    const messages: any[] = []
    let text = ""
    stream.onData = data => {
      if (purpose === "terminal") {
        const message = JSON.parse(String(data)); messages.push(message)
        if (message.event?.kind === "output") void stream.send(JSON.stringify({ ack: { sessionId: "shell", offset: message.event.offset } }))
      } else if (purpose === "agent") {
        text += Buffer.from(data as Uint8Array).toString()
        for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n")) {
          messages.push(JSON.parse(text.slice(0, newline))); text = text.slice(newline + 1)
        }
      }
    }
    return { stream, messages }
  }
  const rpc = async (stream: MuxStream, id: number, method: string, params: unknown = {}) => {
    const text = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    await stream.send(stream.purpose === "agent" ? Buffer.from(text + "\n") : text)
  }
  return {
    server, client, open, rpc, grant, calls, lanes, signals, errors, agentListeners, terminalListeners, blockedSends,
    created: () => created, closed: () => closed, expire: () => { now += 60_001 },
    backpressure: (value: boolean) => { backpressured = value },
    append: (text: string) => { transcript = Buffer.concat([transcript, Buffer.from(text)]); for (const listener of terminalListeners) listener("output") },
  }
}

test("authorized Mux output recovers past five seconds and retires only a peer that stalls for thirty", { timeout: 5_000 }, async t => {
  const slow = await fixture(t), healthy = await fixture(t)
  const agent = slow.open("agent"), sibling = healthy.open("agent")
  await Promise.all([agent.stream.ready, sibling.stream.ready])
  await slow.rpc(agent.stream, 1, "initialize", { protocolVersion: 1 })
  await healthy.rpc(sibling.stream, 1, "initialize", { protocolVersion: 1 })
  await until(() => agent.messages.some(value => value.id === 1) && sibling.messages.some(value => value.id === 1))
  t.mock.timers.enable({ apis: ["Date"] })
  const bothLanesRetried = () => slow.blockedSends.get("agent") === Date.now() && slow.blockedSends.get("control") === Date.now()
  slow.backpressure(true)
  await slow.rpc(agent.stream, 2, "_deskfleet/session/list")
  await until(() => slow.calls.length === 1)
  await until(bothLanesRetried)
  t.mock.timers.tick(6_000)
  await until(bothLanesRetried)
  assert.equal(slow.closed(), false)
  slow.backpressure(false)
  // Replies and credit frames retry independently. Drain both lanes before
  // starting a new stall with its own thirty-second deadline.
  await until(() => agent.messages.some(value => value.id === 2) && slow.blockedSends.size === 0)
  assert.equal(agent.messages.filter(value => value.id === 2).length, 1)
  assert.equal(slow.calls.length, 1)

  slow.backpressure(true)
  await slow.rpc(agent.stream, 3, "_deskfleet/session/list")
  await until(() => slow.calls.length === 2)
  await until(bothLanesRetried)
  t.mock.timers.tick(29_999)
  await until(bothLanesRetried)
  assert.equal(slow.closed(), false)
  t.mock.timers.tick(1)
  await until(() => slow.closed())
  assert.equal(slow.agentListeners.size, 0)
  await healthy.rpc(sibling.stream, 2, "_deskfleet/session/list")
  await until(() => sibling.messages.some(value => value.id === 2))
  assert.equal(healthy.closed(), false)
  assert.deepEqual(healthy.errors, [])
})

test("one authorized peer isolates Agent RPC IDs and terminal views while sharing four lanes", { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const agents = [f.open("agent"), f.open("agent")]
  const terminals = [f.open("terminal"), f.open("terminal")]
  await Promise.all([...agents, ...terminals].map(({ stream }) => stream.ready))
  await Promise.all(agents.map(({ stream }) => f.rpc(stream, 1, "initialize", { protocolVersion: 1 })))
  await Promise.all(agents.map(({ messages }) => until(() => messages.some(value => value.id === 1))))
  await Promise.all(agents.map(({ stream }) => f.rpc(stream, 2, "_deskfleet/session/list")))
  await Promise.all(agents.map(({ messages }) => until(() => messages.some(value => value.id === 2))))
  for (const agent of agents) assert.deepEqual(agent.messages.find(value => value.id === 2).result, [{ deviceId: "login" }])
  await Promise.all(terminals.map(({ stream }) => f.rpc(stream, 1, "attach", { sessionId: "shell" })))
  await Promise.all(terminals.map(({ messages }) => until(() => messages.some(value => value.event?.kind === "ready"))))
  assert.equal(f.created(), 1)
  assert.equal(f.agentListeners.size, 2)
  assert.equal(f.terminalListeners.size, 2)
  assert.equal(f.lanes.includes("bulk"), true, "transcript replay uses the bulk lane")
  agents[0]!.stream.close(); terminals[0]!.stream.close()
  await until(() => f.agentListeners.size === 1 && f.terminalListeners.size === 1)
  assert.equal(f.closed(), false)
  f.append("new output\r\n")
  await until(() => terminals[1]!.messages.some(value => value.event?.kind === "output" && Buffer.from(value.event.data, "base64").toString() === "new output\r\n"))
  await f.rpc(agents[1]!.stream, 3, "_deskfleet/session/list")
  await until(() => agents[1]!.messages.some(value => value.id === 3))
  assert.equal(f.calls.every(call => call.actor.userId === "user" && call.actor.deviceId === "login"), true)
  assert.deepEqual(f.errors, [])
})

test("file frames share the authorized Mux peer without changing their binary protocol", { timeout: 5_000 }, async t => {
  const f = await fixture(t)
  const stream = f.client.open("files")
  await stream.ready
  const reply = new Promise<string | Uint8Array>((resolve, reject) => {
    stream.onData = resolve
    stream.onClose = error => reject(error ?? new Error("Files stream closed before its reply"))
  })
  // Closing an absent read handle exercises the real file endpoint without disk I/O.
  const request = encodeFileFrame({ id: 1, method: "closeRead", params: { readId: "absent" } })
  const [bytes] = await Promise.all([reply, stream.send(request)])
  assert.ok(bytes instanceof Uint8Array)
  const frames = new FileFrameDecoder().push(bytes)
  assert.deepEqual(frames.map(frame => frame.header), [{ id: 1, value: null }])
  assert.equal(f.created(), 1)
  assert.ok(f.lanes.includes("bulk"))
})

test("Mux stream admission and operations cannot broaden the immutable grant", { timeout: 5_000 }, async t => {
  const f = await fixture(t, ["agent:read"])
  const agent = f.open("agent")
  await agent.stream.ready
  const denied = f.client.open("files")
  await assert.rejects(denied.ready, /does not allow this stream/)
  assert.equal(f.closed(), false)
  await f.rpc(agent.stream, 1, "initialize", { protocolVersion: 1 })
  await until(() => agent.messages.some(value => value.id === 1))
  await f.rpc(agent.stream, 2, "_deskfleet/git/status", { sessionId: "session" })
  await until(() => agent.messages.some(value => value.id === 2))
  assert.match(agent.messages.find(value => value.id === 2).error.message, /does not allow/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.server.start("mux", { displayId: 0 }), /does not allow/)
})

test("failed file stream cleanup preserves Agent and terminal siblings and reaches peer cleanup", { timeout: 5_000 }, async t => {
  const cleanupError = new Error("staging cleanup failed")
  const closeFiles = FilesService.prototype.close
  t.mock.method(FilesService.prototype, "close", async function (this: FilesService) {
    await closeFiles.call(this)
    throw cleanupError
  })
  const report = t.mock.method(console, "error", () => {})
  const f = await fixture(t)
  const agent = f.open("agent"), terminal = f.open("terminal"), files = f.open("files")
  await Promise.all([agent.stream.ready, terminal.stream.ready, files.stream.ready])
  await f.rpc(agent.stream, 1, "initialize", { protocolVersion: 1 })
  await f.rpc(terminal.stream, 1, "attach", { sessionId: "shell" })
  await until(() => terminal.messages.some(value => value.event?.kind === "ready"))

  files.stream.close()
  await until(() => report.mock.callCount() > 0)
  assert.deepEqual(report.mock.calls[0]!.arguments, ["Mux stream cleanup failed", cleanupError])
  assert.equal(f.closed(), false)
  await f.rpc(agent.stream, 2, "_deskfleet/session/list")
  await until(() => agent.messages.some(value => value.id === 2))
  f.append("output after file cleanup failure\r\n")
  await until(() => terminal.messages.some(value => value.event?.kind === "output" && Buffer.from(value.event.data, "base64").toString() === "output after file cleanup failure\r\n"))
  assert.deepEqual(f.errors, [])

  await assert.rejects(f.server.closeAll(), error => {
    assert.ok(error instanceof AggregateError)
    const peerError = error.errors[0] as AggregateError
    const muxError = peerError.errors[0] as AggregateError
    assert.deepEqual(muxError.errors, [cleanupError])
    return true
  })
})

for (const ending of ["expiry", "revocation"] as const) {
  test(`Mux ${ending} detaches all viewers and closes the physical peer`, { timeout: 5_000 }, async t => {
    const f = await fixture(t)
    const agent = f.open("agent"), terminal = f.open("terminal")
    await Promise.all([agent.stream.ready, terminal.stream.ready])
    await f.rpc(terminal.stream, 1, "attach", { sessionId: "shell" })
    await until(() => f.terminalListeners.size === 1)
    if (ending === "revocation") await f.server.reconcile([])
    else {
      f.expire()
      await f.rpc(agent.stream, 1, "initialize", { protocolVersion: 1 })
    }
    await until(() => f.closed() && f.agentListeners.size === 0 && f.terminalListeners.size === 0)
    await assert.rejects(agent.stream.send(Buffer.from("{}\n")), /closed/)
  })
}
