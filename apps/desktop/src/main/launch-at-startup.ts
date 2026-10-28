import { app } from "electron"
import type { LaunchAtStartupState } from "../../../../packages/client/src/settings.ts"

function available(): boolean {
  // Development runs use Electron's executable, not the installed DeskFleet app.
  return app.isPackaged && (process.platform === "darwin" || process.platform === "win32")
}

export function getLaunchAtStartup(): LaunchAtStartupState {
  if (!available()) return { available: false, enabled: false }
  const settings = app.getLoginItemSettings()
  return {
    available: true,
    enabled: settings.openAtLogin
      && (process.platform !== "win32" || settings.executableWillLaunchAtLogin),
  }
}

export function setLaunchAtStartup(enabled: boolean): LaunchAtStartupState {
  if (!available()) throw new Error("Launch at startup is unavailable")
  app.setLoginItemSettings({ openAtLogin: enabled })
  return getLaunchAtStartup()
}
