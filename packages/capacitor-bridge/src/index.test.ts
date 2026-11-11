import { expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import type { NatTestResult } from "@deskfleet/client/network-diagnostics"
import {
  createCapacitorNativeDesktopApi,
  createCapacitorNetworkDiagnosticsApi,
  spawnCapacitorDesktopViewer,
  type DeskFleetBridgeCapacitorPlugin,
} from "./index.ts"

const unusedTestNat = async (): Promise<NatTestResult> => {
  throw new Error("unexpected testNat call")
}

test("spawnCapacitorDesktopViewer registers viewerEvent listener before opening and forwards commands", async () => {
  const order: string[] = []
  let listener: ((data: { payload: string }) => void) | undefined
  const remove = vi.fn(async () => {
    order.push("remove")
  })
  const plugin: DeskFleetBridgeCapacitorPlugin = {
    async authenticate() { return { url: "" } },
    async openExternal() {},
    async addListener(_name, fn) {
      order.push("addListener")
      listener = fn
      return { remove }
    },
    async open() {
      order.push("open")
      listener?.({ payload: JSON.stringify({ type: "capabilities", codecs: ["h264", "av1"] }) })
    },
    async send({ command }) {
      order.push(`send:${JSON.parse(command).type}`)
    },
    async close() {
      order.push("close")
    },
    testNat: unusedTestNat,
  }

  const events: unknown[] = []
  const viewer = spawnCapacitorDesktopViewer(event => {
    events.push(event)
  }, plugin)

  viewer.send({
    type: "start",
    title: "DeskFleet",
    codec: "av1",
    width: 1920,
    height: 1080,
    control: true,
    relayOnly: false,
    iceServers: [],
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  expect(order.slice(0, 3)).toEqual(["addListener", "open", "send:start"])
  expect(events).toEqual([{ type: "capabilities", codecs: ["h264", "av1"] }])

  await viewer.close()
  expect(order.slice(3)).toEqual(["remove", "close"])
})

test("createCapacitorNativeDesktopApi completes signaling handshake with the Capacitor plugin", async () => {
  let listener: ((data: { payload: string }) => void) | undefined
  const sent: { type: string }[] = []
  const plugin: DeskFleetBridgeCapacitorPlugin = {
    async authenticate() { return { url: "" } },
    async openExternal() {},
    async addListener(_name, fn) {
      listener = fn
      return { remove: async () => {} }
    },
    async open() {
      listener?.({ payload: JSON.stringify({ type: "capabilities", codecs: ["h264"] }) })
    },
    async send({ command }) {
      const parsed = JSON.parse(command) as { type: string }
      sent.push(parsed)
      if (parsed.type === "start") {
        listener?.({ payload: JSON.stringify({ type: "offer", sdp: "v=0-offer" }) })
        listener?.({ payload: JSON.stringify({ type: "connected" }) })
      } else if (parsed.type === "answer") {
        listener?.({ payload: JSON.stringify({ type: "answerApplied" }) })
        listener?.({ payload: JSON.stringify({ type: "inputReady" }) })
        listener?.({ payload: JSON.stringify({ type: "videoReady" }) })
      }
    },
    async close() {},
    testNat: unusedTestNat,
  }

  const central = {
    onEvent: vi.fn(() => () => {}),
    machines: vi.fn(async () => [{ id: "machine", name: "Workstation" }]),
    rpc: vi.fn(async () => ({
      displays: [{ id: 1, width: 1920, height: 1080, codecs: ["h264"] }],
      audio: false,
    })),
    createPeer: vi.fn(async () => ({
      peerId: "peer-1",
      authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
      iceServers: [],
    })),
    offerPeer: vi.fn(async () => ({ sdp: "v=0-answer" })),
    candidatePeer: vi.fn(async () => {}),
    startPeer: vi.fn(async () => {}),
    closePeer: vi.fn(async () => {}),
  } as unknown as CentralApi

  const api = createCapacitorNativeDesktopApi(central, plugin)
  await api.open({
    target: { teamId: "team-1", machineId: "machine" },
    displayId: 1,
    control: true,
  })

  expect(central.offerPeer).toHaveBeenCalledWith("peer-1", "v=0-offer", {
    codec: "h264",
    audio: false,
  })
  expect(central.startPeer).toHaveBeenCalledWith("peer-1", {
    displayId: 1,
    control: true,
  })
  expect(sent.filter(item => item.type !== "ui").map(item => item.type)).toEqual(["start", "answer"])
})

test("createCapacitorNetworkDiagnosticsApi selects the first compatible STUN server and forwards to the plugin", async () => {
  const result: NatTestResult = {
    server: "198.51.100.10:3478",
    localAddress: "192.0.2.2:54321",
    publicAddress: "203.0.113.5:62000",
    mapping: "endpoint-independent",
    filtering: "address-dependent",
    status: "complete",
    durationMs: 42,
  }
  const testNat = vi.fn(async () => result)
  const networkConfiguration = vi.fn(async () => ({
    stunUrls: ["stun:invalid?transport=tcp", "stun:stun.example.com", "stun:backup.example.com:3479"],
  }))
  const api = createCapacitorNetworkDiagnosticsApi({ networkConfiguration }, { testNat })

  await expect(api.testNat()).resolves.toEqual(result)
  expect(testNat).toHaveBeenCalledExactlyOnceWith({ server: "stun.example.com:3478" })

  networkConfiguration.mockResolvedValueOnce({ stunUrls: ["stun:[::1]:3478"] })
  await expect(api.testNat()).rejects.toThrow("no IPv4 UDP STUN server configured")
})
