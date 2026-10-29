import { expect, test, vi } from "vitest"
import type { LocalPeerGrant } from "@deskfleet/client/central"
import { LOCAL_CHANNEL_BUFFER_BYTES, LOCAL_CHANNEL_BUFFER_MESSAGES, LOCAL_CHANNEL_MESSAGE_BYTES, type LocalChannelOpen } from "@deskfleet/client/local-channels"
import type { DaemonEvent } from "../../../daemon/src/control-protocol.ts"
import { WindowLocalChannels, type ConnectLocalDaemon, type LocalChannelDaemon } from "./local-channels-controller.ts"

const request: LocalChannelOpen = { connectionId: "view", teamId: "team", machineId: "machine", purpose: "agent" }
function grant(peerId = "peer"): LocalPeerGrant {
  return {
    peerId, token: "one-use-secret",
    authorization: {
      peerId, transport: "local", serverId: "https://deskfleet.test", teamId: "team", purpose: "agent",
      actor: { kind: "user", userId: "user", deviceId: "device", sourceMachine: null },
      targetMachine: { id: "machine", originId: "origin", localMachineId: "local" },
      actions: ["agent:read", "agent:execute", "git:read"],
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  }
}
function fixture() {
  let receive!: (event: DaemonEvent) => void
  let disconnected!: (error: Error) => void
  const local = {
    configured: true, connected: true, revoked: false, serverUrl: "https://deskfleet.test", machineId: "machine", teamId: "team",
    identity: { originId: "origin", machineId: "local" }, machineName: "This computer",
  }
  const call = vi.fn(async (method: string, _params: unknown): Promise<unknown> => method === "centralStatus" ? local : null)
  const daemon = { closed: false, call, close: vi.fn(() => { daemon.closed = true; disconnected(new Error("disconnected")) }) }
  const connect: ConnectLocalDaemon = async (event, gone) => { receive = event; disconnected = gone; return daemon as LocalChannelDaemon }
  const central = {
    status: vi.fn(async () => ({ serverUrl: "https://deskfleet.test", siteAdmin: false, user: { id: "user", name: "User" } })),
    createLocalPeer: vi.fn(async () => grant()), closePeer: vi.fn(async () => {}),
  }
  const emit = vi.fn()
  const channels = new WindowLocalChannels(central, connect, emit)
  return { local, daemon, call, central, emit, channels, receive: (event: DaemonEvent) => receive(event) }
}

test("main verifies locality, keeps claim tokens private, and delivers both wire formats", async () => {
  const f = fixture()
  await f.channels.open(request)
  expect(f.central.createLocalPeer).toHaveBeenCalledExactlyOnceWith("team", "machine", "agent")
  expect(f.call).toHaveBeenCalledWith("localOpen", { peerId: "peer", token: "one-use-secret" })
  await f.channels.send("view", new Uint8Array([0, 255]))
  await f.channels.send("view", "terminal text")
  expect(f.call).toHaveBeenCalledWith("localSend", { peerId: "peer", data: "AP8=", isString: false })
  expect(f.call).toHaveBeenCalledWith("localSend", { peerId: "peer", data: "terminal text", isString: true })
  f.receive({ kind: "localChannelMessage", peerId: "peer", sequence: 1, data: "AP8=", isString: false })
  expect(f.emit).toHaveBeenCalledExactlyOnceWith({ connectionId: "view", kind: "message", sequence: 1, data: new Uint8Array([0, 255]) })
  await f.channels.acknowledge("view", 1)
  expect(f.call).toHaveBeenCalledWith("localAck", { peerId: "peer", sequence: 1 })
  f.receive({ kind: "localChannelMessage", peerId: "another-peer", sequence: 2, data: "private", isString: true })
  expect(f.emit).toHaveBeenCalledOnce()
  await f.channels.dispose()
  expect(f.daemon.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledExactlyOnceWith("peer")
})

test.each(["server", "team", "machine", "revoked", "unconfigured"])("%s mismatch rejects before creating a local grant", async cause => {
  const f = fixture()
  if (cause === "server") f.local.serverUrl = "https://other.test"
  if (cause === "team") f.local.teamId = "another-team"
  if (cause === "machine") f.local.machineId = "another-machine"
  if (cause === "revoked") f.local.revoked = true
  if (cause === "unconfigured") f.local.configured = false
  await expect(f.channels.open(request)).rejects.toThrow("registered local machine")
  expect(f.central.createLocalPeer).not.toHaveBeenCalled()
  expect(f.daemon.close).toHaveBeenCalledOnce()
  await f.channels.dispose()
})

test.each(["origin", "actor", "transport", "purpose"])("a grant with the wrong %s is never claimed", async cause => {
  const f = fixture(), value = grant()
  if (cause === "origin") value.authorization.targetMachine.originId = "other"
  if (cause === "actor") value.authorization.actor.userId = "other"
  if (cause === "transport") value.authorization.transport = "webrtc"
  if (cause === "purpose") value.authorization.purpose = "terminal"
  f.central.createLocalPeer.mockResolvedValue(value)
  await expect(f.channels.open(request)).rejects.toThrow("does not match")
  expect(f.call.mock.calls.map(([method]) => method)).not.toContain("localOpen")
  await f.channels.dispose()
  expect(f.central.closePeer).toHaveBeenCalledExactlyOnceWith("peer")
})

test("disposing during grant creation cancels the late result without claiming it", async () => {
  const f = fixture()
  let finish!: (value: LocalPeerGrant) => void
  f.central.createLocalPeer.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = f.channels.open(request)
  const rejected = expect(pending).rejects.toThrow("cancelled")
  await vi.waitFor(() => expect(f.central.createLocalPeer).toHaveBeenCalledOnce())
  await f.channels.dispose()
  finish(grant())
  await rejected
  expect(f.central.closePeer).toHaveBeenCalledExactlyOnceWith("peer")
  expect(f.call.mock.calls.map(([method]) => method)).not.toContain("localOpen")
})

test("windows cannot send or acknowledge each other's connections; daemon closure detaches only its viewer", async () => {
  const a = fixture(), b = fixture()
  await a.channels.open(request)
  expect(() => b.channels.send("view", "payload")).toThrow("not open in this window")
  await expect(b.channels.acknowledge("view", 1)).rejects.toThrow("not open in this window")
  await b.channels.open({ ...request, connectionId: "other-view" })
  a.receive({ kind: "localChannelClosed", peerId: "peer", error: "grant revoked" })
  expect(a.emit).toHaveBeenLastCalledWith({ connectionId: "view", kind: "closed", error: "grant revoked" })
  expect(b.daemon.close).not.toHaveBeenCalled()
  await b.channels.send("other-view", "still connected")
  await Promise.all([a.channels.dispose(), b.channels.dispose()])
})

test("ordered sends have a bounded byte budget and copy binary data before yielding", async () => {
  const f = fixture()
  await f.channels.open(request)
  let release!: () => void
  f.call.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(null) }))
  const data = new Uint8Array(LOCAL_CHANNEL_MESSAGE_BYTES)
  const sends: Promise<void>[] = []
  for (let offset = 0; offset < LOCAL_CHANNEL_BUFFER_BYTES; offset += data.byteLength) sends.push(f.channels.send("view", data))
  data[0] = 255
  expect(() => f.channels.send("view", "overflow")).toThrow("buffer is full")
  expect(() => f.channels.send("view", new Uint8Array(LOCAL_CHANNEL_MESSAGE_BYTES + 1))).toThrow("too large")
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  const before = f.call.mock.calls.filter(([method]) => method === "localSend")
  expect(before).toHaveLength(1)
  expect((before[0]![1] as { data: string }).data.startsWith("AAAA")).toBe(true)
  release()
  await Promise.all(sends)
  await f.channels.send("view", "budget released")
  await f.channels.dispose()
})

test("direct bridge callers cannot bypass the pending-message bound with empty frames", async () => {
  const f = fixture()
  await f.channels.open(request)
  let release!: () => void
  f.call.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(null) }))
  const sends = Array.from({ length: LOCAL_CHANNEL_BUFFER_MESSAGES }, () => f.channels.send("view", ""))
  expect(() => f.channels.send("view", new Uint8Array())).toThrow("buffer is full")
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  release()
  await Promise.all(sends)
  await f.channels.dispose()
})
