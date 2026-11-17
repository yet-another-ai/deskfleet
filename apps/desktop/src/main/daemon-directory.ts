import { app } from "electron"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

/** The desktop profile owns its hosted Agent and every local connection to it. */
export function desktopDaemonDirectory(): string {
  return join(app.getPath("userData"), "daemon")
}

/**
 * Default Linux and Windows profiles keep Agent files outside config/roaming
 * directories that terminal sandboxes block; `--user-data-dir` stays isolated.
 */
export function desktopWorkspaceDirectory(): string {
  const userData = resolve(app.getPath("userData"))
  if (process.platform !== "linux" && process.platform !== "win32") return join(userData, "daemon")
  const appData = resolve(app.getPath("appData"))
  const parent = dirname(userData)
  const inAppData = process.platform === "win32" ? parent.toLowerCase() === appData.toLowerCase() : parent === appData
  if (!inAppData) return join(userData, "daemon")
  const dataRoot = process.platform === "win32"
    ? process.env.LOCALAPPDATA && isAbsolute(process.env.LOCALAPPDATA) ? process.env.LOCALAPPDATA : join(homedir(), "AppData", "Local")
    : process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share")
  return join(resolve(dataRoot), basename(userData), "daemon")
}
