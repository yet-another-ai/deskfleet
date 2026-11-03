import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent } from "@deskfleet/client/central"
import type { VideoCodec } from "@deskfleet/client/desktop-media"
import { PEER_DISCONNECT_GRACE_MS, PEER_SETUP_TIMEOUT_MS } from "@deskfleet/client/peer-lifecycle"
import { openNativeDesktopSession, type ViewerCommand, type ViewerEvent } from "./native-desktop-session.ts"

const closing: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); vi.useRealTimers() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture({ autoAnswerApplied = true, autoInputReady = true, autoVideoReady = true, control = true, viewerCodecs = ["h264"] as VideoCodec[] } = {}) {
  let receive!: (event: ViewerEvent) => void
  let emit!: (event: CentralEvent) => void
  const unsubscribe = vi.fn()
  const central = {
    onEvent: vi.fn((listener: typeof emit) => { emit = listener; return unsubscribe }),
    machines: vi.fn(async () => [{ id: "machine", name: "Workstation" }]),
    rpc: vi.fn(async () => ({ displays: [{ id: 7, width: 1920, height: 1080, codecs: ["h264", "h265", "av1"] }], audio: true })),
    createPeer: vi.fn(async () => ({ peerId: "peer", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [{ urls: "turn:example.test", username: "user", credential: "secret" }] })),
    offerPeer: vi.fn(async () => ({ sdp: "answer" })),
    candidatePeer: vi.fn(async () => {}), startPeer: vi.fn(async () => {}), closePeer: vi.fn(async () => {}),
  }
  const child = { send: vi.fn((command: ViewerCommand) => {
    if (command.type === "answer") queueMicrotask(() => {
      if (autoAnswerApplied) receive({ type: "answerApplied" })
      if (autoInputReady && control) receive({ type: "inputReady" })
      if (autoVideoReady) receive({ type: "videoReady" })
    })
  }), close: vi.fn(async () => {}) }
  const spawn = vi.fn((listener: typeof receive) => { receive = listener; queueMicrotask(() => listener({ type: "capabilities", codecs: viewerCodecs })); return child })
  const failed = vi.fn(), ended = vi.fn()
  const open = () => {
    const session = openNativeDesktopSession(central as unknown as CentralApi,
      { target: { teamId: "team", machineId: "machine" }, displayId: 7, control }, spawn, failed, ended)
    closing.push(session.close)
    return session
  }
  return { central, child, spawn, failed, ended, unsubscribe, open,
    receive: (event: ViewerEvent) => receive(event), emit: (event: CentralEvent) => emit(event) }
}

test("native signaling buffers early ICE and starts H264 capture only after answer and connection", async () => {
  const f = fixture()
  const answer = deferred<{ sdp: string }>()
  f.central.offerPeer.mockReturnValueOnce(answer.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith({
    type: "start", title: "Workstation", control: true, relayOnly: false,
    codec: "h264", width: 1920, height: 1080,
    iceServers: [{ urls: ["turn:example.test"], username: "user", credential: "secret" }],
  }))
  const local = { candidate: "local", sdpMid: "0" }, remote = { candidate: "remote", sdpMid: "0" }
  f.receive({ type: "candidate", candidate: local })
  f.emit({ type: "peerEvent", peerId: "peer", event: { kind: "iceCandidate", candidate: remote } as never })
  f.receive({ type: "offer", sdp: "offer" })
  f.receive({ type: "connected" })
  expect(f.central.startPeer).not.toHaveBeenCalled()
  expect(f.central.candidatePeer).not.toHaveBeenCalled()
  expect(f.child.send).not.toHaveBeenCalledWith({ type: "candidate", candidate: remote })
  expect(f.central.offerPeer).toHaveBeenCalledWith("peer", "offer", { codec: "h264", audio: false })
  answer.resolve({ sdp: "answer" })
  await session.ready
  expect(f.child.send.mock.calls.slice(1)).toEqual([[{ type: "answer", sdp: "answer" }], [{ type: "candidate", candidate: remote }]])
  expect(f.central.candidatePeer).toHaveBeenCalledWith("peer", local)
  expect(f.central.startPeer).toHaveBeenCalledWith("peer", { displayId: 7, control: true })
  f.receive({ type: "connected" })
  expect(f.central.startPeer).toHaveBeenCalledOnce()
  f.receive({ type: "closed" })
  await session.close()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
  expect(f.child.close).toHaveBeenCalledOnce()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
  expect(f.ended).toHaveBeenCalledOnce()
  expect(f.failed).not.toHaveBeenCalled()
})

