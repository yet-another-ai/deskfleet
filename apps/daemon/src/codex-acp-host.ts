/// <reference path="./codex-acp.d.ts" />

/** Start the bundled adapter without importing the daemon's native services. */
export async function runCodexAcpHost(): Promise<void> {
  process.env.CODEX_PATH ||= "codex"
  await import("@agentclientprotocol/codex-acp")
}
