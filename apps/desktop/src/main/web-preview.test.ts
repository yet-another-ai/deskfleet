import { EventEmitter } from "node:events"
import { expect, test, vi } from "vitest"
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
}))

import { installWebPreview, parseLoopbackHttpOrigin, WEB_PREVIEW_PARTITION, WebPreviewController } from "./web-preview.ts"

function createMockWebContents(url = BUNDLED_RENDERER_URL, id = 1) {
  return Object.assign(new EventEmitter(), {
    id,
    mainFrame: { url },
    getURL: () => url,
    isDestroyed: vi.fn(() => false),
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  })
}

test("loopback HTTP origin parsing rejects non-loopback hosts, credentials, HTTPS, and empty URLs", () => {
  expect(parseLoopbackHttpOrigin("http://localhost:5173/docs")).toBe("http://localhost:5173")
  expect(parseLoopbackHttpOrigin("http://localhost:80")).toBe("http://localhost")
  expect(parseLoopbackHttpOrigin("http://127.0.0.1:41000/")).toBe("http://127.0.0.1:41000")
  expect(parseLoopbackHttpOrigin("http://[::1]:8080/app")).toBe("http://[::1]:8080")

  for (const bad of [
    "",
    "about:blank",
    "https://localhost:5173",
    "http://user:pass@localhost:5173",
    "http://192.168.1.10:3000",
    "http://example.com:3000",
    "file:///etc/passwd",
    "http://127.0.0.1:3000\0",
  ]) {
    expect(parseLoopbackHttpOrigin(bad)).toBeNull()
  }
})

test("will-attach-webview enforces main renderer, sandboxed temp partition, and per-webview origin pinning", () => {
  const controller = new WebPreviewController()
  const owner = createMockWebContents()
  controller.attachWindow({ webContents: owner as unknown as Electron.WebContents })

  expect(mockFromPartition).toHaveBeenCalledWith(WEB_PREVIEW_PARTITION)
  expect((mockSession.setPermissionCheckHandler.mock.calls.at(-1)![0] as () => boolean)()).toBe(false)
  const permCb = vi.fn()
  ;(mockSession.setPermissionRequestHandler.mock.calls.at(-1)![0] as (_w: unknown, _p: unknown, cb: (allowed: boolean) => void) => void)(null, "media", permCb)
  expect(permCb).toHaveBeenCalledWith(false)

  for (const src of ["", "about:blank", "https://localhost:5173", "http://example.com:3000"]) {
    const blocked = { preventDefault: vi.fn() }
    owner.emit("will-attach-webview", blocked, {}, { src })
    expect(blocked.preventDefault).toHaveBeenCalledOnce()
  }

  const untrustedOwner = createMockWebContents("https://evil.example", 2)
  controller.attachWindow({ webContents: untrustedOwner as unknown as Electron.WebContents })
  const untrustedAttach = { preventDefault: vi.fn() }
  untrustedOwner.emit("will-attach-webview", untrustedAttach, {}, { src: "http://127.0.0.1:5173/" })
  expect(untrustedAttach.preventDefault).toHaveBeenCalledOnce()

  const allowedEvent = { preventDefault: vi.fn() }
  const prefs: Record<string, unknown> = {
    preload: "/evil.js",
    preloadURL: "file:///evil.js",
    partition: "persist:hijack",
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    allowRunningInsecureContent: true,
    experimentalFeatures: true,
    webviewTag: true,
  }
  owner.emit("will-attach-webview", allowedEvent, prefs, { src: "http://127.0.0.1:5173/dashboard" })
  expect(allowedEvent.preventDefault).not.toHaveBeenCalled()
  expect(prefs).toMatchObject({
    partition: WEB_PREVIEW_PARTITION,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
  })
  expect(prefs.preload).toBeUndefined()
  expect(prefs.preloadURL).toBeUndefined()

  const guest1 = createMockWebContents("http://127.0.0.1:5173/dashboard", 42)
  owner.emit("did-attach-webview", {}, guest1)
  expect((guest1.setWindowOpenHandler.mock.calls[0]![0] as () => { action: string })()).toEqual({ action: "deny" })

  // Second webview pinned to a different loopback origin must stay isolated from the first guest.
  owner.emit("will-attach-webview", { preventDefault: vi.fn() }, {}, { src: "http://127.0.0.1:3000/" })
  owner.emit("did-attach-webview", {}, createMockWebContents("http://127.0.0.1:3000/", 43))

  const navOk = { isMainFrame: true, preventDefault: vi.fn() }
  guest1.emit("will-navigate", navOk, "http://127.0.0.1:5173/other")
  expect(navOk.preventDefault).not.toHaveBeenCalled()

  for (const forbidden of ["https://example.com", "http://127.0.0.1:3000/other-tab"]) {
    const blockedNav = { isMainFrame: true, preventDefault: vi.fn() }
    guest1.emit("will-redirect", blockedNav, forbidden)
    expect(blockedNav.preventDefault).toHaveBeenCalledOnce()
  }

  controller.openDevTools(owner as unknown as Electron.WebContents, 42)
  expect(guest1.openDevTools).toHaveBeenCalledWith({ mode: "detach", activate: true })

  const otherOwner = createMockWebContents(BUNDLED_RENDERER_URL, 99)
  expect(() => controller.openDevTools(otherOwner as unknown as Electron.WebContents, 42)).toThrow("does not belong")

  controller.close()
})

test("IPC handler restricts DevTools to the main renderer and unregisters on close", async () => {
  const installed = installWebPreview()
  const [channel, handler] = mockHandle.mock.calls.at(-1)! as [
    string,
    (event: unknown, guestWebContentsId: unknown) => Promise<void>,
  ]
  expect(channel).toBe(WEB_PREVIEW_IPC_CHANNEL)
  const sender = createMockWebContents()
  await expect(handler({ sender, senderFrame: { url: "https://untrusted.example" } }, 42)).rejects.toThrow("restricted")
  await expect(handler({ sender, senderFrame: sender.mainFrame }, "42")).rejects.toThrow("Invalid web preview guest ID")

  installed.close()
  expect(mockRemoveHandler).toHaveBeenCalledWith(WEB_PREVIEW_IPC_CHANNEL)
})
