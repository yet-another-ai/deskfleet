import type { CentralApi } from "@deskfleet/client/central"
import { NATIVE_DESKTOP_CHANNEL } from "@deskfleet/client/native-desktop"
import type { IpcMainInvokeEvent } from "electron"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { ViewerCommand, ViewerEvent } from "./native-desktop-session.ts"

const { app, handle, removeHandler, invoke, spawnViewer } = vi.hoisted(() => ({
  app: { isPackaged: true, getAppPath: vi.fn(() => "/checkout/apps/desktop") },
  handle: vi.fn(), removeHandler: vi.fn(), invoke: vi.fn(), spawnViewer: vi.fn(),
}))
vi.mock("electron", () => ({
  app,
  ipcMain: { handle, removeHandler },
  ipcRenderer: { invoke },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: vi.fn(async () => {}) },
}))
vi.mock("./native-desktop-process.ts", () => ({ spawnDesktopViewer: spawnViewer }))
import { desktopApi } from "../preload/api.ts"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"
import { installNativeDesktop, nativeDesktopRequest } from "./native-desktop.ts"

const closing: (() => Promise<void>)[] = []
beforeEach(() => {
  vi.clearAllMocks()
  app.isPackaged = true
  vi.stubGlobal("process", { ...process, platform: "darwin", resourcesPath: "/Applications/DeskFleet.app/Contents/Resources" })
})
afterEach(async () => {
  await Promise.all(closing.splice(0).map(close => close()))
  vi.unstubAllGlobals()
})

function fixture() {
  const central = {
    onEvent: vi.fn(() => () => {}),
    machines: vi.fn(async () => [{ id: "machine", name: "Workstation" }]),
    rpc: vi.fn(async () => ({ displays: [{ id: 7, width: 1920, height: 1080, codecs: ["h264"] }] })),
    createPeer: vi.fn(async () => ({ peerId: "peer", authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [] })),
    offerPeer: vi.fn(async () => ({ sdp: "answer" })),
    candidatePeer: vi.fn(async () => {}), startPeer: vi.fn(async () => {}), closePeer: vi.fn(async () => {}),
  }
  const viewer = { send: vi.fn(), close: vi.fn(async () => {}) }
  spawnViewer.mockImplementation((_executable: string, receive: (event: ViewerEvent) => void) => {
    viewer.send.mockImplementation((command: ViewerCommand) => {
      if (command.type === "start") queueMicrotask(() => {
        receive({ type: "offer", sdp: "offer" })
        receive({ type: "connected" })
      })
      if (command.type === "answer") queueMicrotask(() => {
        receive({ type: "answerApplied" })
        receive({ type: "inputReady" })
        receive({ type: "videoReady" })
      })
    })
    queueMicrotask(() => receive({ type: "capabilities", codecs: ["h264"] }))
    return viewer
  })
  const host = installNativeDesktop(central as unknown as CentralApi)
  closing.push(host.close)
  const handler = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, value: unknown) => Promise<void>
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const event = { sender: { mainFrame }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  invoke.mockImplementation((channel: string, value: unknown) => {
    expect(channel).toBe(NATIVE_DESKTOP_CHANNEL)
    return handler(event, value)
  })
  return { central, viewer, host, handler, event }
}

test.each([true, false])("macOS exposes the native viewer and launches its executable (packaged=%s)", async packaged => {
  app.isPackaged = packaged
  const f = fixture()
  const request = { target: { teamId: "team", machineId: "machine" }, displayId: 7, control: true }
  const api = desktopApi()
  expect(api.nativeDesktop).toBeDefined()
  await api.nativeDesktop!.open(request)
  expect(invoke).toHaveBeenCalledExactlyOnceWith(NATIVE_DESKTOP_CHANNEL, request)
  expect(spawnViewer).toHaveBeenCalledExactlyOnceWith(packaged
    ? join(process.resourcesPath, "native", "deskfleet-viewer")
    : resolve(app.getAppPath(), "../../target/debug/deskfleet-viewer"), expect.any(Function))
  await vi.waitFor(() => expect(f.central.startPeer).toHaveBeenCalledExactlyOnceWith("peer", { displayId: 7, control: true }))
  expect(f.viewer.close).not.toHaveBeenCalled()
  await f.host.close()
  expect(f.viewer.close).toHaveBeenCalledOnce()
  expect(f.central.closePeer).toHaveBeenCalledExactlyOnceWith("peer")
  expect(removeHandler).toHaveBeenCalledWith(NATIVE_DESKTOP_CHANNEL)
})

test("macOS native viewer rejects unrelated renderers before creating a peer or window", async () => {
  const f = fixture()
  const request = { target: { teamId: "team", machineId: "machine" }, displayId: 7, control: false }
  await expect(f.handler({ ...f.event, senderFrame: null }, request)).rejects.toThrow("restricted")
  expect(f.central.createPeer).not.toHaveBeenCalled()
  expect(spawnViewer).not.toHaveBeenCalled()
})

test("native desktop requests preserve validated locale and theme", () => {
  const request = { target: { teamId: "team", machineId: "machine" }, displayId: 7, control: true, locale: "zh-CN", theme: "light" }
  expect(nativeDesktopRequest(request)).toEqual(request)
  expect(() => nativeDesktopRequest({ ...request, theme: "system" })).toThrow("theme")
  expect(() => nativeDesktopRequest({ ...request, locale: "\0" })).toThrow("locale")
})
