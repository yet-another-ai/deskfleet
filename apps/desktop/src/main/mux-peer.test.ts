import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import { getMachineMux, type MuxPeerEvents } from "@deskfleet/client/mux-client"
import { MuxConnection } from "@deskfleet/client/mux/connection"
import { MUX_LABELS, MUX_PROFILE, muxLane } from "@deskfleet/client/mux/protocol"
import type { PeerEvent } from "@deskfleet/native"
import { encodeFileFrame, FileFrameDecoder } from "../../../daemon/src/files-wire.ts"
import { WindowMuxChannels } from "./mux-channels-controller.ts"

const native = vi.hoisted(() => ({ createPeer: vi.fn() }))
vi.mock("@deskfleet/native", () => native)
import { nativeMuxPeer } from "./mux-peer.ts"
import { createNativeFileEndpoint } from "./files-peer.ts"

afterEach(() => { vi.useRealTimers(); native.createPeer.mockReset() })
const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n"
function fixture() {
  const queued: PeerEvent[] = []
  let waiting: ((event: PeerEvent | null) => void) | undefined
  const push = (event: PeerEvent) => {
    if (waiting) { const ready = waiting; waiting = undefined; ready(event) }
    else queued.push(event)
  }
  const server = new MuxConnection({
    role: "server", failed: vi.fn(),
    send: async (lane, bytes) => push({ kind: "data", label: MUX_LABELS[lane], data: Buffer.from(bytes) }),
    accept(stream) {
      const decoder = new FileFrameDecoder()
      stream.onData = async data => {
        if (stream.purpose !== "files") { await stream.send(data); return }
        if (typeof data === "string") throw new Error("Expected binary file frame")
        for (const frame of decoder.push(data)) await stream.send(encodeFileFrame({ id: frame.header.id, value: { bytes: 0 } }))
      }
    },
  })
  const peer = {
    createDataChannel: vi.fn(async (_label: string) => {}), createOffer: vi.fn(async () => sdp),
    acceptAnswer: vi.fn(async () => { for (const label of Object.values(MUX_LABELS)) push({ kind: "dataChannelOpen", label }) }),
    addIceCandidate: vi.fn(async () => {}),
    nextEvent: () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<PeerEvent | null>(ready => { waiting = ready }),
    sendData: vi.fn(async (label: string, data: Buffer) => server.receive(muxLane(label)!, data)),
    close: vi.fn(async () => { server.close(); waiting?.(null); waiting = undefined }),
  }
  native.createPeer.mockResolvedValue(peer)
  const events: MuxPeerEvents = { data: vi.fn(), open: vi.fn(), state: vi.fn(), candidate: vi.fn(), fail: vi.fn() }
  const central = {
    machines: vi.fn(async () => [{ id: "machine", teamId: "team", capabilities: { mux: MUX_PROFILE, muxServer: MUX_PROFILE } }]),
    createPeer: vi.fn(async () => ({ peerId: "mux", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] })),
    offerPeer: vi.fn(async () => ({ sdp })), candidatePeer: vi.fn(async () => {}),
    closePeer: vi.fn(async () => {}), onEvent: () => () => {},
  } as unknown as CentralApi
  return { peer, server, events, central, push }
}

test("native factory opens exactly four channels before the initial offer and routes each lane", async () => {
  const f = fixture()
  const transport = await nativeMuxPeer([], f.events)
  expect(f.peer.createDataChannel.mock.calls.map(([label]) => label)).toEqual(Object.values(MUX_LABELS))
  expect(f.peer.createOffer).not.toHaveBeenCalled()
  await transport.offer()
  await transport.answer(sdp)
  await vi.waitFor(() => expect(f.events.open).toHaveBeenCalledTimes(4))
  f.push({ kind: "data", label: MUX_LABELS.terminal, data: Buffer.from([1, 2]) })
  await vi.waitFor(() => expect(f.events.data).toHaveBeenCalledWith("terminal", Buffer.from([1, 2])))
  await transport.close()
  expect(f.peer.close).toHaveBeenCalledOnce()
})

test("transient native backpressure retries one frame without creating another peer", async () => {
  vi.useFakeTimers()
  const f = fixture(), transport = await nativeMuxPeer([], f.events)
  f.peer.sendData.mockRejectedValueOnce(new Error("DataChannel backpressure: send buffer is full"))
  f.peer.sendData.mockResolvedValueOnce()
  const sending = transport.send("terminal", new Uint8Array([7]))
  await vi.advanceTimersByTimeAsync(10)
  await sending
  expect(f.peer.sendData).toHaveBeenCalledTimes(2)
  expect(native.createPeer).toHaveBeenCalledOnce()
  await transport.close()
})

test("closing a peer interrupts a pending native send promptly", async () => {
  const f = fixture(), transport = await nativeMuxPeer([], f.events)
  f.peer.sendData.mockRejectedValue(new Error("DataChannel backpressure: send buffer is full"))
  const rejected = expect(transport.send("bulk", new Uint8Array([7]))).rejects.toThrow("Mux peer closed")
  await Promise.resolve()
  await transport.close()
  await rejected
})

test("native file operations and renderer streams share one four-channel peer across renderer retirement", async () => {
  const f = fixture(), pool = getMachineMux(f.central, nativeMuxPeer)
  const deliveries = vi.fn()
  const first = new WindowMuxChannels(request => pool.open(request, request.purpose), deliveries)
  const second = new WindowMuxChannels(request => pool.open(request, request.purpose), deliveries)
  const target = { teamId: "team", machineId: "machine" }
  const endpoint = createNativeFileEndpoint(f.central, { kind: "machine", ...target })
  await Promise.all([
    first.open({ ...target, connectionId: "terminal", purpose: "terminal" }),
    second.open({ ...target, connectionId: "agent", purpose: "agent" }),
    endpoint.call("read", { path: "/file", offset: 0, length: 1 }),
  ])
  expect(native.createPeer).toHaveBeenCalledOnce()
  expect(f.central.createPeer).toHaveBeenCalledExactlyOnceWith("team", "machine", "mux")
  expect(f.peer.createDataChannel).toHaveBeenCalledTimes(4)
  await first.send("terminal", "input")
  await vi.waitFor(() => expect(deliveries).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "terminal", kind: "message", data: "input" })))
  await first.dispose()
  expect(f.peer.close).not.toHaveBeenCalled()
  await second.send("agent", new Uint8Array([1]))
  const result = await endpoint.call("read", { path: "/file", offset: 1, length: 1 })
  expect(result.value).toEqual({ bytes: 0 })
  expect(native.createPeer).toHaveBeenCalledOnce()
  await second.dispose()
  await endpoint.close()
  expect(f.peer.close).not.toHaveBeenCalled()
  await pool.close()
  expect(f.peer.close).toHaveBeenCalledOnce()
})
