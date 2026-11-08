import { connectAcpProcess, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

/** Antigravity CLI serves ACP directly and uses its existing local credentials. */
export const antigravityProvider: AgentProvider = {
  id: "antigravity",
  connect(config, client) {
    return connectAcpProcess(launchProviderCommand(config.binaryPath || "agy", ["acp"], config.env), client)
  },
}
