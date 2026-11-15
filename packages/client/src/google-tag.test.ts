import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveSurfaceGoogleTagIds } from "./analytics-config.ts"
import {
  configureGoogleTag,
  hasGoogleTagConfiguration,
  identifyGoogleTagUser,
  normalizeGooglePageLocation,
  resetGoogleTagForTests,
  setNativeTelemetrySink,
  trackGoogleEvent,
} from "./google-tag.ts"
import { clearMarketingAttribution } from "./marketing-attribution.ts"

function installFakeDom(href = "https://deskfleet.org/download") {
  const appendedScripts: Array<{ async: boolean; src: string }> = []
  const head = {
    appendChild(node: { async: boolean; src: string }) {
      appendedScripts.push(node)
      return node
    },
  }
  const fakeDocument = {
    head,
    title: "DeskFleet",
    querySelector(selector: string) {
      return appendedScripts.find(script => selector.includes(script.src)) ?? null
    },
    createElement(_tag: string) {
      return { async: false, src: "" }
    },
  }
  const fakeWindow: {
    location: URL
    dataLayer?: unknown[]
    gtag?: (...args: unknown[]) => void
  } = {
    location: new URL(href),
  }
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true, writable: true })
  Object.defineProperty(globalThis, "document", { value: fakeDocument, configurable: true, writable: true })
  return { appendedScripts, fakeWindow }
}

