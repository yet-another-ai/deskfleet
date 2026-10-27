import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { NativePeer, PeerEvent } from "@deskfleet/native"
import { AuthorizedPeers, normalizeCandidate } from "./authorized-peers.ts"
import type { AgentChannelSessions } from "./agent-channel.ts"
import type { AgentActor } from "./agent-protocol.ts"
import type { MachineCredentials, PeerAuthorization } from "./central-protocol.ts"
import type { TerminalSessions } from "./terminals.ts"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFileFrame, FileFrameDecoder } from "./files-wire.ts"
import { encoderFailure, isEncoderFailure } from "./control-protocol.ts"

const sdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=ice-ufrag:test\r\n"
const identity = { originId: "origin", machineId: "1" }
const credentials: MachineCredentials = { serverUrl: "https://backend.example", serverId: "server", teamId: "team", machineId: "machine", token: "secret" }
const epoch = Date.parse("2026-10-25T00:00:00Z")
function grant(): PeerAuthorization {
  return {
    peerId: "peer", serverId: "server", teamId: "team", actor: { kind: "user", userId: "alice", deviceId: "login" },
    targetMachine: { id: "machine", originId: "origin", localMachineId: "1" }, purpose: "agent",
    actions: ["agent:read", "agent:execute", "git:read"], issuedAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 86_400_000).toISOString(),
  }
}

function fixture(closeGate?: Promise<void>, closeError?: Error) {
  let now = epoch, closed = false, closeCalls = 0
  let closing!: () => void
  const closeStarted = new Promise<void>(resolve => { closing = resolve })
  const sent: string[] = [], events: PeerEvent[] = [], calls: { method: string; actor: AgentActor }[] = []
  const packets: Buffer[] = []
  const input: string[] = [], starts: unknown[] = [], signals: unknown[] = []
  const negotiation: string[] = [], forwardingDeadlines: number[] = []
  const gitListeners = new Set<(error?: string) => void>()
  let waiting: ((event: PeerEvent | null) => void) | undefined
  const push = (event: PeerEvent) => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(event) } else events.push(event) }
  const native = {
    answerOffer: async () => { negotiation.push("answer"); return sdp }, addIceCandidate: async () => {}, startDesktop: async (options: unknown) => { starts.push(options) },
    enablePortForwarding: async (expiresAt: number) => { negotiation.push("ports"); forwardingDeadlines.push(expiresAt) },
    sendDesktopInput: async (text: string) => { input.push(text) },
    sendText: async (_label: string, text: string) => { sent.push(text) },
    sendData: async (_label: string, data: Buffer) => { sent.push(data.toString()); packets.push(data) },
    nextEvent: async () => events.shift() ?? (closed ? null : new Promise<PeerEvent | null>(resolve => { waiting = resolve })),
  } as unknown as NativePeer
  const agents: AgentChannelSessions = {
    journal: { identity }, onEvent: () => () => {},
    handle: async (method, _params, actor) => { calls.push({ method, actor }); return null },
    watchGit: async (_sessionId, actor, listener) => {
      calls.push({ method: "_deskfleet/git/subscribe", actor })
      gitListeners.add(listener)
      return () => { gitListeners.delete(listener) }
    },
  }
  const peers = new AuthorizedPeers({
    peers: {
      create: async () => { negotiation.push("create"); return native },
      close: async () => {
        closeCalls++; closing(); await closeGate; closed = true; waiting?.(null)
        if (closeError) throw closeError
      },
    },
    agents, terminals: {} as TerminalSessions, identity, signal: (_id, event) => { signals.push(event) }, now: () => now,
  })
  peers.bind(credentials)
  const rpc = async (id: number, method: string, params: unknown) => {
    push({ kind: "data", label: "deskfleet-acp", data: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n") })
    for (let tries = 0; tries < 100 && !sent.some(value => value.includes(`"id":${id},`)); tries++) await delay(1)
  }
  return { peers, native, calls, sent, packets, rpc, push, input, starts, signals, negotiation, forwardingDeadlines, gitListeners, closeStarted, closeCalls: () => closeCalls, expired: () => { now += 86_400_001 }, closed: () => closed }
}

test("ports require their own action and enable native forwarding before negotiation", async context => {
  const f = fixture(); context.after(() => f.peers.closeAll())
  const authorization: PeerAuthorization = { ...grant(), purpose: "ports", actions: ["ports:forward"] }
  await assert.rejects(f.peers.offer({ peerId: "peer", sdp, authorization: { ...authorization, actions: ["agent:execute"] }, iceServers: [] }), /does not allow port forwarding/)
  assert.deepEqual(f.negotiation, [])
  await f.peers.offer({ peerId: "peer", sdp, authorization, iceServers: [] })
  assert.deepEqual(f.negotiation, ["create", "ports", "answer"])
  assert.deepEqual(f.forwardingDeadlines, [Date.parse(authorization.expiresAt)])
})

test("another peer purpose cannot enable forwarding through a channel label or action", async context => {
  const f = fixture(); context.after(() => f.peers.closeAll())
  await f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), actions: [...grant().actions, "ports:forward"] }, iceServers: [] })
  f.push({ kind: "dataChannelOpen", label: "deskfleet-ports" })
  f.push({ kind: "data", label: "deskfleet-ports", data: Buffer.from("open") })
  await delay(0)
  assert.deepEqual(f.negotiation, ["create", "answer"])
  assert.deepEqual(f.forwardingDeadlines, [])
})

