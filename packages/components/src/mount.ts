import { createPinia, disposePinia } from "pinia"
import { createApp, vaporInteropPlugin } from "vue"
import { getClient } from "@deskfleet/client/platform"
import { i18n } from "./i18n/index.ts"
import { useAppearanceStore } from "./stores/appearance.ts"
import { useOutlineAudioStore } from "./stores/outline-audio.ts"
import { nativeDragPolicy } from "./plugins/native-drag.ts"
import { visualViewportSizing } from "./plugins/visual-viewport.ts"
import { installAnalytics } from "./plugins/analytics.ts"
import { installErrorReporting, installErrorReportingAccount, shutdownErrorReporting } from "./services/error-reporting.ts"
import { previewResourceRequestFromQuery, resolvePreviewKind } from "./services/preview.ts"
import "./styles.css"

export async function mountDeskfleet(target: string | Element = "#root") {
  const state = createPinia()
  await useAppearanceStore(state).initialize()
  if (window.location.hash.startsWith("#/preview")) {
    const params = new URLSearchParams(window.location.hash.split("?")[1])
    const content = params.get("content") || undefined
    const text = params.get("text") || undefined
    const mimeType = params.get("mimeType") || undefined
    const root = (await import("./components/session/PreviewViewer.vue")).default
    const props = {
      kind: resolvePreviewKind(content ?? "", params.get("kind"), mimeType),
      content,
      text,
      title: params.get("title") || undefined,
      mimeType,
      mode: "window",
      resourceRequest: previewResourceRequestFromQuery(key => params.get(key)),
      source: {
        sessionId: params.get("sessionId") || undefined,
        entryId: params.get("entryId") || undefined,
        itemId: params.get("itemId") || undefined,
      },
    }
    const app = createApp(root, props)
    installErrorReporting(app)
    const central = getClient().central
    if (central) installErrorReportingAccount(app, central)
    app.onUnmount(() => { disposePinia(state); void shutdownErrorReporting() })
    app.use(nativeDragPolicy).use(visualViewportSizing)
    if (vaporInteropPlugin) app.use(vaporInteropPlugin)
    app.use(state).use((await import("./router/index.ts")).router).use(i18n).mount(target)
    return app
  }
  await useOutlineAudioStore(state).initialize()
  const host = getClient()
  // Account sign-in and the local workspace are separate graphs.
  const root = host.central
    ? (await import("./AccountShell.vue")).default
    : (await import("./App.vue")).default
  const app = host.central ? createApp(root, { host: { ...host } }) : createApp(root)
  const { router } = await import("./router/index.ts")
  installAnalytics(app, router)
  installErrorReporting(app)
  app.use(nativeDragPolicy).use(visualViewportSizing)
  if (vaporInteropPlugin) app.use(vaporInteropPlugin)
  app.use(state)
  app.onUnmount(() => { disposePinia(state); void shutdownErrorReporting() })
  app.use(router)
  app.use(i18n)
  app.mount(target)
  return app
}
