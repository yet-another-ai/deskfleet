import type { SystemStatus } from "@deskfleet/protocol/system"

export type { SystemStatus } from "@deskfleet/protocol/system"

/** Read the selected daemon's machine metrics without creating a media peer. */
export interface SystemApi {
  status(): Promise<SystemStatus>
}
