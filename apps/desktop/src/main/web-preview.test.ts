import { EventEmitter } from "node:events"
import { expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent } from "@deskfleet/client/central"
import { WEB_PREVIEW_IPC_CHANNEL } from "../../../../packages/client/src/web-preview.ts"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"

const { mockSession, mockFromPartition, mockHandle, mockRemoveHandler } = vi.hoisted(() => {
  const sessionMock = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
  }
  return {
    mockSession: sessionMock,
    mockFromPartition: vi.fn(() => sessionMock),
    mockHandle: vi.fn(),
    mockRemoveHandler: vi.fn(),
  }
})

vi.mock("electron", () => ({
  ipcMain: { handle: mockHandle, removeHandler: mockRemoveHandler },
  session: { fromPartition: mockFromPartition },
  webContents: { fromId: vi.fn() },
}))

import { installWebPreview, isLoopbackHttpOrigin, WEB_PREVIEW_PARTITION, WebPreviewController } from "./web-preview.ts"

function createMockWebContents(url = BUNDLED_RENDERER_URL, id = 1) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    id,
    mainFrame: { url },
    getURL: () => url,
    isDestroyed: vi.fn(() => false),
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  })
}

function createCentral() {
  let listener: ((event: CentralEvent) => void) | undefined
  const central: Pick<CentralApi, "onEvent"> = {
    onEvent: cb => {
      listener = cb
      return () => { listener = undefined }
    },
  }
  return {
    central,
    emitAccountChanged: () => listener?.({ type: "accountChanged" }),
  }
}

test("loopback HTTP origin validation rejects non-loopback hosts, credentials, and HTTPS", () => {
  expect(isLoopbackHttpOrigin("http://localhost:5173")).toBe(true)
  expect(isLoopbackHttpOrigin("http://localhost")).toBe(true)
  expect(isLoopbackHttpOrigin("http://127.0.0.1:41000")).toBe(true)
  expect(isLoopbackHttpOrigin("http://[::1]:8080")).toBe(true)

  for (const bad of [
    "",
    "https://localhost:5173",
    "http://localhost:80",
    "http://localhost:5173/",
    "http://user:pass@localhost:5173",
    "http://192.168.1.10:3000",
    "http://example.com:3000",
    "file:///etc/passwd",
    "http://127.0.0.1:3000\0",
  ]) {
    expect(isLoopbackHttpOrigin(bad)).toBe(false)
  }
})

