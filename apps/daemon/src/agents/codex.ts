/// <reference path="../codex-acp.d.ts" />
import { isSea } from "node:sea"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { connectAcpProcess, type AgentProcess, type AgentProvider } from "./acp.ts"

export const CODEX_ACP_ARGUMENT = "--codex-acp"

let adapterHost: AgentProcess | undefined

/** The embedding entry point supplies its bundled adapter host before daemon startup. */
export function configureCodexAdapterHost(host: AgentProcess): void {
  adapterHost = host
}

/** Shared by source, SEA, and Electron's Node-mode adapter host. */
export async function runCodexAdapter(): Promise<void> {
  process.env.CODEX_PATH ||= "codex"
  await import("@agentclientprotocol/codex-acp")
}

export const codexProvider: AgentProvider = {
  id: "codex",
  connect(config, client) {
    // Resolve the source fallback only when needed. A literal new URL(...,
    // import.meta.url) is treated as an asset by Vite and can become a data URL.
    const host = adapterHost ?? {
      command: process.execPath,
      args: isSea() ? [CODEX_ACP_ARGUMENT] : [resolve(dirname(fileURLToPath(import.meta.url)), "../main.ts"), CODEX_ACP_ARGUMENT],
    }
    return connectAcpProcess({
      ...host,
      env: {
        ...config.env,
        ...host.env,
        // Always select the installed CLI rather than the adapter's bundled Codex.
        CODEX_PATH: config.binaryPath || "codex",
      },
    }, client)
  },
}
