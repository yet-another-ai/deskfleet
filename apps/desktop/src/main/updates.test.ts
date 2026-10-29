import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { UPDATES_CHANNEL, UPDATES_CHANGED_EVENT, type UpdateState } from "../../../../packages/client/src/updates.ts"
import type { BackgroundLifecycle } from "./lifecycle.ts"
import type { UpdateController } from "./update-controller.ts"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"

const { handle, app, loadUpdater, createDriver, driver } = vi.hoisted(() => ({
  handle: vi.fn(), app: { isPackaged: false, getVersion: () => "0.1.0" }, loadUpdater: vi.fn(), createDriver: vi.fn(),
  driver: { check: vi.fn(), download: vi.fn(), install: vi.fn(), close: vi.fn() },
}))
vi.mock("electron", () => ({ ipcMain: { handle }, app }))
vi.mock("electron-updater", () => { loadUpdater(); return { default: { autoUpdater: {} } } })
vi.mock("./electron-update-driver.ts", () => ({ electronUpdateDriver: createDriver }))
import { attachUpdates, installUpdateIpc, installUpdates, publishUpdateState } from "./updates.ts"

const renderers: EventEmitter[] = []
const controllers: UpdateController[] = []
const originalPlatform = process.platform
beforeEach(() => {
  vi.clearAllMocks()
  app.isPackaged = false
  createDriver.mockReturnValue(driver)
  driver.check.mockResolvedValue("0.2.0")
  driver.download.mockResolvedValue(undefined)
  driver.install.mockReset()
})
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.emit("destroyed")
  for (const controller of controllers.splice(0)) controller.close()
  Object.defineProperty(process, "platform", { value: originalPlatform })
  vi.unstubAllEnvs()
})

function renderer() {
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const sender = Object.assign(new EventEmitter(), { mainFrame, send: vi.fn(), isDestroyed: vi.fn(() => false) })
  renderers.push(sender)
  return {
    sender,
    window: { webContents: sender } as unknown as BrowserWindow,
    event: { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
  }
}

function installIpc() {
  const controller = {
    get: vi.fn((): UpdateState => ({ status: "available", version: "0.2.0" })),
    check: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
  }
  installUpdateIpc(controller as unknown as UpdateController)
  expect(handle).toHaveBeenCalledWith(UPDATES_CHANNEL, expect.any(Function))
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, method?: unknown) => Promise<unknown>
  return { controller, invoke }
}

function lifecycle(): BackgroundLifecycle {
  return { quitting: false, quit: vi.fn(), setInstallingUpdate: vi.fn() }
}

test("development installs disabled IPC without importing or creating the updater", async () => {
  const controller = await installUpdates(lifecycle(), vi.fn())
  controllers.push(controller)
  expect(controller.get()).toEqual({ status: "disabled", currentVersion: "0.1.0" })
  expect(loadUpdater).not.toHaveBeenCalled()
  expect(createDriver).not.toHaveBeenCalled()
  expect(handle).toHaveBeenCalledWith(UPDATES_CHANNEL, expect.any(Function))
})

test("extracted Linux bundles are disabled while AppImage installs can update", async () => {
  app.isPackaged = true
  Object.defineProperty(process, "platform", { value: "linux" })
  vi.stubEnv("APPIMAGE", "")
  const extracted = await installUpdates(lifecycle(), vi.fn())
  controllers.push(extracted)
  expect(extracted.get()).toEqual({ status: "disabled", currentVersion: "0.1.0" })
  expect(createDriver).not.toHaveBeenCalled()
  vi.stubEnv("APPIMAGE", "/opt/deskfleet.AppImage")
  const appImage = await installUpdates(lifecycle(), vi.fn())
  controllers.push(appImage)
  expect(appImage.get()).toEqual({ status: "idle", currentVersion: "0.1.0" })
  expect(createDriver).toHaveBeenCalledOnce()
})

test("update IPC only accepts registered application main frames", async () => {
  const { invoke, controller } = installIpc()
  const main = renderer()
  await expect(invoke(main.event, "install")).rejects.toThrow("restricted")
  attachUpdates(main.window)
  await expect(invoke({ ...main.event, senderFrame: null } as unknown as IpcMainInvokeEvent, "install")).rejects.toThrow("restricted")
  await expect(invoke({ ...main.event, senderFrame: { ...main.sender.mainFrame } } as IpcMainInvokeEvent, "install")).rejects.toThrow("restricted")
  main.sender.mainFrame.url = "https://example.com/"
  await expect(invoke(main.event, "install")).rejects.toThrow("restricted")
  main.sender.mainFrame.url = BUNDLED_RENDERER_URL
  await expect(invoke(main.event, "get")).resolves.toEqual({ ok: true, value: { status: "available", version: "0.2.0" } })
  await expect(invoke(main.event, "install")).resolves.toEqual({ ok: true, value: undefined })
  expect(controller.install).toHaveBeenCalledOnce()
  main.sender.emit("destroyed")
  await expect(invoke(main.event, "get")).rejects.toThrow("restricted")
})

