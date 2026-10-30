import { contextBridge, ipcRenderer } from "electron"
import type { CentralEvent } from "@deskfleet/client/central"
import type { CentralBridge } from "@deskfleet/client/central-bridge"
import { isMainRendererUrl } from "../shared/renderer-security.ts"
import { desktopApi } from "./api.ts"

const central: CentralBridge = {
  invoke: (method, args) => ipcRenderer.invoke("deskfleet:central", method, args),
  context: () => ipcRenderer.invoke("deskfleet:central-context"),
  onEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: CentralEvent) => listener(value)
    ipcRenderer.on("deskfleet:central-event", handler)
    return () => ipcRenderer.removeListener("deskfleet:central-event", handler)
  },
}

if (isMainRendererUrl(globalThis.location.href)) {
  contextBridge.exposeInMainWorld("deskfleet", desktopApi(central))
}