for (const failure of ["native startup", "expired during startup"] as const) {
  test(`port negotiation closes native resources after ${failure}`, async context => {
    const f = fixture(); context.after(() => f.peers.closeAll())
    f.native.enablePortForwarding = async () => {
      if (failure === "native startup") throw new Error("Port forwarding could not start")
      f.expired()
    }
    await assert.rejects(f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), purpose: "ports", actions: ["ports:forward"] }, iceServers: [] }), failure === "native startup" ? /could not start/ : /authorization has expired/)
    assert.deepEqual(f.negotiation, ["create"])
    assert.equal(f.closeCalls(), 1)
    assert.equal(f.closed(), true)
  })
}

for (const ending of ["expiry", "revocation", "channel close"] as const) {
  test(`port ${ending} closes its native peer and waits for resource cleanup`, { timeout: 5_000 }, async context => {
    let release!: () => void
    const f = fixture(new Promise<void>(resolve => { release = resolve }))
    context.after(async () => { release(); await f.peers.closeAll() })
    const authorization: PeerAuthorization = {
      ...grant(), purpose: "ports", actions: ["ports:forward"],
      ...(ending === "expiry" ? { expiresAt: new Date(epoch + 10).toISOString() } : {}),
    }
    await f.peers.offer({ peerId: "peer", sdp, authorization, iceServers: [] })
    const revocation = ending === "revocation" ? f.peers.reconcile([]) : undefined
    if (ending === "channel close") f.push({ kind: "dataChannelClosed", label: "deskfleet-ports" })
    await f.closeStarted
    let settled = false
    const closing = f.peers.close("peer").then(() => { settled = true })
    await delay(0)
    assert.equal(settled, false)
    assert.equal(f.closed(), false)
    release()
    await Promise.all([closing, revocation])
    assert.equal(f.closed(), true)
    assert.equal(f.closeCalls(), 1)
    await assert.rejects(f.peers.candidate("peer", { candidate: "candidate:1" }), /Unknown authorized peer/)
  })
}

test("repeated close and shutdown await the same native input cleanup", async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = fixture(gate)
  await f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), purpose: "desktop", actions: ["desktop:stream", "desktop:control"] }, iceServers: [] })
  const closed: string[] = []
  const first = f.peers.close("peer").then(() => { closed.push("first") })
  const second = f.peers.close("peer").then(() => { closed.push("second") })
  const shutdown = f.peers.closeAll().then(() => { closed.push("shutdown") })
  await delay(0)
  assert.deepEqual(closed, [])
  release()
  await Promise.all([first, second, shutdown])
  assert.equal(closed.length, 3)
  assert.equal(f.closed(), true)
})

test("desktop streaming grant alone cannot enable or send control", async context => {
  const f = fixture(); context.after(() => f.peers.closeAll())
  await f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), purpose: "desktop", actions: ["desktop:stream"] }, iceServers: [] })
  await assert.rejects(f.peers.start("peer", { displayId: 7, control: true }), /does not allow/)
  assert.equal(f.starts.length, 0)
  await f.peers.start("peer", { displayId: 7 })
  f.push({ kind: "data", label: "deskfleet-input", isString: true, data: Buffer.from('{"type":"releaseAll"}') })
  for (let tries = 0; tries < 100 && !f.closed(); tries++) await delay(1)
  assert.equal(f.closed(), true)
  assert.deepEqual(f.input, [])
})

