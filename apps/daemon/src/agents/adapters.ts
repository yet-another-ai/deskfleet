import { runMcpStdio } from "@deskfleet/mcp"
import { AUV_MCP_ARGUMENT, DESKFLEET_MCP_ARGUMENT } from "./adapter-host.ts"
import { runAuvMcp } from "./auv-mcp.ts"
import { AGENT_PLUGINS } from "./registry.ts"

export {
  AUV_MCP_ARGUMENT, CLAUDE_AGENT_ACP_ARGUMENT, CODEX_ACP_ARGUMENT, DESKFLEET_MCP_ARGUMENT, PI_ACP_ARGUMENT,
  configureAdapterHost,
} from "./adapter-host.ts"

const adapters: Record<string, () => Promise<void>> = {
  [AUV_MCP_ARGUMENT]: runAuvMcp,
  [DESKFLEET_MCP_ARGUMENT]: runMcpStdio,
  ...Object.fromEntries(AGENT_PLUGINS.flatMap(plugin =>
    plugin.bundledAdapter ? [[plugin.bundledAdapter.argument, plugin.bundledAdapter.run]] : [],
  )),
}

/** Entry points route adapter arguments before any daemon or client startup. */
export function bundledAdapter(args: readonly string[]): (() => Promise<void>) | undefined {
  const argument = Object.keys(adapters).find(argument => args.includes(argument))
  return argument ? adapters[argument] : undefined
}
