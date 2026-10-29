import "./storybook-init.ts"
import { setup, type Preview } from "@storybook/vue3-vite"
import { vaporInteropPlugin } from "vue"
import { i18n } from "../src/i18n/index.ts"
import { nativeDragPolicy } from "../src/plugins/native-drag.ts"
import { loadProviderIcons } from "../src/services/provider-icons.ts"
import { createSeededStorybookState, createStorybookRouter } from "./storybook-fixtures.ts"
import "virtual:uno.css"
import "../src/styles.css"

const sharedState = createSeededStorybookState()
const router = createStorybookRouter()
void loadProviderIcons()

setup((app) => {
  app.use(nativeDragPolicy)
  app.use(vaporInteropPlugin)
  app.use(sharedState.pinia)
  app.use(router)
  app.use(i18n)
  for (const symbol of Object.getOwnPropertySymbols(sharedState.provideMap)) {
    app.provide(symbol, (sharedState.provideMap as Record<symbol, unknown>)[symbol])
  }
})

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Color scheme for components",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
          { value: "system", title: "System" },
        ],
        dynamicTitle: true,
      },
    },
    locale: {
      description: "Internationalization locale",
      toolbar: {
        title: "Locale",
        icon: "globe",
        items: [
          { value: "en-US", title: "English (US)" },
          { value: "zh-cmn-Hans-CN", title: "简体中文" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: "light",
    locale: "en-US",
  },
  parameters: {
    controls: {
      expanded: true,
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: "padded",
  },
  decorators: [
    (story, context) => {
      const theme = (context.globals.theme as "light" | "dark" | "system") || "light"
      const locale = (context.globals.locale as "en-US" | "zh-cmn-Hans-CN") || "en-US"
      document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme
      document.documentElement.dataset.theme = theme
      sharedState.appearance.settings.theme = theme
      sharedState.appearance.settings.language = locale
      i18n.global.locale.value = locale

      return {
        components: { story },
        template: `<div class="bg-ui-canvas text-ui-text p-4 rounded-xl min-h-[120px]"><story /></div>`,
      }
    },
  ],
}

export default preview
