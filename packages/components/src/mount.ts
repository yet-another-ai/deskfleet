import { createPinia, disposePinia } from "pinia"
import { createApp, vaporInteropPlugin } from "vue"
import { getClient } from "@deskfleet/client/platform"
import { i18n } from "./i18n/index.ts"
import { useAppearanceStore } from "./stores/appearance.ts"
import "./styles.css"

export async function mountDeskfleet(target: string | Element = "#root") {
  const state = createPinia()
  await useAppearanceStore(state).initialize()
  if (window.location.hash.startsWith("#/mermaid")) {
    const params = new URLSearchParams(window.location.hash.split("?")[1])
    const root = (await import("./components/session/MermaidViewer.vue")).default
    const app = createApp(root, {
      code: params.get("code") ?? "",
      mode: "window",
      source: {
        sessionId: params.get("sessionId") || undefined,
        entryId: params.get("entryId") || undefined,
        diagramId: params.get("diagramId") || undefined,
      },
    })
    app.onUnmount(() => disposePinia(state))
    app.use(vaporInteropPlugin).use(state).use((await import("./router/index.ts")).router).use(i18n).mount(target)
    return app
  }
  const host = getClient()
  // Account sign-in and the local workspace are separate graphs.
  const root = host.central
    ? (await import("./AccountShell.vue")).default
    : (await import("./App.vue")).default
  const app = host.central ? createApp(root, { host: { ...host } }) : createApp(root)
  app.use(vaporInteropPlugin)
  app.use(state)
  app.onUnmount(() => disposePinia(state))
  app.use((await import("./router/index.ts")).router)
  app.use(i18n)
  app.mount(target)
  return app
}
