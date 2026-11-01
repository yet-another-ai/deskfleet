import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent } from "@deskfleet/client/central"
import { openNativeDesktopSession, type ViewerEvent } from "./native-desktop-session.ts"

const closing: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); vi.useRealTimers() })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  let receive!: (event: ViewerEvent) => void
  let emit!: (event: CentralEvent) => void
  const unsubscribe = vi.fn()
  const central = {
    onEvent: vi.fn((listener: typeof emit) => { emit = listener; return unsubscribe }),
    machines: vi.fn(async () => [{ id: "machine", name: "Workstation" }]),
    rpc: vi.fn(async () => ({ displays: [{ id: 7, codecs: ["h264", "av1"] }], audio: true })),
    createPeer: vi.fn(async () => ({ peerId: "peer", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [{ urls: "turn:example.test", username: "user", credential: "secret" }] })),
    offerPeer: vi.fn(async () => ({ sdp: "answer" })),
    candidatePeer: vi.fn(async () => {}), startPeer: vi.fn(async () => {}), closePeer: vi.fn(async () => {}),
  }
  const child = { send: vi.fn(), close: vi.fn(async () => {}) }
  const spawn = vi.fn((listener: typeof receive) => { receive = listener; return child })
  const failed = vi.fn(), ended = vi.fn()
  const open = () => {
    const session = openNativeDesktopSession(central as unknown as CentralApi,
      { target: { teamId: "team", machineId: "machine" }, displayId: 7, control: true }, spawn, failed, ended)
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
  expect(f.central.offerPeer).toHaveBeenCalledWith("peer", "offer", { sessionId: "peer", sdp: "offer", codec: "h264", audio: false })
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
  f.central.rpc.mockResolvedValueOnce({ displays: [{ id: 7, codecs: ["av1"] }], audio: false })
  const session = f.open()
  await expect(session.ready).rejects.toThrow("does not support H.264")
  expect(f.central.createPeer).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
})
