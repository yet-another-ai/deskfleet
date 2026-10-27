import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import type { PeerEvent } from "@deskfleet/native"
import type { PortPeerEvents, PortPeerFactory } from "@deskfleet/client/ports-signaling"

const mocked = vi.hoisted(() => ({ createPeer: vi.fn(), connectPortPeer: vi.fn() }))
vi.mock("@deskfleet/native", () => ({ createPeer: mocked.createPeer }))
vi.mock("@deskfleet/client/ports-signaling", () => ({ connectPortPeer: mocked.connectPortPeer }))
import { openNativePortForward } from "./ports-peer.ts"

afterEach(() => { mocked.createPeer.mockReset(); mocked.connectPortPeer.mockReset() })
function fixture() {
  let waiting: ((event: PeerEvent | null) => void) | undefined
  const queue: PeerEvent[] = []
  const push = (event: PeerEvent) => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(event) }
    else queue.push(event)
  }
  const native = {
    listenPortForward: vi.fn(async () => 41000), createOffer: vi.fn(async () => "offer"),
    acceptAnswer: vi.fn(async () => {}), addIceCandidate: vi.fn(async () => {}),
    nextEvent: () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<PeerEvent | null>(resolve => { waiting = resolve }),
    close: vi.fn(async () => { waiting?.(null); waiting = undefined }),
  }
  mocked.createPeer.mockResolvedValue(native)
  const events: PortPeerEvents = { open: vi.fn(), candidate: vi.fn(), fail: vi.fn() }
  mocked.connectPortPeer.mockImplementation(async (_central, _target, factory: PortPeerFactory) => factory([
    { urls: "turn:relay", username: "user", credential: "password" },
  ], events))
  const abort = new AbortController()
  const open = () => openNativePortForward({} as CentralApi, {
    target: { teamId: "team", machineId: "machine" }, targetPort: 3000,
  }, vi.fn(), abort.signal)
  return { native, push, events, abort, open }
}

test("native setup owns the listener before negotiation and forwards only lifecycle events", async () => {
  const f = fixture(), peer = await f.open()
  expect(peer.localPort).toBe(41000)
  expect(f.native.listenPortForward).toHaveBeenCalledWith(0, "127.0.0.1", 3000)
  expect(mocked.createPeer).toHaveBeenCalledWith({ iceServers: [{ urls: ["turn:relay"], username: "user", credential: "password" }] })
  const candidate = { candidate: "candidate", sdpMid: "0" }
  f.push({ kind: "iceCandidate", candidate })
  f.push({ kind: "dataChannelOpen", label: "deskfleet-ports" })
  await vi.waitFor(() => expect(f.events.open).toHaveBeenCalledOnce())
  expect(f.events.candidate).toHaveBeenCalledWith(candidate)
  await peer.close()
  f.abort.abort()
  expect(f.native.close).toHaveBeenCalledOnce()
  expect(f.events.fail).not.toHaveBeenCalled()
})

test("listener setup errors close the native peer", async () => {
  const f = fixture()
  f.native.listenPortForward.mockRejectedValueOnce(new Error("address in use"))
  await expect(f.open()).rejects.toThrow("address in use")
  expect(f.native.close).toHaveBeenCalledOnce()
})

test("aborting while the native factory is pending closes its late result before listening", async () => {
  const f = fixture()
  let complete!: (value: typeof f.native) => void
  mocked.createPeer.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  const pending = f.open(), rejected = expect(pending).rejects.toThrow("cancelled")
  f.abort.abort()
  complete(f.native)
  await rejected
  expect(f.native.close).toHaveBeenCalledOnce()
  expect(f.native.listenPortForward).not.toHaveBeenCalled()
})

test("transport failures are reported to the grant owner", async () => {
  const f = fixture(), peer = await f.open()
  f.push({ kind: "error", error: "transport failed" })
  await vi.waitFor(() => expect(f.events.fail).toHaveBeenCalledWith(expect.objectContaining({ message: "transport failed" })))
  await peer.close()
})
