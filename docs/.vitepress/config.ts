import { resolve } from "node:path"
import { defineConfig } from "vitepress"
import UnoCSS from "unocss/vite"

const repository = "https://github.com/yet-another-ai/deskfleet"
const description = "All your agents, working together. Step into their computers, collaborate with your team, and keep using the agents you love. Fully open source."

export default defineConfig({
  title: "DeskFleet",
  titleTemplate: ":title · DeskFleet",
  description,
  srcDir: "content",
  cleanUrls: true,
  appearance: "dark",
  lastUpdated: true,
  vite: {
    plugins: [UnoCSS({
      configFile: resolve(import.meta.dirname, "../../packages/components/uno.config.ts"),
      content: { filesystem: [resolve(import.meta.dirname, "../../packages/components/src/**/*.vue")] },
    })],
    resolve: { dedupe: ["vue", "vue-i18n"] },
    ssr: { noExternal: ["@deskfleet/components", "@lucide/vue", "vue-i18n"] },
    define: { __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false },
  },
  head: [
    ["link", { rel: "icon", href: "/favicon.ico", sizes: "any" }],
    ["link", { rel: "icon", href: "/favicon-32x32.png", type: "image/png", sizes: "32x32" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" }],
    ["meta", { name: "theme-color", content: "#17191f" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "DeskFleet" }],
    ["meta", { property: "og:image", content: "/og.png" }],
    ["meta", { name: "twitter:card", content: "summary" }],
  ],
  transformPageData(page) {
    page.frontmatter.head ??= []
    page.frontmatter.head.push(
      ["meta", { property: "og:title", content: page.title || "DeskFleet" }],
      ["meta", { property: "og:description", content: page.description || description }],
    )
  },
  locales: {
    root: {
      label: "English", lang: "en-US",
      themeConfig: {
        nav: [{ text: "Explore", link: "/#explore" }, { text: "Guide", link: "/guide/" }, { text: "Privacy", link: "/privacy" }, { text: "Get DeskFleet", link: "/#get-deskfleet" }],
        sidebar: [{ text: "Get started", items: [{ text: "Welcome", link: "/guide/" }, { text: "Run DeskFleet", link: "/guide/getting-started" }, { text: "Agents & collaboration", link: "/guide/agents" }, { text: "Privacy", link: "/privacy" }] }],
        footer: { message: "Client and server, open source under Apache-2.0.", copyright: "DeskFleet contributors" },
        editLink: { pattern: `${repository}/edit/main/docs/content/:path`, text: "Improve this page" },
      },
    },
    zh: {
      label: "简体中文", lang: "zh-CN", link: "/zh/",
      description: "所有 Agent，如同在一起工作。随时远程介入，与同事共同操作，继续使用你喜欢的 Agent。前后端完全开源。",
      themeConfig: {
        nav: [{ text: "探索", link: "/zh/#explore" }, { text: "指南", link: "/zh/guide/" }, { text: "隐私", link: "/zh/privacy" }, { text: "开始使用", link: "/zh/#get-deskfleet" }],
        sidebar: [{ text: "开始使用", items: [{ text: "欢迎", link: "/zh/guide/" }, { text: "运行 DeskFleet", link: "/zh/guide/getting-started" }, { text: "Agent 与协作", link: "/zh/guide/agents" }, { text: "隐私", link: "/zh/privacy" }] }],
        footer: { message: "客户端与服务端均以 Apache-2.0 协议开源。", copyright: "DeskFleet 贡献者" },
        editLink: { pattern: `${repository}/edit/main/docs/content/:path`, text: "改进此页" },
        outline: { label: "页面导航" },
        docFooter: { prev: "上一页", next: "下一页" },
        returnToTopLabel: "回到顶部", sidebarMenuLabel: "菜单", darkModeSwitchLabel: "主题", langMenuLabel: "更改语言",
      },
    },
  },
  themeConfig: {
    logo: { src: "/logo.png", alt: "DeskFleet" },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repository }],
  },
})
