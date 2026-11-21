import type { PluginListenerHandle } from "@capacitor/core"
import type { CentralApi, CentralEvent } from "@deskfleet/client/central"
import { expect, test, vi } from "vitest"
import { createCapacitorPortsApi, type PortsBridgePlugin } from "./ports.ts"

const target = { teamId: "team-1", machineId: "machine-1" }

function createCentralFixture() {
  const listeners = new Set<(event: CentralEvent) => void>()
  const central = {
    onEvent: (listener: (event: CentralEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    createPeer: vi.fn(async () => ({
      peerId: "peer-remote",
      iceServers: [{ urls: ["stun:stun.example:3478"] }],
      authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
      relayDeniedReason: null,
    })),
    offerPeer: vi.fn(async () => ({ sdp: "v=0\r\nm=application 9 DTLS/SCTP 5000\r\na=mid:0\r\n" })),
    candidatePeer: vi.fn(async () => {}),
    closePeer: vi.fn(async () => {}),
  } as unknown as CentralApi & {
    createPeer: ReturnType<typeof vi.fn>
    offerPeer: ReturnType<typeof vi.fn>
    candidatePeer: ReturnType<typeof vi.fn>
    closePeer: ReturnType<typeof vi.fn>
  }
  return {
    central,
    emit: (event: CentralEvent) => {
      for (const listener of listeners) listener(event)
    },
  }
}

function createPluginFixture() {
  const listeners = new Set<(data: { payload: string }) => void>()
  const calls: Array<Record<string, unknown>> = []
  const remove = vi.fn(async () => {})
  const plugin: PortsBridgePlugin = {
    portsCall: vi.fn(async ({ request }) => {
      const parsed = JSON.parse(request) as Record<string, unknown>
      calls.push(parsed)
      if (parsed.op === "create") return { response: JSON.stringify({ result: { localPort: 42123 } }) }
      if (parsed.op === "offer") return { response: JSON.stringify({ result: { sdp: "v=0\r\nm=application 9 DTLS/SCTP 5000\r\na=mid:0\r\n" } }) }
      return { response: JSON.stringify({ result: { ok: true } }) }
    }),
    addListener: vi.fn(async (_eventName, listener) => {
      listeners.add(listener)
      return {
        remove: async () => {
          listeners.delete(listener)
          await remove()
        },
      } satisfies PluginListenerHandle
    }),
  }
  return {
    plugin,
    calls,
    remove,
    emit: (payload: Record<string, unknown>) => {
      const encoded = JSON.stringify(payload)
      for (const listener of listeners) listener({ payload: encoded })
    },
  }
}

test("bridges native WebRTC loopback port forwarding and closes cleanly", async () => {
  const { central, emit: emitCentral } = createCentralFixture()
  const { plugin, calls, remove, emit: emitPorts } = createPluginFixture()
  const ports = createCapacitorPortsApi(central, plugin)

  const pending = ports.start({ target, targetHost: "localhost", targetPort: 5173 })
  await vi.waitFor(() => expect(calls.some(call => call.op === "answer")).toBe(true))
  const peerId = String(calls.find(call => call.op === "create")!.peerId)

  emitPorts({ peerId: "other-peer", kind: "error", error: "ignored" })
  emitPorts({ peerId, kind: "iceCandidate", candidate: { candidate: "candidate:1", sdpMid: "0", sdpMlineIndex: 0 } })
  emitPorts({ peerId, kind: "open" })

  const forward = await pending
  expect(forward).toMatchObject({ localHost: "127.0.0.1", localPort: 42123, targetHost: "localhost", targetPort: 5173 })
  expect(calls.find(call => call.op === "create")).toMatchObject({
    op: "create",
    targetHost: "localhost",
    targetPort: 5173,
    localPort: 0,
  })
  await vi.waitFor(() => expect(central.candidatePeer).toHaveBeenCalledOnce())

  emitCentral({
    type: "peerEvent",
    peerId: "peer-remote",
    event: { kind: "iceCandidate", candidate: { candidate: "candidate:remote", sdpMid: "0", sdpMlineIndex: 0 } },
  })
  await vi.waitFor(() => expect(calls.some(call => call.op === "candidate")).toBe(true))

  await ports.stop(forward.id)
  expect(calls.some(call => call.op === "close" && call.peerId === peerId)).toBe(true)
  expect(remove).toHaveBeenCalledOnce()
  expect(central.closePeer).toHaveBeenCalledWith("peer-remote")
})

test("closes native peer and listener when setup is aborted or native returns an error", async () => {
  const { central, emit: emitCentral } = createCentralFixture()
  const { plugin, calls, remove } = createPluginFixture()
  let resolveCreate!: (value: { response: string }) => void
  vi.mocked(plugin.portsCall).mockImplementationOnce(async ({ request }) => {
    calls.push(JSON.parse(request) as Record<string, unknown>)
    return new Promise(resolve => { resolveCreate = resolve })
  })
  const ports = createCapacitorPortsApi(central, plugin)

  const pending = ports.start({ target, targetPort: 3000 })
  const rejected = expect(pending).rejects.toThrow("cancelled")
  await vi.waitFor(() => expect(calls.some(call => call.op === "create")).toBe(true))
  const peerId = String(calls[0]!.peerId)

  emitCentral({ type: "accountChanged" })
  resolveCreate({ response: JSON.stringify({ result: { localPort: 43000 } }) })
  await rejected
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())

  vi.mocked(plugin.portsCall).mockResolvedValueOnce({ response: JSON.stringify({ error: "bind failed" }) })
  await expect(ports.start({ target, targetPort: 3000 })).rejects.toThrow("bind failed")
  expect(calls.filter(call => call.op === "close" && call.peerId === peerId).length).toBeLessThanOrEqual(1)
})
