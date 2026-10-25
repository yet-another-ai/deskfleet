/// <reference path="../pi-acp.d.ts" />
import { connectAcpProcess, type AgentProvider } from "./acp.ts"
import { adapterProcess, PI_ACP_ARGUMENT } from "./adapter-host.ts"

/** The pinned bridge translates ACP to the installed Pi CLI's RPC mode. */
export async function runPiAdapter(): Promise<void> {
  if (process.argv.includes("--version")) {
    const { default: manifest } = await import("pi-acp/package.json", { with: { type: "json" } })
    console.log(manifest.version)
    return
  }
  await import("pi-acp")
}

export const piProvider: AgentProvider = {
  id: "pi",
  connect(config, client) {
    const host = adapterProcess(PI_ACP_ARGUMENT)
    const env = Object.fromEntries(Object.entries({ ...config.env, ...host.env })
      .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]))
    // Pi's Windows installers provide a command shim; the bridge needs its
    // extension to select cross-spawn instead of Node's native executable path.
    const binary = config.binaryPath || "pi"
    return connectAcpProcess({
      ...host,
      env: { ...env, PI_ACP_PI_COMMAND: process.platform === "win32" && binary === "pi" ? "pi.cmd" : binary },
    }, client)
  },
}
