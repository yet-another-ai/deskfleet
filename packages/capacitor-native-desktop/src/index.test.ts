import { expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import {
  createCapacitorNativeDesktopApi,
  spawnCapacitorDesktopViewer,
  type NativeDesktopCapacitorPlugin,
} from "./index.ts"

test("spawnCapacitorDesktopViewer registers viewerEvent listener before opening and forwards commands", async () => {
  const order: string[] = []
  let listener: ((data: { payload: string }) => void) | undefined
  const remove = vi.fn(async () => {
    order.push("remove")
  })
  const plugin: NativeDesktopCapacitorPlugin = {
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
  const plugin: NativeDesktopCapacitorPlugin = {
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
  expect(sent.map(item => item.type)).toEqual(["start", "answer"])
})
