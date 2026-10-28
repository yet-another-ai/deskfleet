/**
 * Rolldown groups shared by the desktop renderer and the web client.
 * Heavy libraries stay in their own chunks so a route can cache them
 * separately from the screen that imports them.
 */
export const clientCodeSplitting = {
  groups: [
    {
      name: "echarts",
      test: /[\\/]node_modules[\\/](?:echarts|zrender)[\\/]/,
      priority: 30,
    },
    {
      name: "xterm",
      test: /[\\/]node_modules[\\/]@xterm[\\/]/,
      priority: 30,
    },
    {
      name: "mermaid",
      test: /[\\/]node_modules[\\/]mermaid[\\/]/,
      priority: 30,
    },
    {
      name: "markdown",
      test: /[\\/]node_modules[\\/](?:markdown-it|katex|shiki|@shikijs)[\\/]/,
      priority: 30,
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
