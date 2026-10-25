import { connectAcpProcess, type AgentProvider } from "./acp.ts"
import { adapterProcess, CLAUDE_AGENT_ACP_ARGUMENT } from "./adapter-host.ts"

/**
 * Shared by source, SEA, and Electron's Node-mode adapter host. The published
 * entry uses top-level await, which the CommonJS SEA bundle cannot contain, so
 * this starts the same stdio server through the adapter's exported modules.
 */
export async function runClaudeCodeAdapter(): Promise<void> {
  if (process.argv.includes("--version")) {
    const { default: manifest } = await import("@agentclientprotocol/claude-agent-acp/package.json", { with: { type: "json" } })
    console.log(manifest.version)
    return
  }
  process.env.CLAUDE_CODE_EXECUTABLE ||= "claude"
  const [{ applyManagedPolicyEnv }, { serveAcp }] = await Promise.all([
    import("@agentclientprotocol/claude-agent-acp/dist/managed-policy.js"),
    import("@agentclientprotocol/claude-agent-acp/dist/serve.js"),
  ])
  // Managed-policy variables must be in place before the SDK starts Claude Code.
  await applyManagedPolicyEnv()
  // stdout carries ACP messages; diagnostics go to stderr.
  console.log = console.info = console.warn = console.debug = console.error
  process.on("unhandledRejection", reason => console.error("Unhandled rejection:", reason))
  const acp = serveAcp(undefined, { protocols: "v1" })
  const shutdown = () => {
    void acp.dispose().catch(error => console.error("Error during cleanup:", error)).finally(() => process.exit(0))
  }
  void acp.closed.then(shutdown)
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  process.stdin.resume()
}

export const claudeCodeProvider: AgentProvider = {
  id: "claude-code",
  connect(config, client) {
    const host = adapterProcess(CLAUDE_AGENT_ACP_ARGUMENT)
    return connectAcpProcess({
      ...host,
      env: {
        ...config.env,
        ...host.env,
        // Always select the installed CLI rather than the SDK's optional native binary.
        CLAUDE_CODE_EXECUTABLE: config.binaryPath || "claude",
      },
    }, client)
  },
}
