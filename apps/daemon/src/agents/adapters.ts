import { CLAUDE_AGENT_ACP_ARGUMENT, CODEX_ACP_ARGUMENT, PI_ACP_ARGUMENT, type AdapterArgument } from "./adapter-host.ts"
import { runClaudeCodeAdapter } from "./claude-code.ts"
import { runCodexAdapter } from "./codex.ts"
import { runPiAdapter } from "./pi.ts"

export { CLAUDE_AGENT_ACP_ARGUMENT, CODEX_ACP_ARGUMENT, PI_ACP_ARGUMENT, configureAdapterHost } from "./adapter-host.ts"

const adapters: Record<AdapterArgument, () => Promise<void>> = {
  [CODEX_ACP_ARGUMENT]: runCodexAdapter,
  [CLAUDE_AGENT_ACP_ARGUMENT]: runClaudeCodeAdapter,
  [PI_ACP_ARGUMENT]: runPiAdapter,
}

/** Entry points route adapter arguments before any daemon or client startup. */
export function bundledAdapter(args: readonly string[]): (() => Promise<void>) | undefined {
  const argument = (Object.keys(adapters) as AdapterArgument[]).find(argument => args.includes(argument))
  return argument && adapters[argument]
}