test("IPC rejects unknown operations and returns controller errors", async () => {
  const { invoke, controller } = installIpc()
  const main = renderer()
  attachUpdates(main.window)
  await expect(invoke(main.event, "download")).resolves.toEqual({ ok: false, error: "Unknown update operation" })
  expect(controller.install).not.toHaveBeenCalled()
  controller.get.mockImplementationOnce(() => { throw new Error("Unavailable") })
  await expect(invoke(main.event, "get")).resolves.toEqual({ ok: false, error: "Unavailable" })
  controller.install.mockRejectedValueOnce(new Error("Shutdown failed"))
  await expect(invoke(main.event, "install")).resolves.toEqual({ ok: false, error: "Shutdown failed" })
})

test("manual check IPC returns the checked state without authorizing installation", async () => {
  const { invoke, controller } = installIpc()
  const main = renderer()
  attachUpdates(main.window)
  await expect(invoke(main.event, "check")).resolves.toEqual({ ok: true, value: { status: "available", version: "0.2.0" } })
  expect(controller.check).toHaveBeenCalledOnce()
  expect(controller.install).not.toHaveBeenCalled()
  controller.check.mockRejectedValueOnce(new Error("Offline"))
  await expect(invoke(main.event, "check")).resolves.toEqual({ ok: false, error: "Offline" })
  expect(controller.install).not.toHaveBeenCalled()
})

test("state broadcasts reach attached live renderers and stop after destruction", () => {
  const main = renderer()
  const unopened = renderer()
  const destroyed = renderer()
  attachUpdates(main.window)
  attachUpdates(destroyed.window)
  destroyed.sender.isDestroyed.mockReturnValue(true)
  const state: UpdateState = { status: "downloading", version: "0.2.0", percent: 42 }
  publishUpdateState(state)
  expect(main.sender.send).toHaveBeenCalledExactlyOnceWith(UPDATES_CHANGED_EVENT, state)
  expect(unopened.sender.send).not.toHaveBeenCalled()
  expect(destroyed.sender.send).not.toHaveBeenCalled()
  main.sender.emit("destroyed")
  main.sender.send.mockClear()
  publishUpdateState(state)
  expect(main.sender.send).not.toHaveBeenCalled()
})

test.each(["event", "throw"])("installer failure via %s restores tray quit behavior", async failure => {
  app.isPackaged = true
  Object.defineProperty(process, "platform", { value: "win32" })
  const background = lifecycle()
  const beforeInstall = vi.fn().mockResolvedValue(undefined)
  const controller = await installUpdates(background, beforeInstall)
  controllers.push(controller)
  await controller.check()
  if (failure === "throw") driver.install.mockImplementationOnce(() => { throw new Error("Cannot launch installer") })
  const install = controller.install()
  if (failure === "throw") await expect(install).rejects.toThrow("Cannot launch installer")
  else {
    await install
    driver.install.mock.calls[0]![0](new Error("Cannot launch installer"))
  }
  expect(beforeInstall).toHaveBeenCalledOnce()
  expect(background.setInstallingUpdate).toHaveBeenNthCalledWith(1, true)
  expect(background.setInstallingUpdate).toHaveBeenNthCalledWith(2, false)
  expect(background.quit).not.toHaveBeenCalled()
  expect(controller.get()).toMatchObject({ status: "error", error: "Cannot launch installer" })
})

test("failed service shutdown never arms updater quit or launches the installer", async () => {
  app.isPackaged = true
  Object.defineProperty(process, "platform", { value: "darwin" })
  const background = lifecycle()
  const controller = await installUpdates(background, vi.fn().mockRejectedValue(new Error("Daemon still running")))
  controllers.push(controller)
  await controller.check()
  await expect(controller.install()).rejects.toThrow("Daemon still running")
  expect(background.setInstallingUpdate).not.toHaveBeenCalled()
  expect(driver.install).not.toHaveBeenCalled()
})
