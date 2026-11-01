import { ipcRenderer } from "electron"
import { WINDOWS_DESKTOP_SERVICE_CHANNEL, type WindowsDesktopServiceApi, type WindowsDesktopServiceState } from "../../../../packages/client/src/windows-desktop-service.ts"
import type { SettingsResult } from "../../../../packages/client/src/settings.ts"

export function windowsDesktopServiceApi(): WindowsDesktopServiceApi {
  async function invoke(method: "get" | "setEnabled", enabled?: boolean): Promise<WindowsDesktopServiceState> {
    const result = await ipcRenderer.invoke(WINDOWS_DESKTOP_SERVICE_CHANNEL, method, enabled) as SettingsResult<WindowsDesktopServiceState>
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  return { get: () => invoke("get"), setEnabled: enabled => invoke("setEnabled", enabled) }
}
