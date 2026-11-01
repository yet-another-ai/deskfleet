import { app, BrowserWindow, dialog, ipcMain } from "electron"
import { join, resolve } from "node:path"
import type { CentralApi } from "@deskfleet/client/central"
import { NATIVE_DESKTOP_CHANNEL, type NativeDesktopRequest } from "@deskfleet/client/native-desktop"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { spawnDesktopViewer } from "./native-desktop-process.ts"
import { openNativeDesktopSession } from "./native-desktop-session.ts"

export function nativeDesktopRequest(value: unknown): NativeDesktopRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native desktop request")
  const request = value as Record<string, unknown>
  if (!request.target || typeof request.target !== "object" || Array.isArray(request.target)) throw new Error("Invalid native desktop target")
  const target = request.target as Record<string, unknown>
  const identifier = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim() || value.length > 1024 || value.includes("\0")) throw new Error("Invalid native desktop target")
    return value
  }
  if (typeof request.displayId !== "number" || !Number.isSafeInteger(request.displayId) || request.displayId < 0) throw new Error("Invalid display identifier")
  if (typeof request.control !== "boolean") throw new Error("Invalid desktop control option")
  return { target: { teamId: identifier(target.teamId), machineId: identifier(target.machineId) }, displayId: request.displayId, control: request.control }
}

export function installNativeDesktop(central: CentralApi): { close(): Promise<void> } {
  const sessions = new Set<ReturnType<typeof openNativeDesktopSession>>()
  let closed = false
  ipcMain.handle(NATIVE_DESKTOP_CHANNEL, async (event, value: unknown) => {
    if (closed || !isDesktopMediaSender(event)) throw new Error("Native desktop IPC is restricted to the main renderer")
    if (process.platform !== "linux" && process.platform !== "win32") throw new Error("Native desktop windows are not available on this platform")
    const request = nativeDesktopRequest(value)
    const window = BrowserWindow.fromWebContents(event.sender)
    const name = process.platform === "win32" ? "deskfleet-viewer.exe" : "deskfleet-viewer"
    const executable = app.isPackaged
      ? join(process.resourcesPath, "native", name)
      : resolve(app.getAppPath(), "../../target/debug", name)
    let started = false
    const session = openNativeDesktopSession(central, request, receive => spawnDesktopViewer(executable, receive), error => {
      if (!started || closed) return
      const options = { type: "error" as const, title: "DeskFleet", message: "Remote desktop window disconnected", detail: error.message }
      const show = window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
      void show.catch(error => console.error("Native desktop error dialog failed", error))
    }, () => { sessions.delete(session) })
    sessions.add(session)
    await session.ready
    started = true
  })
  return {
    async close() {
      closed = true
      ipcMain.removeHandler(NATIVE_DESKTOP_CHANNEL)
      await Promise.all([...sessions].map(session => session.close()))
    },
  }
}
