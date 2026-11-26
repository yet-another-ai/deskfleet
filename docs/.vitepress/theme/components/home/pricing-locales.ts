import type { AppLocale } from "@deskfleet/client/i18n"

const en = {
  title: "Hosted plans and pricing",
  lead: "One plan covers your whole team. Bring the coding agents you already use and run them on your own machines.",
  free: "No subscription required",
  months: "Per month",
  years: "Per year",
  sessions: "Sessions, including archived",
  relay: "Relay traffic per month",
  relayHelp: "Direct connections are included on every plan. Relay traffic is used when your devices can’t connect directly.",
  compare: "Open Plans & Usage",
  start: "Start free",
  loading: "Loading current plans…",
  unavailable: "Current plans could not be loaded.",
  noPlans: "This server does not offer hosted plans.",
  noSales: "Subscriptions are unavailable.",
  custom: "Custom pricing",
  retry: "Try again",
  selfHost: "Self-host DeskFleet",
}

const zh: typeof en = {
  title: "托管服务定价",
  lead: "一个方案覆盖整个团队。你可以继续使用熟悉的编程 Agent，在自己的机器上运行。",
  free: "无需订阅",
  months: "每月",
  years: "每年",
  sessions: "会话数（含已归档）",
  relay: "每月中继流量",
  relayHelp: "所有方案均支持直连。设备无法直接连接时，可以通过中继传输数据。",
  compare: "查看方案与用量",
  start: "免费开始使用",
  loading: "正在加载当前方案…",
  unavailable: "暂时无法加载当前方案。",
  noPlans: "此服务器不提供托管方案。",
  noSales: "暂时无法订阅。",
  custom: "联系询价",
  retry: "重试",
  selfHost: "自行部署 DeskFleet",
}

const ja: typeof en = {
  title: "ホスティングプランと料金",
  lead: "ひとつのプランをチーム全員で利用できます。使い慣れたコーディングエージェントを自分たちのマシンで実行できます。",
  free: "契約不要",
  months: "月額",
  years: "年額",
  sessions: "セッション数（アーカイブを含む）",
  relay: "月間リレー通信量",
  relayHelp: "すべてのプランで直接接続を利用できます。端末同士が直接接続できない場合に、リレー通信を使用します。",
  compare: "プランと使用量を見る",
  start: "無料で始める",
  loading: "現在のプランを読み込んでいます…",
  unavailable: "現在のプランを読み込めませんでした。",
  noPlans: "このサーバーはホスティングプランを提供していません。",
  noSales: "現在、プランのお申し込みはできません。",
  custom: "個別見積もり",
  retry: "再試行",
  selfHost: "DeskFleet をセルフホストする",
}

export const pricingCopy = { "en-US": en, "zh-cmn-Hans-CN": zh, "ja-JP": ja } satisfies Record<AppLocale, typeof en>
