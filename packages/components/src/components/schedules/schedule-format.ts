import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { ScheduleInput } from "@deskfleet/client/schedules"

type ScheduleTrigger = ScheduleInput["trigger"]
type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string

/** Monday-first display order of the protocol's 0 (Sunday) to 6 weekdays. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const

export function weekdayName(day: number, locale: string, width: "short" | "long" = "short"): string {
  // 2026-01-04 is a Sunday, so adding the weekday number lands on that day.
  return new Intl.DateTimeFormat(intlLocale(locale as AppLocale), { weekday: width, timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + day)))
}

/** A trigger's wall-clock time, formatted for the viewer without shifting it between zones. */
function clockTime(time: string, locale: string): string {
  const [hour = 0, minute = 0] = time.split(":").map(Number)
  return new Intl.DateTimeFormat(intlLocale(locale as AppLocale), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, hour, minute)))
}

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** One line describing when a trigger fires; the zone appears only when it differs from the viewer's. */
export function describeTrigger(trigger: ScheduleTrigger, t: Translate, locale: string): string {
  if (trigger.kind === "manual") return t("schedules.cadence.manual")
  if (trigger.kind === "interval") {
    const hours = trigger.minutes % 60 === 0 ? trigger.minutes / 60 : 0
    return hours ? t("schedules.cadence.hours", { n: hours }, hours) : t("schedules.cadence.minutes", { n: trigger.minutes }, trigger.minutes)
  }
  const time = clockTime(trigger.time, locale)
  const days = trigger.kind === "weekly" ? trigger.weekdays : []
  const text = trigger.kind === "daily" || days.length === 7 ? t("schedules.cadence.daily", { time })
    : days.length === 5 && days.every(day => day >= 1 && day <= 5) ? t("schedules.cadence.weekdays", { time })
      : t("schedules.cadence.weekly", { time, days: new Intl.ListFormat(intlLocale(locale as AppLocale), { style: "narrow" }).format(WEEKDAYS.filter(day => days.includes(day)).map(day => weekdayName(day, locale))) })
  return trigger.timeZone === localTimeZone() ? text : `${text} · ${trigger.timeZone}`
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]]

/** "in 18 hours", "5 minutes ago": precise enough to tell whether a run is near or recent. */
export function relativeTime(value: string, now: Date, locale: string): string {
  const delta = Date.parse(value) - now.getTime()
  const format = new Intl.RelativeTimeFormat(intlLocale(locale as AppLocale), { numeric: "auto" })
  const [unit, size] = UNITS.find(([, size]) => Math.abs(delta) >= size) ?? ["minute", 60_000]
  return format.format(Math.round(delta / size), unit)
}

export function absoluteTime(value: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale as AppLocale), { dateStyle: "medium", timeStyle: "short", ...(timeZone && { timeZone }) }).format(new Date(value))
}
