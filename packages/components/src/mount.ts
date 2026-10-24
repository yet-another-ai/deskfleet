import { createPinia } from "pinia"
import { createApp, vaporInteropPlugin } from "vue"
import { client as platformClient } from "@deskfleet/client/platform"
import App from "./App.vue"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import "./styles.css"

export function mountDeskfleet(target: string | Element = "#root") {
  document.documentElement.lang = platformClient.locale
  const app = createApp(App)
  app.use(vaporInteropPlugin)
  app.use(createPinia())
  app.use(router)
  app.use(i18n)
  app.mount(target)
  return app
}
