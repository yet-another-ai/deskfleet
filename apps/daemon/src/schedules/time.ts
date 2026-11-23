import type { ScheduleTrigger } from "@deskfleet/protocol/schedule"

type LocalTime = { year: number; month: number; day: number; hour: number; minute: number }

/** Missing DST wall times are skipped; a repeated wall time runs at its first occurrence only. */
export function nextScheduleTime(trigger: ScheduleTrigger, after: Date): string | undefined {
  if (!Number.isFinite(after.getTime())) throw new Error("Invalid schedule clock")
  if (trigger.kind === "manual") return undefined
  if (trigger.kind === "interval") return new Date(after.getTime() + trigger.minutes * 60_000).toISOString()
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: trigger.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  const local = (time: number): LocalTime => Object.fromEntries(formatter.formatToParts(time)
    .filter(part => ["year", "month", "day", "hour", "minute"].includes(part.type)).map(part => [part.type, Number(part.value)])) as LocalTime
  const utc = (parts: LocalTime) => Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  const today = local(after.getTime())
  const [hour, minute] = trigger.time.split(":").map(Number) as [number, number]
  for (let day = 0; day < 15; day += 1) {
    const civil = new Date(Date.UTC(today.year, today.month - 1, today.day + day, hour, minute))
    if (trigger.kind === "weekly" && !trigger.weekdays.includes(civil.getUTCDay())) continue
    const expected = civil.getTime()
    const offsets = new Set<number>()
    // Sample both sides of an offset transition, including non-hour DST changes.
    for (let hours = -36; hours <= 36; hours += 6) {
      const sample = expected + hours * 3_600_000
      offsets.add(utc(local(sample)) - sample)
    }
    const candidates = [...offsets].map(offset => expected - offset).filter(time => utc(local(time)) === expected).sort((a, b) => a - b)
    const first = candidates[0]
    if (first !== undefined && first > after.getTime()) return new Date(first).toISOString()
  }
  throw new Error("Could not calculate the next scheduled occurrence")
}
