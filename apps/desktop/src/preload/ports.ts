import { ipcRenderer } from "electron"
import { PORTS_IPC_CHANNEL, type PortsApi } from "@deskfleet/client/ports"

export function portsApi(): PortsApi {
  return {
    start: request => ipcRenderer.invoke(PORTS_IPC_CHANNEL, "start", [request]),
    list: () => ipcRenderer.invoke(PORTS_IPC_CHANNEL, "list", []),
    stop: id => ipcRenderer.invoke(PORTS_IPC_CHANNEL, "stop", [id]),
  }
}
