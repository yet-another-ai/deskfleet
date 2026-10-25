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

function fixture() {
  let now = epoch, closed = false
  const sent: string[] = [], events: PeerEvent[] = [], calls: { method: string; actor: AgentActor }[] = []
  const packets: Buffer[] = []
  let waiting: ((event: PeerEvent | null) => void) | undefined
  const push = (event: PeerEvent) => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(event) } else events.push(event) }
  const native = {
    answerOffer: async () => sdp, addIceCandidate: async () => {}, startDesktop: async () => {},
    sendData: async (_label: string, data: Buffer) => { sent.push(data.toString()); packets.push(data) },
    nextEvent: async () => events.shift() ?? (closed ? null : new Promise<PeerEvent | null>(resolve => { waiting = resolve })),
  } as unknown as NativePeer
  const agents: AgentChannelSessions = {
    journal: { identity }, onEvent: () => () => {},
    handle: async (method, _params, actor) => { calls.push({ method, actor }); return null },
  }
  const peers = new AuthorizedPeers({
    peers: { create: async () => native, close: async () => { closed = true; waiting?.(null) } },
    agents, terminals: {} as TerminalSessions, identity, signal: () => {}, now: () => now,
  })
  peers.bind(credentials)
  const rpc = async (id: number, method: string, params: unknown) => {
    push({ kind: "data", label: "deskfleet-acp", data: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n") })
    for (let tries = 0; tries < 100 && !sent.some(value => value.includes(`"id":${id},`)); tries++) await delay(1)
  }
  return { peers, calls, sent, packets, rpc, push, expired: () => { now += 86_400_001 }, closed: () => closed }
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
