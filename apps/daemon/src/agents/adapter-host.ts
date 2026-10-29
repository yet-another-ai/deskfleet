import { isSea } from "node:sea"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentProcess } from "./acp.ts"

/** Each bundled ACP adapter runs in a child of the embedding executable, selected by one argument. */
export const CODEX_ACP_ARGUMENT = "--codex-acp"
export const CLAUDE_AGENT_ACP_ARGUMENT = "--claude-agent-acp"
export const DESKFLEET_MCP_ARGUMENT = "--deskfleet-mcp"
export const PI_ACP_ARGUMENT = "--pi-acp"

export type AdapterArgument = typeof CODEX_ACP_ARGUMENT | typeof CLAUDE_AGENT_ACP_ARGUMENT | typeof DESKFLEET_MCP_ARGUMENT | typeof PI_ACP_ARGUMENT

let adapterHost: AgentProcess | undefined

/** The embedding entry point supplies how to rerun itself before daemon startup; the adapter argument is appended. */
export function configureAdapterHost(host: AgentProcess): void {
  adapterHost = host
}

export function adapterProcess(argument: AdapterArgument): AgentProcess {
  return hostedProcess(argument)
}

/** Reuse the embedding runtime for bundled command-line helpers. */
export function hostedProcess(argument: string): AgentProcess {
  if (adapterHost) return { ...adapterHost, args: [...adapterHost.args ?? [], argument] }
  // Resolve the source fallback only when needed. A literal new URL(...,
  // import.meta.url) is treated as an asset by Vite and can become a data URL.
  return {
    command: process.execPath,
    args: isSea() ? [argument] : [resolve(dirname(fileURLToPath(import.meta.url)), "../main.ts"), argument],
  }
}
