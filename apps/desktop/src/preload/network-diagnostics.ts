import { ipcRenderer } from "electron"
import { NETWORK_DIAGNOSTICS_CHANNEL, type NetworkDiagnosticsApi } from "@deskfleet/client/network-diagnostics"

export function networkDiagnosticsApi(): NetworkDiagnosticsApi {
  return {
    testNat: server => ipcRenderer.invoke(NETWORK_DIAGNOSTICS_CHANNEL, "testNat", server),
  }
}
