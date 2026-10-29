import { app } from "electron"
import { join } from "node:path"

/** The desktop profile owns its hosted Agent and every local connection to it. */
export function desktopDaemonDirectory(): string {
  return join(app.getPath("userData"), "daemon")
}
