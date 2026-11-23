import { App as CapApp } from "@capacitor/app"
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core"
import {
  DeskFleetBridge,
  createCapacitorFilesApi,
  createCapacitorNativeDesktopApi,
  createCapacitorNetworkDiagnosticsApi,
  createCapacitorOutlineAudioApi,
  createCapacitorPortsApi,
  createCapacitorPushNotifications,
  createCapacitorSpeechApi,
  createCapacitorTelemetrySink,
} from "@deskfleet/capacitor-bridge"
import { createAndroidUpdates } from "@deskfleet/capacitor-bridge/app-updates"
import { setNativeTelemetrySink } from "@deskfleet/client/google-tag"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { browserClient } from "@deskfleet/client/browser"
import { configureClient } from "@deskfleet/client/platform"
import { useFeatureGate } from "@deskfleet/components/services/analytics.ts"
import { captureCentralRequestError, initializeErrorReporting } from "@deskfleet/components/services/error-reporting.ts"
import { installVitePreloadRecovery } from "@deskfleet/components/services/module-recovery.ts"
import { watch } from "vue"
import { capacitorClientOptions } from "./capacitor-auth.ts"
import { listenForNativeResume } from "./native-resume.ts"
import "virtual:uno.css"

initializeErrorReporting("web")
installVitePreloadRecovery()
const configuredServerUrl = import.meta.env.VITE_DESKFLEET_SERVER_URL ?? (import.meta.env.DEV ? "http://localhost:8080" : location.origin)
const adapter = await browserClient(configuredServerUrl, captureCentralRequestError, {
  ...capacitorClientOptions(configuredServerUrl),
  ...(Capacitor.isNativePlatform() ? { createFiles: createCapacitorFilesApi } : {}),
})
if (Capacitor.isNativePlatform()) {
  void listenForNativeResume((event, listener) => CapApp.addListener(event, listener))
  setNativeTelemetrySink(createCapacitorTelemetrySink())
  adapter.speech = createCapacitorSpeechApi()
  adapter.haptic = kind => { void DeskFleetBridge.haptic({ kind }) }
  adapter.openExternal = url => DeskFleetBridge.openExternal({ url })
}
if (Capacitor.getPlatform() === "ios") {
  adapter.outlineAudio = createCapacitorOutlineAudioApi()
}
if (Capacitor.isNativePlatform() && adapter.central) {
  adapter.ports = createCapacitorPortsApi(adapter.central)
  adapter.nativeDesktop = createCapacitorNativeDesktopApi(adapter.central)
  adapter.networkDiagnostics = createCapacitorNetworkDiagnosticsApi(
    adapter.central as HttpCentralClient,
    undefined,
    async () => {
      const { i18n } = await import("@deskfleet/components/i18n/index.ts")
      return i18n.global.t("developerSettings.noStunServer")
    },
  )
  const platform = Capacitor.getPlatform()
  if (platform === "ios" || platform === "android") {
    const pushNotificationsEnabled = useFeatureGate("mobile_push_notifications")
    const pushNotifications = createCapacitorPushNotifications({
      platform,
      central: adapter.central,
      settings: adapter.settings,
      locale: () => adapter.locale,
      enabled: () => pushNotificationsEnabled.value,
    })
    adapter.settings = { ...adapter.settings, ...pushNotifications.settings }
    adapter.onOpenNotificationSession = pushNotifications.onOpenSession
    watch(pushNotificationsEnabled, enabled => {
      if (enabled) void pushNotifications.sync().catch(() => {})
    })
    void CapApp.addListener("resume", () => { void pushNotifications.sync().catch(() => {}) })
  }
}
if (Capacitor.getPlatform() === "android") {
  adapter.outlineAudio = createCapacitorOutlineAudioApi()
  const androidUpdates = await createAndroidUpdates({ getAppInfo: () => CapApp.getInfo() })
  adapter.updates = androidUpdates.updates
  adapter.settings = {
    ...adapter.settings,
    getAutoDownloadUpdates: androidUpdates.getAutoDownload,
    setAutoDownloadUpdates: androidUpdates.setAutoDownload,
    setPauseUpdatesOnMetered: androidUpdates.setPauseOnMetered,
  }
  // Background checks are silent: transient network or Play failures keep the current state.
  const check = (): void => { void androidUpdates.updates.check().catch(() => {}) }
  check()
  void CapApp.addListener("resume", check)
}
configureClient(adapter)
if (location.pathname.startsWith("/auth/")) {
  const { mountAuthentication } = await import("@deskfleet/components/auth-mount.ts")
  await mountAuthentication(adapter.central as HttpCentralClient)
} else {
  const { mountDeskfleet } = await import("@deskfleet/components")
  await mountDeskfleet()
}

if (Capacitor.isNativePlatform()) {
  const [{ useAppearanceStore }, { router }] = await Promise.all([
    import("@deskfleet/components/stores/appearance.ts"),
    import("@deskfleet/components/router/index.ts"),
  ])
  const appearance = useAppearanceStore()
  watch(() => appearance.isDark, isDark => {
    void SystemBars.setStyle({
      style: isDark ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
    })
  }, { immediate: true })
  void CapApp.addListener("backButton", ({ canGoBack }) => {
    const overlay = document.querySelector('[data-dismissable-layer]:not([data-state="closed"]):not(:has([role="tooltip"])), [data-view-overview]')
    if (overlay) {
      const target = document.querySelector("[data-mobile-windows]") ?? document.activeElement ?? document
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }))
      return
    }
    if (window.history.state?.back != null) {
      router.back()
      return
    }
    if (!location.pathname.startsWith("/auth/") && router.currentRoute.value.path !== "/") {
      void router.replace("/")
      return
    }
    if (location.pathname.startsWith("/auth/") && canGoBack) {
      window.history.back()
      return
    }
    void CapApp.minimizeApp()
  })
}
