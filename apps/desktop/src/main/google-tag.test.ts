import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { beforeEach, expect, test, vi } from "vitest"
import type { GoogleTagMessage } from "@deskfleet/client/google-tag"

const { handle, createdHosts } = vi.hoisted(() => ({
  handle: vi.fn(),
  createdHosts: [] as Array<{ send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
}))
vi.mock("electron", () => ({ ipcMain: { handle } }))
vi.mock("./google-tag-host.ts", () => ({
  DesktopGoogleTagHost: class {
    send = vi.fn().mockResolvedValue(undefined)
    close = vi.fn()
    constructor() { createdHosts.push(this) }
  },
}))
import { GOOGLE_TAG_CHANNEL } from "../shared/google-tag-bridge.ts"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"
import { attachGoogleTag, installGoogleTag } from "./google-tag.ts"

beforeEach(() => {
  vi.clearAllMocks()
  createdHosts.length = 0
})

function renderer() {
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const sender = Object.assign(new EventEmitter(), { mainFrame })
  const window = { webContents: sender } as unknown as BrowserWindow
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  return { sender, mainFrame, window, event }
}

test("only a registered main renderer can send Google Tag commands", async () => {
  installGoogleTag()
  expect(handle).toHaveBeenCalledWith(GOOGLE_TAG_CHANNEL, expect.any(Function))
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, message: GoogleTagMessage) => Promise<void>
  const { sender, mainFrame, window, event } = renderer()
  const message: GoogleTagMessage = { type: "gtag", args: ["event", "app_opened", { app_platform: "windows" }] }

  expect(() => invoke(event, message)).toThrow("restricted")
  attachGoogleTag(window)
  expect(() => invoke({ ...event, senderFrame: null } as IpcMainInvokeEvent, message)).toThrow("restricted")
  expect(() => invoke({ ...event, senderFrame: { ...mainFrame } } as IpcMainInvokeEvent, message)).toThrow("restricted")
  mainFrame.url = "https://example.test/"
  expect(() => invoke(event, message)).toThrow("restricted")
  expect(createdHosts[0]!.send).not.toHaveBeenCalled()

  mainFrame.url = `${BUNDLED_RENDERER_URL}#/sessions/session-1`
  await invoke(event, structuredClone(message))
  expect(createdHosts[0]!.send).toHaveBeenCalledExactlyOnceWith(message)
  sender.emit("destroyed")
  expect(() => invoke(event, message)).toThrow("restricted")
})

test("closes only the owning tag host on document navigation, renderer exit, or destruction", () => {
  const first = renderer(), second = renderer()
  attachGoogleTag(first.window)
  attachGoogleTag(second.window)
  const firstHost = createdHosts[0]!, secondHost = createdHosts[1]!

  first.sender.emit("did-start-navigation", {}, `${BUNDLED_RENDERER_URL}#/settings`, true, true)
  first.sender.emit("did-start-navigation", {}, "https://example.test/", false, false)
  expect(firstHost.close).not.toHaveBeenCalled()
  first.sender.emit("did-start-navigation", {}, BUNDLED_RENDERER_URL, false, true)
  expect(firstHost.close).toHaveBeenCalledTimes(1)
  first.sender.emit("render-process-gone", {}, { reason: "crashed" })
  expect(firstHost.close).toHaveBeenCalledTimes(2)
  first.sender.emit("destroyed")
  expect(firstHost.close).toHaveBeenCalledTimes(3)
  expect(secondHost.close).not.toHaveBeenCalled()
  second.sender.emit("destroyed")
  expect(secondHost.close).toHaveBeenCalledOnce()
})
