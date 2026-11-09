import { app, ipcMain, type BrowserWindow, type WebContents } from "electron"
import { UPDATES_CHANNEL, UPDATES_CHANGED_EVENT, type UpdateState } from "../../../../packages/client/src/updates.ts"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import { electronUpdateDriver } from "./electron-update-driver.ts"
import type { BackgroundLifecycle } from "./lifecycle.ts"
import { UpdateController, type UpdateDriver } from "./update-controller.ts"

const renderers = new Set<WebContents>()

export function attachUpdates(window: BrowserWindow): void {
  const contents = window.webContents
  renderers.add(contents)
  contents.once("destroyed", () => renderers.delete(contents))
}

export function publishUpdateState(state: UpdateState): void {
  for (const contents of renderers) {
    if (!contents.isDestroyed()) contents.send(UPDATES_CHANGED_EVENT, state)
  }
}

export function installUpdateIpc(controller: UpdateController): void {
  ipcMain.handle(UPDATES_CHANNEL, async (event, method: unknown) => {
    if (!renderers.has(event.sender) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || !isMainRendererUrl(event.senderFrame.url)) {
      throw new Error("Update IPC is restricted to application renderers")
    }
    try {
      if (method === "get") return { ok: true, value: controller.get() }
      if (method === "check") {
        await controller.check()
        return { ok: true, value: controller.get() }
      }
      if (method !== "install") throw new Error("Unknown update operation")
      await controller.install()
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function nixManagedDarwinInstall(): boolean {
  if (process.platform !== "darwin") return false
  // nix-darwin copies the app bundle to /Applications/Nix Apps; direct store
  // launches are also possible. Nix owns upgrades for both, so electron-updater
  // must not try to replace the read-only bundle.
  const executable = app.getPath("exe")
  return executable.startsWith("/nix/store/") || executable.includes("/Applications/Nix Apps/")
}

export async function installUpdates(lifecycle: BackgroundLifecycle, beforeInstall: () => Promise<void>): Promise<UpdateController> {
  // Development launches, extracted Linux bundles, and Nix-managed macOS
  // installs have no installable update target.
  const enabled = app.isPackaged
    && !nixManagedDarwinInstall()
    && (process.platform !== "linux" || Boolean(process.env.APPIMAGE))
  let driver: UpdateDriver | null = null
  if (enabled) {
    const { default: module } = await import("electron-updater")
    const updater = electronUpdateDriver(module.autoUpdater)
    driver = {
      ...updater,
      install(failed) {
        lifecycle.setInstallingUpdate(true)
        try {
          updater.install(error => { lifecycle.setInstallingUpdate(false); failed(error) })
        } catch (error) {
          lifecycle.setInstallingUpdate(false)
          throw error
        }
      },
    }
  }
  const controller = new UpdateController(driver, publishUpdateState, beforeInstall, app.getVersion())
  installUpdateIpc(controller)
  return controller
}
