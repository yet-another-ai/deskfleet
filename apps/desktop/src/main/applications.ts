import { ipcMain } from "electron"
import type { CentralApi } from "@deskfleet/client/central"
import { APPLICATIONS_CHANNEL } from "@deskfleet/client/applications"
import { openLocalApplication, scanLocalApplications } from "@deskfleet/native"
import { DaemonClient } from "./daemon-client.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { invokeApplications, LocalApplicationsController } from "./applications-controller.ts"

export function installLocalApplications(central: CentralApi): void {
  const controller = new LocalApplicationsController(central, async () => {
    const daemon = await DaemonClient.connect(() => {}, () => {})
    try { return await daemon.call("centralStatus", {}) }
    finally { daemon.close() }
  }, {
    scan: scanLocalApplications,
    open: openLocalApplication,
  })
  ipcMain.handle(APPLICATIONS_CHANNEL, async (event, method: unknown, value: unknown) => {
    if (!isDesktopMediaSender(event)) throw new Error("Local applications IPC is restricted to the main renderer")
    return invokeApplications(controller, method, value)
  })
}