test("desktop control binds the capture display and expires before further input", async context => {
  const f = fixture(); context.after(() => f.peers.closeAll())
  await f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), purpose: "desktop", actions: ["desktop:stream", "desktop:control"] }, iceServers: [] })
  f.push({ kind: "dataChannelOpen", label: "deskfleet-input" })
  await f.peers.start("peer", { displayId: 7, control: true })
  f.push({ kind: "data", label: "deskfleet-input", isString: true, data: Buffer.from('{"type":"key","code":"KeyA","pressed":true}') })
  for (let tries = 0; tries < 100 && !f.input.length; tries++) await delay(1)
  assert.deepEqual(f.starts, [{ displayId: 7, control: true }])
  assert.equal(f.input.length, 1)
  assert.deepEqual(f.sent, ['{"type":"ready"}'])
  f.expired()
  f.push({ kind: "data", label: "deskfleet-input", isString: true, data: Buffer.from('{"type":"key","code":"KeyB","pressed":true}') })
  for (let tries = 0; tries < 100 && !f.closed(); tries++) await delay(1)
  assert.equal(f.closed(), true)
  assert.equal(f.input.length, 1)
})

for (const phase of ["before native startup", "during input readiness"] as const) {
  test(`desktop starts reject duplicates ${phase} and after startup without closing the peer`, { timeout: 5_000 }, async context => {
    const f = fixture()
    let release!: () => void, ready!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const enabling = new Promise<void>(resolve => { ready = resolve })
    context.after(async () => { release(); await f.peers.closeAll() })
    const startDesktop = f.native.startDesktop.bind(f.native)
    f.native.startDesktop = async options => {
      await startDesktop(options)
      if (phase === "before native startup") await gate
    }
    const sendText = f.native.sendText.bind(f.native)
    f.native.sendText = async (label, text) => {
      ready()
      if (phase === "during input readiness") await gate
      await sendText(label, text)
    }
    await f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), purpose: "desktop", actions: ["desktop:stream", "desktop:control"] }, iceServers: [] })
    f.push({ kind: "dataChannelOpen", label: "deskfleet-input" })
    await delay(0)
    const first = f.peers.start("peer", { displayId: 7, control: true })
    if (phase === "during input readiness") await enabling
    await assert.rejects(f.peers.start("peer", { displayId: 8, control: true }), /already starting/)
    assert.equal(f.closeCalls(), 0)
    release()
    await first
    await assert.rejects(f.peers.start("peer", { displayId: 8 }), /already started/)
    assert.deepEqual(f.starts, [{ displayId: 7, control: true }])
    assert.deepEqual(f.sent, ['{"type":"ready"}'])
    assert.equal(f.closeCalls(), 0)
    f.push({ kind: "data", label: "deskfleet-input", isString: true, data: Buffer.from('{"type":"key","code":"KeyA","pressed":true}') })
    for (let tries = 0; tries < 100 && !f.input.length; tries++) await delay(1)
    assert.equal(f.input.length, 1)
    assert.equal(f.closed(), false)
  })
}

for (const primaryEncoder of [true, false]) {
  test(`desktop startup keeps ${primaryEncoder ? "encoder" : "generic"} classification when cleanup also fails`, async context => {
    const cleanup = encoderFailure("encoder worker terminated during cleanup")
    const f = fixture(undefined, cleanup)
    context.mock.method(console, "error", () => {})
    context.after(() => f.peers.closeAll())
    const startup = new Error(primaryEncoder ? "video encoder failed during startup" : "screen capture permission denied")
    f.native.startDesktop = async () => { throw startup }
    f.native.takeMediaFailure = () => primaryEncoder ? { message: startup.message, reason: "encoder" } : null
    await f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), purpose: "desktop", actions: ["desktop:stream", "desktop:control"] }, iceServers: [] })
    await assert.rejects(f.peers.start("peer", { displayId: 7, control: true }), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(isEncoderFailure(error), primaryEncoder)
      assert.ok(error.cause instanceof Error)
      assert.equal(error.cause.message, startup.message)
      assert.equal(error.errors[0], error.cause)
      assert.ok(error.errors[1] instanceof AggregateError)
      assert.deepEqual(error.errors[1].errors, [cleanup])
      assert.ok(error.message.includes(startup.message))
      assert.ok(error.message.includes(cleanup.message))
      return true
    })
    assert.equal(f.closed(), true)
    assert.equal(f.closeCalls(), 1)
  })
}

