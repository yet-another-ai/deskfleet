import { StatsigClient, type StatsigUser } from "@statsig/js-client"
import { computed, readonly, ref } from "vue"
import { STATSIG_INITIALIZE_URL, STATSIG_LOG_EVENT_URL } from "@deskfleet/client/analytics-config"
import type { BillingPlan } from "@deskfleet/client/billing"
import type { Team } from "@deskfleet/client/central"
import {
  configureGoogleTag,
  identifyGoogleTagUser,
  shutdownGoogleTag,
  trackGoogleEvent,
  type GoogleTagConfiguration,
} from "@deskfleet/client/google-tag"
import {
  captureMarketingSearchParams,
  readStoredTelemetryConsent,
  writeStoredTelemetryConsent,
} from "@deskfleet/client/marketing-attribution"
import type { PeerTelemetryEvents } from "@deskfleet/client/peer-telemetry"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { BillingAnalyticsEvents } from "./billing-events.ts"
import type { EntitlementAnalyticsEvents } from "./entitlement-events.ts"

/** The client shell that emitted the event. Electron is the desktop OS; a browser PWA is not. */
export type AnalyticsPlatform = "web" | "pwa" | "android" | "ios" | "windows" | "macos" | "linux" | "docs"

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

/** Resolve the viewer shell. A Capacitor webview is native even when its display mode is standalone. */
export function clientAnalyticsPlatform(hostPlatform: DeskfleetDesktopApi["platform"]): AnalyticsPlatform {
  if (hostPlatform === "darwin") return "macos"
  if (hostPlatform === "win32") return "windows"
  if (hostPlatform === "linux") return "linux"
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor
  if (capacitor?.isNativePlatform?.()) {
    const native = capacitor.getPlatform?.()
    if (native === "ios" || native === "android") return native
  }
  const standalone = typeof navigator !== "undefined" && (navigator as Navigator & { standalone?: boolean }).standalone === true
  const installed = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches
  return standalone || installed ? "pwa" : "web"
}

/** Explicit product events: never pass RPC payloads, user text, or resource paths. */
export interface AnalyticsEvents extends BillingAnalyticsEvents, EntitlementAnalyticsEvents, PeerTelemetryEvents {
  app_opened: { surface: "app" | "authentication" }
  page_viewed: { page: string }
  account_registered: { method: "password" }
  account_verified: Record<string, never>
  account_signed_in: { method: "password" | "passkey" }
  team_created: Record<string, never>
  machine_enrolled: { kind: "local" | "headless" }
  workspace_created: { directory_count: number }
  terminal_created: { scope: "machine" | "worktree" }
  schedule_action: { action: "create" | "run" | "delete" }
}

export interface AnalyticsConfiguration extends GoogleTagConfiguration {
  clientKey?: string
  environment: string
  platform: AnalyticsPlatform
  requireConsent?: boolean
}

const GOOGLE_FORWARDED_PRODUCT_EVENTS = new Set<keyof AnalyticsEvents>([
  "app_opened",
  "page_viewed",
  "account_registered",
  "account_verified",
  "account_signed_in",
  "team_created",
  "machine_enrolled",
  "billing_checkout",
])

// One instance per renderer document, shared across the isolated MachineSurface apps.
let sdk: StatsigClient | undefined
let savedConfig: AnalyticsConfiguration | undefined
let consentRequired = false
let platform: AnalyticsConfiguration["platform"] = "web"
let userId: string | undefined
let email: string | undefined
let team: Pick<Team, "id" | "role"> | undefined
let plan: BillingPlan | undefined
let planRevision = 0
let pendingAppOpened: AnalyticsEvents["app_opened"] | undefined
let pendingPageViewed: AnalyticsEvents["page_viewed"] | undefined
const revision = ref(0)
/** False until `/api/site` (or auth config) applies the master switch. */
let siteTelemetryResolved = false
const siteTelemetryEnabledRef = ref(false)
const userTelemetryConsentRef = ref(false)

export const siteTelemetryEnabled = readonly(siteTelemetryEnabledRef)
export const userTelemetryConsent = readonly(userTelemetryConsentRef)

function canRunTelemetry(): boolean {
  if (!consentRequired) return true
  return siteTelemetryEnabledRef.value && userTelemetryConsentRef.value
}

