import type { AppLocale } from "@deskfleet/client/i18n"

const enUS = {
  title: "Around the world. Within reach.",
  lead: "Global acceleration nodes provided by yetanother.ai and Cloudflare.",
  ownedTitle: "Acceleration node provided by yetanother.ai",
  anycastTitle: "Acceleration node provided by Cloudflare",
  cities: { tokyo: "Tokyo", frankfurt: "Frankfurt", shanghai: "Shanghai", hongkong: "Hong Kong" },
  globeLabel: "A rotating globe of global acceleration nodes.",
  loading: "Loading globe…",
  unavailable: "Globe unavailable.",
}

const zhCmnHansCN: typeof enUS = {
  title: "相隔万里，也能一起工作。",
  lead: "覆盖全球的 TURN 节点加速你的网络访问",
  ownedTitle: "由 yetanother.ai 提供的加速节点",
  anycastTitle: "由 Cloudflare 提供的加速节点",
  cities: { tokyo: "东京", frankfurt: "法兰克福", shanghai: "上海", hongkong: "香港" },
  globeLabel: "展示全球加速节点的旋转地球。",
  loading: "正在加载地球…",
  unavailable: "暂时无法显示地球。",
}

const jaJP: typeof enUS = {
  title: "世界のどこでも、すぐそばに。",
  lead: "yetanother.ai と Cloudflare が提供するグローバル高速接続ノード。",
  ownedTitle: "yetanother.ai が提供する高速接続ノード",
  anycastTitle: "Cloudflare が提供する高速接続ノード",
  cities: { tokyo: "東京", frankfurt: "フランクフルト", shanghai: "上海", hongkong: "香港" },
  globeLabel: "世界の高速接続ノードを表示する回転する地球。",
  loading: "地球を読み込み中…",
  unavailable: "地球を表示できません。",
}

export const networkCopy = {
  "en-US": enUS,
  "zh-cmn-Hans-CN": zhCmnHansCN,
  "ja-JP": jaJP,
} satisfies Record<AppLocale, typeof enUS>
