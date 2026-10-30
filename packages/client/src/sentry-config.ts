/** Parse a public Sentry DSN shared by SDK setup and renderer CSP generation. */
export function parseSentryDsn(value: string | undefined): { dsn: string; origin: string } | undefined {
  const dsn = value?.trim()
  if (!dsn) return undefined
  try {
    const url = new URL(dsn)
    if (!["http:", "https:"].includes(url.protocol)
      || !/^\w+$/.test(url.username)
      || url.password || url.search || url.hash
      // Match the SDK's DNS/IPv4 and bracketed IPv6 host forms.
      || !/^(?:[\w.-]+|\[[\da-f:.]+\])$/.test(url.hostname)
      || !/\/\d+$/.test(url.pathname)) return undefined
    return { dsn: url.href, origin: url.origin }
  } catch {
    return undefined
  }
}
