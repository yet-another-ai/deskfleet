import { flushPromises } from "@vue/test-utils"
import { effectScope } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { browserCodecs, deferred, mockDesktopApi, stubWebRtc, TestPeer } from "../test/desktop-media.ts"
import { browserCodecPreferences, commonDesktopCodecs, useDesktopConnection } from "./useDesktopConnection.ts"

const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const mock = mockDesktopApi()
  const scope = effectScope()
  scopes.push(scope)
  const connection = scope.run(() => useDesktopConnection(mock.api))!
  return { ...mock, scope, connection }
}
const options = { codecs: ["h264", "h265", "av1"], displayId: 2, audio: false } as const
beforeEach(stubWebRtc)
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test("matches native profiles and prefers H264 when available", () => {
  expect(commonDesktopCodecs(["av1", "h265", "h264"], browserCodecs)).toEqual(["h264", "h265", "av1"])
  expect(browserCodecPreferences("h264", browserCodecs)).toEqual([browserCodecs[0]])
  expect(commonDesktopCodecs(["h265", "av1"], [
    { mimeType: "video/H265", clockRate: 90000, sdpFmtpLine: "profile-id=2" },
    { mimeType: "video/AV1", clockRate: 90000, sdpFmtpLine: "profile=1" },
  ])).toEqual([])
})

test("negotiates receive-only media and starts capture only after the answer and connection", async () => {
  const { connection, api } = setup()
  await connection.connect(options)
  const peer = TestPeer.instances[0]!
  expect(peer.addTransceiver).toHaveBeenCalledExactlyOnceWith("video", { direction: "recvonly" })
  expect(peer.codecPreferences).toHaveBeenCalledWith([browserCodecs[0]])
  expect(api.offer).toHaveBeenCalledWith({ sessionId: expect.any(String), sdp: "browser-offer", codec: "h264", audio: false })
  expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "native-answer" })
  expect(api.start).not.toHaveBeenCalled()
  peer.changeState("connected")
  await flushPromises()
  expect(api.start).toHaveBeenCalledExactlyOnceWith({ sessionId: api.offer.mock.calls[0]![0].sessionId, displayId: 2 })
  expect(connection.state.value).toBe("connected")
  peer.changeState("connected")
  expect(api.start).toHaveBeenCalledTimes(1)
})

test("queues early trickle candidates in both directions and translates m-line spelling", async () => {
  const { connection, api, emit } = setup()
  const answer = deferred<{ sdp: string }>()
  api.offer.mockReturnValue(answer.promise)
  const connecting = connection.connect(options)
  await flushPromises()
  const peer = TestPeer.instances[0]!
  const sessionId = api.offer.mock.calls[0]![0].sessionId
  peer.emitCandidate({ candidate: "browser-ice", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "browser" })
  emit({ sessionId, kind: "iceCandidate", candidate: { candidate: "native-ice", sdpMlineIndex: 0 } })
  emit({ sessionId: "other-session", kind: "error", error: "ignore" })
  expect(api.candidate).not.toHaveBeenCalled()
  expect(peer.addIceCandidate).not.toHaveBeenCalled()
  answer.resolve({ sdp: "answer" })
  await connecting
  await flushPromises()
  expect(api.candidate).toHaveBeenCalledWith(sessionId, {
    candidate: "browser-ice", sdpMid: "0", sdpMlineIndex: 0, usernameFragment: "browser",
  })
  expect(peer.addIceCandidate).toHaveBeenCalledWith({ candidate: "native-ice", sdpMLineIndex: 0 })
  expect(peer.setRemoteDescription.mock.invocationCallOrder[0]).toBeLessThan(peer.addIceCandidate.mock.invocationCallOrder[0]!)
})

