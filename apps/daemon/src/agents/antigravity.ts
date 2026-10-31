import { posix, win32 } from "node:path"
import { connectAcpProcess, type AgentConfig, type AgentProcess, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

/** Google's standalone ACP runtime ships with a matching local harness. */
export function antigravityProcess(config: AgentConfig, platform: NodeJS.Platform = process.platform): AgentProcess {
  const path = platform === "win32" ? win32 : posix
  const binary = config.binaryPath || (platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par")
  const harness = /[/\\]/u.test(binary)
    ? { ANTIGRAVITY_HARNESS_PATH: path.resolve(path.dirname(binary), platform === "win32" ? "localharness_external.exe" : "localharness_external") }
    : {}
  // The Linux registry entry disables the runtime's default UID switch.
  return launchProviderCommand(binary, platform === "linux" ? ["--uid="] : [], { ...harness, ...config.env }, platform)
}

export const antigravityProvider: AgentProvider = {
  id: "antigravity",
  connect(config, client) {
    return connectAcpProcess(antigravityProcess(config), client)
  },
}
