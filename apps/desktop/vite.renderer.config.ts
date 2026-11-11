import { resolve } from "node:path"
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite"
import vue from "@vitejs/plugin-vue"
import UnoCSS from "unocss/vite"
import { defineConfig } from "vite"
import { clientCodeSplitting, tresTemplateCompilerOptions } from "../../packages/components/src/chunking.ts"
import { injectRendererContentSecurityPolicy } from "./src/shared/renderer-csp.ts"

export default defineConfig(({ command }) => {
  let statsigEnabled = false
  let sentryDsn: string | undefined
  return {
    base: "./",
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [
      {
        name: "deskfleet-renderer-content-security-policy",
        configResolved(config) {
          // Use the same mode, envDir, and process overrides as import.meta.env.
          statsigEnabled = Boolean(config.env.VITE_STATSIG_CLIENT_KEY?.trim())
          sentryDsn = config.env.VITE_SENTRY_DSN
        },
        transformIndexHtml: {
          order: "pre",
          handler: (html, ctx) =>
            ctx.path === "/html-preview.html"
              ? html
              : injectRendererContentSecurityPolicy(html, command === "build", statsigEnabled, sentryDsn),
        },
      },
      UnoCSS({ configFile: resolve(import.meta.dirname, "../../packages/components/uno.config.ts") }),
      vue({ features: { vapor: true }, ...tresTemplateCompilerOptions }),
      VueI18nPlugin({
        // Locale JSON stays plain so the main process can import the same catalogs.
        strictMessage: false,
        runtimeOnly: true,
      }),
    ],
    build: {
      sourcemap: process.env.DESKFLEET_SOURCEMAPS === "1" ? "hidden" : false,
      emptyOutDir: true,
      outDir: resolve(import.meta.dirname, "out/renderer"),
      rolldownOptions: { output: { codeSplitting: clientCodeSplitting, strictExecutionOrder: true } },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
  }
})