describe("google-tag", () => {
  afterEach(() => {
    resetGoogleTagForTests()
    clearMarketingAttribution()
    delete (globalThis as { window?: unknown }).window
    delete (globalThis as { document?: unknown }).document
  })

  it("normalizes custom-scheme Electron and Capacitor URLs to https://app.deskfleet.org", () => {
    expect(normalizeGooglePageLocation("deskfleet-app://bundle/index.html#/sessions/123")).toBe(
      "https://app.deskfleet.org/sessions/123",
    )
    expect(normalizeGooglePageLocation("capacitor://localhost/settings/preferences")).toBe(
      "https://app.deskfleet.org/settings/preferences",
    )
    expect(normalizeGooglePageLocation("https://deskfleet.org/pricing?utm_source=google")).toBe(
      "https://deskfleet.org/pricing?utm_source=google",
    )
  })

  it("keeps Google Consent Mode v2 denied and avoids injecting scripts until consent is granted", () => {
    const { appendedScripts, fakeWindow } = installFakeDom("https://deskfleet.org/")
    const config = {
      gtmId: "GTM-TEST123",
      gaMeasurementId: "G-TEST456",
      googleAdsId: "AW-TEST789",
      platform: "docs",
    }
    expect(hasGoogleTagConfiguration(config)).toBe(true)

    configureGoogleTag(config, false)
    expect(appendedScripts).toHaveLength(0)

    const entries = fakeWindow.dataLayer as unknown[]
    expect(entries).toEqual([
      [
        "consent",
        "default",
        {
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          analytics_storage: "denied",
          wait_for_update: 500,
        },
      ],
    ])

    trackGoogleEvent("marketing_page_viewed", { page: "/" })
    expect(entries).toHaveLength(1)

    configureGoogleTag(config, true)
    expect(appendedScripts.map(script => script.src)).toEqual([
      "https://www.googletagmanager.com/gtm.js?id=GTM-TEST123",
      "https://www.googletagmanager.com/gtag/js?id=G-TEST456",
    ])
    expect(entries).toContainEqual([
      "consent",
      "update",
      {
        ad_storage: "granted",
        ad_user_data: "granted",
        ad_personalization: "granted",
        analytics_storage: "granted",
      },
    ])

    trackGoogleEvent("marketing_download_clicked", { os: "macos" })
    expect(entries).toContainEqual({
      event: "marketing_download_clicked",
      os: "macos",
      app_platform: "docs",
      page_location: "https://deskfleet.org/",
    })
  })

  it("loads gtag.js with client_storage none on custom schemes and emits conversion labels", () => {
    const { appendedScripts, fakeWindow } = installFakeDom("deskfleet-app://bundle/index.html#/welcome")
    const config = {
      gaMeasurementId: "G-NATIVE01",
      googleAdsId: "AW-999",
      googleAdsInstallLabel: "AW-999/regLabel",
      platform: "macos",
    }
    configureGoogleTag(config, true)
    identifyGoogleTagUser("user-42")

    expect(appendedScripts.map(script => script.src)).toEqual([
      "https://www.googletagmanager.com/gtag/js?id=G-NATIVE01",
    ])

    const entries = fakeWindow.dataLayer as unknown[]
    expect(entries).toContainEqual([
      "config",
      "G-NATIVE01",
      expect.objectContaining({
        send_page_view: false,
        page_location: "https://app.deskfleet.org/welcome",
        client_storage: "none",
        app_platform: "macos",
      }),
    ])
    expect(entries).toContainEqual(["set", { user_id: "user-42" }])

    trackGoogleEvent("account_registered", { method: "github" }, { isAcquisitionConversion: true })
    expect(entries).toContainEqual([
      "event",
      "conversion",
      {
        send_to: "AW-999/regLabel",
        method: "github",
        user_id: "user-42",
        app_platform: "macos",
        page_location: "https://app.deskfleet.org/welcome",
      },
    ])

    configureGoogleTag(config, false)
    const lengthAfterRevoke = entries.length
    trackGoogleEvent("app_opened")
    expect(entries).toHaveLength(lengthAfterRevoke)
  })

  it("resolves per-surface GA4/GTM stream IDs and keeps mobile WebViews isolated from Web G- streams", () => {
    const env = {
      VITE_GTM_ID: "GTM-FALLBACK",
      VITE_GA_MEASUREMENT_ID: "G-FALLBACK",
      VITE_DOCS_GA_MEASUREMENT_ID: "G-DOCS001",
      VITE_WEB_GA_MEASUREMENT_ID: "G-WEB001",
      VITE_DESKTOP_GA_MEASUREMENT_ID: "G-DESKTOP001",
    }
    expect(resolveSurfaceGoogleTagIds("docs", env)).toEqual({
      gtmId: "GTM-FALLBACK",
      gaMeasurementId: "G-DOCS001",
      googleAdsId: undefined,
      googleAdsInstallLabel: undefined,
    })
    expect(resolveSurfaceGoogleTagIds("web", env).gaMeasurementId).toBe("G-WEB001")
    expect(resolveSurfaceGoogleTagIds("desktop", env).gaMeasurementId).toBe("G-DESKTOP001")
    expect(resolveSurfaceGoogleTagIds("android", env).gaMeasurementId).toBeUndefined()
    expect(resolveSurfaceGoogleTagIds("ios", env).gaMeasurementId).toBeUndefined()
  })

  it("forwards consent, userId, and events to the Capacitor native Firebase sink without injecting gtag.js", () => {
    const { appendedScripts } = installFakeDom("capacitor://localhost/welcome")
    const sink = {
      setConsent: vi.fn(),
      setUserId: vi.fn(),
      logEvent: vi.fn(),
    }
    setNativeTelemetrySink(sink)
    expect(hasGoogleTagConfiguration({ platform: "android" })).toBe(true)

    configureGoogleTag({ platform: "android" }, false)
    expect(sink.setConsent).toHaveBeenCalledWith(false)
    expect(sink.setUserId).toHaveBeenCalledWith(null)
    trackGoogleEvent("app_opened", { surface: "app" })
    expect(sink.logEvent).not.toHaveBeenCalled()

    configureGoogleTag({ platform: "android" }, true)
    identifyGoogleTagUser("user-mobile-1")
    trackGoogleEvent("account_registered", { method: "password" }, { isAcquisitionConversion: true })

    expect(appendedScripts).toHaveLength(0)
    expect(sink.setConsent).toHaveBeenLastCalledWith(true)
    expect(sink.setUserId).toHaveBeenLastCalledWith("user-mobile-1")
    expect(sink.logEvent).toHaveBeenCalledWith(
      "account_registered",
      expect.objectContaining({
        method: "password",
        user_id: "user-mobile-1",
        app_platform: "android",
        page_location: "https://app.deskfleet.org/welcome",
      }),
    )
  })
})
