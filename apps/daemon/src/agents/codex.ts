import { isSea } from "node:sea"
import { resolve } from "node:path"
import { connectAcpProcess, type AgentProcess, type AgentProvider } from "./acp.ts"

/** Embedded hosts supply their own executable entry point for the ACP adapter. */
export function createCodexProvider(launch?: AgentProcess): AgentProvider {
  return {
    id: "codex",
    connect: (config, client) => connectAcpProcess({
      command: launch?.command ?? process.execPath,
      args: launch?.args ?? (isSea() ? ["--codex-acp"] : [resolve(import.meta.dirname, "../main.ts"), "--codex-acp"]),
      env: {
        ...launch?.env,
        ...config.env,
        // Always select the installed CLI rather than the adapter's bundled Codex.
        CODEX_PATH: config.binaryPath || "codex",
      },
    }, client),
  }
}

export const codexProvider = createCodexProvider()
