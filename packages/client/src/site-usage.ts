export type SiteUsagePeriod = "7d" | "30d" | "90d"

export interface SiteUsageTotals {
  users: number
  teams: number
  sessions: number
}

export interface SiteUsageBucket extends SiteUsageTotals {
  /** UTC calendar date. Inventory totals are measured at the end of this day. */
  date: string
  turnCount: number
  /** Relayed egress bytes, serialized without losing integer precision. */
  relayedBytes: string
}

export interface SiteUsageTrends {
  period: SiteUsagePeriod
  timeZone: "UTC"
  from: string
  to: string
  generatedAt: string
  /** Some retained Cloudflare billing periods have not supplied daily analytics yet. */
  relayHistoryIncomplete: boolean
  totals: SiteUsageTotals
  buckets: SiteUsageBucket[]
}
