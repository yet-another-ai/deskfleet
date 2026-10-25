import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme-without-fonts"
import { createI18n } from "vue-i18n"
import en from "../../../packages/components/locales/en-US.json"
import zh from "../../../packages/components/locales/zh-cmn-Hans-CN.json"
import HomePage from "./components/home/HomePage.vue"
import SiteLayout from "./components/SiteLayout.vue"
import "@fontsource-variable/inter/wght.css"
import "@fontsource-variable/cascadia-mono/wght.css"
import "@fontsource/barlow-condensed/latin-600.css"
import "@fontsource/barlow-condensed/latin-700.css"
import "@fontsource-variable/noto-sans-sc/wght.css"
import "uno.css"
import "../../../packages/components/src/styles.css"
import "./custom.css"
import "./product-demo.css"

export default {
  extends: DefaultTheme,
  Layout: SiteLayout,
  enhanceApp({ app }) {
    app.use(createI18n({ legacy: false, locale: "en-US", fallbackLocale: "en-US", messages: { "en-US": en, "zh-cmn-Hans-CN": zh } }))
    app.component("HomePage", HomePage)
  },
} satisfies Theme
