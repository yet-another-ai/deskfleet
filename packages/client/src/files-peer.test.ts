import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi } from "./central.ts"
import { createBrowserFileEndpoint } from "./files-peer.ts"
import { FILE_CHUNK_BYTES } from "../../../apps/daemon/src/files-protocol.ts"
import { encodeFileFrame, FileFrameDecoder, FILE_WIRE_CHUNK_BYTES } from "../../../apps/daemon/src/files-wire.ts"

const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n"
afterEach(() => vi.unstubAllGlobals())

function fixture(maxMessageSize: number, stallAfter?: number) {
  const decoder = new FileFrameDecoder(), packets: Uint8Array[] = [], received: Uint8Array[] = []
  class Channel extends EventTarget {
    readyState = "connecting"
    binaryType = ""
    bufferedAmount = 0
    bufferedAmountLowThreshold = 0
    onopen?: () => void
    onclose?: () => void
    onerror?: () => void
    onmessage?: (event: { data: ArrayBuffer }) => void
    send(bytes: Uint8Array) {
      packets.push(bytes)
      if (packets.length === stallAfter) this.bufferedAmount = 1024 * 1024
      for (const frame of decoder.push(bytes)) {
        received.push(frame.data)
        const reply = encodeFileFrame({ id: frame.header.id, value: { bytes: frame.data.length } })
        queueMicrotask(() => this.onmessage?.({ data: reply.buffer as ArrayBuffer }))
      }
    }
    close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); this.onclose?.() }
  }
  const channel = new Channel()
  const listeners = vi.spyOn(channel, "addEventListener")
  const peer = {
    sctp: { maxMessageSize },
    createDataChannel: () => channel,
    createOffer: async () => ({ sdp }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => { channel.readyState = "open"; channel.onopen?.() },
    addIceCandidate: async () => {},
    close: vi.fn(),
  }
  vi.stubGlobal("RTCPeerConnection", class { constructor() { return peer } })
  const central = {
    createPeer: vi.fn(async () => ({ peerId: "files", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] })),
    onEvent: () => () => {}, offerPeer: async () => ({ sdp }), closePeer: vi.fn(async () => {}),
  } as unknown as CentralApi
  return { channel, listeners, packets, received, peer, central, endpoint: createBrowserFileEndpoint(central, { kind: "machine", machineId: "1", teamId: "1" }) }
}

test.each([2048, 0, 65536])("browser file frames respect negotiated maxMessageSize %i and preserve a maximum-sized operation", async negotiated => {
  const { endpoint, packets, received } = fixture(negotiated)
  const bytes = new Uint8Array(FILE_CHUNK_BYTES).map((_, index) => index % 251)
  try {
    expect((await endpoint.call("write", { transferId: "upload", path: "", offset: 0 }, bytes)).value.bytes).toBe(bytes.length)
    const limit = negotiated ? Math.min(FILE_WIRE_CHUNK_BYTES, negotiated) : FILE_WIRE_CHUNK_BYTES
    expect(packets.every(packet => packet.length <= limit)).toBe(true)
    if (!negotiated || negotiated >= FILE_WIRE_CHUNK_BYTES) expect(packets).toHaveLength(2)
    expect(Math.max(...packets.map(packet => packet.length))).toBe(Math.min(limit, encodeFileFrame({ id: 1, method: "write", params: { transferId: "upload", path: "", offset: 0 } }, bytes).length))
    expect(received).toHaveLength(1)
    expect(Buffer.from(received[0]!).equals(Buffer.from(bytes))).toBe(true)
  } finally { await endpoint.close() }
})

test("closing a browser peer interrupts a partially sent frame while waiting for send capacity", async () => {
  const { endpoint, channel, packets, listeners, central, peer } = fixture(2048, 1)
  const request = endpoint.call("write", { transferId: "upload", path: "", offset: 0 }, new Uint8Array(FILE_CHUNK_BYTES))
  const rejected = expect(request).rejects.toThrow("closed")
  await vi.waitFor(() => expect(listeners).toHaveBeenCalledWith("bufferedamountlow", expect.any(Function), { once: true }))
  await endpoint.close(); await rejected
  expect(packets).toHaveLength(1)
  expect(channel.readyState).toBe("closed")
  expect(peer.close).toHaveBeenCalledOnce()
  expect(central.createPeer).toHaveBeenCalledOnce()
})
