import { systemStatus } from "@deskfleet/native"
import manifest from "../../package.json" with { type: "json" }
import type { SystemStatus } from "@deskfleet/protocol/system"

/** The package version is embedded when bundling either daemon host. */
export async function readSystemStatus(): Promise<SystemStatus> {
  return { ...await systemStatus(), daemonVersion: manifest.version }
}
