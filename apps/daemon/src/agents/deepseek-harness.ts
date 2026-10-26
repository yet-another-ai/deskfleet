import { connectAcpProcess, type AgentConfig, type AgentProcess, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

/**
 * DeepSeek Harness starts its automation-only ACP server with this profile.
 * `dsh acp` is the documented abbreviation for the same launch.
 */
export const DEEPSEEK_HARNESS_ACP_ARGUMENTS = ["--profile", "acp"] as const

export function deepseekHarnessProcess(config: AgentConfig): AgentProcess {
  return launchProviderCommand(config.binaryPath || "dsh", [...DEEPSEEK_HARNESS_ACP_ARGUMENTS], config.env)
}

/**
 * Launches the installed DeepSeek Harness CLI directly. It speaks ACP over
 * stdio; no adapter process is required. Credentials come from `DEEPSEEK_API_KEY`
 * (and optional `DEEPSEEK_BASE_URL`) in the process environment — the ACP server
 * advertises no interactive authenticate methods.
 */
export const deepseekHarnessProvider: AgentProvider = {
  id: "deepseek-harness",
  connect(config, client) {
    return connectAcpProcess(deepseekHarnessProcess(config), client)
  },
}
