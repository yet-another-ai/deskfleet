import type { AppUpdater } from "electron-updater"
import type { UpdateDriver } from "./update-controller.ts"

export function electronUpdateDriver(updater: AppUpdater, channel = "latest"): UpdateDriver {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.channel = channel
  updater.allowPrerelease = channel !== "latest"
  // Setting channel enables downgrade internally, so set this afterwards.
  updater.allowDowngrade = false
  updater.disableWebInstaller = true
  updater.disableDifferentialDownload = true
  let installFailed: ((error: Error) => void) | undefined
  updater.on("error", (error: Error) => {
    console.error("Application update failed", error)
    const failed = installFailed
    installFailed = undefined
    failed?.(error)
  })
  return {
    async check() {
      const result = await updater.checkForUpdates()
      return result?.isUpdateAvailable ? result.updateInfo.version : null
    },
    async download(progress) {
      const listener = (info: { percent: number }): void => progress(info.percent)
      updater.on("download-progress", listener)
      try {
        await updater.downloadUpdate()
      } finally {
        updater.removeListener("download-progress", listener)
      }
    },
    install(failed) {
      installFailed = failed
      updater.quitAndInstall(false, true)
    },
    close() {
      installFailed = undefined
      // Keep an error listener for any in-flight request during normal shutdown.
      updater.autoInstallOnAppQuit = false
    },
  }
}
