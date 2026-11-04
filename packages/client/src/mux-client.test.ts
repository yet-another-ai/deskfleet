import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent, Machine } from "./central.ts"
import { MachineMuxRegistry, supportsMachineMux, type MuxPeerFactory } from "./mux-client.ts"
import { MuxConnection, type MuxStream } from "./mux/connection.ts"
import { MUX_LABELS, MUX_PROFILE, type MuxLane } from "./mux/protocol.ts"
import { HttpError } from "./http-central.ts"
import { MuxDataChannel } from "./mux-data-channel.ts"
import { LocalDataChannel, type LocalChannelEvent, type LocalChannelsApi } from "./local-channels.ts"

const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n"
const target = { teamId: "team", machineId: "machine" }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); vi.useRealTimers() })

function fixture(capabilities: Record<string, unknown> = { mux: MUX_PROFILE, muxServer: MUX_PROFILE }) {
  const listeners = new Set<(event: CentralEvent) => void>()
  const peers: Array<{ server: MuxConnection; streams: MuxStream[]; close: ReturnType<typeof vi.fn> }> = []
  const machine = { ...target, id: target.machineId, capabilities, online: true } as unknown as Machine
  let nextId = 0
  const central = {
    onEvent: (listener: (event: CentralEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    machines: vi.fn(async () => [machine]),
    createPeer: vi.fn(async () => ({ peerId: `peer-${++nextId}`, authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] })),
    offerPeer: vi.fn(async () => ({ sdp })), candidatePeer: vi.fn(async () => {}), closePeer: vi.fn(async () => {}),
  } as unknown as CentralApi
  const factory: MuxPeerFactory = vi.fn(async (_ice, events) => {
    const streams: MuxStream[] = []
    const server = new MuxConnection({ role: "server", send: async (lane, bytes) => { queueMicrotask(() => events.data(lane, bytes)) },
      accept: stream => { streams.push(stream); stream.onData = bytes => { void stream.send(bytes) } }, failed: events.fail })
    const close = vi.fn(async () => { server.close() })
    peers.push({ server, streams, close })
    return { offer: async () => sdp, answer: async () => {
      for (const lane of Object.keys(MUX_LABELS) as MuxLane[]) events.open(lane)
    }, candidate: async () => {}, send: async (lane: MuxLane, bytes: Uint8Array) => { queueMicrotask(() => server.receive(lane, bytes)) }, close }
  })
  const registry = new MachineMuxRegistry(central, factory)
  cleanup.push(() => registry.close())
  return { central, factory, registry, peers, machine, emit: (event: CentralEvent) => { for (const listener of listeners) listener(event) } }
}

test("concurrent Agent, terminal views and files share one authorized peer, retaining independent streams", async () => {
  const f = fixture()
  const streams = await Promise.all(["agent", "terminal", "terminal", "files"].map(purpose => f.registry.open(target, purpose as "agent" | "terminal" | "files")))
  expect(f.central.createPeer).toHaveBeenCalledExactlyOnceWith("team", "machine", "mux")
  expect(f.factory).toHaveBeenCalledOnce()
  expect(f.central.machines).toHaveBeenCalledOnce()
  expect(new Set(streams.map(stream => stream!.id)).size).toBe(4)
  streams[1]!.close()
  const receive = vi.fn()
  streams[2]!.onData = receive
  await streams[2]!.send("echo")
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith("echo"))
  expect(f.peers[0]!.close).not.toHaveBeenCalled()
  expect((await f.registry.open(target, "terminal"))!.state).toBe("open")
  expect(f.factory).toHaveBeenCalledOnce()
})

test.each([{}, { mux: MUX_PROFILE }, { muxServer: MUX_PROFILE }, { mux: "future", muxServer: MUX_PROFILE }])("missing/mismatched client-visible support uses legacy without trying a Mux grant: %j", async capabilities => {
  const f = fixture(capabilities)
  expect(supportsMachineMux(f.machine)).toBe(false)
  expect(await f.registry.open(target, "terminal")).toBeUndefined()
  expect(f.central.createPeer).not.toHaveBeenCalled()
  expect(f.factory).not.toHaveBeenCalled()
})

test("only explicit unsupported grant errors select legacy and cache the result", async () => {
  const f = fixture()
  vi.mocked(f.central.createPeer).mockRejectedValueOnce(new HttpError(400, "unsupported peer purpose", undefined, "invalid_request"))
  expect(await f.registry.open(target, "agent")).toBeUndefined()
  f.registry.observe(f.machine)
  expect(await f.registry.open(target, "files")).toBeUndefined()
  expect(f.central.createPeer).toHaveBeenCalledOnce()
})

test("a daemon rollback rejects the offer explicitly and releases the unused peer before fallback", async () => {
  const f = fixture()
  vi.mocked(f.central.offerPeer).mockImplementationOnce(async () => {
    f.emit({ type: "peerRevoked", peerId: "peer-1", reason: "negotiation_failed" })
    throw new HttpError(422, "Unsupported peer purpose", undefined, "daemon_error")
  })
  expect(await f.registry.open(target, "terminal")).toBeUndefined()
  expect(f.peers[0]!.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledWith("peer-1")
  expect(f.peers[0]!.streams).toHaveLength(0)
})

test.each([new HttpError(403, "forbidden"), new Error("network failed"), new HttpError(400, "invalid grant")])("authorization/network/protocol failures never trigger legacy fallback: %s", async error => {
  const f = fixture()
  vi.mocked(f.central.createPeer).mockRejectedValueOnce(error)
  await expect(f.registry.open(target, "agent")).rejects.toBe(error)
  expect(f.factory).not.toHaveBeenCalled()
})

test("signaling loss retains streams, while revocation closes all streams without replaying requests", async () => {
  const f = fixture()
  const first = (await f.registry.open(target, "agent"))!, second = (await f.registry.open(target, "terminal"))!
  f.emit({ type: "connection", connected: false })
  expect(first.state).toBe("open")
  f.emit({ type: "peerRevoked", peerId: "peer-1", reason: "revoked" })
  expect(first.state).toBe("closed"); expect(second.state).toBe("closed")
  expect(f.central.createPeer).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(f.peers[0]!.close).toHaveBeenCalledOnce())
})

