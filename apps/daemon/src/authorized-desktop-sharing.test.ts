import assert from "node:assert/strict"
import test from "node:test"
import type { DesktopConfig, DesktopStreamPool, NativePeer, PeerEvent } from "@deskfleet/native"
import { AuthorizedPeers } from "./authorized-peers.ts"
import type { AgentChannelSessions } from "./agent-channel.ts"
import type { MachineCredentials, PeerAuthorization } from "./central-protocol.ts"
import type { TerminalSessions } from "./terminals.ts"

const epoch = Date.parse("2026-10-25T00:00:00Z")
const credentials: MachineCredentials = { serverUrl: "https://backend.example", serverId: "server", teamId: "team", machineId: "machine", token: "secret" }
const identity = { originId: "origin", machineId: "1" }
const sdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=ice-ufrag:test\r\n"
const preview = { displayId: 7, fps: 1, bitrateBps: 150_000, maxWidth: 320, maxHeight: 180 }

function fixture() {
  let now = epoch
  const calls = new Map<string, { config: DesktopConfig; pool: DesktopStreamPool | null | undefined }>()
  const closed = new Set<string>()
  const finish = new Map<string, () => void>()
  const peers = new AuthorizedPeers({
    identity, signal: () => {}, now: () => now,
    agents: {} as AgentChannelSessions, terminals: {} as TerminalSessions,
    peers: {
      create: async id => {
        const ended = new Promise<PeerEvent | null>(resolve => { finish.set(id, () => { resolve(null) }) })
        return {
          answerOffer: async () => sdp,
          nextEvent: () => ended,
          startDesktop: async (config: DesktopConfig, pool?: DesktopStreamPool | null) => { calls.set(id, { config, pool }) },
        } as unknown as NativePeer
      },
      close: async id => { closed.add(id); finish.get(id)?.() },
    },
  })
  peers.bind(credentials)
  const offer = async (id: string, scope = credentials, expiresAt = epoch + 86_400_000, actions = ["desktop:stream"]): Promise<PeerAuthorization> => {
    const authorization: PeerAuthorization = {
      peerId: id, serverId: scope.serverId, teamId: scope.teamId,
      actor: { kind: "user", userId: "alice", deviceId: id },
      targetMachine: { id: scope.machineId, originId: identity.originId, localMachineId: identity.machineId },
      purpose: "desktop", transport: "webrtc", actions,
      issuedAt: new Date(epoch).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    }
    await peers.offer({ peerId: id, sdp, authorization, iceServers: [], options: { codec: "h264", audio: false } })
    return authorization
  }
  return { peers, offer, calls, closed, advance: (ms: number) => { now += ms } }
}

test("desktop viewers share their registration pool and keep independent grant lifetimes", async context => {
  const f = fixture()
  context.after(() => f.peers.closeAll())
  await f.offer("expiring", credentials, epoch + 1_000)
  await f.offer("revoked")
  const survivor = await f.offer("survivor")
  await Promise.all(["expiring", "revoked", "survivor"].map(id => f.peers.start(id, preview)))
  const shared = f.calls.get("survivor")!.pool
  assert.ok(shared)
  for (const call of f.calls.values()) {
    assert.equal(call.pool, shared)
    assert.deepEqual(call.config, preview)
  }

  f.advance(1_001)
  await assert.rejects(f.peers.start("expiring", preview), /expired/)
  await f.peers.close("expiring")
  assert.deepEqual([...f.closed], ["expiring"])
  await f.peers.reconcile([survivor])
  assert.deepEqual([...f.closed].sort(), ["expiring", "revoked"])
  await assert.rejects(f.peers.start("revoked", preview), /Unknown authorized peer/)
  await assert.rejects(f.peers.start("survivor", preview), /already started/)

  await f.offer("joining")
  await f.peers.start("joining", preview)
  assert.equal(f.calls.get("joining")!.pool, shared)
  assert.equal(f.closed.has("survivor"), false)
})

for (const field of ["serverId", "teamId", "machineId"] as const) {
  test(`desktop pools follow the admitted ${field} across credential rebinding`, async context => {
    const f = fixture()
    context.after(() => f.peers.closeAll())
    await f.offer("old-active")
    await f.offer("old-pending")
    await f.peers.start("old-active", preview)

    const rebound = { ...credentials, [field]: `another-${field}` }
    f.peers.bind(rebound)
    await f.offer("new", rebound)
    await f.peers.start("new", preview)
    await f.peers.start("old-pending", preview)
    assert.notEqual(f.calls.get("new")!.pool, f.calls.get("old-active")!.pool)
    assert.equal(f.calls.get("old-pending")!.pool, f.calls.get("old-active")!.pool)

    f.peers.bind({ ...rebound, token: "refreshed" })
    await f.offer("reconnected", rebound)
    await f.peers.start("reconnected", preview)
    assert.equal(f.calls.get("reconnected")!.pool, f.calls.get("new")!.pool)
  })
}

test("separate registration owners cannot share pools through client start options", async context => {
  const first = fixture(), second = fixture()
  context.after(async () => { await first.peers.closeAll(); await second.peers.closeAll() })
  await first.offer("first")
  await second.offer("second")
  await first.peers.start("first", preview)
  const supplied = { ...preview, pool: first.calls.get("first")!.pool }
  await second.peers.start("second", supplied)
  assert.ok(second.calls.get("second")!.pool)
  assert.notEqual(first.calls.get("first")!.pool, second.calls.get("second")!.pool)

  await second.offer("denied", credentials, epoch + 86_400_000, [])
  await assert.rejects(second.peers.start("denied", preview), /does not allow/)
  assert.equal(second.calls.has("denied"), false)
})
