import type { CentralBridge } from "@deskfleet/client/central-bridge"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { FilesBridge } from "./files-bridge.ts"

/** The renderer adapts bridge-safe central and file operations after contextBridge. */
export interface DesktopPreloadApi extends Omit<DeskfleetDesktopApi, "central" | "files"> {
  centralBridge?: CentralBridge
  files?: FilesBridge
}
