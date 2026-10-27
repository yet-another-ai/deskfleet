import { ipcRenderer } from "electron"
import { APPEARANCE_CHANNEL, APPEARANCE_CHANGED_EVENT, type AppearanceApi, type AppearanceSettings } from "../../../../packages/client/src/appearance.ts"
import type { SettingsResult } from "../../../../packages/client/src/settings.ts"

export function appearanceApi(): AppearanceApi {
  async function invoke(method: "get" | "set", value?: AppearanceSettings): Promise<AppearanceSettings> {
    const result = await ipcRenderer.invoke(APPEARANCE_CHANNEL, method, value) as SettingsResult<AppearanceSettings>
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  return {
    get: () => invoke("get"),
    set: value => invoke("set", value),
    onChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, value: AppearanceSettings) => listener(value)
      ipcRenderer.on(APPEARANCE_CHANGED_EVENT, handler)
      return () => ipcRenderer.removeListener(APPEARANCE_CHANGED_EVENT, handler)
    },
  }
}
