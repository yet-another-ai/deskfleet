import { ipcMain } from "electron"
import { testNat } from "@deskfleet/native"
import { NETWORK_DIAGNOSTICS_CHANNEL, stunEndpoint, type NatTestResult } from "@deskfleet/client/network-diagnostics"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { t } from "./i18n.ts"

export function installNetworkDiagnostics(central: Pick<HttpCentralClient, "networkConfiguration">): void {
  ipcMain.handle(NETWORK_DIAGNOSTICS_CHANNEL, async (event, method: unknown): Promise<NatTestResult> => {
    if (!isDesktopMediaSender(event)) throw new Error("Network diagnostics IPC is restricted to the main renderer")
    if (method !== "testNat") throw new Error("Unknown network diagnostics operation")
    const configuration = await central.networkConfiguration()
    const server = stunEndpoint(configuration.stunUrls)
    if (!server) throw new Error(t("developerSettings.noStunServer"))
    return testNat(server)
  })
}