test("collects audio/video tracks in one stream and releases all resources on scope disposal", async () => {
  const { connection, api, listeners, scope } = setup()
  await connection.connect({ ...options, audio: true })
  const peer = TestPeer.instances[0]!
  const media = connection.stream.value
  const video = { stop: vi.fn() } as unknown as MediaStreamTrack
  const audio = { stop: vi.fn() } as unknown as MediaStreamTrack
  peer.ontrack?.({ track: video })
  peer.ontrack?.({ track: audio })
  expect(peer.addTransceiver).toHaveBeenCalledWith("audio", { direction: "recvonly" })
  expect(connection.stream.value).toBe(media)
  expect(media?.getTracks()).toEqual([video, audio])
  scope.stop()
  await flushPromises()
  expect(peer.close).toHaveBeenCalledTimes(1)
  expect(video.stop).toHaveBeenCalledTimes(1)
  expect(audio.stop).toHaveBeenCalledTimes(1)
  expect(listeners.size).toBe(0)
  expect(connection.stream.value).toBeNull()
  expect(api.close).toHaveBeenCalledWith(api.offer.mock.calls[0]![0].sessionId)
})

test("disconnect during an offer closes the eventual native session without starting capture", async () => {
  const { connection, api } = setup()
  const answer = deferred<{ sdp: string }>()
  api.offer.mockReturnValue(answer.promise)
  const connecting = connection.connect(options)
  await flushPromises()
  const sessionId = api.offer.mock.calls[0]![0].sessionId
  await connection.disconnect()
  expect(api.close).toHaveBeenCalledWith(sessionId)
  answer.resolve({ sdp: "late-answer" })
  await connecting
  expect(api.close).toHaveBeenCalledTimes(2)
  expect(api.start).not.toHaveBeenCalled()
  expect(TestPeer.instances[0]!.setRemoteDescription).not.toHaveBeenCalled()
  expect(connection.state.value).toBe("idle")
})

test("disconnect during capture startup closes again after startup completes", async () => {
  const { connection, api } = setup()
  const started = deferred<void>()
  api.start.mockReturnValue(started.promise)
  await connection.connect(options)
  TestPeer.instances[0]!.changeState("connected")
  expect(connection.state.value).toBe("starting")
  await connection.disconnect()
  started.resolve()
  await flushPromises()
  expect(api.close).toHaveBeenCalledTimes(2)
  expect(connection.state.value).toBe("idle")
})

test("duplicate connect is ignored and late failures cannot tear down a replacement session", async () => {
  const { connection, api } = setup()
  const firstAnswer = deferred<{ sdp: string }>()
  api.offer.mockReturnValueOnce(firstAnswer.promise)
  const first = connection.connect(options)
  await flushPromises()
  await connection.connect(options)
  expect(TestPeer.instances).toHaveLength(1)
  await connection.disconnect()
  await connection.connect(options)
  TestPeer.instances[1]!.changeState("connected")
  await flushPromises()
  firstAnswer.reject(new Error("old offer failed"))
  await first
  expect(connection.state.value).toBe("connected")
  expect(TestPeer.instances[1]!.close).not.toHaveBeenCalled()
})

test("native errors and browser connection failures close the peer and surface errors", async () => {
  const { connection, api, emit, listeners } = setup()
  await connection.connect(options)
  emit({ sessionId: api.offer.mock.calls[0]![0].sessionId, kind: "error", error: "Screen recording permission denied" })
  await flushPromises()
  expect(connection.failure.value).toEqual({ kind: "operation", detail: "Screen recording permission denied" })
  expect(connection.state.value).toBe("error")
  expect(listeners.size).toBe(0)
  expect(api.offer).toHaveBeenCalledTimes(1)
  await connection.connect(options)
  TestPeer.instances[1]!.changeState("failed")
  expect(connection.failure.value).toEqual({ kind: "connection" })
  expect(TestPeer.instances[1]!.close).toHaveBeenCalled()
  expect(api.offer).toHaveBeenCalledTimes(2)
})

test("an encoder failure opens a new peer for the next codec at startup and mid-session", async () => {
  const { connection, api, emit } = setup()
  let starts = 0
  api.start.mockImplementation(async () => {
    starts += 1
    if (starts === 1) {
      const sessionId = api.offer.mock.calls.at(-1)![0].sessionId
      emit({ sessionId, kind: "error", error: "NVENC session open failed", reason: "encoder" })
      throw Object.assign(new Error("NVENC session open failed"), { reason: "encoder" })
    }
  })
  const connecting = connection.connect(options)
  await flushPromises()
  TestPeer.instances[0]!.changeState("connected")
  await flushPromises()
  TestPeer.instances[1]!.changeState("connected")
  await connecting
  await flushPromises()
  expect(api.offer.mock.calls.map(call => call[0].codec)).toEqual(["h264", "h265"])
  expect(connection.codec.value).toBe("h265")
  expect(connection.state.value).toBe("connected")

  const sessionId = api.offer.mock.calls[1]![0].sessionId
  emit({ sessionId, kind: "error", error: "encoder reset", reason: "encoder" })
  await flushPromises()
  TestPeer.instances[2]!.changeState("connected")
  await flushPromises()
  expect(api.offer.mock.calls.map(call => call[0].codec)).toEqual(["h264", "h265", "av1"])
  expect(connection.codec.value).toBe("av1")
  expect(connection.state.value).toBe("connected")
})

