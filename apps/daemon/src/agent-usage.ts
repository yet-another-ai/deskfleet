import type { AgentQuotaItem } from "./agent-configuration-protocol.ts"
import type { AgentConfig, AgentProvider } from "./agents/acp.ts"

export { clampQuota, providerProcessEnv, runJsonLineExchange, runUsageJsonCommand } from "@deskfleet/agent-core"

const USAGE_TTL_MS = 60_000

/** Deduplicates concurrent provider quota reads and caches recent snapshots briefly. */
export class AgentUsageCache {
  readonly #entries = new Map<string, { value: AgentQuotaItem[]; expiresAt: number }>()
  readonly #pending = new Map<string, Promise<AgentQuotaItem[]>>()
  #generation = 0

  read(
    providerId: string,
    launch: { provider: AgentProvider; config: AgentConfig },
    signal?: AbortSignal,
  ): Promise<AgentQuotaItem[]> {
    if (!launch.provider.readUsage) return Promise.resolve([])
    const cached = this.#entries.get(providerId)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
    const inflight = this.#pending.get(providerId)
    if (inflight) return inflight
    const generation = this.#generation
    const reading = launch.provider.readUsage(launch.config, signal).then(value => {
      if (generation === this.#generation) this.#entries.set(providerId, { value, expiresAt: Date.now() + USAGE_TTL_MS })
      return value
    }).finally(() => {
      if (this.#pending.get(providerId) === reading) this.#pending.delete(providerId)
    })
    this.#pending.set(providerId, reading)
    return reading
  }

  clear(): void {
    this.#generation++
    this.#entries.clear()
    this.#pending.clear()
  }
}
