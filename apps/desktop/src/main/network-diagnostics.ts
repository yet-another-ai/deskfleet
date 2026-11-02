import { ipcMain } from "electron"
import { testNat } from "@deskfleet/native"
import { NETWORK_DIAGNOSTICS_CHANNEL, type NatTestResult } from "@deskfleet/client/network-diagnostics"
import { isDesktopMediaSender } from "./desktop-media.ts"

export function installNetworkDiagnostics(): void {
  ipcMain.handle(NETWORK_DIAGNOSTICS_CHANNEL, async (event, method: unknown, server: unknown): Promise<NatTestResult> => {
    if (!isDesktopMediaSender(event)) throw new Error("Network diagnostics IPC is restricted to the main renderer")
    if (method !== "testNat") throw new Error("Unknown network diagnostics operation")
    if (typeof server !== "string" || !server.trim()) throw new Error("A STUN server hostname:port is required")
    return testNat(server.trim())
  })
}
