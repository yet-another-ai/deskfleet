import { readOrCreateGaClientId } from "./marketing-attribution.ts"

export interface GoogleTagConfiguration {
  gtmId?: string
  gaMeasurementId?: string
  googleAdsId?: string
  googleAdsInstallLabel?: string
  platform?: string
}

interface DataLayerWindow {
  dataLayer?: unknown[]
  gtag?: (...args: unknown[]) => void
}

const CONSENT_DENIED = {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
} as const

const CONSENT_GRANTED = {
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
  analytics_storage: "granted",
} as const

let currentConfig: GoogleTagConfiguration | undefined
let activeConsent = false
let currentUserId: string | undefined
let defaultConsentPushed = false
const injectedScripts = new Set<string>()

function cleanId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function hasGoogleTagConfiguration(config?: GoogleTagConfiguration): boolean {
  if (!config) return false
  return Boolean(cleanId(config.gtmId) || cleanId(config.gaMeasurementId) || cleanId(config.googleAdsId))
}

function getWindow(): (Window & DataLayerWindow) | undefined {
  return typeof window !== "undefined" ? (window as Window & DataLayerWindow) : undefined
}

function pushGtag(...args: unknown[]): void {
  const win = getWindow()
  if (!win) return
  win.dataLayer ??= []
  if (typeof win.gtag === "function") {
    win.gtag(...args)
  } else {
    win.dataLayer.push(args)
  }
}

function pushDataLayerObject(payload: Record<string, unknown>): void {
  const win = getWindow()
  if (!win) return
  win.dataLayer ??= []
  win.dataLayer.push(payload)
}

function injectScriptOnce(src: string): void {
  if (typeof document === "undefined" || injectedScripts.has(src)) return
  injectedScripts.add(src)
  if (document.querySelector(`script[src="${src}"]`)) return
  const script = document.createElement("script")
  script.async = true
  script.src = src
  document.head?.appendChild(script)
}

function getLocationHref(): string | undefined {
  if (typeof location !== "undefined" && typeof location.href === "string") return location.href
  const winLoc = getWindow()?.location
  return typeof winLoc?.href === "string" ? winLoc.href : undefined
}

/** Normalizes custom-scheme Electron/Capacitor URLs so GA4 accepts page_location. */
export function normalizeGooglePageLocation(href?: string): string {
  const raw = href ?? getLocationHref() ?? "https://app.deskfleet.org/"
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString()
    }
    const hashPath = parsed.hash.startsWith("#/") ? parsed.hash.slice(1) : parsed.pathname
    const cleanPath = hashPath.startsWith("/") ? hashPath : `/${hashPath}`
    return `https://app.deskfleet.org${cleanPath}`
  } catch {
    return "https://app.deskfleet.org/"
  }
}

function isCustomSchemeEnvironment(): boolean {
  const href = getLocationHref()
  if (!href) return false
  try {
    const parsed = new URL(href)
    return parsed.protocol !== "http:" && parsed.protocol !== "https:"
  } catch {
    return false
  }
}

/** Initializes Google Consent Mode v2 in default-denied state before any tag runs. */
export function initializeGoogleConsentMode(): void {
  const win = getWindow()
  if (!win || defaultConsentPushed) return
  win.dataLayer ??= []
  win.gtag ??= function gtag(...args: unknown[]) {
    win.dataLayer!.push(args)
  }
  defaultConsentPushed = true
  pushGtag("consent", "default", { ...CONSENT_DENIED, wait_for_update: 500 })
}

