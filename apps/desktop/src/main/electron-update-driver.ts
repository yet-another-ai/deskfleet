import { CancellationToken, type AppUpdater } from "electron-updater"
import type { UpdateDriver } from "./update-controller.ts"

export function electronUpdateDriver(updater: AppUpdater, channel = "latest"): UpdateDriver {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.channel = channel
  updater.allowPrerelease = channel !== "latest"
  // Setting channel enables downgrade internally, so set this afterwards.
  updater.allowDowngrade = false
  updater.disableWebInstaller = true
  // The published blockmap lets Windows reuse unchanged installer blocks; electron-updater
  // falls back to a full download when a differential download cannot be applied.
  updater.disableDifferentialDownload = false
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
    async download(progress, signal) {
      signal?.throwIfAborted()
      const cancellation = new CancellationToken()
      const abort = (): void => cancellation.cancel()
      signal?.addEventListener("abort", abort, { once: true })
      const listener = (info: { percent: number }): void => progress(info.percent)
      updater.on("download-progress", listener)
      try {
        await updater.downloadUpdate(cancellation)
      } finally {
        signal?.removeEventListener("abort", abort)
        updater.removeListener("download-progress", listener)
      }
    },
    install(failed, silent = false) {
      installFailed = failed
      updater.autoRunAppAfterInstall = !silent
      updater.quitAndInstall(silent, !silent)
    },
    close() {
      installFailed = undefined
      // Keep an error listener for any in-flight request during normal shutdown.
      updater.autoInstallOnAppQuit = false
    },
  }
}
