import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent } from "./central.ts"
import { connectFilePeer, type FilePeerEvents } from "./files-signaling.ts"
import { setPeerTelemetrySink } from "./peer-telemetry.ts"

afterEach(() => { setPeerTelemetrySink(undefined); vi.useRealTimers() })
const sdp = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n"

test("file peers retain transport through signaling loss and close on revocation", async () => {
  const telemetry = vi.fn()
  setPeerTelemetrySink(telemetry)
  let listener!: (event: CentralEvent) => void
  let events!: FilePeerEvents
  const send = vi.fn(async () => {}), close = vi.fn(async () => {}), failed = vi.fn()
  const central = {
    createPeer: vi.fn(async () => ({ peerId: "file-peer", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] })),
    onEvent: (fn: typeof listener) => { listener = fn; return () => {} },
    offerPeer: vi.fn(async () => ({ sdp })), candidatePeer: vi.fn(async () => {}), closePeer: vi.fn(async () => {}),
  } as unknown as CentralApi
  const endpoint = await connectFilePeer(central, { kind: "machine", machineId: "3", teamId: "1" }, async (_servers, callbacks) => {
    events = callbacks
    return {
      offer: async () => { callbacks.candidate({ candidate: "candidate", sdpMid: "", sdpMlineIndex: 0 }); return sdp },
      answer: async () => callbacks.open(), candidate: async () => {}, send, close,
    }
  }, () => {}, failed)
  expect(central.createPeer).toHaveBeenCalledWith("1", "3", "files")
  expect(central.candidatePeer).toHaveBeenCalledWith("file-peer", expect.objectContaining({ sdpMid: "0" }))
  listener({ type: "connection", connected: false })
  await endpoint.send(new Uint8Array([1]))
  expect(send).toHaveBeenCalledOnce()
  expect(failed).not.toHaveBeenCalled()
  listener({ type: "peerRevoked", peerId: "file-peer", reason: "Access removed" })
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Access removed" }))
  await expect(endpoint.send(new Uint8Array([2]))).rejects.toThrow("closed")
  expect(close).toHaveBeenCalledOnce()
  events.data(new Uint8Array())
  expect(telemetry.mock.calls.map(([event]) => event)).toEqual([
    { name: "peer_granted", teamId: "1", metadata: { feature: "files", relay: "unconfigured" } },
    { name: "peer_connection", teamId: "1", metadata: { feature: "files", relay: "unconfigured", outcome: "connected", transport: "unknown" } },
  ])
})

test("expiry closes file access without depending on another command", async () => {
  vi.useFakeTimers()
  const close = vi.fn(async () => {}), failed = vi.fn()
  const central = {
    createPeer: async () => ({ peerId: "a", authorization: { expiresAt: new Date(Date.now() + 1000).toISOString() }, iceServers: [] }),
    onEvent: () => () => {}, offerPeer: async () => ({ sdp }), closePeer: async () => {},
  } as unknown as CentralApi
  await connectFilePeer(central, { kind: "machine", machineId: "3", teamId: "1" }, async (_servers, events) => ({
    offer: async () => sdp, answer: async () => events.open(), candidate: async () => {}, send: async () => {}, close,
  }), () => {}, failed)
  await vi.advanceTimersByTimeAsync(1000)
  expect(close).toHaveBeenCalledOnce()
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("expired") }))
})

test("the setup deadline rejects a stalled offer without waiting for signaling to respond", async () => {
  vi.useFakeTimers()
  const close = vi.fn(async () => {}), failed = vi.fn()
  const central = {
    createPeer: async () => ({ peerId: "a", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] }),
    onEvent: () => () => {}, offerPeer: () => new Promise(() => {}), closePeer: async () => {},
  } as unknown as CentralApi
  const connecting = connectFilePeer(central, { kind: "machine", machineId: "3", teamId: "1" }, async () => ({
    offer: async () => sdp, answer: async () => {}, candidate: async () => {}, send: async () => {}, close,
  }), () => {}, failed)
  const rejected = expect(connecting).rejects.toThrow("timed out")
  await vi.advanceTimersByTimeAsync(20_000)
  await rejected
  expect(close).toHaveBeenCalledOnce()
})

test.each(["free_plan", "turn_quota_exhausted", "metering_unavailable"] as const)("explains relay denial after direct file failure: %s", async relayDeniedReason => {
  const telemetry = vi.fn()
  setPeerTelemetrySink(telemetry)
  const failed = vi.fn()
  const central = {
    createPeer: async () => ({ peerId: "a", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [], relayDeniedReason }),
    onEvent: () => () => {}, offerPeer: async () => ({ sdp }), closePeer: async () => {},
  } as unknown as CentralApi
  const connecting = connectFilePeer(central, { kind: "machine", machineId: "3", teamId: "1" }, async (_servers, events) => ({
    offer: async () => sdp, answer: async () => events.fail(new Error("ICE failed")), candidate: async () => {}, send: async () => {}, close: async () => {},
  }), () => {}, failed)
  await expect(connecting).rejects.toThrow("Direct connection failed.")
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("TURN relay") }))
  expect(telemetry).toHaveBeenLastCalledWith({ name: "peer_connection", teamId: "1", metadata: { feature: "files", relay: relayDeniedReason, outcome: "failed", transport: "unknown" } })
  expect(telemetry).toHaveBeenCalledTimes(2)
})
