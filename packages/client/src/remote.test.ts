import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent, Machine } from "./central.ts"
import type { DeskfleetDesktopApi } from "./desktop-api.ts"
import { remoteMachineClient } from "./remote.ts"
import { setPeerTelemetrySink } from "./peer-telemetry.ts"
import type { LocalChannelsApi } from "./local-channels.ts"
const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); setPeerTelemetrySink(undefined); vi.useRealTimers() })
function fixture(host: Partial<DeskfleetDesktopApi> = {}, local = false) {
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
  const remote = remoteMachineClient({ platform: "web", locale: "en-US", ...host } as DeskfleetDesktopApi, central, machine, { local })
  disposers.push(remote.dispose)
  return { remote, central, machine, emit: (event: CentralEvent) => listener(event) }
}
test("a refreshed machine reconciles missed presence without replacing its peer", async () => {
  const f = fixture()
  const changed = vi.fn()
  f.remote.api.catalog.onChanged(changed)
  await f.remote.api.agent.prepare!("retained-peer")
  f.emit({ type: "connection", connected: false })
  const updated = { ...f.machine, online: true, name: "Renamed remote", lastSeenAt: "2026-10-29T12:00:00Z" }
  f.central.machines = vi.fn(async () => [updated])
  f.remote.updateMachine(updated)
  expect(f.remote.api.agent.history!.available()).toBe(true)
  expect(await f.remote.api.desktop.target()).toMatchObject({ name: updated.name, online: true })
  expect(f.remote.api.target!.lastSeen).toBe(updated.lastSeenAt)
  expect(changed).toHaveBeenCalledOnce()
  f.remote.updateMachine({ ...updated })
  expect(changed).toHaveBeenCalledOnce()
  await f.remote.api.agent.offer({ sessionId: "retained-peer", sdp: "offer" })
  expect(f.central.offerPeer).toHaveBeenCalledWith("peer1", "offer", { sessionId: "retained-peer", sdp: "offer" })
  expect(f.central.closePeer).not.toHaveBeenCalled()
})

test("refreshing a retained local machine preserves its direct channels and locality", async () => {
  const bridge: LocalChannelsApi = { open: vi.fn(async () => {}), send: vi.fn(async () => {}), close: vi.fn(async () => {}), onEvent: () => () => {} }
  const f = fixture({ platform: "darwin", localChannels: bridge }, true)
  const agent = f.remote.api.agent.connectChannel!("agent"), terminal = f.remote.api.terminal.connectChannel!("terminal")
  await vi.waitFor(() => { expect(agent.readyState).toBe("open"); expect(terminal.readyState).toBe("open") })
  f.remote.updateMachine({ ...f.machine, online: true, name: "Renamed local", lastSeenAt: "2026-10-29T12:00:00Z" })
  expect(f.remote.api.agent.history!.available()).toBe(true)
  expect(f.remote.api.target?.local).toBe(true)
  expect(f.remote.api.agent.control!("_deskfleet/git/branches", { workspaceId: "1" })).toBeUndefined()
  expect(agent.readyState).toBe("open")
  expect(terminal.readyState).toBe("open")
  expect(bridge.close).not.toHaveBeenCalled()
  expect(f.central.createPeer).not.toHaveBeenCalled()
})

test("verified local targets use direct Agent/Git and terminal channels, while desktop retains WebRTC", async () => {
  const bridge: LocalChannelsApi = { open: vi.fn(async () => {}), send: vi.fn(async () => {}), close: vi.fn(async () => {}), onEvent: () => () => {} }
  const f = fixture({ platform: "darwin", localChannels: bridge }, true)
  const agent = f.remote.api.agent.connectChannel!("agent"), terminal = f.remote.api.terminal.connectChannel!("terminal")
  await vi.waitFor(() => { expect(agent.readyState).toBe("open"); expect(terminal.readyState).toBe("open") })
  expect(bridge.open).toHaveBeenCalledWith({ connectionId: "agent", teamId: "team2", machineId: "central7", purpose: "agent" })
  expect(bridge.open).toHaveBeenCalledWith({ connectionId: "terminal", teamId: "team2", machineId: "central7", purpose: "terminal" })
  expect(f.central.createPeer).not.toHaveBeenCalled()
  expect(f.remote.api.target?.local).toBe(true)
  expect(f.remote.api.agent.control!("_deskfleet/git/branches", { workspaceId: "1" })).toBeUndefined()
  await f.remote.api.desktop.prepare!("desktop")
  expect(f.central.createPeer).toHaveBeenCalledWith("team2", "central7", "desktop")
  f.remote.dispose()
  expect(agent.readyState).toBe("closed")
  expect(terminal.readyState).toBe("closed")
})

