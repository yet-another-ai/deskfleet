import { ipcRenderer } from "electron"
import { UPDATES_CHANNEL, UPDATES_CHANGED_EVENT, type UpdateApi, type UpdateState } from "../../../../packages/client/src/updates.ts"
import type { SettingsResult } from "../../../../packages/client/src/settings.ts"

export function updatesApi(): UpdateApi {
  async function invoke<T>(method: "get" | "check" | "install"): Promise<T> {
    const result = await ipcRenderer.invoke(UPDATES_CHANNEL, method) as SettingsResult<T>
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  return {
    get: () => invoke<UpdateState>("get"),
    check: () => invoke<UpdateState>("check"),
    install: () => invoke<void>("install"),
    onChanged: listener => {
      const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state)
      ipcRenderer.on(UPDATES_CHANGED_EVENT, handler)
      return () => ipcRenderer.removeListener(UPDATES_CHANGED_EVENT, handler)
    },
  }
}
