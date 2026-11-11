import { connectAcpProcess, type AgentConfig, type AgentProcess, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

/** CodeBuddy Code exposes native ACP over stdio and loads its own credentials. */
export function codebuddyProcess(config: AgentConfig): AgentProcess {
  return {
    ...launchProviderCommand(config.binaryPath || "codebuddy", ["--acp"], config.env),
    ...(config.cwd ? { cwd: config.cwd } : {}),
  }
}

export const codebuddyProvider: AgentProvider = {
  id: "codebuddy",
  // Its ACP authenticate method clears cached credentials and starts login.
  // session/new accepts existing credentials; interactive login belongs to setup.
  connect: (config, client) => connectAcpProcess(codebuddyProcess(config), client),
}
