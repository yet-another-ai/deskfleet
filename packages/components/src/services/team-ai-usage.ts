import type { AiUsageBucket, AiUsageDay, TeamAiUsage } from "@deskfleet/client/ai-usage"

export const AI_USAGE_COLORS = ["#4775f5", "#12a8d7", "#8b5cf6", "#14b88a", "#e99a22", "#e66184", "#73849a"]

export function calendarDate(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value))
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === name)!.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

export function usageStatistics(buckets: AiUsageBucket[], range?: Pick<TeamAiUsage, "period" | "from" | "to">) {
  let active = 0
  let longest = 0
  let streak = 0
  let peak: AiUsageBucket | undefined
  let total = 0
  for (const bucket of buckets) {
    total += bucket.totalTokens
    if (bucket.reportedTurnCount > 0 && (!peak || bucket.totalTokens > peak.totalTokens)) peak = bucket
    if (bucket.totalTokens > 0) {
      active++
      longest = Math.max(longest, ++streak)
    } else streak = 0
  }
  // Rolling hours can include partial buckets at both ends; their count is not the duration.
  const periods = range?.period === "24h"
    ? (Date.parse(range.to) - Date.parse(range.from)) / 3_600_000
    : buckets.length
  return { active, longest, peak, average: periods > 0 ? total / periods : 0 }
}

/** Pad the calendar to Monday-start columns without inventing usage for absent dates. */
export function calendarCells(days: AiUsageDay[]): (AiUsageDay | null)[] {
  if (!days.length) return []
  const weekday = new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay()
  return [...Array<null>((weekday + 6) % 7).fill(null), ...days]
}

export function heatmapLevel(day: AiUsageDay, maximum: number): number {
  if (!day.totalTokens || !maximum) return 0
  return Math.max(1, Math.ceil(Math.sqrt(day.totalTokens / maximum) * 4))
}
