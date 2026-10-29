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
    // The demo host and shared components must use the same router injection keys,
    // even when pnpm installs separate peer dependency variants of vue-router.
    resolve: { dedupe: ["vue", "vue-i18n", "vue-router"] },
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
    ja: {
      label: "日本語", lang: "ja-JP", link: "/ja/",
      description: "エージェントのコンピューターに入り、チームと共同作業。使い慣れたエージェントをそのまま使えます。クライアントもサーバーも、すべてオープンソース。",
      themeConfig: {
        nav: [{ text: "体験する", link: "/ja/#explore" }, { text: "ガイド", link: "/ja/guide/" }, { text: "プライバシー", link: "/ja/privacy" }, { text: "DeskFleet を使う", link: "/ja/#get-deskfleet" }],
        sidebar: [{ text: "はじめに", items: [{ text: "ようこそ", link: "/ja/guide/" }, { text: "DeskFleet を実行する", link: "/ja/guide/getting-started" }, { text: "エージェントと共同作業", link: "/ja/guide/agents" }, { text: "プライバシー", link: "/ja/privacy" }] }],
        footer: { message: "クライアントとサーバーは Apache-2.0 ライセンスで公開しています。", copyright: "DeskFleet コントリビューター" },
        editLink: { pattern: `${repository}/edit/main/docs/content/:path`, text: "このページを改善する" },
        outline: { label: "このページの内容" },
        docFooter: { prev: "前のページ", next: "次のページ" },
        lastUpdated: { text: "最終更新", formatOptions: { forceLocale: true } },
        returnToTopLabel: "ページの先頭に戻る", sidebarMenuLabel: "メニュー", darkModeSwitchLabel: "外観", langMenuLabel: "言語を変更",
        lightModeSwitchTitle: "ライトテーマに切り替え", darkModeSwitchTitle: "ダークテーマに切り替え",
        navMenuLabel: "メインナビゲーション", mobileMenuLabel: "メニュー", extraMenuLabel: "その他のオプション", skipToContentLabel: "本文へ移動",
        notFound: { title: "ページが見つかりません", quote: "リンク先を確認するか、ホームページに戻ってください。", link: "/ja/", linkLabel: "ホームページに戻る", linkText: "ホームページに戻る" },
      },
    },
  },
  themeConfig: {
    logo: { src: "/logo.png", alt: "DeskFleet" },
    search: {
      provider: "local",
      options: {
        locales: {
          ja: {
            translations: {
              button: { buttonText: "検索", buttonAriaLabel: "ドキュメントを検索" },
              modal: {
                displayDetails: "詳細を表示", resetButtonTitle: "検索をクリア", backButtonTitle: "検索を閉じる", noResultsText: "一致する結果はありません：",
                footer: {
                  selectText: "選択", selectKeyAriaLabel: "Enter キー",
                  navigateText: "移動", navigateUpKeyAriaLabel: "上矢印キー", navigateDownKeyAriaLabel: "下矢印キー",
                  closeText: "閉じる", closeKeyAriaLabel: "Escape キー",
                },
              },
            },
          },
        },
      },
    },
    socialLinks: [{ icon: "github", link: repository }],
  },
})
