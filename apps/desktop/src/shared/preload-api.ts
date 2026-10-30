import type { CentralBridge } from "@deskfleet/client/central-bridge"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"

/** The renderer converts central results into its public CentralApi after contextBridge. */
export interface DesktopPreloadApi extends Omit<DeskfleetDesktopApi, "central"> {
  centralBridge?: CentralBridge
}
