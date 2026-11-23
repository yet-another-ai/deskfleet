import type { MarketingAttribution } from "@deskfleet/protocol/generated/central-control"

export type { MarketingAttribution } from "@deskfleet/protocol/generated/central-control"

export const TELEMETRY_CONSENT_STORAGE_KEY = "deskfleet-telemetry-consent"
export const MARKETING_ATTRIBUTION_STORAGE_KEY = "deskfleet-marketing-attribution"
export const PENDING_MARKETING_ATTRIBUTION_SESSION_KEY = "deskfleet-pending-marketing-attribution"
export const GA_CLIENT_ID_STORAGE_KEY = "deskfleet-ga-client-id"
const MAX_PARAM_LENGTH = 256

export type TelemetryConsentDecision = "granted" | "declined"

type ReadableStorage = Pick<Storage, "getItem">
type WritableStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function defaultStorage(): WritableStorage | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined
  } catch {
    return undefined
  }
}

function defaultSessionStorage(): WritableStorage | undefined {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : undefined
  } catch {
    return undefined
  }
}

function cleanParam(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_PARAM_LENGTH) return undefined
  return trimmed
}

function hasAttributionFields(value: MarketingAttribution): boolean {
  return Boolean(
    value.gclid
    || value.gbraid
    || value.wbraid
    || value.utmSource
    || value.utmMedium
    || value.utmCampaign
    || value.utmTerm
    || value.utmContent
    || value.gaClientId,
  )
}

function parseAttributionFromSearch(search: string): MarketingAttribution {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  const parsed: MarketingAttribution = {}
  const gclid = cleanParam(params.get("gclid"))
  const gbraid = cleanParam(params.get("gbraid"))
  const wbraid = cleanParam(params.get("wbraid"))
  const utmSource = cleanParam(params.get("utm_source"))
  const utmMedium = cleanParam(params.get("utm_medium"))
  const utmCampaign = cleanParam(params.get("utm_campaign"))
  const utmTerm = cleanParam(params.get("utm_term"))
  const utmContent = cleanParam(params.get("utm_content"))
  const gaClientId = cleanParam(params.get("ga_cid"))
  if (gclid) parsed.gclid = gclid
  if (gbraid) parsed.gbraid = gbraid
  if (wbraid) parsed.wbraid = wbraid
  if (utmSource) parsed.utmSource = utmSource
  if (utmMedium) parsed.utmMedium = utmMedium
  if (utmCampaign) parsed.utmCampaign = utmCampaign
  if (utmTerm) parsed.utmTerm = utmTerm
  if (utmContent) parsed.utmContent = utmContent
  if (gaClientId) parsed.gaClientId = gaClientId
  return parsed
}

/** First-touch fields take precedence over later partial values. */
export function mergeMarketingAttribution(
  existing: MarketingAttribution | undefined,
  incoming: MarketingAttribution | undefined,
): MarketingAttribution | undefined {
  const merged: MarketingAttribution = {}
  const keys = [
    "gclid",
    "gbraid",
    "wbraid",
    "utmSource",
    "utmMedium",
    "utmCampaign",
    "utmTerm",
    "utmContent",
    "gaClientId",
  ] as const
  for (const key of keys) {
    const value = cleanParam(existing?.[key]) ?? cleanParam(incoming?.[key])
    if (value) merged[key] = value
  }
  return hasAttributionFields(merged) ? merged : undefined
}

let pendingMemoryAttribution: MarketingAttribution | undefined

function readStoredObject(
  storage: ReadableStorage | undefined,
  key: string = MARKETING_ATTRIBUTION_STORAGE_KEY,
): MarketingAttribution | undefined {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return mergeMarketingAttribution(undefined, {
      gclid: typeof parsed.gclid === "string" ? parsed.gclid : undefined,
      gbraid: typeof parsed.gbraid === "string" ? parsed.gbraid : undefined,
      wbraid: typeof parsed.wbraid === "string" ? parsed.wbraid : undefined,
      utmSource: typeof parsed.utmSource === "string" ? parsed.utmSource : undefined,
      utmMedium: typeof parsed.utmMedium === "string" ? parsed.utmMedium : undefined,
      utmCampaign: typeof parsed.utmCampaign === "string" ? parsed.utmCampaign : undefined,
      utmTerm: typeof parsed.utmTerm === "string" ? parsed.utmTerm : undefined,
      utmContent: typeof parsed.utmContent === "string" ? parsed.utmContent : undefined,
      gaClientId: typeof parsed.gaClientId === "string" ? parsed.gaClientId : undefined,
    })
  } catch {
    return undefined
  }
}

export function readStoredTelemetryConsent(
  storage: ReadableStorage | undefined = defaultStorage(),
): TelemetryConsentDecision | undefined {
  try {
    const raw = storage?.getItem(TELEMETRY_CONSENT_STORAGE_KEY)
    if (raw === "granted" || raw === "declined") return raw
    return undefined
  } catch {
    return undefined
  }
}