test("Team scopes and changed accounts never reuse a peer or capability cache", async () => {
  const f = fixture()
  f.registry.observe({ ...f.machine, teamId: "other" })
  const first = (await f.registry.open(target, "terminal"))!
  const other = (await f.registry.open({ ...target, teamId: "other" }, "agent"))!
  expect(f.factory).toHaveBeenCalledTimes(2)
  f.emit({ type: "accountChanged" })
  expect(first.state).toBe("closed"); expect(other.state).toBe("closed")
  await f.registry.open(target, "terminal")
  expect(f.factory).toHaveBeenCalledTimes(3)
  expect(f.central.machines).toHaveBeenCalledTimes(2)
})

test("an account change during grant creation closes the late grant before creating a peer", async () => {
  const f = fixture()
  let grant!: (value: Awaited<ReturnType<CentralApi["createPeer"]>>) => void
  vi.mocked(f.central.createPeer).mockImplementationOnce(() => new Promise(resolve => { grant = resolve }))
  const opening = f.registry.open(target, "agent")
  const rejected = expect(opening).rejects.toThrow("account changed")
  await vi.waitFor(() => expect(grant).toBeTypeOf("function"))
  f.emit({ type: "accountChanged" })
  await rejected
  grant({ peerId: "late", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() } as never, iceServers: [] })
  await vi.waitFor(() => expect(f.central.closePeer).toHaveBeenCalledWith("late"))
  expect(f.factory).not.toHaveBeenCalled()
})

test("closing during a stalled capability lookup settles without waiting for the network", async () => {
  const f = fixture()
  vi.mocked(f.central.machines).mockReturnValueOnce(new Promise(() => {}))
  const opening = f.registry.open(target, "terminal")
  const rejected = expect(opening).rejects.toThrow("account changed")
  await f.registry.close()
  await rejected
  expect(f.factory).not.toHaveBeenCalled()
})

test("DataChannel facade forwards text/binary messages and closing a view preserves its sibling", async () => {
  const f = fixture()
  const fallback = vi.fn(async () => { throw new Error("Unexpected legacy connection") })
  const channel = new MuxDataChannel(() => f.registry.open(target, "terminal"), fallback)
  const second = new MuxDataChannel(() => f.registry.open(target, "agent"), fallback)
  const receive = vi.fn()
  channel.onmessage = event => receive(event.data)
  await vi.waitFor(() => expect(channel.readyState).toBe("open"))
  channel.send("text")
  channel.send(new Uint8Array([1, 2, 3]))
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2))
  expect(receive.mock.calls[0]![0]).toBe("text")
  expect(new Uint8Array(receive.mock.calls[1]![0])).toEqual(new Uint8Array([1, 2, 3]))
  channel.close()
  expect(second.readyState).toBe("open")
  expect(f.peers[0]!.close).not.toHaveBeenCalled()
  second.close()
})

test("closing a DataChannel before opening releases its late stream", async () => {
  const f = fixture()
  const channel = new MuxDataChannel(() => f.registry.open(target, "terminal"), async () => { throw new Error("unexpected") })
  channel.close()
  await vi.waitFor(() => expect(f.peers[0]?.streams[0]?.state).toBe("closed"))
  expect(channel.readyState).toBe("closed")
})

test("a logical open deadline releases the stream without closing its shared physical peer", async () => {
  vi.useFakeTimers()
  const f = fixture(), close = vi.fn(async () => {})
  vi.mocked(f.factory).mockImplementationOnce(async (_ice, events) => ({
    offer: async () => sdp, answer: async () => { for (const lane of Object.keys(MUX_LABELS) as MuxLane[]) events.open(lane) },
    candidate: async () => {}, send: async () => {}, close,
  }))
  const opening = f.registry.open(target, "terminal")
  const rejected = expect(opening).rejects.toThrow("stream opening timed out")
  await vi.advanceTimersByTimeAsync(45_000)
  await rejected
  expect(close).not.toHaveBeenCalled()
})

test("bridge data queued before open is delivered after facade open without being lost", async () => {
  let emit!: (event: LocalChannelEvent) => void
  const bridge: LocalChannelsApi = {
    onEvent: listener => { emit = listener; return () => {} }, close: async () => {}, send: async () => {},
    open: async () => { emit({ connectionId: "view", kind: "message", data: "early" }) },
  }
  const channel = new MuxDataChannel(() => new LocalDataChannel(bridge, { ...target, connectionId: "view", purpose: "terminal" }), async () => { throw new Error("unexpected") })
  const order: string[] = []
  channel.onopen = () => order.push("open")
  channel.onmessage = event => order.push(event.data as string)
  await vi.waitFor(() => expect(order).toEqual(["open", "early"]))
  channel.close()
})
