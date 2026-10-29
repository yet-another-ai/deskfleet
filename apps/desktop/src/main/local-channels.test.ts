import { EventEmitter } from "node:events"
import { expect, test, vi } from "vitest"
import { LOCAL_CHANNEL, LOCAL_CHANNEL_EVENT } from "@deskfleet/client/local-channels"
import type { CentralEvent } from "@deskfleet/client/central"
import type { LocalChannelAuthority } from "./local-channels-controller.ts"

const mocks = vi.hoisted(() => ({ managers: [] as Array<{ open: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; acknowledge: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> }))
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  ipcRenderer: { invoke: vi.fn(async () => {}), on: vi.fn(), removeListener: vi.fn() },
}))
vi.mock("./desktop-media.ts", () => ({ isDesktopMediaSender: vi.fn(() => true) }))
vi.mock("./daemon-client.ts", () => ({ DaemonClient: { connect: vi.fn() } }))
vi.mock("./local-channels-controller.ts", () => ({
  WindowLocalChannels: class {
    open = vi.fn(async () => {})
    send = vi.fn(async () => {})
    acknowledge = vi.fn(async () => {})
    close = vi.fn(async () => {})
    dispose = vi.fn(async () => {})
    constructor() { mocks.managers.push(this) }
  },
}))
import { ipcMain, ipcRenderer } from "electron"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { installLocalChannels } from "./local-channels.ts"
import { localChannelsApi } from "../preload/local-channels.ts"

test("the narrow bridge enforces sender and request shapes and releases each document's authority", async () => {
  let accountEvent!: (event: CentralEvent) => void
  const central = { onEvent: (listener: typeof accountEvent) => { accountEvent = listener; return vi.fn() } } as unknown as LocalChannelAuthority & { onEvent(listener: typeof accountEvent): () => void }
  const host = installLocalChannels(central)
  const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1]
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  const event = { sender: contents } as unknown as Electron.IpcMainInvokeEvent
  const request = { connectionId: "view", teamId: "team", machineId: "machine", purpose: "agent" }
  vi.mocked(isDesktopMediaSender).mockReturnValueOnce(false)
  await expect(handler(event, "open", [request])).rejects.toThrow("restricted")
  await handler(event, "open", [request])
  const manager = mocks.managers.at(-1)!
  expect(manager.open).toHaveBeenCalledExactlyOnceWith(request)
  await expect(handler(event, "open", [{ ...request, purpose: "desktop" }])).rejects.toThrow("Unsupported")
  await expect(handler(event, "send", ["view", {}])).rejects.toThrow("Invalid")
  await expect(handler(event, "ack", ["view", -1])).rejects.toThrow("acknowledgement")
  await expect(handler(event, "peer.local", [request])).rejects.toThrow("Unknown")
  await handler(event, "send", ["view", new Uint8Array([1])])
  await handler(event, "ack", ["view", 1])
  expect(manager.send).toHaveBeenCalledWith("view", new Uint8Array([1]))
  expect(manager.acknowledge).toHaveBeenCalledWith("view", 1)
  contents.emit("did-start-navigation", {}, "https://deskfleet.test", false, true)
  expect(manager.dispose).toHaveBeenCalledOnce()
  const count = mocks.managers.length
  await handler(event, "ack", ["view", 2])
  await handler(event, "close", ["view"])
  expect(mocks.managers).toHaveLength(count)
  await handler(event, "open", [request])
  const next = mocks.managers.at(-1)!
  accountEvent({ type: "accountChanged" })
  expect(next.dispose).toHaveBeenCalledOnce()
  await handler(event, "open", [request])
  const crashed = mocks.managers.at(-1)!
  contents.emit("render-process-gone")
  expect(crashed.dispose).toHaveBeenCalledOnce()
  await host.close()
  expect(contents.listenerCount("did-start-navigation")).toBe(0)
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(LOCAL_CHANNEL)
})

test("preload acknowledges each delivered frame once after listeners run, without exposing ACK metadata", async () => {
  const bridge = localChannelsApi(), first = vi.fn(), second = vi.fn()
  const stopFirst = bridge.onEvent(first), stopSecond = bridge.onEvent(second)
  const handler = vi.mocked(ipcRenderer.on).mock.calls.at(-1)![1]
  expect(vi.mocked(ipcRenderer.on).mock.calls.at(-1)![0]).toBe(LOCAL_CHANNEL_EVENT)
  const before = vi.mocked(ipcRenderer.invoke).mock.calls.length
  first.mockImplementation(() => expect(vi.mocked(ipcRenderer.invoke).mock.calls).toHaveLength(before))
  handler({} as Electron.IpcRendererEvent, { connectionId: "view", kind: "message", data: new Uint8Array([0, 255]), sequence: 7 })
  expect(first).toHaveBeenCalledExactlyOnceWith({ connectionId: "view", kind: "message", data: new Uint8Array([0, 255]) })
  expect(second).toHaveBeenCalledOnce()
  expect(vi.mocked(ipcRenderer.invoke).mock.calls.slice(before)).toEqual([[LOCAL_CHANNEL, "ack", ["view", 7]]])
  stopFirst()
  stopSecond()
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith(LOCAL_CHANNEL_EVENT, handler)
  await bridge.open({ connectionId: "view", machineId: "machine", teamId: "team", purpose: "agent" })
  await bridge.send("view", "test")
  await bridge.close("view")
  expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(LOCAL_CHANNEL, "close", ["view"])
})
