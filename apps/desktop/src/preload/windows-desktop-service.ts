import { ipcRenderer } from "electron"
import { WINDOWS_DESKTOP_SERVICE_CHANNEL, type WindowsDesktopServiceApi, type WindowsDesktopServiceState } from "@deskfleet/client/windows-desktop-service"
import type { SettingsResult } from "@deskfleet/client/settings"

export function windowsDesktopServiceApi(): WindowsDesktopServiceApi {
  async function invoke(method: "get" | "setEnabled" | "update", enabled?: boolean): Promise<WindowsDesktopServiceState> {
    const result = await ipcRenderer.invoke(WINDOWS_DESKTOP_SERVICE_CHANNEL, method, enabled) as SettingsResult<WindowsDesktopServiceState>
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  return {
    get: () => invoke("get"),
    setEnabled: enabled => invoke("setEnabled", enabled),
    update: () => invoke("update"),
  }
}
