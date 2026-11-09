import { App as CapApp } from "@capacitor/app"
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core"
import { createCapacitorNativeDesktopApi } from "@deskfleet/capacitor-native-desktop"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { browserClient } from "@deskfleet/client/browser"
import { configureClient } from "@deskfleet/client/platform"
import { captureCentralRequestError, initializeErrorReporting } from "@deskfleet/components/services/error-reporting.ts"
import { watch } from "vue"
import "virtual:uno.css"

initializeErrorReporting("web")
const adapter = await browserClient(import.meta.env.VITE_DESKFLEET_SERVER_URL ?? (import.meta.env.DEV ? "http://localhost:8080" : location.origin), captureCentralRequestError)
if ((Capacitor.getPlatform() === "android" || Capacitor.getPlatform() === "ios") && adapter.central) {
  adapter.nativeDesktop = createCapacitorNativeDesktopApi(adapter.central)
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