test("shutdown during grant creation closes the late grant without spawning a window", async () => {
  const f = fixture()
  const grant = deferred<Awaited<ReturnType<typeof f.central.createPeer>>>()
  f.central.createPeer.mockReturnValueOnce(grant.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.central.createPeer).toHaveBeenCalled())
  await session.close()
  grant.resolve({ peerId: "late", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] })
  await vi.waitFor(() => expect(f.central.closePeer).toHaveBeenCalledWith("late"))
  expect(f.spawn).not.toHaveBeenCalled()
  await expect(session.ready).rejects.toThrow("closed")
})

test("candidate send failure after connection preserves the viewer and remaining trickle candidates", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const f = fixture()
  const sending = deferred<void>()
  f.central.candidatePeer.mockReturnValueOnce(sending.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled())
  const first = { candidate: "first", sdpMid: "0" }
  const second = { candidate: "second", sdpMid: "0" }
  const third = { candidate: "third", sdpMid: "0" }
  // Both candidates belong to one buffered batch; a failed send must not
  // discard its tail or poison the promise chain for later batches.
  f.receive({ type: "candidate", candidate: first })
  f.receive({ type: "candidate", candidate: second })
  f.receive({ type: "offer", sdp: "offer" })
  await vi.waitFor(() => expect(f.central.candidatePeer).toHaveBeenCalledWith("peer", first))
  f.receive({ type: "connected" })
  await session.ready
  sending.reject(new Error("Signaling unavailable"))
  await vi.waitFor(() => expect(f.central.candidatePeer).toHaveBeenCalledWith("peer", second))
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.child.close).not.toHaveBeenCalled()
  expect(f.central.closePeer).not.toHaveBeenCalled()
  f.receive({ type: "candidate", candidate: third })
  await vi.waitFor(() => expect(f.central.candidatePeer).toHaveBeenCalledWith("peer", third))
  // A signaling blip does not weaken the separate authorization lifecycle.
  f.emit({ type: "peerRevoked", peerId: "peer", reason: "Access revoked" } as CentralEvent)
  await session.close()
  expect(f.failed).toHaveBeenCalledExactlyOnceWith(new Error("Access revoked"))
  expect(f.child.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
  warning.mockRestore()
})

test("candidate send failure before connection rejects startup and closes the grant", async () => {
  const f = fixture()
  f.central.candidatePeer.mockRejectedValueOnce(new Error("Signaling unavailable"))
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled())
  f.receive({ type: "candidate", candidate: { candidate: "early", sdpMid: "0" } })
  f.receive({ type: "offer", sdp: "offer" })
  await expect(session.ready).rejects.toThrow("Signaling unavailable")
  await session.close()
  expect(f.failed).toHaveBeenCalledExactlyOnceWith(new Error("Signaling unavailable"))
  expect(f.central.startPeer).not.toHaveBeenCalled()
  expect(f.child.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
})

test.each(["account", "revoked", "expired", "error"])("%s closes the native viewer and remote capture", async cause => {
  vi.useFakeTimers()
  const f = fixture()
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled())
  f.receive({ type: "offer", sdp: "offer" })
  f.receive({ type: "connected" })
  await session.ready
  if (cause === "account") f.emit({ type: "accountChanged" })
  if (cause === "revoked") f.emit({ type: "peerRevoked", peerId: "peer", reason: "Access revoked" } as CentralEvent)
  if (cause === "expired") await vi.advanceTimersByTimeAsync(60_000)
  if (cause === "error") f.receive({ type: "error", error: "Decoder failed" })
  await session.close()
  expect(f.child.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
  if (cause === "account") expect(f.failed).not.toHaveBeenCalled()
  else expect(f.failed).toHaveBeenCalledOnce()
})

test("failed native process startup rejects opening and releases the authorization", async () => {
  const f = fixture()
  f.spawn.mockImplementationOnce(() => { throw new Error("Viewer executable missing") })
  const session = f.open()
  await expect(session.ready).rejects.toThrow("Viewer executable missing")
  expect(f.central.closePeer).toHaveBeenCalledWith("peer")
  expect(f.central.startPeer).not.toHaveBeenCalled()
})

