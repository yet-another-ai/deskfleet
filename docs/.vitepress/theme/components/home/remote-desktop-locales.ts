import type { AppLocale } from "@deskfleet/client/i18n"

const enUS = {
  machine: "Windows test PC",
  kicker: "Remote desktop",
  title: "A remote desktop that feels local.",
  lead: "Step into any machine on your Team in one click. Every frame is captured and encoded on the GPU, then streamed peer to peer over WebRTC, so the screen keeps up with your hands.",
  viewerLabel: "Illustration of the DeskFleet desktop viewer streaming a remote machine, with its codec, encoder, frame rate, and connection shown in an overlay.",
  viewer: "Remote control",
  live: "Live",
  hud: { codec: "Codec", encoder: "Encoder", rate: "Frame rate", path: "Connection", pathValue: "Peer to peer" },
  stats: [
    { value: "60 fps", body: "Smooth by default, up to your display's refresh rate." },
    { value: "AV1", body: "The best codec both ends support: AV1, then HEVC, then H.264." },
    { value: "P2P", body: "Direct connections, with TURN relays around the world as a fallback." },
    { value: "Ctrl+Alt+Del", body: "Reaches Windows even at the lock screen." },
  ],
}

const zhCmnHansCN: typeof enUS = {
  machine: "Windows 测试机",
  kicker: "远程桌面",
  title: "远程桌面，如在眼前。",
  lead: "一键进入团队中的任意一台机器。每一帧都在 GPU 上采集和编码，再通过 WebRTC 点对点传输，画面始终跟得上你的操作。",
  viewerLabel: "DeskFleet 桌面查看器正在串流远程机器的示意图，叠加层显示编解码器、编码器、帧率和连接方式。",
  viewer: "远程控制",
  live: "实时",
  hud: { codec: "编解码器", encoder: "编码器", rate: "帧率", path: "连接", pathValue: "点对点" },
  stats: [
    { value: "60 fps", body: "默认流畅帧率，最高跟随显示器刷新率。" },
    { value: "AV1", body: "自动选择两端都支持的最佳编码：AV1、HEVC、H.264。" },
    { value: "P2P", body: "点对点直连，并以遍布全球的 TURN 节点作为后备。" },
    { value: "Ctrl+Alt+Del", body: "即使在 Windows 锁屏界面也能使用。" },
  ],
}

const jaJP: typeof enUS = {
  machine: "Windows テスト PC",
  kicker: "リモートデスクトップ",
  title: "手元のように動く、リモートデスクトップ。",
  lead: "チームのどのマシンにも、ワンクリックで入れます。すべてのフレームを GPU でキャプチャー・エンコードし、WebRTC でピアツーピア配信。画面があなたの操作に遅れません。",
  viewerLabel: "リモートマシンを配信する DeskFleet デスクトップビューアーのイメージ。コーデック、エンコーダー、フレームレート、接続方式をオーバーレイで表示しています。",
  viewer: "リモート操作",
  live: "ライブ",
  hud: { codec: "コーデック", encoder: "エンコーダー", rate: "フレームレート", path: "接続", pathValue: "ピアツーピア" },
  stats: [
    { value: "60 fps", body: "標準でなめらか。ディスプレイのリフレッシュレートまで。" },
    { value: "AV1", body: "両端が対応する最適なコーデックを自動選択：AV1、HEVC、H.264。" },
    { value: "P2P", body: "直接接続。つながらないときは世界各地の TURN ノードで中継。" },
    { value: "Ctrl+Alt+Del", body: "Windows のロック画面でも送信できます。" },
  ],
}

export const remoteDesktopCopy = {
  "en-US": enUS,
  "zh-cmn-Hans-CN": zhCmnHansCN,
  "ja-JP": jaJP,
} satisfies Record<AppLocale, typeof enUS>
