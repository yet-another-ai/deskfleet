export type AiUsagePeriod = "24h" | "7d" | "30d" | "all"
export interface AiUsageQuery { period: AiUsagePeriod; timeZone: string }

export interface AiUsageCount {
  totalTokens: number
  turnCount: number
  reportedTurnCount: number
}

export interface AiUsageTotals extends AiUsageCount {
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number | null
  cachedWriteTokens: number | null
  thoughtTokens: number | null
}

export interface AiUsageGroup extends AiUsageCount { id: string; name: string }
export interface AiUsageBucket extends AiUsageCount {
  /** UTC instant at the start of the hour or local calendar day. */
  start: string
  models: Record<string, number>
  members: Record<string, number>
}
export interface AiUsageDay extends AiUsageCount { date: string }

export interface TeamAiUsage {
  period: AiUsagePeriod
  timeZone: string
  from: string
  to: string
  lastSyncedAt: string | null
  totals: AiUsageTotals
  /** Hourly for 24h; daily for other periods. */
  buckets: AiUsageBucket[]
  /** Calendar dates for the last 53 weeks, independent of the selected period. */
  heatmap: AiUsageDay[]
  models: AiUsageGroup[]
  members: AiUsageGroup[]
}

export interface AiUsageSession extends AiUsageTotals {
  machineId: string
  machineName: string
  sessionId: string
  title: string
}
export interface TeamAiUsageSessions {
  date: string
  timeZone: string
  sessions: AiUsageSession[]
  truncated: boolean
}