export function captureMarketingSearchParams(
  search: string = typeof window !== "undefined" ? window.location?.search ?? "" : "",
  consented = false,
  storage: WritableStorage | undefined = defaultStorage(),
  sessionStore: WritableStorage | undefined = defaultSessionStorage(),
): MarketingAttribution | undefined {
  const sessionPending = readStoredTelemetryConsent(storage) === "declined"
    ? undefined
    : readStoredObject(sessionStore, PENDING_MARKETING_ATTRIBUTION_SESSION_KEY)
  const parsed = parseAttributionFromSearch(search)
  pendingMemoryAttribution = mergeMarketingAttribution(
    mergeMarketingAttribution(sessionPending, pendingMemoryAttribution),
    hasAttributionFields(parsed) ? parsed : undefined,
  )
  if (!consented) {
    if (pendingMemoryAttribution && readStoredTelemetryConsent(storage) !== "declined") {
      try {
        sessionStore?.setItem(
          PENDING_MARKETING_ATTRIBUTION_SESSION_KEY,
          JSON.stringify(pendingMemoryAttribution),
        )
      } catch {
        // Ignore session storage write errors.
      }
    }
    return pendingMemoryAttribution
  }
  const stored = readStoredObject(storage)
  const merged = mergeMarketingAttribution(stored, pendingMemoryAttribution)
  if (merged) {
    try {
      storage?.setItem(MARKETING_ATTRIBUTION_STORAGE_KEY, JSON.stringify(merged))
      sessionStore?.removeItem(PENDING_MARKETING_ATTRIBUTION_SESSION_KEY)
      if (merged.gaClientId && !storage?.getItem(GA_CLIENT_ID_STORAGE_KEY)) {
        storage?.setItem(GA_CLIENT_ID_STORAGE_KEY, merged.gaClientId)
      }
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }
  return merged
}

export function clearMarketingAttribution(
  storage: Pick<Storage, "removeItem"> | undefined = defaultStorage(),
  sessionStore: Pick<Storage, "removeItem"> | undefined = defaultSessionStorage(),
): void {
  pendingMemoryAttribution = undefined
  try {
    storage?.removeItem(MARKETING_ATTRIBUTION_STORAGE_KEY)
    storage?.removeItem(GA_CLIENT_ID_STORAGE_KEY)
    sessionStore?.removeItem(PENDING_MARKETING_ATTRIBUTION_SESSION_KEY)
  } catch {
    // Ignore storage removal errors.
  }
}

export function writeStoredTelemetryConsent(
  decision: TelemetryConsentDecision,
  storage: WritableStorage | undefined = defaultStorage(),
  sessionStore: WritableStorage | undefined = defaultSessionStorage(),
): void {
  try {
    storage?.setItem(TELEMETRY_CONSENT_STORAGE_KEY, decision)
  } catch {
    // Ignore storage write errors.
  }
  if (decision === "granted") {
    captureMarketingSearchParams("", true, storage, sessionStore)
  } else {
    clearMarketingAttribution(storage, sessionStore)
  }
}

export function readOrCreateGaClientId(
  consented: boolean,
  storage: WritableStorage | undefined = defaultStorage(),
): string | undefined {
  if (!consented) return undefined
  try {
    const sessionPending = readStoredObject(defaultSessionStorage(), PENDING_MARKETING_ATTRIBUTION_SESSION_KEY)
    const existing = cleanParam(storage?.getItem(GA_CLIENT_ID_STORAGE_KEY))
      ?? readStoredObject(storage)?.gaClientId
      ?? pendingMemoryAttribution?.gaClientId
      ?? sessionPending?.gaClientId
    if (existing) {
      storage?.setItem(GA_CLIENT_ID_STORAGE_KEY, existing)
      return existing
    }
    const generated = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`
    storage?.setItem(GA_CLIENT_ID_STORAGE_KEY, generated)
    return generated
  } catch {
    return undefined
  }
}

export function readMarketingAttribution(
  consented: boolean,
  storage: ReadableStorage | undefined = defaultStorage(),
): MarketingAttribution | undefined {
  if (!consented) return undefined
  const stored = readStoredObject(storage)
  const sessionPending = readStoredObject(defaultSessionStorage(), PENDING_MARKETING_ATTRIBUTION_SESSION_KEY)
  const pending = mergeMarketingAttribution(sessionPending, pendingMemoryAttribution)
  let gaClientId: string | undefined
  try {
    gaClientId = cleanParam(storage?.getItem(GA_CLIENT_ID_STORAGE_KEY))
  } catch {
    gaClientId = undefined
  }
  return mergeMarketingAttribution(stored, {
    ...pending,
    ...(gaClientId ? { gaClientId } : {}),
  })
}

/** Appends consented first-touch attribution and GA client ID parameters to an outbound URL. */
export function appendAttributionParams(
  targetUrl: string,
  consented: boolean,
  storage: ReadableStorage | undefined = defaultStorage(),
): string {
  if (!consented) return targetUrl
  const attribution = readMarketingAttribution(true, storage)
  if (!attribution) return targetUrl
  try {
    const parsed = new URL(targetUrl, "https://www.deskfleet.org")
    const entries: Array<[string, string | undefined]> = [
      ["gclid", attribution.gclid],
      ["gbraid", attribution.gbraid],
      ["wbraid", attribution.wbraid],
      ["utm_source", attribution.utmSource],
      ["utm_medium", attribution.utmMedium],
      ["utm_campaign", attribution.utmCampaign],
      ["utm_term", attribution.utmTerm],
      ["utm_content", attribution.utmContent],
      ["ga_cid", attribution.gaClientId],
    ]
    for (const [key, value] of entries) {
      if (value && !parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, value)
      }
    }
    if (/^https?:\/\//i.test(targetUrl)) return parsed.toString()
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return targetUrl
  }
}