/**
 * Buffer startup lifecycle events only before the site gate resolves, or while
 * site telemetry is on and waiting for user consent. Once the master switch is
 * known off, do not re-buffer — a later re-enable must not flush events from the
 * disabled window.
 */
function canBufferLifecycleEvents(): boolean {
  if (!consentRequired) return false
  if (readStoredTelemetryConsent() === "declined") return false
  return !siteTelemetryResolved || siteTelemetryEnabledRef.value
}

function user(): StatsigUser {
  return {
    ...(userId ? { userID: userId } : {}),
    ...(email ? { email } : {}),
    ...(team ? { customIDs: { teamID: team.id } } : {}),
    custom: { platform },
  }
}

function startStatsigIfNeeded(): void {
  const key = savedConfig?.clientKey?.trim()
  if (sdk || !key || !savedConfig) return
  const instance = new StatsigClient(key, user(), {
    environment: { tier: savedConfig.environment },
    includeCurrentPageUrlWithEvents: false,
    networkConfig: {
      initializeUrl: STATSIG_INITIALIZE_URL,
      logEventUrl: STATSIG_LOG_EVENT_URL,
      initializeFallbackUrls: [],
      logEventFallbackUrls: [],
    },
  })
  sdk = instance
  instance.on("values_updated", () => { if (sdk === instance) revision.value++ })
  // The SDK handles ordinary network failures and cached/default evaluations.
  // A rejected initialization must also leave the application usable.
  void instance.initializeAsync({ timeoutMs: 1000 }).catch(() => {}).finally(() => {
    if (sdk === instance) revision.value++
  })
  revision.value++
}

function stopStatsigIfRunning(): void {
  const instance = sdk
  if (!instance) return
  sdk = undefined
  revision.value++
  void instance.shutdown().catch(() => {})
}

function syncAnalyticsRuntime(): void {
  if (!savedConfig) return
  const active = canRunTelemetry()
  if (active) {
    startStatsigIfNeeded()
    configureGoogleTag({ ...savedConfig, platform }, true)
    identifyGoogleTagUser(userId)
    if (pendingAppOpened) {
      const opened = pendingAppOpened
      pendingAppOpened = undefined
      trackEvent("app_opened", opened)
    }
    if (pendingPageViewed) {
      const viewed = pendingPageViewed
      pendingPageViewed = undefined
      trackEvent("page_viewed", viewed)
    }
  } else {
    stopStatsigIfRunning()
    configureGoogleTag({ ...savedConfig, platform }, false)
  }
}

/** Starts in the background; product startup never waits for analytics. */
export function initializeAnalytics(configuration: AnalyticsConfiguration): void {
  platform = configuration.platform
  if (configuration.requireConsent !== undefined) {
    consentRequired = configuration.requireConsent
  }
  if (consentRequired) {
    userTelemetryConsentRef.value = readStoredTelemetryConsent() === "granted"
  }
  captureMarketingSearchParams(undefined, canRunTelemetry())
  savedConfig = configuration
  syncAnalyticsRuntime()
}

/** Updates the backend master switch (`SiteSettings.telemetryEnabled`). */
export function setSiteTelemetryEnabled(enabled: boolean): void {
  consentRequired = true
  if (!enabled) {
    pendingAppOpened = undefined
    pendingPageViewed = undefined
  }
  const unchanged = siteTelemetryResolved && siteTelemetryEnabledRef.value === enabled
  siteTelemetryResolved = true
  if (unchanged) return
  siteTelemetryEnabledRef.value = enabled
  syncAnalyticsRuntime()
}

/** Updates the user's opt-in telemetry & marketing attribution consent. */
export function setUserTelemetryConsent(consented: boolean, options: { persist?: boolean } = {}): void {
  consentRequired = true
  if (!consented) {
    pendingAppOpened = undefined
    pendingPageViewed = undefined
  }
  userTelemetryConsentRef.value = consented
  if (options.persist !== false) {
    writeStoredTelemetryConsent(consented ? "granted" : "declined")
  }
  syncAnalyticsRuntime()
}