test("revocation during negotiation fences a late answer and cannot start capture", async () => {
  const f = fixture()
  const answer = deferred<{ sdp: string }>()
  f.central.offerPeer.mockReturnValueOnce(answer.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled())
  f.receive({ type: "offer", sdp: "offer" })
  f.receive({ type: "connected" })
  f.emit({ type: "peerRevoked", peerId: "peer", reason: "Access revoked" } as CentralEvent)
  answer.resolve({ sdp: "late answer" })
  await expect(session.ready).rejects.toThrow("Access revoked")
  await session.close()
  expect(f.child.send).not.toHaveBeenCalledWith({ type: "answer", sdp: "late answer" })
  expect(f.central.startPeer).not.toHaveBeenCalled()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
  expect(f.child.close).toHaveBeenCalledOnce()
})

test("unsupported display codec fails before authorizing a native connection", async () => {
  const f = fixture()
  f.central.rpc.mockResolvedValueOnce({ displays: [{ id: 7, width: 1920, height: 1080, codecs: [] }], audio: false })
  const session = f.open()
  await expect(session.ready).rejects.toThrow("No common native desktop video codec")
  expect(f.central.createPeer).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
})

test("capture waits for the viewer to apply the answer; opening waits for input readiness", async () => {
  const f = fixture({ autoAnswerApplied: false, autoInputReady: false })
  const session = f.open()
  const ready = vi.fn()
  void session.ready.then(ready)
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled())
  f.receive({ type: "offer", sdp: "offer" })
  f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith({ type: "answer", sdp: "answer" }))
  expect(f.central.startPeer).not.toHaveBeenCalled()
  f.receive({ type: "answerApplied" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  expect(ready).not.toHaveBeenCalled()
  f.receive({ type: "inputReady" })
  await session.ready
  expect(f.failed).not.toHaveBeenCalled()
})

test("missing input readiness times out and releases the capture and grant", async () => {
  vi.useFakeTimers()
  const f = fixture({ autoInputReady: false })
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled())
  f.receive({ type: "offer", sdp: "offer" })
  f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalled())
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(session.ready).rejects.toThrow("input readiness timed out")
  expect(f.child.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
})

test("view-only startup does not wait for an input channel", async () => {
  const f = fixture({ control: false })
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled())
  f.receive({ type: "offer", sdp: "offer" })
  f.receive({ type: "connected" })
  await session.ready
  expect(f.central.startPeer).toHaveBeenCalledWith("peer", { displayId: 7 })
})

test.each(["local", "remote"])("%s disconnection recovers within grace but sustained loss closes the session", async side => {
  vi.useFakeTimers()
  const f = fixture()
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalled())
  f.receive({ type: "offer", sdp: "offer" })
  f.receive({ type: "connected" })
  await session.ready
  const state = (state: "disconnected" | "connected") => side === "local"
    ? f.receive({ type: state })
    : f.emit({ type: "peerEvent", peerId: "peer", event: { kind: "stateChanged", state } as never })
  state("disconnected")
  await vi.advanceTimersByTimeAsync(9_000)
  state("connected")
  await vi.advanceTimersByTimeAsync(2_000)
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.central.startPeer).toHaveBeenCalledOnce()
  state("disconnected")
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.failed).toHaveBeenCalledOnce()
  expect(f.child.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
})

test.each(["av1", "h265", "h264"] as const)("negotiates %s from actual native decoding capabilities", async codec => {
  const f = fixture({ viewerCodecs: [codec] })
  const session = f.open()
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith(expect.objectContaining({ type: "start", codec })))
  f.receive({ type: "offer", sdp: `${codec} offer` })
  f.receive({ type: "connected" })
  await session.ready
  expect(f.central.offerPeer).toHaveBeenCalledWith("peer", `${codec} offer`, { codec, audio: false })
})

test("decoder fallback waits for old peer cleanup and fences old events", async () => {
  const f = fixture({ viewerCodecs: ["h264", "h265", "av1"], autoVideoReady: false })
  const cleanup = deferred<void>()
  f.central.closePeer.mockReturnValueOnce(cleanup.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith(expect.objectContaining({ type: "start", codec: "av1" })))
  const oldReceive = f.spawn.mock.calls[0]![0]
  f.receive({ type: "offer", sdp: "av1 offer" })
  f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  f.receive({ type: "error", error: "AV1 decoder failed", reason: "decoder" })
  await vi.waitFor(() => expect(f.central.closePeer).toHaveBeenCalledOnce())
  expect(f.spawn).toHaveBeenCalledOnce()
  cleanup.resolve()
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith(expect.objectContaining({ type: "start", codec: "h265" })))
  oldReceive({ type: "error", error: "late old process failure" })
  f.receive({ type: "offer", sdp: "hevc offer" })
  f.receive({ type: "connected" })
  f.receive({ type: "videoReady" })
  await session.ready
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.ended).not.toHaveBeenCalled()
})

