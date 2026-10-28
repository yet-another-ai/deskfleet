import { expect, test } from "vitest"
import type { AiUsageBucket } from "@deskfleet/client/ai-usage"
import { calendarCells, calendarDate, heatmapLevel, usageStatistics } from "./team-ai-usage.ts"

test("calendar dates follow the requested timezone across midnight and daylight saving", () => {
  expect(calendarDate("2026-10-28T20:00:00Z", "Asia/Shanghai")).toBe("2026-10-29")
  expect(calendarDate("2026-03-08T07:30:00Z", "America/New_York")).toBe("2026-03-08")
  expect(calendarDate("2026-03-08T04:30:00Z", "America/New_York")).toBe("2026-03-07")
})

test("activity summaries include empty periods in the average and interrupt streaks", () => {
  const buckets: AiUsageBucket[] = [12, 8, 0, 30, 4, 1, 0].map((totalTokens, day) => ({
    start: `2026-10-${String(day + 1).padStart(2, "0")}T00:00:00Z`, totalTokens,
    reportedTurnCount: totalTokens ? 1 : 0, turnCount: 1, models: {}, members: {},
  }))
  expect(usageStatistics(buckets)).toEqual({ active: 5, longest: 3, peak: buckets[3], average: 55 / 7 })
  expect(usageStatistics([])).toEqual({ active: 0, longest: 0, peak: undefined, average: 0 })
})

test("reported zero has a peak while absent usage does not", () => {
  const bucket = { start: "2026-10-28T00:00:00Z", totalTokens: 0, reportedTurnCount: 1, turnCount: 1, models: {}, members: {} }
  expect(usageStatistics([bucket]).peak).toBe(bucket)
  expect(usageStatistics([{ ...bucket, reportedTurnCount: 0 }]).peak).toBeUndefined()
})

test("the hourly average uses the rolling duration rather than counting partial boundary buckets", () => {
  const buckets: AiUsageBucket[] = Array.from({ length: 25 }, (_, index) => ({
    start: new Date(Date.UTC(2026, 9, 27, 12 + index)).toISOString(),
    totalTokens: index === 0 || index === 24 ? 5 : 10,
    turnCount: 1, reportedTurnCount: 1, models: {}, members: {},
  }))
  const range = { period: "24h" as const, from: "2026-10-27T12:30:00Z", to: "2026-10-28T12:30:00Z" }
  expect(usageStatistics(buckets, range).average).toBe(10)
  // Calendar-day views still divide by their number of local dates.
  expect(usageStatistics(buckets, { ...range, period: "30d" }).average).toBe(240 / 25)
})

test("heatmap aligns Wednesday after two empty cells and distinguishes zero from positive usage", () => {
  const day = { date: "2026-10-28", totalTokens: 25, turnCount: 1, reportedTurnCount: 1 }
  expect(calendarCells([day])).toEqual([null, null, day])
  expect(heatmapLevel(day, 100)).toBe(2)
  expect(heatmapLevel({ ...day, totalTokens: 1 }, 100)).toBe(1)
  expect(heatmapLevel({ ...day, totalTokens: 0 }, 0)).toBe(0)
})
