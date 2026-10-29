import { resolve } from "node:path"
import type { StorybookConfig } from "@storybook/vue3-vite"
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite"
import vue from "@vitejs/plugin-vue"
import UnoCSS from "unocss/vite"

const config: StorybookConfig = {
  stories: ["../src/components/**/*.stories.ts"],
  addons: ["@storybook/addon-docs"],
  core: {
    disableTelemetry: true,
  },
  framework: {
    name: "@storybook/vue3-vite",
    options: {
      docgen: "vue-component-meta",
    },
  },
  viteFinal(config) {
    config.plugins ??= []
    config.plugins.push(
      UnoCSS({ configFile: resolve(import.meta.dirname, "../uno.config.ts") }),
      vue({ features: { vapor: true } }),
      VueI18nPlugin({ strictMessage: false, runtimeOnly: true }),
    )
    config.resolve ??= {}
    config.resolve.alias = {
      ...config.resolve.alias,
      "@agentclientprotocol/sdk/unstable": resolve(
        import.meta.dirname,
        "../node_modules/@agentclientprotocol/sdk/dist/v1/unstable/acp.js",
      ),
      "@agentclientprotocol/sdk": resolve(
        import.meta.dirname,
        "../node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js",
      ),
    }
    return config
  },
}

export default config
