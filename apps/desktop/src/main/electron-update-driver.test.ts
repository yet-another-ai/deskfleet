import { EventEmitter } from "node:events"
import type { AppUpdater } from "electron-updater"
import { expect, test, vi } from "vitest"
import { electronUpdateDriver } from "./electron-update-driver.ts"

function updater() {
  const mock = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
    disableWebInstaller: false, disableDifferentialDownload: false,
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } }),
    downloadUpdate: vi.fn().mockResolvedValue(["installer.exe"]),
    quitAndInstall: vi.fn(),
  })
  let channel = ""
  Object.defineProperty(mock, "channel", {
    get: () => channel,
    set: value => { channel = value; mock.allowDowngrade = true },
  })
  return { mock, api: mock as unknown as AppUpdater, channel: () => channel }
}

test("stable update policy requires a click, never installs on ordinary quit, and never downgrades", async () => {
  const { mock, api, channel } = updater()
  const driver = electronUpdateDriver(api)
  expect(channel()).toBe("latest")
  expect(mock).toMatchObject({
    autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false,
    disableWebInstaller: true, disableDifferentialDownload: true,
  })
  expect(await driver.check()).toBe("0.2.0")
  expect(mock.downloadUpdate).not.toHaveBeenCalled()
  expect(mock.quitAndInstall).not.toHaveBeenCalled()
  driver.close()
  expect(mock.autoInstallOnAppQuit).toBe(false)
})

test("an explicit prerelease channel allows prereleases without enabling downgrade", () => {
  const { mock, api, channel } = updater()
  electronUpdateDriver(api, "beta")
  expect(channel()).toBe("beta")
  expect(mock.allowPrerelease).toBe(true)
  expect(mock.allowDowngrade).toBe(false)
})

test("check reports no update when the provider returns no newer version", async () => {
  const { mock, api } = updater()
  const driver = electronUpdateDriver(api)
  mock.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: { version: "0.1.0" } })
  expect(await driver.check()).toBeNull()
  mock.checkForUpdates.mockResolvedValueOnce(null)
  expect(await driver.check()).toBeNull()
})

test.each([false, true])("download progress listeners are removed when download rejects=%s", async fails => {
  const { mock, api } = updater()
  const driver = electronUpdateDriver(api)
  const progress = vi.fn()
  mock.downloadUpdate.mockImplementationOnce(async () => {
    mock.emit("download-progress", { percent: 38 })
    if (fails) throw new Error("Disconnected")
    return ["installer.exe"]
  })
  const downloading = driver.download(progress)
  if (fails) await expect(downloading).rejects.toThrow("Disconnected")
  else await downloading
  expect(progress).toHaveBeenCalledWith(38)
  expect(mock.listenerCount("download-progress")).toBe(0)
})

test("installation is explicit and reports asynchronous installer failure once", () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const { mock, api } = updater()
  const driver = electronUpdateDriver(api)
  const failed = vi.fn()
  driver.install(failed)
  expect(mock.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true)
  const error = new Error("Installer refused")
  mock.emit("error", error)
  mock.emit("error", error)
  expect(failed).toHaveBeenCalledExactlyOnceWith(error)
  driver.close()
  expect(() => mock.emit("error", new Error("Late request failure"))).not.toThrow()
})
