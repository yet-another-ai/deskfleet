import { flushPromises } from "@vue/test-utils"
import { effectScope } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { deferred, mockDesktopApi, stubWebRtc, TestPeer } from "../test/desktop-media.ts"
import { useDesktopConnection } from "./useDesktopConnection.ts"

const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const mock = mockDesktopApi()
  const scope = effectScope()
  scopes.push(scope)
  const connection = scope.run(() => useDesktopConnection(mock.api))!
  return { ...mock, scope, connection }
}
const options = { codecs: ["av1", "h265", "h264"], displayId: 2, audio: true, audioAvailable: true, control: true, liveSettings: true } as const
beforeEach(stubWebRtc)
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function configurations(peer: TestPeer): { type: "configure"; requestId: number; audio: boolean; control: boolean }[] {
  return peer.input.send.mock.calls.map(([message]) => JSON.parse(message)).filter(message => message.type === "configure")
}

test("live audio and control toggles retain the peer, stream, codec, and capture", async () => {
  const { connection, api } = setup()
  await connection.connect(options)
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.ready()
  await flushPromises()
  const stream = connection.stream.value
  expect(configurations(peer)).toEqual([])
  expect(connection.inputReady.value).toBe(true)

  await connection.reconfigure({ ...options, audio: false, control: false })
  expect(connection.state.value).toBe("connected")
  expect(connection.stream.value).toBe(stream)
  expect(connection.inputReady.value).toBe(false)
  expect(connection.sendInput({ type: "key", code: "KeyA", pressed: true, repeat: false })).toBe(false)
  expect(peer.input.send).toHaveBeenCalledWith(JSON.stringify({ type: "releaseAll" }))
  expect(configurations(peer)).toEqual([{ type: "configure", requestId: 1, audio: false, control: false }])
  peer.input.configured(1, false)

  await connection.reconfigure(options)
  expect(connection.inputReady.value).toBe(false)
  peer.input.ready() // Enabling control waits for this request's acknowledgement.
  expect(connection.inputReady.value).toBe(false)
  peer.input.configured(2, true)
  expect(connection.inputReady.value).toBe(true)
  expect(configurations(peer)).toHaveLength(2)
  expect(connection.codec.value).toBe("av1")
  expect(TestPeer.instances).toHaveLength(1)
  expect(api.offer).toHaveBeenCalledTimes(1)
  expect(api.start).toHaveBeenCalledTimes(1)
  expect(api.close).not.toHaveBeenCalled()
  expect(peer.close).not.toHaveBeenCalled()
})

test("a muted view-only start negotiates audio and input for later use", async () => {
  const { connection, api } = setup()
  await connection.connect({ ...options, audio: false, control: false })
  const peer = TestPeer.instances[0]!
  expect(api.offer).toHaveBeenCalledWith(expect.objectContaining({ audio: true }))
  expect(peer.addTransceiver).toHaveBeenCalledWith("audio", { direction: "recvonly" })
  expect(peer.createDataChannel).toHaveBeenCalledWith("deskfleet-input", { ordered: true })
  peer.changeState("connected")
  await flushPromises()
  expect(api.start).toHaveBeenCalledWith({ sessionId: expect.any(String), displayId: 2 })
  expect(configurations(peer)).toEqual([])
  peer.input.open()
  expect(configurations(peer)).toEqual([{ type: "configure", requestId: 1, audio: false, control: false }])
  peer.input.configured(1, false)
  await connection.reconfigure(options)
  peer.input.configured(2, true)
  expect(connection.inputReady.value).toBe(true)
  expect(api.offer).toHaveBeenCalledTimes(1)
  expect(api.start).toHaveBeenCalledTimes(1)
})

test("changes during startup coalesce into the latest live settings", async () => {
  const { connection, api } = setup()
  const started = deferred<void>()
  api.start.mockReturnValueOnce(started.promise)
  await connection.connect(options)
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.ready()
  await connection.reconfigure({ ...options, audio: false })
  await connection.reconfigure({ ...options, control: false })
  expect(configurations(peer)).toEqual([])
  started.resolve()
  await flushPromises()
  expect(configurations(peer)).toEqual([{ type: "configure", requestId: 1, audio: true, control: false }])
  expect(connection.inputReady.value).toBe(false)
  expect(api.offer).toHaveBeenCalledTimes(1)
  expect(api.start).toHaveBeenCalledTimes(1)
})

test("startup readiness survives toggling control off and back on while capture starts", async () => {
  vi.useFakeTimers()
  const { connection, api } = setup()
  const started = deferred<void>()
  api.start.mockReturnValueOnce(started.promise)
  await connection.connect(options)
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  await connection.reconfigure({ ...options, control: false })
  peer.input.ready()
  expect(connection.inputReady.value).toBe(false)
  await connection.reconfigure(options)
  expect(connection.inputReady.value).toBe(false)
  started.resolve()
  await flushPromises()
  expect(connection.inputReady.value).toBe(true)
  expect(configurations(peer)).toEqual([])
  await vi.advanceTimersByTimeAsync(10_000)
  expect(connection.state.value).toBe("connected")
  expect(connection.failure.value).toBeNull()
  expect(api.close).not.toHaveBeenCalled()
})