test("encoder startup failure retries the next codec; authorization failure never retries", async () => {
  const f = fixture({ viewerCodecs: ["av1", "h265", "h264"] })
  f.central.startPeer.mockRejectedValueOnce(Object.assign(new Error("encoder unavailable"), { reason: "encoder" }))
  const session = f.open()
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith(expect.objectContaining({ codec: "av1" })))
  f.receive({ type: "offer", sdp: "av1" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith(expect.objectContaining({ codec: "h265" })))
  f.central.startPeer.mockRejectedValueOnce(new Error("Access denied"))
  f.receive({ type: "offer", sdp: "h265" }); f.receive({ type: "connected" })
  await expect(session.ready).rejects.toThrow("Access denied")
  expect(f.spawn).toHaveBeenCalledTimes(2)
  expect(f.failed).toHaveBeenCalledOnce()
})

test("capture alone cannot mark an undecodable stream ready", async () => {
  const f = fixture({ autoVideoReady: false })
  const session = f.open()
  const ready = vi.fn()
  void session.ready.then(ready)
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith(expect.objectContaining({ type: "start" })))
  f.receive({ type: "offer", sdp: "offer" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  expect(ready).not.toHaveBeenCalled()
  f.receive({ type: "videoReady" })
  await session.ready
})

test.each(["closed", "failed", "native"])("%s before the start RPC rejects preserves encoder fallback", async source => {
  const f = fixture({ viewerCodecs: ["av1", "h265", "h264"] })
  const starting = deferred<void>()
  f.central.startPeer.mockReturnValueOnce(starting.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  f.receive({ type: "offer", sdp: "av1" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  if (source === "native") {
    f.receive({ type: "error", error: "desktop input channel closed" })
    f.receive({ type: "closed" })
  } else f.emit({ type: "peerEvent", peerId: "peer", event: { kind: "stateChanged", state: source } as never })
  expect(f.child.close).not.toHaveBeenCalled()
  expect(f.failed).not.toHaveBeenCalled()
  starting.reject(Object.assign(new Error("AV1 encoder unavailable"), { reason: "encoder" }))
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith(expect.objectContaining({ codec: "h265" })))
  f.receive({ type: "offer", sdp: "h265" }); f.receive({ type: "connected" })
  await session.ready
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
})

test.each(["success", "denied"])("a pending peer closure with RPC %s stays terminal", async outcome => {
  const f = fixture({ viewerCodecs: ["av1", "h265", "h264"] })
  const starting = deferred<void>()
  f.central.startPeer.mockReturnValueOnce(starting.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  f.receive({ type: "offer", sdp: "offer" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  f.emit({ type: "peerEvent", peerId: "peer", event: { kind: "stateChanged", state: "closed" } as never })
  if (outcome === "success") starting.resolve()
  else starting.reject(new Error("Access denied"))
  await expect(session.ready).rejects.toThrow(outcome === "success" ? "connection closed" : "Access denied")
  expect(f.spawn).toHaveBeenCalledOnce()
  expect(f.child.close).toHaveBeenCalledOnce()
})

test("revocation during capture startup does not wait for the start RPC", async () => {
  const f = fixture({ viewerCodecs: ["av1", "h265", "h264"] })
  const starting = deferred<void>()
  f.central.startPeer.mockReturnValueOnce(starting.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  f.receive({ type: "offer", sdp: "offer" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  f.emit({ type: "peerEvent", peerId: "peer", event: { kind: "stateChanged", state: "closed" } as never })
  f.emit({ type: "peerRevoked", peerId: "peer", reason: "Access revoked" } as CentralEvent)
  await expect(session.ready).rejects.toThrow("Access revoked")
  expect(f.child.close).toHaveBeenCalledOnce()
  starting.reject(Object.assign(new Error("late encoder failure"), { reason: "encoder" }))
  await Promise.resolve()
  expect(f.spawn).toHaveBeenCalledOnce()
})

test.each(["local", "remote"])("%s disconnect grace during capture startup preserves encoder fallback", async side => {
  vi.useFakeTimers()
  const f = fixture({ viewerCodecs: ["av1", "h265", "h264"] })
  const starting = deferred<void>()
  f.central.startPeer.mockReturnValueOnce(starting.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  f.receive({ type: "offer", sdp: "av1" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  if (side === "local") f.receive({ type: "disconnected" })
  else f.emit({ type: "peerEvent", peerId: "peer", event: { kind: "stateChanged", state: "disconnected" } as never })
  await vi.advanceTimersByTimeAsync(PEER_DISCONNECT_GRACE_MS)
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.child.close).not.toHaveBeenCalled()
  expect(f.spawn).toHaveBeenCalledOnce()
  starting.reject(Object.assign(new Error("AV1 encoder unavailable"), { reason: "encoder" }))
  await vi.waitFor(() => expect(f.child.send).toHaveBeenCalledWith(expect.objectContaining({ codec: "h265" })))
  f.receive({ type: "offer", sdp: "h265" }); f.receive({ type: "connected" })
  await session.ready
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
})

test.each(["local", "remote"])("%s expired grace stays terminal when capture startup succeeds", async side => {
  vi.useFakeTimers()
  const f = fixture({ viewerCodecs: ["av1", "h265", "h264"] })
  const starting = deferred<void>()
  f.central.startPeer.mockReturnValueOnce(starting.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  f.receive({ type: "offer", sdp: "offer" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  if (side === "local") f.receive({ type: "disconnected" })
  else f.emit({ type: "peerEvent", peerId: "peer", event: { kind: "stateChanged", state: "disconnected" } as never })
  await vi.advanceTimersByTimeAsync(PEER_DISCONNECT_GRACE_MS)
  starting.resolve()
  await expect(session.ready).rejects.toThrow("connection lost")
  expect(f.spawn).toHaveBeenCalledOnce()
  expect(f.child.close).toHaveBeenCalledOnce()
})

test("the startup deadline still closes a disconnected peer when capture startup never settles", async () => {
  vi.useFakeTimers()
  const f = fixture({ viewerCodecs: ["av1", "h265", "h264"] })
  const starting = deferred<void>()
  f.central.startPeer.mockReturnValueOnce(starting.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  f.receive({ type: "offer", sdp: "offer" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  f.receive({ type: "disconnected" })
  await vi.advanceTimersByTimeAsync(PEER_DISCONNECT_GRACE_MS)
  expect(f.child.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(PEER_SETUP_TIMEOUT_MS - PEER_DISCONNECT_GRACE_MS)
  await expect(session.ready).rejects.toThrow("timed out")
  expect(f.child.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
  starting.reject(Object.assign(new Error("late encoder error"), { reason: "encoder" }))
  await Promise.resolve()
  expect(f.spawn).toHaveBeenCalledOnce()
})

test.each(["local", "remote", "native"])("user close after deferred %s failure cancels startup and fences a late encoder rejection", async source => {
  vi.useFakeTimers()
  const f = fixture({ viewerCodecs: ["av1", "h265", "h264"] })
  const starting = deferred<void>()
  f.central.startPeer.mockReturnValueOnce(starting.promise)
  const session = f.open()
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  f.receive({ type: "offer", sdp: "offer" }); f.receive({ type: "connected" })
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledOnce())
  if (source === "local") f.receive({ type: "disconnected" })
  else if (source === "remote") f.emit({ type: "peerEvent", peerId: "peer", event: { kind: "stateChanged", state: "disconnected" } as never })
  else f.receive({ type: "error", error: "desktop input channel closed" })
  await vi.advanceTimersByTimeAsync(PEER_DISCONNECT_GRACE_MS)
  expect(f.child.close).not.toHaveBeenCalled()
  f.receive({ type: "closeRequested" })
  await expect(session.ready).rejects.toThrow("window closed")
  expect(f.child.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledOnce()
  expect(f.ended).toHaveBeenCalledOnce()
  starting.reject(Object.assign(new Error("late encoder failure"), { reason: "encoder" }))
  f.receive({ type: "closed" })
  await vi.advanceTimersByTimeAsync(PEER_SETUP_TIMEOUT_MS)
  expect(f.spawn).toHaveBeenCalledOnce()
  expect(f.failed).not.toHaveBeenCalled()
})
