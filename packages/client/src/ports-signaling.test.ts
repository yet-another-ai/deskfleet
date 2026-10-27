import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent } from "./central.ts"
import { connectPortPeer, type PortPeer, type PortPeerEvents, type PortPeerFactory } from "./ports-signaling.ts"

afterEach(() => vi.useRealTimers())
const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n"
const target = { teamId: "team", machineId: "machine" }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(lifetime = 60_000) {
  const listeners = new Set<(event: CentralEvent) => void>()
  const emit = (event: CentralEvent) => { for (const listener of listeners) listener(event) }
  const grant = { peerId: "ports", authorization: { expiresAt: new Date(Date.now() + lifetime).toISOString() }, iceServers: [] }
  const api = {
    createPeer: vi.fn(async () => grant),
    onEvent: (listener: (event: CentralEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    offerPeer: vi.fn(async () => ({ sdp })),
    candidatePeer: vi.fn(async () => {}), closePeer: vi.fn(async () => {}),
  }
  const close = vi.fn(async () => {}), candidate = vi.fn(async () => {})
  let events!: PortPeerEvents
  const native: PortPeer = {
    localPort: 43123, close, candidate,
    offer: async () => sdp, answer: async () => events.open(),
  }
  const factory = vi.fn<PortPeerFactory>(async (_servers, callbacks) => { events = callbacks; return native })
  const failed = vi.fn()
  const connect = (signal?: AbortSignal) => connectPortPeer(api as unknown as CentralApi, target, factory, failed, signal)
  return { api, grant, close, candidate, native, factory, failed, emit, connect, listeners, events: () => events }
}

test("ports signaling binds early ICE candidates and preserves an authorized tunnel through signaling loss", async () => {
  const f = fixture()
  f.native.offer = async () => {
    f.events().candidate({ candidate: "local", sdpMid: "", sdpMlineIndex: 0 })
    const event = { kind: "iceCandidate", candidate: { candidate: "remote", sdpMid: "", sdpMlineIndex: 0 } } as const
    f.emit({ type: "peerEvent", peerId: "ports", event })
    return sdp
  }
  const connection = await f.connect()
  expect(f.api.createPeer).toHaveBeenCalledWith("team", "machine", "ports")
  expect(connection.localPort).toBe(43123)
  expect(f.api.candidatePeer).toHaveBeenCalledWith("ports", expect.objectContaining({ candidate: "local", sdpMid: "0" }))
  expect(f.candidate).toHaveBeenCalledWith(expect.objectContaining({ candidate: "remote", sdpMid: "0" }))
  f.emit({ type: "connection", connected: false })
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.close).not.toHaveBeenCalled()
  await Promise.all([connection.close(), connection.close()])
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.api.closePeer).toHaveBeenCalledOnce()
  expect(f.listeners.size).toBe(0)
})

for (const event of [
  { type: "peerRevoked", peerId: "ports", reason: "Access removed" },
  { type: "accountChanged" },
] satisfies CentralEvent[]) {
  test(`${event.type} closes established sockets without another caller operation`, async () => {
    const f = fixture()
    const connection = await f.connect()
    f.emit(event)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.failed).toHaveBeenCalledOnce()
    expect(f.listeners.size).toBe(0)
    await connection.close()
  })
}

test("grant expiry closes an idle port listener", async () => {
  vi.useFakeTimers()
  const f = fixture(1000)
  await f.connect()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("expired") }))
})

test("startup waits for the data channel as well as the answer", async () => {
  const f = fixture()
  f.native.answer = async () => {}
  let connected = false
  const pending = f.connect().then(value => { connected = true; return value })
  await vi.waitFor(() => expect(f.api.offerPeer).toHaveBeenCalledOnce())
  expect(connected).toBe(false)
  f.events().open()
  await (await pending).close()
})

test("setup timeout covers a stalled grant and revokes its late result", async () => {
  vi.useFakeTimers()
  const f = fixture()
  const granting = deferred<typeof f.grant>()
  f.api.createPeer.mockImplementation(() => granting.promise)
  const rejected = expect(f.connect()).rejects.toThrow("timed out")
  await vi.advanceTimersByTimeAsync(20_000)
  await rejected
  granting.resolve(f.grant)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.api.closePeer).toHaveBeenCalledWith("ports")
  expect(f.factory).not.toHaveBeenCalled()
  expect(f.listeners.size).toBe(0)
})

test("cancelling pending native setup closes a late listener", async () => {
  const f = fixture()
  const controller = new AbortController(), creating = deferred<PortPeer>()
  f.factory.mockImplementation(() => creating.promise)
  const rejected = expect(f.connect(controller.signal)).rejects.toThrow("cancelled")
  await vi.waitFor(() => expect(f.factory).toHaveBeenCalledOnce())
  controller.abort()
  await rejected
  creating.resolve(f.native)
  await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
  expect(f.api.offerPeer).not.toHaveBeenCalled()
  expect(f.api.closePeer).toHaveBeenCalledOnce()
})

test("account changes cancel a pending grant before native resources can be created", async () => {
  const f = fixture(), granting = deferred<ReturnType<typeof fixture>["grant"]>()
  f.api.createPeer.mockImplementation(() => granting.promise)
  const rejected = expect(f.connect()).rejects.toThrow("Account changed")
  f.emit({ type: "accountChanged" })
  await rejected
  granting.resolve(f.grant)
  await vi.waitFor(() => expect(f.api.closePeer).toHaveBeenCalledOnce())
  expect(f.factory).not.toHaveBeenCalled()
})

test("setup timeout closes the local listener when the offer never returns", async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.api.offerPeer.mockImplementation(() => new Promise(() => {}))
  const rejected = expect(f.connect()).rejects.toThrow("timed out")
  await vi.advanceTimersByTimeAsync(20_000)
  await rejected
  expect(f.close).toHaveBeenCalledOnce()
})

test("unreachable signaling cannot hold local cleanup open", async () => {
  const f = fixture()
  f.api.closePeer.mockImplementation(() => new Promise(() => {}))
  const connection = await f.connect()
  await connection.close()
  expect(f.close).toHaveBeenCalledOnce()
})
