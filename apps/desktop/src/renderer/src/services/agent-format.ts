/** Milliseconds between two timestamps, or undefined when either is unknown. */
export function elapsed(from: string | undefined, to: string | number | undefined): number | undefined {
  const start = from ? Date.parse(from) : NaN
  const end = typeof to === "number" ? to : to ? Date.parse(to) : NaN
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined
}

/** Compact elapsed time: `42s`, `3m 22s`, `1h 04m`. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** Short message time such as `10/6 08:33 PM`; undefined for unparseable values. */
export function formatMessageTime(value: string | undefined, locale: string): string | undefined {
  const time = value ? Date.parse(value) : NaN
  if (!Number.isFinite(time)) return undefined
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(time)
}

/** One or two initials for an avatar. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0]![0], words[1]![0]] : [...(words[0] ?? "")].slice(0, 1)
  return letters.join("").toUpperCase()
}
