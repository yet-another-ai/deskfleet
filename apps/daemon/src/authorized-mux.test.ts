import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { NativePeer, PeerEvent } from "@deskfleet/native"
import { MuxConnection, type MuxStream } from "../../../packages/client/src/mux/connection.ts"
import { MUX_LABELS, type MuxLane, type MuxPurpose } from "../../../packages/client/src/mux/protocol.ts"
import { AuthorizedPeers } from "./authorized-peers.ts"
import type { AgentChannelSessions } from "./agent-channel.ts"
import type { AgentActor } from "./agent-protocol.ts"
import type { PeerAuthorization } from "./central-protocol.ts"
import type { TerminalSessions, TerminalChange } from "./terminals.ts"
import { encodeFileFrame, FileFrameDecoder } from "./files-wire.ts"
import { FilesService } from "./files-service.ts"

const sdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=ice-ufrag:test\r\n"
const actions = ["agent:read", "agent:execute", "git:read", "terminal:read", "terminal:write", "files:read", "files:write"]

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(1)
  assert.equal(predicate(), true)
}

async function fixture(t: TestContext, permissions = actions) {
  let now = Date.now(), closed = false, created = 0
  const grant: PeerAuthorization = {
    peerId: "mux", serverId: "server", teamId: "team", purpose: "mux", transport: "webrtc",
    actor: { kind: "user", userId: "user", deviceId: "login" },
    targetMachine: { id: "machine", originId: "origin", localMachineId: "1" },
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), actions: permissions,
  }
  const pending: PeerEvent[] = [], calls: { method: string; actor: AgentActor }[] = []
  const lanes: MuxLane[] = [], signals: unknown[] = [], errors: Error[] = []
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
    server, client, open, rpc, grant, calls, lanes, signals, errors, agentListeners, terminalListeners,
    created: () => created, closed: () => closed, expire: () => { now += 60_001 },
    append: (text: string) => { transcript = Buffer.concat([transcript, Buffer.from(text)]); for (const listener of terminalListeners) listener("output") },
  }
}

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
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-mux-files-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, "hello.txt"), "hello")
  const f = await fixture(t)
  const stream = f.client.open("files"), decoder = new FileFrameDecoder()
  const replies: ReturnType<FileFrameDecoder["push"]> = []
  stream.onData = data => { assert.ok(data instanceof Uint8Array); replies.push(...decoder.push(data)) }
  await stream.ready
  await stream.send(encodeFileFrame({ id: 1, method: "list", params: { path: directory } }))
  await until(() => replies.length === 1)
  assert.equal(replies[0]!.header.id, 1)
  assert.equal(replies[0]!.header.error, undefined)
  assert.ok(JSON.stringify(replies[0]!.header.value).includes("hello.txt"))
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
