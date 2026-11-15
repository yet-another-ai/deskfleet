import type { App } from "vue"
import type { Router } from "vue-router"
import { resolveSurfaceGoogleTagIds } from "@deskfleet/client/analytics-config"
import { getClient } from "@deskfleet/client/platform"
import { setPeerTelemetrySink, type PeerTelemetryEvent } from "@deskfleet/client/peer-telemetry"
import { analyticsTeamId, clientAnalyticsPlatform, initializeAnalytics, shutdownAnalytics, trackEvent } from "../services/analytics.ts"

export function installAnalytics(app: App, router?: Router): void {
  const host = getClient()
  const platform = clientAnalyticsPlatform(host.platform)
  const surface = platform === "macos" || platform === "windows" || platform === "linux"
    ? "desktop"
    : platform === "android" || platform === "ios"
      ? platform
      : "web"
  const googleIds = resolveSurfaceGoogleTagIds(surface, import.meta.env)
  initializeAnalytics({
    clientKey: import.meta.env.VITE_STATSIG_CLIENT_KEY,
    environment: import.meta.env.VITE_STATSIG_ENVIRONMENT?.trim() || import.meta.env.MODE,
    platform,
    gtmId: googleIds.gtmId,
    gaMeasurementId: googleIds.gaMeasurementId,
    googleAdsId: googleIds.googleAdsId,
    googleAdsInstallLabel: googleIds.googleAdsInstallLabel,
    requireConsent: true,
  })
  const peerEvent = (event: PeerTelemetryEvent) => {
    // Main-process transfers can finish after the user navigates to another Team.
    if (event.teamId === analyticsTeamId()) trackEvent(event.name, event.metadata)
  }
  const stopPeer = setPeerTelemetrySink(peerEvent)
  const stopCentral = host.platform !== "web" ? host.central?.onEvent(event => {
    if (event.type === "peerTelemetry") peerEvent(event.event)
  }) : undefined
  trackEvent("app_opened", { surface: router ? "app" : "authentication" })
  const stop = router?.afterEach((to, from, failure) => {
    if (!failure && (to.fullPath !== from.fullPath || to.name !== from.name) && typeof to.name === "string") {
      trackEvent("page_viewed", { page: to.name })
    }
  })
  if (!router) trackEvent("page_viewed", { page: "authentication" })
  app.onUnmount(() => {
    stop?.()
    stopPeer()
    stopCentral?.()
    void shutdownAnalytics()
  })
}
