import { createPinia, disposePinia } from "pinia"
import { createApp, vaporInteropPlugin } from "vue"
import { getClient } from "@deskfleet/client/platform"
import { i18n } from "./i18n/index.ts"
import { useAppearanceStore } from "./stores/appearance.ts"
import { nativeDragPolicy } from "./plugins/native-drag.ts"
import { installAnalytics } from "./plugins/analytics.ts"
import { installErrorReporting, shutdownErrorReporting } from "./services/error-reporting.ts"
import { resolvePreviewKind } from "./services/preview.ts"
import "./styles.css"

export async function mountDeskfleet(target: string | Element = "#root") {
  const state = createPinia()
  await useAppearanceStore(state).initialize()
  const previewWindow = window.location.hash.startsWith("#/preview")
  const mermaidWindow = window.location.hash.startsWith("#/mermaid")
  if (previewWindow || mermaidWindow) {
    const params = new URLSearchParams(window.location.hash.split("?")[1])
    const content = params.get(previewWindow ? "content" : "code") ?? ""
    const mimeType = params.get("mimeType") || undefined
    const root = previewWindow
      ? (await import("./components/session/PreviewViewer.vue")).default
      : (await import("./components/session/MermaidViewer.vue")).default
    const props = previewWindow
      ? { kind: resolvePreviewKind(content, params.get("kind"), mimeType), content, title: params.get("title") || undefined, mimeType, mode: "window", source: { sessionId: params.get("sessionId") || undefined, entryId: params.get("entryId") || undefined, itemId: params.get("itemId") || undefined } }
      : { code: content, mode: "window", source: { sessionId: params.get("sessionId") || undefined, entryId: params.get("entryId") || undefined, diagramId: params.get("diagramId") || undefined } }
    const app = createApp(root, props)
    installErrorReporting(app)
    app.onUnmount(() => { disposePinia(state); void shutdownErrorReporting() })
    app.use(nativeDragPolicy).use(vaporInteropPlugin).use(state).use((await import("./router/index.ts")).router).use(i18n).mount(target)
    return app
  }
  const host = getClient()
  // Account sign-in and the local workspace are separate graphs.
  const root = host.central
    ? (await import("./AccountShell.vue")).default
    : (await import("./App.vue")).default
  const app = host.central ? createApp(root, { host: { ...host } }) : createApp(root)
  const { router } = await import("./router/index.ts")
  installAnalytics(app, router)
  installErrorReporting(app)
  app.use(nativeDragPolicy)
  app.use(vaporInteropPlugin)
  app.use(state)
  app.onUnmount(() => { disposePinia(state); void shutdownErrorReporting() })
  app.use(router)
  app.use(i18n)
  app.mount(target)
  return app
}
