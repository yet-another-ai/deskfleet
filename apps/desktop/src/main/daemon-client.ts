import { DaemonClient as ControlClient } from "@deskfleet/daemon/control-client"
import type { DaemonEvent } from "@deskfleet/protocol/control"
import { desktopDaemonDirectory } from "./daemon-directory.ts"

export type DaemonClient = ControlClient

/** Desktop IPC follows the active Electron profile, independently of headless discovery. */
export const DaemonClient = {
  connect(onEvent: (event: DaemonEvent) => void, onDisconnect: (error: Error) => void): Promise<DaemonClient> {
    return ControlClient.connect(onEvent, onDisconnect, desktopDaemonDirectory())
  },
}
