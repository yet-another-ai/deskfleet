import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { app, ipcMain, type BrowserWindow, type WebContents } from "electron"
import { WINDOWS_DESKTOP_SERVICE_CHANNEL } from "../../../../packages/client/src/windows-desktop-service.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { WindowsDesktopServiceController } from "./windows-desktop-service-controller.ts"

const execute = promisify(execFile)
const renderers = new Set<WebContents>()

export function attachWindowsDesktopService(window: BrowserWindow): void {
  const contents = window.webContents
  renderers.add(contents)
  contents.once("destroyed", () => renderers.delete(contents))
}

export function installWindowsDesktopServiceIpc(controller: WindowsDesktopServiceController): void {
  ipcMain.handle(WINDOWS_DESKTOP_SERVICE_CHANNEL, async (event, method: unknown, enabled: unknown) => {
    if (!renderers.has(event.sender) || !isDesktopMediaSender(event)) {
      throw new Error("Windows desktop service IPC is restricted to the main renderer")
    }
    try {
      if (method === "get") return { ok: true, value: await controller.get() }
      if (method !== "setEnabled") throw new Error("Unknown Windows desktop service operation")
      if (typeof enabled !== "boolean") throw new Error("Windows desktop service setting must be a boolean")
      return { ok: true, value: await controller.setEnabled(enabled) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

export function installWindowsDesktopService(): WindowsDesktopServiceController | undefined {
  if (process.platform !== "win32") return
  const executable = app.isPackaged
    ? join(process.resourcesPath, "windows", "deskfleet-desktop-service.exe")
    : join(import.meta.dirname, "../windows/deskfleet-desktop-service.exe")
  const controller = new WindowsDesktopServiceController(existsSync(executable), async command => {
    // The helper owns UAC elevation. No renderer value becomes an executable, path,
    // shell expression, or arbitrary service command.
    const { stdout } = await execute(executable, [command], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
      ...(command === "status" ? { timeout: 10_000 } : {}),
    })
    return stdout
  })
  installWindowsDesktopServiceIpc(controller)
  return controller
}