test("will-attach-webview strips preload, forces sandboxed temp partition, and restricts src and navigations", () => {
  const { central, emitAccountChanged } = createCentral()
  const controller = new WebPreviewController(central)
  const owner = createMockWebContents()
  controller.attachWindow({ webContents: owner as unknown as Electron.WebContents })

  expect(mockFromPartition).toHaveBeenCalledWith(WEB_PREVIEW_PARTITION)
  const checkHandler = mockSession.setPermissionCheckHandler.mock.calls.at(-1)![0] as () => boolean
  expect(checkHandler()).toBe(false)
  const reqHandler = mockSession.setPermissionRequestHandler.mock.calls.at(-1)![0] as (_w: unknown, _p: unknown, cb: (allowed: boolean) => void) => void
  const permCb = vi.fn()
  reqHandler(null, "media", permCb)
  expect(permCb).toHaveBeenCalledWith(false)

  const blockedEvent = { preventDefault: vi.fn() }
  const blockedPrefs: Record<string, unknown> = { preload: "/evil.js", nodeIntegration: true }
  owner.emit("will-attach-webview", blockedEvent, blockedPrefs, { src: "http://127.0.0.1:5173/app" })
  expect(blockedEvent.preventDefault).toHaveBeenCalledOnce()

  const grantId = controller.allowOrigin(owner as unknown as Electron.WebContents, "http://127.0.0.1:5173")
  const allowedEvent = { preventDefault: vi.fn() }
  const allowedPrefs: Record<string, unknown> = {
    preload: "/evil.js",
    preloadURL: "file:///evil.js",
    partition: "persist:hijack",
    nodeIntegration: true,
    nodeIntegrationInWorker: true,
    nodeIntegrationInSubFrames: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    experimentalFeatures: true,
    webviewTag: true,
  }
  owner.emit("will-attach-webview", allowedEvent, allowedPrefs, { src: "http://127.0.0.1:5173/dashboard" })
  expect(allowedEvent.preventDefault).not.toHaveBeenCalled()
  expect(allowedPrefs).toMatchObject({
    partition: WEB_PREVIEW_PARTITION,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
  })
  expect(allowedPrefs.preload).toBeUndefined()
  expect(allowedPrefs.preloadURL).toBeUndefined()

  const guest = createMockWebContents("http://127.0.0.1:5173/dashboard", 42)
  owner.emit("did-attach-webview", {}, guest)
  expect(guest.setWindowOpenHandler).toHaveBeenCalledOnce()
  const windowOpen = guest.setWindowOpenHandler.mock.calls[0]![0] as () => { action: string }
  expect(windowOpen()).toEqual({ action: "deny" })

  const navOk = { isMainFrame: true, preventDefault: vi.fn() }
  guest.emit("will-navigate", navOk, "http://127.0.0.1:5173/other")
  expect(navOk.preventDefault).not.toHaveBeenCalled()

  const navExternal = { isMainFrame: true, preventDefault: vi.fn() }
  guest.emit("will-navigate", navExternal, "https://example.com")
  expect(navExternal.preventDefault).toHaveBeenCalledOnce()

  const navOtherPort = { isMainFrame: true, preventDefault: vi.fn() }
  guest.emit("will-redirect", navOtherPort, "http://127.0.0.1:9999")
  expect(navOtherPort.preventDefault).toHaveBeenCalledOnce()

  controller.openDevTools(owner as unknown as Electron.WebContents, 42)
  expect(guest.openDevTools).toHaveBeenCalledWith({ mode: "detach", activate: true })

  const otherOwner = createMockWebContents(BUNDLED_RENDERER_URL, 99)
  expect(() => controller.openDevTools(otherOwner as unknown as Electron.WebContents, 42)).toThrow("does not belong")

  controller.revokeOrigin(owner as unknown as Electron.WebContents, grantId)
  const navRevoked = { isMainFrame: true, preventDefault: vi.fn() }
  guest.emit("will-navigate", navRevoked, "http://127.0.0.1:5173/after-revoke")
  expect(navRevoked.preventDefault).toHaveBeenCalledOnce()

  controller.allowOrigin(owner as unknown as Electron.WebContents, "http://localhost:3000")
  emitAccountChanged()
  expect(controller.isAllowedUrl(owner as unknown as Electron.WebContents, "http://localhost:3000/")).toBe(false)

  controller.close()
})

test("IPC handler restricts callers to the main renderer and unregisters on close", async () => {
  const { central } = createCentral()
  const installed = installWebPreview(central)
  const [channel, handler] = mockHandle.mock.calls.at(-1)! as [
    string,
    (event: unknown, method: unknown, args: unknown) => Promise<unknown>,
  ]
  expect(channel).toBe(WEB_PREVIEW_IPC_CHANNEL)
  const sender = createMockWebContents()
  await expect(handler({ sender, senderFrame: { url: "https://untrusted.example" } }, "allowOrigin", ["http://localhost:5173"]))
    .rejects.toThrow("restricted")

  const grant = await handler({ sender, senderFrame: sender.mainFrame }, "allowOrigin", ["http://localhost:5173"])
  expect(typeof grant).toBe("string")
  await handler({ sender, senderFrame: sender.mainFrame }, "revokeOrigin", [grant])

  installed.close()
  expect(mockRemoveHandler).toHaveBeenCalledWith(WEB_PREVIEW_IPC_CHANNEL)
})
