import { DaemonClient as ControlClient } from "../../../daemon/src/control-client.ts"
import type { DaemonEvent } from "../../../daemon/src/control-protocol.ts"
import { desktopDaemonDirectory } from "./daemon-directory.ts"

export type DaemonClient = ControlClient

/** Desktop IPC follows the active Electron profile, independently of headless discovery. */
export const DaemonClient = {
  connect(onEvent: (event: DaemonEvent) => void, onDisconnect: (error: Error) => void): Promise<DaemonClient> {
    return ControlClient.connect(onEvent, onDisconnect, desktopDaemonDirectory())
  },
}
