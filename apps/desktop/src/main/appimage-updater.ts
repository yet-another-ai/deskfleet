import { autoUpdater } from "electron"
import updaterModule from "electron-updater"
import { startAppImageRestart } from "./appimage-restart.ts"

/** Keep electron-updater's file replacement, but own the Linux restart handoff. */
export class RestartingAppImageUpdater extends updaterModule.AppImageUpdater {
  #restart: Promise<boolean> | undefined

  override quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    if (this.quitAndInstallCalled) return
    this.#restart = undefined
    const installed = this.install(isSilent, isSilent ? isForceRunAfter : this.autoRunAppAfterInstall)
    if (!installed) {
      this.quitAndInstallCalled = false
      return
    }

    // BaseUpdater quits immediately and AppImageUpdater discards spawnLog's
    // promise. Wait until our supervisor starts so a spawn failure keeps the
    // current app open and reaches the existing installer error callback.
    void (this.#restart ?? Promise.resolve(true)).then(() => {
      setImmediate(() => {
        autoUpdater.emit("before-quit-for-update")
        this.app.quit()
      })
    }, (error: unknown) => {
      this.quitAndInstallCalled = false
      this.dispatchError(error instanceof Error ? error : new Error(String(error)))
    })
  }

  protected override spawnLog(destination: string, _args: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    // AppImageUpdater passes an empty argument list, dropping launch flags.
    this.#restart = startAppImageRestart(destination, process.argv.slice(1), env)
    // The upstream install() API also calls this hook without awaiting it.
    void this.#restart.catch(() => {})
    return this.#restart
  }
}
