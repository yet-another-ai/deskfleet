import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import type { NativePeer } from "@deskfleet/native"
import { CentralClient } from "./central-client.ts"
import type { MachineOperations } from "./machine-operations.ts"
import type { ControlPeers } from "./control-server.ts"

interface Reply {
  type: string
  id?: string
  result?: unknown
  error?: { code: string; message: string }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 15; index++) await setImmediate()
}

async function fixture(context: TestContext, authenticate = true) {
  const directory = await mkdtemp(join(tmpdir(), "df-peer-cleanup-"))
  await writeFile(join(directory, "central.json"), JSON.stringify({
    serverUrl: "http://127.0.0.1:8080", serverId: "server", teamId: "team", machineId: "machine", token: "fixture-secret",
  }))
  const sockets: FixtureSocket[] = []
  class FixtureSocket extends EventTarget {
    static OPEN = 1
    readyState = 1
    readonly sent: Reply[] = []
    readonly closes: { code: number; reason: string }[] = []
    constructor() { super(); sockets.push(this) }
    send(value: string) { this.sent.push(JSON.parse(value) as Reply) }
    close(code = 1000, reason = "") {
      this.closes.push({ code, reason })
      this.readyState = 2
      queueMicrotask(() => {
        this.readyState = 3
        const event = new Event("close")
        Object.defineProperty(event, "code", { value: code })
        this.dispatchEvent(event)
      })
    }
    receive(value: unknown) { this.raw(JSON.stringify(value)) }
    raw(data: string) { this.dispatchEvent(new MessageEvent("message", { data })) }
  }
  context.mock.property(globalThis, "WebSocket", FixtureSocket as unknown as typeof WebSocket)
  context.mock.method(globalThis, "fetch", async () => Response.json({ lastEventSeq: "0" }))
  const logs: unknown[][] = []
  context.mock.method(console, "error", (...values: unknown[]) => { logs.push(values) })
  const unsubscribe = () => () => {}
  let journalId = 0n
  const operations = {
    agents: {
      reconcileAdmissions: async () => {},
      journal: { id: async () => String(++journalId), identity: { originId: "origin", machineId: "local" }, list: async () => [] },
      onEvent: unsubscribe,
    },
    catalog: { snapshot: async () => ({}), onChange: unsubscribe },
    providers: { metadata: () => ({ providers: [] }), onChanged: unsubscribe },
    terminals: { onChange: unsubscribe },
    handle: async () => ({ alive: true }),
  } as unknown as MachineOperations
  let rejectCleanup!: (error: Error) => void
  let resolveCleanup!: () => void
  let finishEvents: ((event: null) => void) | undefined
  const cleanup = new Promise<void>((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject })
  let closeCalls = 0
  const sdp = "v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\na=ice-ufrag:fixture\r\n"
  const native = {
    answerOffer: async () => sdp,
    nextEvent: () => new Promise<null>(resolve => { finishEvents = resolve }),
  } as unknown as NativePeer
  const peers = {
    create: async () => native,
    close: async () => {
      closeCalls++
      try { await cleanup }
      finally { finishEvents?.(null) }
    },
  } as unknown as ControlPeers
  const central = new CentralClient(directory, operations, peers)
  context.after(async () => {
    resolveCleanup()
    await central.close()
    await rm(directory, { recursive: true, force: true })
  })
  await central.init()
  const socket = sockets[0]!
  if (authenticate) socket.receive({ type: "ready", serverId: "server", machineId: "machine", teamId: "team" })
  async function offer(): Promise<void> {
    const now = Date.now()
    socket.receive({
      type: "request", id: "offer", method: "peer.offer", params: {
        peerId: "peer", sdp, iceServers: [],
        authorization: {
          peerId: "peer", serverId: "server", teamId: "team",
          actor: { kind: "user", userId: "user", deviceId: "login" },
          targetMachine: { id: "machine", originId: "origin", localMachineId: "local" },
          purpose: "desktop", transport: "webrtc", actions: ["desktop:stream", "desktop:control"],
          issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
        },
      },
    })
    await settle()
    assert.ok(socket.sent.some(message => message.id === "offer" && message.result))
  }
  return { central, socket, logs, offer, rejectCleanup, closeCalls: () => closeCalls }
}

for (const notification of ["peerRevoked", "reconcilePeers"] as const) {
  test(`${notification} cleanup failure preserves the control link and the overlapping close RPC error`, async context => {
    const f = await fixture(context)
    await f.offer()
    f.socket.receive(notification === "peerRevoked"
      ? { type: notification, peerId: "peer", reason: "closed" }
      : { type: notification, peers: [] })
    f.socket.receive({ type: "request", id: "close", method: "peer.close", params: { peerId: "peer" } })
    await settle()
    assert.equal(f.closeCalls(), 1, "notification and RPC share the native cleanup")
    assert.equal(f.socket.sent.some(message => message.id === "close"), false, "the receipt waits for cleanup")
    const failure = new Error("native input cleanup failed")
    f.rejectCleanup(failure)
    await settle()
    assert.deepEqual(f.socket.closes, [])
    assert.equal(f.central.status().connected, true)
    const responses = f.socket.sent.filter(message => message.type === "response" && message.id === "close")
    assert.deepEqual(responses, [{ type: "response", id: "close", error: { code: "operation_failed", message: "Failed to close authorized peer" } }])
    assert.ok(f.logs.some(([message, error]) => message === "Central peer cleanup failed" && error instanceof AggregateError && error.errors.includes(failure)), "logging retains the native cleanup cause")
    f.socket.receive({ type: "request", id: "status", method: "systemStatus", params: {} })
    await settle()
    assert.deepEqual(f.socket.sent.find(message => message.id === "status"), { type: "response", id: "status", result: { alive: true } })
  })
}

for (const malformed of ["{", JSON.stringify({ type: "reconcilePeers", peers: [null] })]) {
  test(`malformed control traffic still closes the link: ${malformed}`, async context => {
    const f = await fixture(context)
    f.socket.raw(malformed)
    await settle()
    assert.deepEqual(f.socket.closes, [{ code: 4002, reason: "Invalid control message" }])
    assert.equal(f.central.status().connected, false)
  })
}

test("peer cleanup notifications before authentication still close the link", async context => {
  const f = await fixture(context, false)
  f.socket.receive({ type: "peerRevoked", peerId: "peer", reason: "closed" })
  await settle()
  assert.deepEqual(f.socket.closes, [{ code: 4002, reason: "Invalid control message" }])
  assert.equal(f.closeCalls(), 0)
})