test("encoder fallback stops at the end of the common list and ignores unclassified failures", async () => {
  const { connection, api, emit } = setup()
  api.start.mockImplementation(async () => {
    const sessionId = api.offer.mock.calls.at(-1)![0].sessionId
    emit({ sessionId, kind: "error", error: "encoder produced no packet", reason: "encoder" })
    throw Object.assign(new Error("encoder produced no packet"), { reason: "encoder" })
  })
  const connecting = connection.connect(options)
  await flushPromises()
  for (const peer of [0, 1, 2]) {
    TestPeer.instances[peer]!.changeState("connected")
    await flushPromises()
  }
  await connecting
  await flushPromises()
  expect(api.offer.mock.calls.map(call => call[0].codec)).toEqual(["h264", "h265", "av1"])
  expect(connection.state.value).toBe("error")
  expect(connection.failure.value).toEqual({ kind: "operation", detail: "encoder produced no packet" })
  expect(connection.codec.value).toBeNull()

  api.start.mockReset()
  api.start.mockResolvedValue(undefined)
  await connection.connect({ codecs: ["h264", "h265"], displayId: 2, audio: false })
  TestPeer.instances[3]!.changeState("connected")
  await flushPromises()
  emit({ sessionId: api.offer.mock.calls.at(-1)![0].sessionId, kind: "error", error: "media transport failed" })
  await flushPromises()
  expect(api.offer.mock.calls.map(call => call[0].codec)).toEqual(["h264", "h265", "av1", "h264"])
  expect(connection.failure.value).toEqual({ kind: "operation", detail: "media transport failed" })
})

test("times out stalled connection attempts and closes both ends", async () => {
  vi.useFakeTimers()
  const { connection, api } = setup()
  await connection.connect(options)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(connection.failure.value).toEqual({ kind: "timeout" })
  expect(connection.state.value).toBe("error")
  expect(TestPeer.instances[0]!.close).toHaveBeenCalled()
  expect(api.close).toHaveBeenCalledTimes(1)
})

test("view-only sessions never create an input channel; control waits for native readiness", async () => {
  const { connection, api } = setup()
  await connection.connect(options)
  expect(TestPeer.instances[0]!.createDataChannel).not.toHaveBeenCalled()
  expect(connection.sendInput({ type: "pointerMove", x: 0.5, y: 0.5 })).toBe(false)
  await connection.disconnect()
  const starting = deferred<void>()
  api.start.mockReturnValue(starting.promise)
  await connection.connect({ ...options, control: true })
  const peer = TestPeer.instances[1]!
  expect(peer.createDataChannel).toHaveBeenCalledExactlyOnceWith("deskfleet-input", { ordered: true })
  peer.changeState("connected")
  peer.input.ready()
  expect(connection.inputReady.value).toBe(false)
  starting.resolve()
  await flushPromises()
  expect(api.start).toHaveBeenLastCalledWith(expect.objectContaining({ control: true }))
  expect(connection.inputReady.value).toBe(true)
  expect(connection.sendInput({ type: "key", code: "KeyA", pressed: true, repeat: false })).toBe(true)
  expect(peer.input.send).toHaveBeenCalledWith(JSON.stringify({ type: "key", code: "KeyA", pressed: true, repeat: false }))
  await connection.disconnect()
  expect(peer.input.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "releaseAll" }))
  expect(peer.input.close).toHaveBeenCalledExactlyOnceWith()
  expect(connection.inputReady.value).toBe(false)
})

