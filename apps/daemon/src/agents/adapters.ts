import { ANTIGRAVITY_LOGIN_ARGUMENT, AUV_MCP_ARGUMENT, CLAUDE_AGENT_ACP_ARGUMENT, CODEX_ACP_ARGUMENT, DESKFLEET_MCP_ARGUMENT, PI_ACP_ARGUMENT, type AdapterArgument } from "./adapter-host.ts"
import { runMcpStdio } from "@deskfleet/mcp"
import { runAntigravityLogin } from "./antigravity.ts"
import { runAuvMcp } from "./auv-mcp.ts"
import { runClaudeCodeAdapter } from "./claude-code.ts"
import { runCodexAdapter } from "./codex.ts"
import { runPiAdapter } from "./pi.ts"

export { ANTIGRAVITY_LOGIN_ARGUMENT, AUV_MCP_ARGUMENT, CLAUDE_AGENT_ACP_ARGUMENT, CODEX_ACP_ARGUMENT, DESKFLEET_MCP_ARGUMENT, PI_ACP_ARGUMENT, configureAdapterHost } from "./adapter-host.ts"

const adapters: Record<AdapterArgument, () => Promise<void>> = {
  [ANTIGRAVITY_LOGIN_ARGUMENT]: runAntigravityLogin,
  [AUV_MCP_ARGUMENT]: runAuvMcp,
  [CODEX_ACP_ARGUMENT]: runCodexAdapter,
  [CLAUDE_AGENT_ACP_ARGUMENT]: runClaudeCodeAdapter,
  [DESKFLEET_MCP_ARGUMENT]: runMcpStdio,
  [PI_ACP_ARGUMENT]: runPiAdapter,
}

/** Entry points route adapter arguments before any daemon or client startup. */
export function bundledAdapter(args: readonly string[]): (() => Promise<void>) | undefined {
  const argument = (Object.keys(adapters) as AdapterArgument[]).find(argument => args.includes(argument))
  return argument && adapters[argument]
}
