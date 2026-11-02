import { ipcMain } from "electron"
import { testNat } from "@deskfleet/native"
import { NETWORK_DIAGNOSTICS_CHANNEL, type NatTestResult } from "@deskfleet/client/network-diagnostics"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { t } from "./i18n.ts"

/** Preserve deployment order and use only endpoints compatible with the IPv4 UDP probe. */
function stunEndpoint(urls: string[]): string | undefined {
  for (const url of urls) {
    const match = /^stun:([a-z0-9.-]+)(?::([0-9]+))?(?:\?transport=udp)?$/i.exec(url)
    if (!match || match[1]!.length > 253) continue
    const port = match[2] === undefined ? 3478 : Number(match[2])
    if (port > 0 && port <= 65535) return `${match[1]}:${port}`
  }
}

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
