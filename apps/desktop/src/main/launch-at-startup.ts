import { app } from "electron"
import { isAbsolute, join } from "node:path"
import type { LaunchAtStartupState } from "../../../../packages/client/src/settings.ts"
import { LinuxLaunchAtStartup } from "./linux-launch-at-startup.ts"

function available(): boolean {
  // Development runs use Electron's executable, not the installed DeskFleet app.
  return app.isPackaged && (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux")
}

function linuxStartup(): LinuxLaunchAtStartup {
  const configHome = process.env.XDG_CONFIG_HOME
  const directory = configHome && isAbsolute(configHome) ? configHome : join(app.getPath("home"), ".config")
  const launcher = process.env.DESKFLEET_LAUNCHER
  return new LinuxLaunchAtStartup(
    join(directory, "autostart", "io.github.yet_another_ai.deskfleet.desktop"),
    // Package launchers restore runtime library and plugin paths at login.
    // Electron's executable inside an AppImage lives in a temporary mount.
    launcher && isAbsolute(launcher) ? launcher : process.env.APPIMAGE || process.execPath,
  )
}

/** Refresh an enabled Linux entry after an upgrade or a move of the app. */
export function refreshLaunchAtStartup(): void {
  if (available() && process.platform === "linux") linuxStartup().refresh()
}

export function getLaunchAtStartup(): LaunchAtStartupState {
  if (!available()) return { available: false, enabled: false }
  if (process.platform === "linux") return { available: true, enabled: linuxStartup().get() }
  const settings = app.getLoginItemSettings()
  return {
    available: true,
    enabled: settings.openAtLogin
      && (process.platform !== "win32" || settings.executableWillLaunchAtLogin),
  }
}

export function setLaunchAtStartup(enabled: boolean): LaunchAtStartupState {
  if (!available()) throw new Error("Launch at startup is unavailable")
  if (process.platform === "linux") return { available: true, enabled: linuxStartup().set(enabled) }
  app.setLoginItemSettings({ openAtLogin: enabled })
  return getLaunchAtStartup()
}
