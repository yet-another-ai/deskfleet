/// <reference path="../codex-acp.d.ts" />
import type { AgentQuotaItem } from "../agent-configuration-protocol.ts"
import { clampQuota, providerProcessEnv, runJsonLineExchange } from "../agent-usage.ts"
import { connectAcpProcess, type AgentProvider } from "./acp.ts"
import { adapterProcess, CODEX_ACP_ARGUMENT } from "./adapter-host.ts"

interface CodexWindow { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null }
interface CodexSnapshot {
  limitId?: string | null
  limitName?: string | null
  primary?: CodexWindow | null
  secondary?: CodexWindow | null
  individualLimit?: { remainingPercent?: number | null; resetsAt?: number | null } | null
}

function codexWindowLabel(mins?: number | null): string {
  if (typeof mins !== "number" || mins <= 0) return "Limit"
  if (mins < 60) return `${Math.round(mins)}m limit`
  if (mins < 1_440) return `${Math.round(mins / 60)}h limit`
  if (mins < 10_080) return `${Math.round(mins / 1_440)}d limit`
  return "Weekly limit"
}

/** Parses `codex app-server` `account/rateLimits/read` responses into quota buckets. */
export function parseCodexUsage(payload: unknown): AgentQuotaItem[] {
  if (!payload || typeof payload !== "object") throw new Error("Codex did not return usage data")
  const data = payload as { rateLimits?: CodexSnapshot | null; rateLimitsByLimitId?: Record<string, CodexSnapshot | null | undefined> | null }
  const byId = Object.entries(data.rateLimitsByLimitId ?? {}).filter((entry): entry is [string, CodexSnapshot] => entry[1] != null)
  const entries: [string, CodexSnapshot][] = byId.length
    ? byId
    : data.rateLimits ? [[data.rateLimits.limitId?.trim() || "codex", data.rateLimits]] : []

  const items: AgentQuotaItem[] = []
  for (const [limitId, snapshot] of entries) {
    const group = snapshot.limitName?.trim() || (entries.length > 1 ? limitId : undefined)
    const push = (slot: string, label: string, remainingPercent?: number | null, resetsAt?: number | null) => {
      if (typeof remainingPercent !== "number") return
      items.push({
        id: `${limitId}:${slot}`,
        label,
        ...(group ? { group } : {}),
        remaining: clampQuota(remainingPercent / 100),
        ...(typeof resetsAt === "number" ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}),
      })
    }
    if (typeof snapshot.primary?.usedPercent === "number") {
      push("primary", codexWindowLabel(snapshot.primary.windowDurationMins), 100 - snapshot.primary.usedPercent, snapshot.primary.resetsAt)
    }
    if (typeof snapshot.secondary?.usedPercent === "number") {
      push("secondary", codexWindowLabel(snapshot.secondary.windowDurationMins), 100 - snapshot.secondary.usedPercent, snapshot.secondary.resetsAt)
    }
    if (snapshot.individualLimit) {
      push("spend", "Spend limit", snapshot.individualLimit.remainingPercent, snapshot.individualLimit.resetsAt)
    }
  }
  return items
}

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
  readUsage(config, signal) {
    return runJsonLineExchange({
      command: config.binaryPath || "codex",
      args: ["app-server"],
      env: providerProcessEnv(config.env),
      signal,
      start: send => send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "deskfleet", title: "DeskFleet", version: "0.0.0" }, capabilities: { experimentalApi: true } },
      }),
      onFrame(frame, send) {
        if (frame.id !== 1 && frame.id !== 2) return undefined
        const error = frame.error as { message?: string } | undefined
        if (error) throw new Error(error.message?.trim() || "Could not read Codex usage")
        if (frame.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized" })
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" })
          return undefined
        }
        return parseCodexUsage(frame.result)
      },
    })
  },
}
