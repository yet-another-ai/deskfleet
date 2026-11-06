import { connectAcpProcess, type AgentConfig, type AgentProcess, type AgentProvider } from "./acp.ts"
import { dshAcpProcess } from "@deskfleet/dsh-runtime"
import { launchProviderCommand } from "../provider-setup-process.ts"

/**
 * DeepSeek Harness starts its automation-only ACP server with this profile.
 * `dsh acp` is the documented abbreviation for the same launch.
 */
export const DEEPSEEK_HARNESS_ACP_ARGUMENTS = ["--profile", "acp"] as const

export function deepseekHarnessProcess(config: AgentConfig): AgentProcess {
  return config.binaryPath
    ? launchProviderCommand(config.binaryPath, [...DEEPSEEK_HARNESS_ACP_ARGUMENTS], config.env)
    : dshAcpProcess(config.env)
}

/**
 * Launches the bundled DeepSeek Harness CLI, or an explicit executable override.
 * It speaks ACP over stdio. The bundled launcher selects the API-key route when
 * configured, or the account route after browser sign-in. Login is separate from ACP.
 */
export const deepseekHarnessProvider: AgentProvider = {
  id: "deepseek-harness",
  connect(config, client) {
    return connectAcpProcess(deepseekHarnessProcess(config), client)
  },
}
