/**
 * Rolldown groups shared by the desktop renderer and the web client.
 * Heavy groups split at module boundaries using pre-minification byte sizes.
 * This is a target, not a hard output limit: Mermaid's ELK engine and parser,
 * and Shiki's C++ grammar, each exceed Vite's warning limit as a single module.
 * Pair with strictExecutionOrder so dependent Shiki grammars initialize in order.
 */
export const clientCodeSplitting = {
  groups: [
    {
      name: "echarts",
      test: /[\\/]node_modules[\\/](?:echarts|zrender)[\\/]/,
      priority: 30,
      maxSize: 500_000,
    },
    {
      name: "xterm",
      test: /[\\/]node_modules[\\/]@xterm[\\/]/,
      priority: 30,
      maxSize: 500_000,
    },
    {
      name: "mermaid",
      test: /[\\/]node_modules[\\/]mermaid[\\/]/,
      priority: 30,
      maxSize: 500_000,
      // Preserve Mermaid's dynamic diagram and layout imports.
      entriesAware: true,
    },
    {
      name: "markdown",
      test: /[\\/]node_modules[\\/](?:markdown-it|katex|shiki|@shikijs)[\\/]/,
      priority: 30,
      maxSize: 500_000,
      // Mermaid's math renderer must not pull in the Markdown highlighter.
      entriesAware: true,
    },
    {
      // Keep Vue out of this chunk. vue-i18n depends on it.
      name: "vue-i18n",
      test: /[\\/]node_modules[\\/](?:vue-i18n|@intlify)[\\/]/,
      priority: 25,
      includeDependenciesRecursively: false,
    },
    {
      name: "vue",
      test: /[\\/]node_modules[\\/](?:vue|@vue|pinia|vue-router|@vueuse)[\\/]/,
      priority: 20,
      includeDependenciesRecursively: false,
    },
  ],
}
