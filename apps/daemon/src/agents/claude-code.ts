import type { AgentQuotaItem } from "../agent-configuration-protocol.ts"
import { clampQuota, providerProcessEnv, runJsonLineExchange } from "../agent-usage.ts"
import { connectAcpProcess, type AgentProvider } from "./acp.ts"
import { adapterProcess, CLAUDE_AGENT_ACP_ARGUMENT } from "./adapter-host.ts"

interface ClaudeWindow { utilization?: number | null; resets_at?: string | null; display_name?: string | null }

/** Parses Claude Code `get_usage` control responses into quota buckets. */
export function parseClaudeCodeUsage(payload: unknown): AgentQuotaItem[] {
  if (!payload || typeof payload !== "object") throw new Error("Claude Code did not return usage data")
  const { rate_limits_available, rate_limits: limits } = payload as {
    rate_limits_available?: boolean
    rate_limits?: {
      five_hour?: ClaudeWindow | null
      seven_day?: ClaudeWindow | null
      model_scoped?: ClaudeWindow[] | null
      seven_day_opus?: ClaudeWindow | null
      seven_day_sonnet?: ClaudeWindow | null
      extra_usage?: { is_enabled?: boolean; utilization?: number | null } | null
    } | null
  }
  if (!rate_limits_available || !limits) return []

  const items: AgentQuotaItem[] = []
  const push = (id: string, label: string, window?: ClaudeWindow | null) => {
    if (typeof window?.utilization !== "number") return
    const resetsAt = window.resets_at?.trim()
    items.push({ id, label, remaining: clampQuota((100 - window.utilization) / 100), ...(resetsAt ? { resetsAt } : {}) })
  }

  push("five_hour", "5-hour limit", limits.five_hour)
  push("seven_day", "Weekly · all models", limits.seven_day)
  if (limits.model_scoped?.length) {
    for (const scoped of limits.model_scoped) {
      const name = scoped?.display_name?.trim()
      if (name) push(`model:${name}`, `Weekly · ${name}`, scoped)
    }
  } else {
    push("seven_day_opus", "Weekly · Opus", limits.seven_day_opus)
    push("seven_day_sonnet", "Weekly · Sonnet", limits.seven_day_sonnet)
  }
  if (limits.extra_usage?.is_enabled) push("extra_usage", "Extra usage", limits.extra_usage)
  return items
}

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
  readUsage(config, signal) {
    const env = providerProcessEnv({ ...config.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" })
    delete env.NODE_OPTIONS
    delete env.CLAUDECODE
    return runJsonLineExchange({
      command: config.binaryPath || "claude",
      args: ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--no-session-persistence"],
      env,
      signal,
      start: send => send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } }),
      onFrame(frame, send) {
        if (frame.type !== "control_response") return undefined
        const res = frame.response as { subtype?: string; request_id?: string; error?: string; response?: unknown } | undefined
        if (res?.request_id !== "init" && res?.request_id !== "usage") return undefined
        if (res.subtype === "error") throw new Error(res.error?.trim() || "Could not read Claude Code usage")
        if (res.request_id === "init") {
          send({ type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } })
          return undefined
        }
        return parseClaudeCodeUsage(res.response)
      },
    })
  },
}
