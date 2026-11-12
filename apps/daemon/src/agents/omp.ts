import type { AgentQuotaItem } from "../agent-configuration-protocol.ts"
import { clampQuota, runUsageJsonCommand } from "../agent-usage.ts"
import { connectAcpProcess, type AgentProvider } from "./acp.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

interface OmpAmount {
  used?: number | null
  limit?: number | null
  unit?: string | null
  usedFraction?: number | null
  remainingFraction?: number | null
}

function ompRemaining(amount?: OmpAmount | null): number | undefined {
  if (!amount) return undefined
  if (typeof amount.usedFraction === "number") return 1 - amount.usedFraction
  if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
    return (amount.limit - amount.used) / amount.limit
  }
  if (amount.unit === "percent" && typeof amount.used === "number") return (100 - amount.used) / 100
  if (typeof amount.remainingFraction === "number") return amount.remainingFraction
  return undefined
}

/** Parses `omp usage --json` output into quota buckets. */
export function parseOmpUsage(stdout: string): AgentQuotaItem[] {
  const payload = JSON.parse(stdout.trim()) as {
    error?: string
    reports?: {
      provider?: string
      error?: string
      limits?: { id?: string; label?: string; amount?: OmpAmount | null; window?: { label?: string; resetsAt?: number | null } | null }[]
    }[]
  }
  if (payload.error?.trim()) throw new Error(payload.error.trim())

  const items: AgentQuotaItem[] = []
  let firstError: string | undefined
  for (const [index, report] of (payload.reports ?? []).entries()) {
    firstError ??= report.error?.trim() || undefined
    const group = report.provider?.trim() || undefined
    for (const limit of report.limits ?? []) {
      const remaining = ompRemaining(limit.amount)
      const label = limit.label?.trim() || limit.window?.label?.trim() || limit.id?.trim()
      if (remaining === undefined || !label) continue
      items.push({
        id: `${index}:${limit.id?.trim() || label}`,
        label,
        ...(group ? { group } : {}),
        remaining: clampQuota(remaining),
        ...(typeof limit.window?.resetsAt === "number" ? { resetsAt: new Date(limit.window.resetsAt).toISOString() } : {}),
      })
    }
  }
  if (!items.length && firstError) throw new Error(firstError)
  return items
}

/** Oh My Pi serves ACP directly and uses its existing local credentials. */
export const ompProvider: AgentProvider = {
  id: "omp",
  connect(config, client) {
    return connectAcpProcess(launchProviderCommand(config.binaryPath || "omp", ["acp"], config.env), client)
  },
  async readUsage(config, signal) {
    return parseOmpUsage(await runUsageJsonCommand(config.binaryPath || "omp", ["usage", "--json"], config.env, signal))
  },
}
