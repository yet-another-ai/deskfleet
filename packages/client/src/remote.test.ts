import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent, Machine } from "./central.ts"
import type { DeskfleetDesktopApi } from "./desktop-api.ts"
import { remoteMachineClient } from "./remote.ts"
const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers() })
function fixture() {
  let listener!: (event: CentralEvent) => void
  const central = {
    onEvent: (value: typeof listener) => { listener = value; return () => {} },
    createPeer: vi.fn(async () => ({ peerId: "peer1", authorization: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, iceServers: [{ urls: ["turn:relay.example"], username: "user", credential: "temporary" }] })),
    closePeer: vi.fn(async () => {}), rpc: vi.fn(async () => ({ result: true })),
    offerPeer: vi.fn(async () => ({ sdp: "answer" })),
    startPeer: vi.fn(async () => {}),
    sessions: vi.fn(async () => [{ session: { id: "1" } }] as never),
  } as unknown as CentralApi
  const machine: Machine = { id: "central7", teamId: "team2", name: "Remote", originId: "origin", localMachineId: "1", capabilities: {}, online: false }
  const remote = remoteMachineClient({ platform: "web", locale: "en-US" } as DeskfleetDesktopApi, central, machine)
  disposers.push(remote.dispose)
  return { remote, central, emit: (event: CentralEvent) => listener(event) }
}
test("passes TURN config to the browser, preserves peers during signaling loss, and closes authorization at 24 hours", async () => {
  vi.useFakeTimers(); const f = fixture(); const events = vi.fn()
  f.remote.api.agent.onEvent(events)
  expect(await f.remote.api.agent.prepare!("local-peer")).toEqual([{ urls: ["turn:relay.example"], username: "user", credential: "temporary" }])
  f.emit({ type: "connection", connected: false })
  expect(events).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(86_400_000)
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "local-peer", kind: "error" }))
})
test("revokes only the matching peer and sends management over the central RPC", async () => {
  const f = fixture(); const events = vi.fn(); f.remote.api.agent.onEvent(events)
  await f.remote.api.agent.prepare!("local-peer")
  f.emit({ type: "peerRevoked", peerId: "another-peer", reason: "revoked" })
  expect(events).not.toHaveBeenCalled()
  f.emit({ type: "peerRevoked", peerId: "peer1", reason: "membership_removed" })
  expect(events).toHaveBeenCalledWith({ sessionId: "local-peer", kind: "error", error: "membership_removed" })
  await f.remote.api.agent.control!("_deskfleet/session/archive", { sessionId: "1", operationId: "archive-op" })
  expect(f.central.rpc).toHaveBeenCalledWith("central7", "_deskfleet/session/archive", { sessionId: "1", operationId: "archive-op" })
  expect(f.remote.api.agent.control!("_deskfleet/input/submit", { sessionId: "1", operationId: "prompt", content: [], delivery: "backlog" })).toBeUndefined()
  expect(await f.remote.api.agent.history!.list()).toEqual([{ id: "1" }])
})

test("retains known terminal tabs during a daemon signaling outage", async () => {
  const f = fixture()
  const shells = [{ id: "shell1", status: "running" }]
  vi.mocked(f.central.rpc).mockResolvedValue(shells)
  f.emit({ type: "presence", machineId: "central7", online: true })
  expect(await f.remote.api.terminal.list()).toEqual(shells)
  f.emit({ type: "presence", machineId: "central7", online: false })
  expect(await f.remote.api.terminal.list()).toEqual(shells)
  expect(f.central.rpc).toHaveBeenCalledTimes(1)
})

test("desktop control is requested explicitly when starting its authorized peer", async () => {
  const f = fixture()
  await f.remote.api.desktop.prepare!("desktop")
  await f.remote.api.desktop.start({ sessionId: "desktop", displayId: 2 })
  expect(f.central.startPeer).toHaveBeenLastCalledWith("peer1", { displayId: 2 })
  await f.remote.api.desktop.start({ sessionId: "desktop", displayId: 2, control: true })
  expect(f.central.startPeer).toHaveBeenLastCalledWith("peer1", { displayId: 2, control: true })
})
