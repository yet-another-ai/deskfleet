import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

/** The staged native executable stays outside ASAR on every platform. */
export function resolveAuvPath(options: {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}): string {
  const executable = process.platform === "win32" ? "auv.exe" : "auv"
  if (!options.isPackaged) return join(options.appPath, "out", "auv", executable)
  if (process.platform === "darwin") return join(options.resourcesPath, "..", "MacOS", executable)
  return join(options.resourcesPath, "bin", executable)
}

/** Register the bundled Linux executable before agents can use its CLI or MCP server. */
export async function prepareAuv(options: Parameters<typeof resolveAuvPath>[0]): Promise<string> {
  const binary = resolveAuvPath(options)
  if (process.platform === "linux") {
    try {
      // AUV owns its desktop identity and refreshes Exec when the app moves or updates.
      // Setup installs metadata only; welcome and permission settings request consent separately.
      await execute(binary, ["doctor", "--portal-setup"], { timeout: 10_000, windowsHide: true })
    } catch (error) {
      // Desktop access is optional: agents, Git, and terminals must remain usable.
      console.error("Could not set up AUV Portal identity", error)
    }
  }
  return binary
}
