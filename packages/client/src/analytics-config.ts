export const STATSIG_INITIALIZE_URL = "https://featureassets.org/v1/initialize"
export const STATSIG_LOG_EVENT_URL = "https://prodregistryv2.org/v1/rgstr"
export const STATSIG_SDK_EXCEPTION_URL = "https://statsigapi.net/v1/sdk_exception"

export const STATSIG_CONNECT_ORIGINS = [
  new URL(STATSIG_INITIALIZE_URL).origin,
  new URL(STATSIG_LOG_EVENT_URL).origin,
  new URL(STATSIG_SDK_EXCEPTION_URL).origin,
] as const

export const GOOGLE_TAG_SCRIPT_ORIGINS = [
  "https://www.googletagmanager.com",
] as const

export const GOOGLE_TAG_CONNECT_ORIGINS = [
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://analytics.google.com",
  "https://region1.google-analytics.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
] as const

export const GOOGLE_TAG_IMG_ORIGINS = [
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
] as const

export type AnalyticsSurface = "docs" | "web" | "desktop" | "android" | "ios"

export interface SurfaceGoogleTagIds {
  gtmId?: string
  gaMeasurementId?: string
  googleAdsId?: string
  googleAdsInstallLabel?: string
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * Resolves per-surface Google Tag / GA4 Data Stream IDs.
 * - `docs` (Landing Page): `VITE_DOCS_*` -> `VITE_*`
 * - `web` (Web App / PWA): `VITE_WEB_*` -> `VITE_APP_*` -> `VITE_*`
 * - `desktop` (Electron): `VITE_DESKTOP_*` -> `VITE_APP_*` -> `VITE_*`
 * - `android` / `ios` (Capacitor): only explicit `VITE_ANDROID_*` / `VITE_IOS_*` so mobile WebViews
 *   use native Firebase (`google-services.json` / `GoogleService-Info.plist`) instead of the shared Web `G-` stream.
 */
export function resolveSurfaceGoogleTagIds(
  surface: AnalyticsSurface,
  env: Record<string, string | undefined>,
): SurfaceGoogleTagIds {
  switch (surface) {
    case "docs":
      return {
        gtmId: firstNonEmpty(env.VITE_DOCS_GTM_ID, env.VITE_GTM_ID),
        gaMeasurementId: firstNonEmpty(env.VITE_DOCS_GA_MEASUREMENT_ID, env.VITE_GA_MEASUREMENT_ID),
        googleAdsId: firstNonEmpty(env.VITE_DOCS_GOOGLE_ADS_ID, env.VITE_GOOGLE_ADS_ID),
        googleAdsInstallLabel: firstNonEmpty(env.VITE_DOCS_GOOGLE_ADS_INSTALL_LABEL, env.VITE_GOOGLE_ADS_INSTALL_LABEL),
      }
    case "web":
      return {
        gtmId: firstNonEmpty(env.VITE_WEB_GTM_ID, env.VITE_APP_GTM_ID, env.VITE_GTM_ID),
        gaMeasurementId: firstNonEmpty(env.VITE_WEB_GA_MEASUREMENT_ID, env.VITE_APP_GA_MEASUREMENT_ID, env.VITE_GA_MEASUREMENT_ID),
        googleAdsId: firstNonEmpty(env.VITE_WEB_GOOGLE_ADS_ID, env.VITE_APP_GOOGLE_ADS_ID, env.VITE_GOOGLE_ADS_ID),
        googleAdsInstallLabel: firstNonEmpty(
          env.VITE_WEB_GOOGLE_ADS_INSTALL_LABEL,
          env.VITE_APP_GOOGLE_ADS_INSTALL_LABEL,
          env.VITE_GOOGLE_ADS_INSTALL_LABEL,
        ),
      }
    case "desktop":
      return {
        gtmId: firstNonEmpty(env.VITE_DESKTOP_GTM_ID, env.VITE_APP_GTM_ID, env.VITE_GTM_ID),
        gaMeasurementId: firstNonEmpty(env.VITE_DESKTOP_GA_MEASUREMENT_ID, env.VITE_APP_GA_MEASUREMENT_ID, env.VITE_GA_MEASUREMENT_ID),
        googleAdsId: firstNonEmpty(env.VITE_DESKTOP_GOOGLE_ADS_ID, env.VITE_APP_GOOGLE_ADS_ID, env.VITE_GOOGLE_ADS_ID),
        googleAdsInstallLabel: firstNonEmpty(
          env.VITE_DESKTOP_GOOGLE_ADS_INSTALL_LABEL,
          env.VITE_APP_GOOGLE_ADS_INSTALL_LABEL,
          env.VITE_GOOGLE_ADS_INSTALL_LABEL,
        ),
      }
    case "android":
      return {
        gtmId: firstNonEmpty(env.VITE_ANDROID_GTM_ID),
        gaMeasurementId: firstNonEmpty(env.VITE_ANDROID_GA_MEASUREMENT_ID),
        googleAdsId: firstNonEmpty(env.VITE_ANDROID_GOOGLE_ADS_ID),
        googleAdsInstallLabel: firstNonEmpty(env.VITE_ANDROID_GOOGLE_ADS_INSTALL_LABEL),
      }
    case "ios":
      return {
        gtmId: firstNonEmpty(env.VITE_IOS_GTM_ID),
        gaMeasurementId: firstNonEmpty(env.VITE_IOS_GA_MEASUREMENT_ID),
        googleAdsId: firstNonEmpty(env.VITE_IOS_GOOGLE_ADS_ID),
        googleAdsInstallLabel: firstNonEmpty(env.VITE_IOS_GOOGLE_ADS_INSTALL_LABEL),
      }
  }
}