for (const failure of ["ready send", "expiry after capture", "expiry during ready send"] as const) {
  test(`desktop startup rolls back ${failure} and waits for native cleanup`, { timeout: 5_000 }, async context => {
    let release!: () => void
    const f = fixture(new Promise<void>(resolve => { release = resolve }))
    context.after(async () => { release(); await f.peers.closeAll() })
    const sendError = new Error("Input ready send failed")
    const startDesktop = f.native.startDesktop.bind(f.native)
    f.native.startDesktop = async options => {
      await startDesktop(options)
      if (failure === "expiry after capture") f.expired()
    }
    f.native.sendText = async () => {
      if (failure === "ready send") throw sendError
      if (failure === "expiry during ready send") f.expired()
    }
    await f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), purpose: "desktop", actions: ["desktop:stream", "desktop:control"] }, iceServers: [] })
    f.push({ kind: "dataChannelOpen", label: "deskfleet-input" })
    await delay(0)
    let settled = false
    const start = f.peers.start("peer", { displayId: 7, control: true }).finally(() => { settled = true })
    const rejected = assert.rejects(start, error => failure === "ready send" ? error === sendError : error instanceof Error && /authorization has expired/.test(error.message))
    await f.closeStarted
    f.push({ kind: "data", label: "deskfleet-input", isString: true, data: Buffer.from('{"type":"key","code":"KeyA","pressed":true}') })
    await delay(0)
    assert.equal(settled, false, "startup must wait for capture and input cleanup")
    assert.equal(f.closed(), false)
    assert.deepEqual(f.starts, [{ displayId: 7, control: true }])
    assert.deepEqual(f.input, [])
    release()
    await rejected
    assert.equal(f.closed(), true)
    assert.equal(f.closeCalls(), 1)
    await assert.rejects(f.peers.start("peer", { displayId: 7, control: true }), /Unknown authorized peer/)
  })
}

test("peer grant binds target, user, purpose, and a maximum 24-hour lifetime", async () => {
  const f = fixture()
  for (const authorization of [
    { ...grant(), teamId: "another" }, { ...grant(), expiresAt: new Date(epoch + 86_400_001).toISOString() },
    { ...grant(), targetMachine: { ...grant().targetMachine, originId: "other-origin" } },
  ]) await assert.rejects(f.peers.offer({ peerId: "peer", sdp, authorization, iceServers: [] }))
  await f.peers.offer({ peerId: "peer", sdp, authorization: grant(), iceServers: [] })
  await f.peers.close("peer")
  await assert.rejects(f.peers.offer({ peerId: "peer", sdp, authorization: grant(), iceServers: [] }), /new peer/)
})

test("Agent RPC uses the server actor and cannot perform management over WebRTC", async context => {
  const f = fixture(); context.after(() => f.peers.closeAll())
  const authorization = grant()
  await f.peers.offer({ peerId: "peer", sdp, authorization, iceServers: [] })
  authorization.actor.userId = "mutated"
  await f.rpc(1, "initialize", { protocolVersion: 1 })
  await f.rpc(2, "_deskfleet/input/submit", { actor: { userId: "spoof" }, sessionId: "1" })
  assert.equal(f.calls[0]?.actor.userId, "alice")
  await f.rpc(3, "_deskfleet/session/create", {})
  assert.match(f.sent.join(""), /Manage Sessions through the backend API/)
  assert.equal(f.calls.length, 1)
  await f.rpc(4, "_deskfleet/elicitation/respond", { sessionId: "1", elicitationId: "2", response: { action: "cancel" }, actor: { userId: "spoof" } })
  assert.equal(f.calls[1]?.method, "_deskfleet/elicitation/respond")
  assert.equal(f.calls[1]?.actor.userId, "alice")
})

