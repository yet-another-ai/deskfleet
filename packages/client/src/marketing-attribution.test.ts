import { beforeEach, describe, expect, test } from "vitest"
import {
  appendAttributionParams,
  captureMarketingSearchParams,
  clearMarketingAttribution,
  GA_CLIENT_ID_STORAGE_KEY,
  MARKETING_ATTRIBUTION_STORAGE_KEY,
  PENDING_MARKETING_ATTRIBUTION_SESSION_KEY,
  readMarketingAttribution,
  readOrCreateGaClientId,
  readStoredTelemetryConsent,
  TELEMETRY_CONSENT_STORAGE_KEY,
  writeStoredTelemetryConsent,
} from "./marketing-attribution.ts"

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

describe("marketing attribution and consent storage", () => {
  beforeEach(() => {
    clearMarketingAttribution(memoryStorage())
  })

  test("holds URL attribution in memory before consent and flushes on grant", () => {
    const storage = memoryStorage()
    const captured = captureMarketingSearchParams(
      "?gclid=gclid_123&utm_source=google&utm_campaign=q4_launch",
      false,
      storage,
    )
    expect(captured).toEqual({
      gclid: "gclid_123",
      utmSource: "google",
      utmCampaign: "q4_launch",
    })
    expect(storage.getItem(MARKETING_ATTRIBUTION_STORAGE_KEY)).toBeNull()
    expect(readMarketingAttribution(false, storage)).toBeUndefined()

    writeStoredTelemetryConsent("granted", storage)
    expect(readStoredTelemetryConsent(storage)).toBe("granted")
    expect(JSON.parse(storage.getItem(MARKETING_ATTRIBUTION_STORAGE_KEY)!)).toEqual({
      gclid: "gclid_123",
      utmSource: "google",
      utmCampaign: "q4_launch",
    })
  })

  test("preserves pre-consent URL attribution in sessionStorage across navigations and clears on decline", () => {
    const storage = memoryStorage()
    const session = memoryStorage()
    captureMarketingSearchParams("?gclid=oauth_gclid&utm_source=google", false, storage, session)
    expect(storage.getItem(MARKETING_ATTRIBUTION_STORAGE_KEY)).toBeNull()
    expect(JSON.parse(session.getItem(PENDING_MARKETING_ATTRIBUTION_SESSION_KEY)!)).toEqual({
      gclid: "oauth_gclid",
      utmSource: "google",
    })

    // Simulate a redirect to /auth/login or OAuth callback without query params before consent
    clearMarketingAttribution(memoryStorage(), memoryStorage())
    captureMarketingSearchParams("", false, storage, session)
    writeStoredTelemetryConsent("granted", storage, session)
    expect(session.getItem(PENDING_MARKETING_ATTRIBUTION_SESSION_KEY)).toBeNull()
    expect(JSON.parse(storage.getItem(MARKETING_ATTRIBUTION_STORAGE_KEY)!)).toEqual({
      gclid: "oauth_gclid",
      utmSource: "google",
    })

    writeStoredTelemetryConsent("declined", storage, session)
    expect(storage.getItem(MARKETING_ATTRIBUTION_STORAGE_KEY)).toBeNull()
    expect(session.getItem(PENDING_MARKETING_ATTRIBUTION_SESSION_KEY)).toBeNull()
  })

  test("preserves first-touch fields and clears everything when consent is declined", () => {
    const storage = memoryStorage()
    writeStoredTelemetryConsent("granted", storage)
    captureMarketingSearchParams("?gclid=first_gclid&utm_source=google", true, storage)
    captureMarketingSearchParams("?gclid=second_gclid&utm_medium=cpc", true, storage)
    const gaId = readOrCreateGaClientId(true, storage)
    expect(gaId).toBeTruthy()
    expect(readMarketingAttribution(true, storage)).toEqual({
      gclid: "first_gclid",
      utmSource: "google",
      utmMedium: "cpc",
      gaClientId: gaId,
    })

    writeStoredTelemetryConsent("declined", storage)
    expect(readStoredTelemetryConsent(storage)).toBe("declined")
    expect(storage.getItem(MARKETING_ATTRIBUTION_STORAGE_KEY)).toBeNull()
    expect(storage.getItem(GA_CLIENT_ID_STORAGE_KEY)).toBeNull()
    expect(storage.getItem(TELEMETRY_CONSENT_STORAGE_KEY)).toBe("declined")
    expect(readMarketingAttribution(true, storage)).toBeUndefined()
  })

  test("appends attribution params to cross-domain and relative links only when consented", () => {
    const storage = memoryStorage()
    captureMarketingSearchParams("?gclid=abc&utm_source=google&ga_cid=cid_99", true, storage)
    expect(appendAttributionParams("https://deskfleet.yetanother.ai", false, storage)).toBe(
      "https://deskfleet.yetanother.ai",
    )
    expect(appendAttributionParams("https://deskfleet.yetanother.ai", true, storage)).toBe(
      "https://deskfleet.yetanother.ai/?gclid=abc&utm_source=google&ga_cid=cid_99",
    )
    expect(appendAttributionParams("/auth/desktop?attempt=xyz", true, storage)).toBe(
      "/auth/desktop?attempt=xyz&gclid=abc&utm_source=google&ga_cid=cid_99",
    )
  })
})
