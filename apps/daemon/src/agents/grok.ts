import * as acp from "@agentclientprotocol/sdk"
import { connectAcpProcess, type AgentConfig, type AgentProcess, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

/** Grok CLI starts its ACP server with these arguments. */
export const GROK_ACP_ARGUMENTS = ["agent", "stdio"] as const
/** Advertised when `XAI_API_KEY` is available to the CLI. */
export const GROK_API_KEY_METHOD = "xai.api_key"
/** Advertised after `grok login` has cached a session token. */
export const GROK_CACHED_TOKEN_METHOD = "cached_token"

export function grokProcess(config: AgentConfig): AgentProcess {
  return launchProviderCommand(config.binaryPath || "grok", [...GROK_ACP_ARGUMENTS], config.env)
}

function agentAuthMethod(initialization: acp.InitializeResponse, id: string): boolean {
  const method = initialization.authMethods?.find(item => item.id === id)
  return !!method && !("type" in method && method.type === "terminal")
}

/**
 * Completes the handshake from Grok's ACP example.
 * `xai.api_key` wins when that variable is set and the CLI advertises it.
 * Otherwise a cached login is used. Interactive methods such as browser login
 * are not passed to `authenticate`.
 */
export async function authenticateGrok(
  initialization: acp.InitializeResponse,
  agent: acp.ClientContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const methodId = env.XAI_API_KEY && agentAuthMethod(initialization, GROK_API_KEY_METHOD)
    ? GROK_API_KEY_METHOD
    : agentAuthMethod(initialization, GROK_CACHED_TOKEN_METHOD)
      ? GROK_CACHED_TOKEN_METHOD
      : undefined
  if (!methodId) throw new Error("Run `grok login` first, or set XAI_API_KEY.")
  await agent.request(acp.methods.agent.authenticate, { methodId, _meta: { headless: true } })
}

/** Launches the installed Grok CLI directly. It speaks ACP; no adapter process is required. */
export const grokProvider: AgentProvider = {
  id: "grok",
  connect(config, client) {
    return connectAcpProcess(grokProcess(config), client, {
      afterInitialize: (initialization, agent) => authenticateGrok(initialization, agent, { ...process.env, ...config.env }),
    })
  },
}
