import * as acp from "@agentclientprotocol/sdk"
import { connectAcpProcess, type AgentConfig, type AgentProcess, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

/** Cursor CLI starts its ACP server with this subcommand. Root flags, when used, must precede it. */
export const CURSOR_ACP_ARGUMENT = "acp"
/** Auth method Cursor advertises during ACP initialization. */
export const CURSOR_AUTH_METHOD = "cursor_login"

export function cursorProcess(config: AgentConfig): AgentProcess {
  return launchProviderCommand(config.binaryPath || "agent", [CURSOR_ACP_ARGUMENT], config.env)
}

/**
 * Completes Cursor's documented handshake when it advertises `cursor_login`.
 * Terminal auth is a separate interactive program and is not passed to `authenticate`.
 * A missing method means the CLI did not ask for this login step.
 */
export async function authenticateCursor(initialization: acp.InitializeResponse, agent: acp.ClientContext): Promise<void> {
  const method = initialization.authMethods?.find(item => item.id === CURSOR_AUTH_METHOD)
  if (!method || ("type" in method && method.type === "terminal")) return
  await agent.request(acp.methods.agent.authenticate, { methodId: CURSOR_AUTH_METHOD })
}

/** Launches the installed Cursor CLI directly. It speaks ACP; no adapter process is required. */
export const cursorProvider: AgentProvider = {
  id: "cursor",
  connect(config, client) {
    // cursor_login starts browser auth when credentials have expired. Cursor's
    // session/new also accepts credentials loaded at startup, without that call.
    return connectAcpProcess(cursorProcess(config), client, {
      ...(config.authentication === "existing" ? {} : { afterInitialize: authenticateCursor }),
    })
  },
}