test("Web and unverified desktop targets never select the local bridge", () => {
  const bridge = { open: vi.fn() } as unknown as LocalChannelsApi
  const web = fixture({ localChannels: bridge }, true), remote = fixture({ platform: "darwin", localChannels: bridge })
  expect(web.remote.api.agent.connectChannel).toBeUndefined()
  expect(remote.remote.api.terminal.connectChannel).toBeUndefined()
  expect(bridge.open).not.toHaveBeenCalled()
})

test("a selected local target reports a missing bridge instead of falling back to WebRTC", () => {
  const f = fixture({ platform: "darwin" }, true)
  expect(() => f.remote.api.agent.connectChannel!("agent")).toThrow("Local message channels are unavailable")
  expect(f.central.createPeer).not.toHaveBeenCalled()
})

test("locality changes update existing signaling objects and keep management subscriptions", async () => {
  const bridge: LocalChannelsApi = { open: vi.fn(async () => {}), send: vi.fn(async () => {}), close: vi.fn(async () => {}), onEvent: () => () => {} }
  const f = fixture({ platform: "darwin", localChannels: bridge }), agent = f.remote.api.agent, terminal = f.remote.api.terminal, catalog = vi.fn()
  f.remote.api.catalog.onChanged(catalog)
  f.remote.setLocal(true)
  const channel = agent.connectChannel!("direct")
  await vi.waitFor(() => expect(channel.readyState).toBe("open"))
  expect(terminal.connectChannel).toBeTypeOf("function")
  expect(agent.control!("_deskfleet/git/branches", { workspaceId: "1" })).toBeUndefined()
  channel.close()
  f.remote.setLocal(false)
  expect(agent.connectChannel).toBeUndefined()
  expect(terminal.connectChannel).toBeUndefined()
  expect(f.remote.api.target?.local).toBe(false)
  await agent.control!("_deskfleet/git/branches", { workspaceId: "1" })
  expect(f.central.rpc).toHaveBeenCalledWith("central7", "_deskfleet/git/branches", { workspaceId: "1" })
  f.emit({ type: "catalogChanged", machineId: "central7" })
  expect(catalog).toHaveBeenCalledOnce()
})
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
  await f.remote.api.agent.control!("_deskfleet/session/rename", { sessionId: "1", operationId: "rename-op", title: "Investigate payment errors" })
  expect(f.central.rpc).toHaveBeenCalledWith("central7", "_deskfleet/session/rename", { sessionId: "1", operationId: "rename-op", title: "Investigate payment errors" })
  expect(f.remote.api.agent.control!("_deskfleet/input/submit", { sessionId: "1", operationId: "prompt", content: [], delivery: "backlog" })).toBeUndefined()
  expect(await f.remote.api.agent.history!.list()).toEqual([{ id: "1" }])
})

test.each(["agent", "terminal", "desktop"] as const)("records %s grants and the first observed connection outcome", async feature => {
  const f = fixture(), sink = vi.fn()
  setPeerTelemetrySink(sink)
  await f.remote.api[feature].prepare!("local-peer")
  const connected = { kind: "stateChanged", state: "connected" } as const
  f.emit({ type: "peerEvent", peerId: "other-peer", event: connected })
  f.emit({ type: "peerEvent", peerId: "peer1", event: connected })
  f.emit({ type: "peerEvent", peerId: "peer1", event: connected })
  const failed = { kind: "stateChanged", state: "failed" } as const
  f.emit({ type: "peerEvent", peerId: "peer1", event: failed })
  expect(sink.mock.calls.map(([event]) => event)).toEqual([
    { name: "peer_granted", teamId: "team2", metadata: { feature, relay: "allowed" } },
    { name: "peer_connection", teamId: "team2", metadata: { feature, relay: "allowed", outcome: "connected", transport: "unknown" } },
  ])
})