test("changes while an acknowledgement is pending send only the newest settings next", async () => {
  const { connection } = setup()
  await connection.connect(options)
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.ready()
  await flushPromises()
  await connection.reconfigure({ ...options, audio: false })
  await connection.reconfigure({ ...options, audio: false, control: false })
  await connection.reconfigure({ ...options, control: false })
  expect(configurations(peer)).toHaveLength(1)
  peer.input.configured(1, true)
  expect(connection.inputReady.value).toBe(false)
  expect(configurations(peer)).toEqual([
    { type: "configure", requestId: 1, audio: false, control: true },
    { type: "configure", requestId: 2, audio: true, control: false },
  ])
  peer.input.configured(1, true) // Ignore stale acknowledgements.
  expect(configurations(peer)).toHaveLength(2)
  peer.input.configured(2, false)
  expect(connection.inputReady.value).toBe(false)
})

test("a denied live control change preserves video and can retry identical settings", async () => {
  const { connection, api } = setup()
  await connection.connect({ ...options, control: false })
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.open()
  await flushPromises()
  const stream = connection.stream.value
  await connection.reconfigure(options)
  peer.input.configurationError(1, false, "Accessibility permission is required", "accessibility")
  expect(connection.settingsFailure.value).toEqual({ kind: "operation", detail: "Accessibility permission is required", reason: "accessibility" })
  expect(connection.failure.value).toBeNull()
  expect(connection.state.value).toBe("connected")
  expect(connection.stream.value).toBe(stream)
  expect(connection.inputReady.value).toBe(false)
  await connection.reconfigure(options)
  expect(configurations(peer)).toHaveLength(2)
  peer.input.configured(2, true)
  expect(connection.settingsFailure.value).toBeNull()
  expect(connection.inputReady.value).toBe(true)
  expect(api.close).not.toHaveBeenCalled()
})

test("settings errors still apply a newer request without retrying the failed one", async () => {
  const { connection } = setup()
  await connection.connect({ ...options, control: false })
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.open()
  await flushPromises()
  await connection.reconfigure(options)
  await connection.reconfigure({ ...options, audio: false, control: false })
  peer.input.configurationError(1, false, "Control is occupied")
  expect(configurations(peer)).toEqual([
    { type: "configure", requestId: 1, audio: true, control: true },
    { type: "configure", requestId: 2, audio: false, control: false },
  ])
  peer.input.configured(2, false)
  expect(connection.settingsFailure.value).toBeNull()
})

test("a settings timeout retains video, allows retry, and ignores its late acknowledgement", async () => {
  vi.useFakeTimers()
  const { connection, api } = setup()
  await connection.connect(options)
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.ready()
  await flushPromises()
  await connection.reconfigure({ ...options, audio: false })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(connection.settingsFailure.value).toEqual({ kind: "timeout" })
  expect(connection.state.value).toBe("connected")
  await connection.reconfigure({ ...options, audio: false })
  peer.input.configured(1, true)
  expect(configurations(peer)).toHaveLength(2)
  peer.input.configured(2, true)
  expect(connection.settingsFailure.value).toBeNull()
  expect(api.close).not.toHaveBeenCalled()
})

test("live changes made during authorization are used by the first peer", async () => {
  const { connection, api } = setup()
  const preparing = deferred<RTCIceServer[]>()
  Object.assign(api, { prepare: vi.fn().mockReturnValue(preparing.promise) })
  const connecting = connection.connect(options)
  await flushPromises()
  await connection.reconfigure({ ...options, control: false })
  preparing.resolve([])
  await connecting
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.open()
  await flushPromises()
  expect(api.start).toHaveBeenCalledWith({ sessionId: expect.any(String), displayId: 2 })
  expect(configurations(peer)).toEqual([])
  expect(api.offer).toHaveBeenCalledTimes(1)
  await connection.disconnect()
  expect(peer.input.send).not.toHaveBeenCalled()
})

test("live changes during encoder fallback carry over without restarting the codec chain", async () => {
  const { connection, api, emit } = setup()
  await connection.connect(options)
  const first = TestPeer.instances[0]!
  first.changeState("connected")
  first.input.ready()
  await flushPromises()
  const closed = deferred<void>()
  api.close.mockReturnValueOnce(closed.promise)
  emit({ sessionId: api.offer.mock.calls[0]![0].sessionId, kind: "error", error: "Encoder failed", reason: "encoder" })
  await connection.reconfigure({ ...options, audio: false, control: false })
  closed.resolve()
  await flushPromises()
  const replacement = TestPeer.instances[1]!
  replacement.changeState("connected")
  replacement.input.open()
  await flushPromises()
  expect(api.offer.mock.calls.map(([offer]) => offer.codec)).toEqual(["av1", "h265"])
  expect(api.start).toHaveBeenLastCalledWith({ sessionId: expect.any(String), displayId: 2 })
  expect(configurations(replacement)).toEqual([{ type: "configure", requestId: 1, audio: false, control: false }])
})

test("display changes still replace the peer and ignore the old settings reply", async () => {
  const { connection, api } = setup()
  await connection.connect(options)
  const peer = TestPeer.instances[0]!
  peer.changeState("connected")
  peer.input.ready()
  await flushPromises()
  await connection.reconfigure({ ...options, audio: false })
  const oldReply = peer.input.onmessage
  await connection.reconfigure({ ...options, displayId: 1 })
  oldReply?.({ data: JSON.stringify({ type: "configured", requestId: 1, control: false }) })
  expect(TestPeer.instances).toHaveLength(2)
  expect(api.offer).toHaveBeenCalledTimes(2)
  expect(api.close).toHaveBeenCalledTimes(1)
  expect(connection.state.value).toBe("connecting")
  expect(connection.inputReady.value).toBe(false)
})
