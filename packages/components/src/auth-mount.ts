import { createApp, vaporInteropPlugin } from "vue"
import { createPinia, disposePinia } from "pinia"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import { i18n } from "./i18n/index.ts"
import { useAppearanceStore } from "./stores/appearance.ts"
import AuthPage from "./components/auth/AuthPage.vue"
import "./styles.css"

export async function mountAuthentication(api: HttpCentralClient) {
  const state = createPinia()
  await useAppearanceStore(state).initialize()
  const app = createApp(AuthPage, { api })
  app.use(vaporInteropPlugin).use(state).use(i18n)
  app.onUnmount(() => disposePinia(state))
  app.mount("#root")
  return app
}
