import { resolve } from "node:path"
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    // Vue Test Utils requires VDOM instances; production renderer builds use Vapor.
    vue(),
    VueI18nPlugin({ strictMessage: false, runtimeOnly: true }),
  ],
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "main",
          environment: "node",
          include: ["src/main/**/*.test.ts", "src/shared/**/*.test.ts", "../../packages/client/src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "happy-dom",
          hookTimeout: 120_000,
          setupFiles: [resolve(import.meta.dirname, "../../packages/components/src/test/setup.ts")],
          include: ["../../packages/components/src/**/*.test.ts"],
        },
      },
    ],
  },
})