/** Keep the account UUID stable and use its email for feature targeting. */
export function identifyAnalytics(nextUserId?: string, nextTeam?: Pick<Team, "id" | "role">, nextEmail?: string): void {
  if (!nextUserId) { nextTeam = undefined; nextEmail = undefined }
  if (userId === nextUserId && email === nextEmail && team?.id === nextTeam?.id && team?.role === nextTeam?.role) return
  planRevision++
  if (userId !== nextUserId || team?.id !== nextTeam?.id) plan = undefined
  userId = nextUserId
  email = nextEmail
  team = nextTeam
  identifyGoogleTagUser(userId)
  const instance = sdk
  if (!instance) return
  // updateUserAsync changes the SDK user synchronously before fetching its values.
  void instance.updateUserAsync(user(), { timeoutMs: 1000 }).catch(() => {}).finally(() => {
    if (sdk === instance) revision.value++
  })
  revision.value++
}

export function analyticsEnabled(): boolean { return sdk !== undefined }
export function analyticsTeamId(): string | undefined { return team?.id }

/** Share response ordering between account refresh and the Plans view. */
export function beginAnalyticsPlanRefresh(teamId: string): (value: BillingPlan) => void {
  if (team?.id !== teamId) return () => {}
  const revision = ++planRevision
  return value => { if (team?.id === teamId && revision === planRevision) plan = value }
}

export function trackEvent<Name extends keyof AnalyticsEvents>(name: Name, metadata: AnalyticsEvents[Name]): void {
  if (!canRunTelemetry()) {
    if (canBufferLifecycleEvents()) {
      if (name === "app_opened") pendingAppOpened = metadata as AnalyticsEvents["app_opened"]
      else if (name === "page_viewed") pendingPageViewed = metadata as AnalyticsEvents["page_viewed"]
    }
    return
  }
  const context = team && name !== "team_joined" ? { team_id: team.id, team_role: team.role, current_plan: plan ?? "unknown" } : {}
  const merged = Object.fromEntries(Object.entries({ ...context, ...metadata })
    .filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))
  sdk?.logEvent(name, undefined, merged)
  if (canRunTelemetry() && GOOGLE_FORWARDED_PRODUCT_EVENTS.has(name)) {
    trackGoogleEvent(name, merged, {
      isAcquisitionConversion: name === "account_registered" || name === "machine_enrolled",
    })
  }
}

/** Marketing-only events (website page views, tab switches, social clicks) go only to Google Tag, never to Statsig. */
export function trackMarketingEvent(
  name: string,
  metadata: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!canRunTelemetry()) return
  trackGoogleEvent(name, metadata)
}

/** Acquisition conversion events (installer downloads, CLI install command copies) go to both Google Tag and Statsig. */
export function trackAcquisitionConversion(
  name: string,
  metadata: Record<string, string | number | boolean | undefined> = {},
): void {
  if (!canRunTelemetry()) return
  const clean = Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  )
  sdk?.logEvent(name, undefined, clean)
  trackGoogleEvent(name, metadata, { isAcquisitionConversion: true })
}

/** Async action results belong to the account and Team that started the action. */
export function captureAnalyticsContext(): typeof trackEvent {
  const instance = sdk, actor = userId, teamId = team?.id
  return (name, metadata) => {
    if (sdk === instance && userId === actor && team?.id === teamId) trackEvent(name, metadata)
  }
}

export const analyticsReady = computed(() => {
  void revision.value
  return sdk?.loadingStatus === "Ready"
})

/** Read only where the feature is used: evaluation records a Statsig exposure. */
export function useFeatureGate(name: string) {
  return computed(() => {
    void revision.value
    return analyticsReady.value ? sdk!.checkGate(name) : false
  })
}

export function useExperimentParameter<T extends string | number | boolean>(name: string, parameter: string, fallback: T) {
  return computed(() => {
    void revision.value
    return analyticsReady.value ? sdk!.getExperiment(name).get(parameter, fallback) : fallback
  })
}

/** Root-app teardown only; switching machines keeps the same analytics instance. */
export async function shutdownAnalytics(): Promise<void> {
  const instance = sdk
  sdk = undefined
  savedConfig = undefined
  consentRequired = false
  pendingAppOpened = undefined
  pendingPageViewed = undefined
  siteTelemetryResolved = false
  siteTelemetryEnabledRef.value = false
  userTelemetryConsentRef.value = false
  userId = undefined
  email = undefined
  team = undefined
  plan = undefined
  planRevision++
  revision.value++
  shutdownGoogleTag()
  await instance?.shutdown().catch(() => {})
}

if (import.meta.hot) import.meta.hot.dispose(() => { void shutdownAnalytics() })
