/// <reference path="../codex-acp.d.ts" />
import { connectAcpProcess, type AgentProvider } from "./acp.ts"
import { adapterProcess, CODEX_ACP_ARGUMENT } from "./adapter-host.ts"

/** Shared by source, SEA, and Electron's Node-mode adapter host. */
export async function runCodexAdapter(): Promise<void> {
  process.env.CODEX_PATH ||= "codex"
  await import("@agentclientprotocol/codex-acp")
}

export const codexProvider: AgentProvider = {
  id: "codex",
  connect(config, client) {
    const host = adapterProcess(CODEX_ACP_ARGUMENT)
    const env = Object.fromEntries(Object.entries({ ...config.env, ...host.env })
      .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]))
    return connectAcpProcess({
      ...host,
      env: {
        ...env,
        // Always select the installed CLI rather than the adapter's bundled Codex.
        CODEX_PATH: config.binaryPath || "codex",
        // The bridge otherwise permits an inherited default request to open OAuth.
        ...(config.authentication === "existing" ? { DEFAULT_AUTH_REQUEST: "" } : {}),
      },
    }, client)
  },
}
