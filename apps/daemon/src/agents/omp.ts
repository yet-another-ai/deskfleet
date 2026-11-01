import { connectAcpProcess, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

/** Oh My Pi serves ACP directly and uses its existing local credentials. */
export const ompProvider: AgentProvider = {
  id: "omp",
  connect(config, client) {
    return connectAcpProcess(launchProviderCommand(config.binaryPath || "omp", ["acp"], config.env), client)
  },
}