/** Updates Google Tag configuration and consent state. Scripts only load when enabled and consented. */
export function configureGoogleTag(
  config: GoogleTagConfiguration | undefined,
  consented: boolean,
): void {
  currentConfig = config ? {
    gtmId: cleanId(config.gtmId),
    gaMeasurementId: cleanId(config.gaMeasurementId),
    googleAdsId: cleanId(config.googleAdsId),
    googleAdsInstallLabel: cleanId(config.googleAdsInstallLabel),
    platform: cleanId(config.platform),
  } : undefined

  if (!hasGoogleTagConfiguration(currentConfig)) {
    if (activeConsent) {
      pushGtag("consent", "update", { ...CONSENT_DENIED })
      activeConsent = false
    }
    return
  }

  initializeGoogleConsentMode()

  if (!consented) {
    if (activeConsent) {
      pushGtag("consent", "update", { ...CONSENT_DENIED })
      activeConsent = false
    }
    return
  }

  const wasActive = activeConsent
  activeConsent = true
  if (!wasActive) {
    pushGtag("js", new Date())
    pushGtag("consent", "update", { ...CONSENT_GRANTED })
  }

  const clientId = readOrCreateGaClientId(true)
  const customScheme = isCustomSchemeEnvironment()
  const gtmId = currentConfig?.gtmId
  const gaId = currentConfig?.gaMeasurementId
  const adsId = currentConfig?.googleAdsId

  if (gtmId) {
    pushDataLayerObject({
      "gtm.start": Date.now(),
      event: "gtm.js",
      ...(clientId ? { ga_client_id: clientId } : {}),
      ...(currentConfig?.platform ? { app_platform: currentConfig.platform } : {}),
    })
    injectScriptOnce(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`)
  }

  const gtagBootstrapId = gaId ?? adsId
  if (gtagBootstrapId) {
    injectScriptOnce(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gtagBootstrapId)}`)
  }

  if (gaId && !wasActive) {
    pushGtag("config", gaId, {
      send_page_view: false,
      ...(customScheme ? { client_storage: "none" } : {}),
      ...(clientId ? { client_id: clientId } : {}),
      ...(currentUserId ? { user_id: currentUserId } : {}),
      ...(currentConfig?.platform ? { app_platform: currentConfig.platform } : {}),
      page_location: normalizeGooglePageLocation(),
    })
  }

  if (adsId && !wasActive) {
    pushGtag("config", adsId, {
      ...(customScheme ? { client_storage: "none" } : {}),
    })
  }
}

export function identifyGoogleTagUser(userId?: string): void {
  const next = cleanId(userId)
  if (currentUserId === next) return
  currentUserId = next
  if (!activeConsent || !hasGoogleTagConfiguration(currentConfig)) return
  if (currentConfig?.gaMeasurementId) {
    pushGtag("set", { user_id: currentUserId ?? null })
  }
  pushDataLayerObject({
    event: "user_context_updated",
    user_id: currentUserId ?? null,
  })
}

export function trackGoogleEvent(
  name: string,
  metadata: Record<string, string | number | boolean | undefined> = {},
  options: { isAcquisitionConversion?: boolean } = {},
): void {
  if (!activeConsent || !hasGoogleTagConfiguration(currentConfig)) return
  const cleanParams: Record<string, string | number | boolean> = {
    page_location: normalizeGooglePageLocation(),
    ...(currentConfig?.platform ? { app_platform: currentConfig.platform } : {}),
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) cleanParams[key] = value
  }
  if (currentUserId) cleanParams.user_id = currentUserId

  if (currentConfig?.gtmId) {
    pushDataLayerObject({ event: name, ...cleanParams })
  }
  if (currentConfig?.gaMeasurementId || currentConfig?.googleAdsId) {
    pushGtag("event", name, cleanParams)
  }
  if (options.isAcquisitionConversion && currentConfig?.googleAdsInstallLabel) {
    pushGtag("event", "conversion", {
      send_to: currentConfig.googleAdsInstallLabel,
      ...cleanParams,
    })
  }
}

export function resetGoogleTagForTests(): void {
  currentConfig = undefined
  activeConsent = false
  currentUserId = undefined
  defaultConsentPushed = false
  injectedScripts.clear()
  const win = getWindow()
  if (win) {
    delete win.dataLayer
    delete win.gtag
  }
}
