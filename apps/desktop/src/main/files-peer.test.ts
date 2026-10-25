import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import type { PeerEvent } from "@deskfleet/native"
import { encodeFileFrame, FileFrameDecoder } from "../../../daemon/src/files-wire.ts"

const native = vi.hoisted(() => ({ createPeer: vi.fn() }))
vi.mock("@deskfleet/native", () => native)
import { createNativeFileEndpoint } from "./files-peer.ts"

afterEach(() => { vi.useRealTimers(); native.createPeer.mockReset() })
const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n"

function fixture(stall = false) {
  const queued: PeerEvent[] = []
  let waiting: ((event: PeerEvent | null) => void) | undefined
  const push = (event: PeerEvent) => {
    if (waiting) { const ready = waiting; waiting = undefined; ready(event) }
    else queued.push(event)
  }
  const decoder = new FileFrameDecoder()
  let retries = 2
  const peer = {
    createDataChannel: vi.fn(async () => {}), createOffer: async () => sdp,
    acceptAnswer: async () => push({ kind: "dataChannelOpen", label: "deskfleet-files" }),
    addIceCandidate: async () => {},
    nextEvent: () => queued.length ? Promise.resolve(queued.shift()!) : new Promise<PeerEvent | null>(ready => { waiting = ready }),
    sendData: vi.fn(async (_label: string, data: Buffer) => {
      if (stall || retries-- > 0) throw new Error("DataChannel backpressure: send buffer is full")
      for (const { header } of decoder.push(data)) {
        push({ kind: "data", label: "deskfleet-files", data: Buffer.from(encodeFileFrame({ id: header.id, value: { bytes: 0 } })) })
      }
    }),
    close: vi.fn(async () => { waiting?.(null); waiting = undefined }),
  }
  native.createPeer.mockResolvedValue(peer)
  const central = {
    createPeer: async () => ({ peerId: "files", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] }),
    onEvent: () => () => {}, offerPeer: async () => ({ sdp }), closePeer: vi.fn(async () => {}),
  } as unknown as CentralApi
  return { peer, endpoint: createNativeFileEndpoint(central, { kind: "machine", machineId: "1", teamId: "1" }) }
}

test("temporary native backpressure retries the same chunk without reconnecting", async () => {
  vi.useFakeTimers()
  const { peer, endpoint } = fixture()
  const call = endpoint.call("read", { path: "/file", offset: 0, length: 1 })
  await vi.advanceTimersByTimeAsync(30)
  expect((await call).value).toEqual({ bytes: 0 })
  expect(peer.sendData).toHaveBeenCalledTimes(3)
  expect(native.createPeer).toHaveBeenCalledOnce()
  expect(peer.close).not.toHaveBeenCalled()
  await endpoint.close()
})

test("persistent native backpressure is bounded and closes the failed peer", async () => {
  vi.useFakeTimers()
  const { peer, endpoint } = fixture(true)
  const rejected = expect(endpoint.call("read", { path: "/file", offset: 0, length: 1 })).rejects.toThrow("send buffer stalled")
  await vi.advanceTimersByTimeAsync(5_010)
  await rejected
  expect(peer.close).toHaveBeenCalledOnce()
  await endpoint.close()
})
