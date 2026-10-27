import { ipcRenderer } from "electron"
import { APPLICATIONS_CHANNEL, type LocalApplicationsApi } from "@deskfleet/client/applications"

export function applicationsApi(): LocalApplicationsApi {
  return {
    scan: () => ipcRenderer.invoke(APPLICATIONS_CHANNEL, "scan"),
    openWorkspace: request => ipcRenderer.invoke(APPLICATIONS_CHANNEL, "openWorkspace", request),
  }
}
