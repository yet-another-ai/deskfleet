import { resolve } from "node:path"
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite"
import vue from "@vitejs/plugin-vue"
import UnoCSS from "unocss/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    UnoCSS({ configFile: resolve(import.meta.dirname, "../../packages/components/uno.config.ts") }),
    vue({ features: { vapor: true } }),
    VueI18nPlugin({ strictMessage: false, runtimeOnly: true }),
  ],
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
  build: { target: "es2023" },
})