test("input errors and send backpressure close the peer so held input cannot remain active", async () => {
  const { connection } = setup()
  await connection.connect({ ...options, control: true })
  let peer = TestPeer.instances.at(-1)!
  peer.changeState("connected")
  await flushPromises()
  peer.input.ready()
  peer.input.bufferedAmount = 65_537
  expect(connection.sendInput({ type: "key", code: "ShiftLeft", pressed: false, repeat: false })).toBe(false)
  expect(peer.close).toHaveBeenCalled()
  expect(connection.failure.value?.detail).toContain("could not keep up")
  await connection.connect({ ...options, control: true })
  peer = TestPeer.instances.at(-1)!
  peer.input.onmessage?.({ data: JSON.stringify({ type: "error", error: "Accessibility permission is required" }) })
  expect(peer.close).toHaveBeenCalled()
  expect(connection.failure.value?.detail).toBe("Accessibility permission is required")
})

test("control startup times out when the native side never acknowledges input readiness", async () => {
  vi.useFakeTimers()
  const { connection } = setup()
  await connection.connect({ ...options, control: true })
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  await flushPromises()
  expect(connection.inputReady.value).toBe(false)
  await vi.advanceTimersByTimeAsync(20_000)
  expect(connection.failure.value).toEqual({ kind: "timeout" })
  expect(peer.close).toHaveBeenCalled()
})

test("encoder fallback releases control and waits for the old native peer to close", async () => {
  const { connection, api, emit } = setup()
  await connection.connect({ ...options, control: true })
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.ready()
  await flushPromises()
  const closed = deferred<void>()
  api.close.mockReturnValueOnce(closed.promise)
  emit({ sessionId: api.offer.mock.calls[0]![0].sessionId, kind: "error", error: "encoder reset", reason: "encoder" })
  await flushPromises()
  expect(peer.input.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "releaseAll" }))
  expect(connection.inputReady.value).toBe(false)
  expect(api.offer).toHaveBeenCalledTimes(1)
  closed.resolve()
  await flushPromises()
  expect(api.offer.mock.calls.map(call => call[0].codec)).toEqual(["h264", "h265"])
  expect(TestPeer.instances[1]!.createDataChannel).toHaveBeenCalledWith("deskfleet-input", { ordered: true })
})

test("disconnect cancels codec fallback while waiting for native input ownership to release", async () => {
  const { connection, api, emit } = setup()
  await connection.connect({ ...options, control: true })
  const closed = deferred<void>()
  api.close.mockReturnValueOnce(closed.promise)
  emit({ sessionId: api.offer.mock.calls[0]![0].sessionId, kind: "error", error: "encoder failed", reason: "encoder" })
  await connection.disconnect()
  closed.resolve()
  await flushPromises()
  expect(api.offer).toHaveBeenCalledTimes(1)
  expect(connection.state.value).toBe("idle")
})

test("a fast manual reconnect waits for the failed peer's pending close", async () => {
  const { connection, api, emit } = setup()
  await connection.connect({ ...options, control: true })
  const closed = deferred<void>()
  api.close.mockReturnValueOnce(closed.promise)
  emit({ sessionId: api.offer.mock.calls[0]![0].sessionId, kind: "error", error: "connection lost" })
  const reconnecting = connection.connect({ ...options, control: true })
  await flushPromises()
  expect(api.offer).toHaveBeenCalledTimes(1)
  closed.resolve()
  await reconnecting
  expect(api.offer).toHaveBeenCalledTimes(2)
  expect(connection.state.value).toBe("connecting")
})

test("reconnect also waits for a late abandoned offer's close added during the barrier", async () => {
  const { connection, api } = setup()
  const answer = deferred<{ sdp: string }>()
  const firstClose = deferred<void>()
  const lateClose = deferred<void>()
  api.offer.mockReturnValueOnce(answer.promise)
  api.close.mockReturnValueOnce(firstClose.promise).mockReturnValueOnce(lateClose.promise)
  const first = connection.connect({ ...options, control: true })
  await flushPromises()
  const disconnecting = connection.disconnect()
  const reconnecting = connection.connect({ ...options, control: true })
  answer.resolve({ sdp: "abandoned answer" })
  await flushPromises()
  expect(api.close).toHaveBeenCalledTimes(2)
  firstClose.resolve()
  await flushPromises()
  expect(api.offer).toHaveBeenCalledTimes(1)
  lateClose.resolve()
  await Promise.all([first, disconnecting, reconnecting])
  expect(api.offer).toHaveBeenCalledTimes(2)
})
