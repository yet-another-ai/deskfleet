import { ipcRenderer } from "electron"
import { WEB_PREVIEW_IPC_CHANNEL, type WebPreviewDesktopApi } from "../../../../packages/client/src/web-preview.ts"

export function webPreviewApi(): WebPreviewDesktopApi {
  return {
    allowOrigin: origin => ipcRenderer.invoke(WEB_PREVIEW_IPC_CHANNEL, "allowOrigin", [origin]),
    revokeOrigin: grantId => ipcRenderer.invoke(WEB_PREVIEW_IPC_CHANNEL, "revokeOrigin", [grantId]),
    openDevTools: guestWebContentsId => ipcRenderer.invoke(WEB_PREVIEW_IPC_CHANNEL, "openDevTools", [guestWebContentsId]),
  }
}
