import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  configureAdapterFallbackEntry, configureAdapterHost, hostedProcess as coreHostedProcess, type AgentProcess,
} from "@deskfleet/agent-core"

/** Each bundled ACP adapter runs in a child of the embedding executable, selected by one argument. */
export const AUV_MCP_ARGUMENT = "--auv-mcp"
export const CODEX_ACP_ARGUMENT = "--codex-acp"
export const CLAUDE_AGENT_ACP_ARGUMENT = "--claude-agent-acp"
export const DESKFLEET_MCP_ARGUMENT = "--deskfleet-mcp"
export const PI_ACP_ARGUMENT = "--pi-acp"

export type AdapterArgument =
  | typeof AUV_MCP_ARGUMENT
  | typeof CODEX_ACP_ARGUMENT
  | typeof CLAUDE_AGENT_ACP_ARGUMENT
  | typeof DESKFLEET_MCP_ARGUMENT
  | typeof PI_ACP_ARGUMENT

export { configureAdapterHost }

// Resolve the source fallback only when needed. A literal new URL(...,
// import.meta.url) is treated as an asset by Vite and can become a data URL.
configureAdapterFallbackEntry(resolve(dirname(fileURLToPath(import.meta.url)), "../main.ts"))

export function adapterProcess(argument: AdapterArgument): AgentProcess {
  return hostedProcess(argument)
}

/** Reuse the embedding runtime for bundled command-line helpers. */
export function hostedProcess(argument: string): AgentProcess {
  return coreHostedProcess(argument)
}