test("an offer failure records a failed attempt without exporting its error", async () => {
  const f = fixture(), sink = vi.fn()
  setPeerTelemetrySink(sink)
  await f.remote.api.agent.prepare!("local-peer")
  vi.mocked(f.central.offerPeer).mockRejectedValueOnce(new Error("Sensitive server details"))
  await expect(f.remote.api.agent.offer({ sessionId: "local-peer", sdp: "offer" })).rejects.toThrow("Sensitive server details")
  expect(sink).toHaveBeenLastCalledWith({ name: "peer_connection", teamId: "team2", metadata: { feature: "agent", relay: "allowed", outcome: "failed", transport: "unknown" } })
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

test("system status reads the selected remote machine without opening a peer", async () => {
  const f = fixture()
  const status = { sampledAt: 1_793_000_000_000, cpuUsagePercent: 37.5, daemonVersion: "2.3.4" }
  vi.mocked(f.central.rpc).mockResolvedValue(status)
  expect(await f.remote.api.system!.status()).toEqual(status)
  expect(f.central.rpc).toHaveBeenCalledWith("central7", "systemStatus", {})
  expect(f.central.createPeer).not.toHaveBeenCalled()
  vi.mocked(f.central.rpc).mockRejectedValueOnce(new Error("Machine is offline"))
  await expect(f.remote.api.system!.status()).rejects.toThrow("Machine is offline")
})

test("desktop control is requested explicitly when starting its authorized peer", async () => {
  const f = fixture()
  await f.remote.api.desktop.prepare!("desktop")
  await f.remote.api.desktop.start({ sessionId: "desktop", displayId: 2 })
  expect(f.central.startPeer).toHaveBeenLastCalledWith("peer1", { displayId: 2 })
  await f.remote.api.desktop.start({ sessionId: "desktop", displayId: 2, control: true })
  expect(f.central.startPeer).toHaveBeenLastCalledWith("peer1", { displayId: 2, control: true })
})

test("desktop discovery reads capabilities published after enrollment and later permission changes", async () => {
  const f = fixture()
  const current: Machine = { id: "central7", teamId: "team2", name: "Remote", originId: "origin", localMachineId: "1", capabilities: {}, online: true }
  f.central.machines = vi.fn(async () => [structuredClone(current)])
  f.emit({ type: "presence", machineId: "central7", online: true })
  expect(await f.remote.api.desktop.target()).toEqual({ id: "central7", name: "Remote", online: true, desktop: false })
  current.capabilities = { desktop: true }
  expect(await f.remote.api.desktop.target()).toEqual({ id: "central7", name: "Remote", online: true, desktop: true })
  f.emit({ type: "presence", machineId: "central7", online: false })
  expect((await f.remote.api.desktop.target()).online).toBe(false)
  current.capabilities = { desktop: false }
  expect((await f.remote.api.desktop.target()).desktop).toBe(false)
  expect(f.central.machines).toHaveBeenLastCalledWith("team2")
})

test("desktop discovery does not reuse capabilities after the machine is removed", async () => {
  const f = fixture()
  f.central.machines = vi.fn(async () => [])
  await expect(f.remote.api.desktop.target()).rejects.toThrow("Machine is no longer available in this team")
})

test.each([
  ["free_plan", "Free plan does not include TURN relay"],
  ["turn_quota_exhausted", "monthly TURN relay allowance"],
  ["metering_unavailable", "TURN relay is temporarily unavailable"],
] as const)("preserves direct ICE and explains a later failure for %s", async (reason, message) => {
  const f = fixture()
  const grant = await f.central.createPeer("team2", "central7", "agent")
  vi.mocked(f.central.createPeer).mockResolvedValue({ ...grant, iceServers: [{ urls: ["stun:example.test"] }], relayDeniedReason: reason })
  expect(await f.remote.api.agent.prepare!("direct")).toEqual([{ urls: ["stun:example.test"] }])
  expect(f.remote.api.agent.connectionFailure!("direct")).toContain(message)
  expect(f.remote.api.terminal.connectionFailure!("direct")).toContain(message)
  expect(f.remote.api.desktop.connectionFailure!("direct")).toContain(message)
  await f.remote.api.agent.close("direct")
  expect(f.remote.api.agent.connectionFailure!("direct")).toBeUndefined()
})