test("expiry closes access without a signaling connection and ignores queued input", async context => {
  const f = fixture(); context.after(() => f.peers.closeAll())
  await f.peers.offer({ peerId: "peer", sdp, authorization: grant(), iceServers: [] })
  await f.rpc(1, "initialize", { protocolVersion: 1 })
  f.expired()
  f.push({ kind: "data", label: "deskfleet-acp", data: Buffer.from('{"jsonrpc":"2.0","id":2,"method":"_deskfleet/input/submit","params":{}}\n') })
  for (let tries = 0; tries < 100 && !f.closed(); tries++) await delay(1)
  assert.equal(f.closed(), true)
  assert.equal(f.calls.length, 0)
  assert.equal(f.sent.length, 1)
})

test("Git observation requires git:read and rechecks authorization before notifications", async context => {
  const denied = fixture(), allowed = fixture()
  context.after(async () => { await denied.peers.closeAll(); await allowed.peers.closeAll() })
  await denied.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), actions: ["agent:read"] }, iceServers: [] })
  await denied.rpc(1, "initialize", { protocolVersion: 1 })
  await denied.rpc(2, "_deskfleet/git/subscribe", { sessionId: "1", subscriptionId: "denied" })
  assert.match(denied.sent.join(""), /does not allow this operation/)
  assert.equal(denied.gitListeners.size, 0)

  await allowed.peers.offer({ peerId: "peer", sdp, authorization: grant(), iceServers: [] })
  await allowed.rpc(1, "initialize", { protocolVersion: 1 })
  await allowed.rpc(2, "_deskfleet/git/subscribe", { sessionId: "1", subscriptionId: "allowed", actor: { userId: "spoof" } })
  assert.equal(allowed.calls[0]?.actor.userId, "alice")
  assert.equal(allowed.gitListeners.size, 1)
  for (const listener of allowed.gitListeners) listener()
  await delay(0)
  assert.match(allowed.sent.join(""), /_deskfleet\/git\/changed/)
  const count = allowed.sent.length
  allowed.expired()
  for (const listener of allowed.gitListeners) listener()
  await delay(0)
  assert.equal(allowed.sent.length, count)
  await allowed.peers.closeAll()
  assert.equal(allowed.gitListeners.size, 0)
})

test("reconciliation never extends an existing peer grant", async () => {
  const f = fixture()
  await f.peers.offer({ peerId: "peer", sdp, authorization: grant(), iceServers: [] })
  await f.peers.reconcile([{ ...grant(), expiresAt: new Date(epoch + 90_000_000).toISOString() }])
  assert.equal(f.closed(), true)
})

test("native ICE without ufrag or mid binds through its SDP media index", () => {
  assert.deepEqual(normalizeCandidate({ candidate: "candidate:1", sdpMid: "", sdpMlineIndex: 0 }, sdp), { candidate: "candidate:1", sdpMid: "0", sdpMlineIndex: 0 })
  assert.throws(() => normalizeCandidate({ candidate: "candidate:1", sdpMid: "wrong", sdpMlineIndex: 0 }, sdp), /media binding/)
  assert.throws(() => normalizeCandidate({ candidate: "candidate:1", sdpMlineIndex: 0, usernameFragment: "old" }, sdp), /another negotiation/)
})

test("files peers route binary reads and enforce a separate write action", async context => {
  const f = fixture()
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-file-peer-"))
  context.after(async () => { await f.peers.closeAll(); await rm(directory, { recursive: true, force: true }) })
  const path = join(directory, "source.txt")
  await writeFile(path, "hello")
  await f.peers.offer({ peerId: "peer", sdp, authorization: { ...grant(), purpose: "files", actions: ["files:read"] }, iceServers: [] })
  f.push({ kind: "data", label: "deskfleet-files", data: Buffer.from(encodeFileFrame({ id: 1, method: "read", params: { path, offset: 0, length: 5 } })) })
  for (let tries = 0; tries < 100 && !f.packets.length; tries++) await delay(1)
  const decoder = new FileFrameDecoder()
  const replies = f.packets.flatMap(packet => decoder.push(packet))
  assert.equal(Buffer.from(replies[0]!.data).toString(), "hello")
  f.push({ kind: "data", label: "deskfleet-files", data: Buffer.from(encodeFileFrame({ id: 2, method: "begin", params: { directory, name: "blocked", kind: "file", conflict: "ask" } })) })
  for (let tries = 0; tries < 100 && !f.closed(); tries++) await delay(1)
  assert.equal(f.closed(), true)
  assert.equal(f.calls.length, 0)
})
