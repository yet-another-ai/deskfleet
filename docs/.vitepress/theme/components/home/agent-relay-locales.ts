import type { AppLocale } from "@deskfleet/client/i18n"

const enUS = {
  kicker: "Cross-machine MCP · Computer use",
  title: "One agent. Every machine on your team.",
  lead: "An agent on your laptop can reach the rest of your Team. It calls MCP tools hosted on other machines, moves files with the task, and operates their desktops through built-in computer use.",
  sceneLabel: "Animation: Claude Code on a MacBook Pro uploads an installer to a Windows test PC, opens it with computer use, and returns a screenshot.",
  local: { name: "MacBook Pro", agent: "Claude Code" },
  remote: { name: "Windows test PC", agent: "Computer use" },
  server: "Team server",
  author: "Maya",
  prompt: "Install today's build on the Windows test PC and check that setup opens.",
  steps: {
    machines: { action: "Find machines", result: "Windows test PC · operate allowed" },
    upload: { action: "Upload file", result: "DeskFleet-Setup.exe → Downloads" },
    open: { action: "Open the installer", result: "Double-click DeskFleet-Setup.exe" },
    capture: { action: "Check the screen", result: "Screenshot returned" },
  },
  reply: "Setup opens on Windows and shows its welcome screen. Screenshot attached.",
  installer: { title: "DeskFleet Setup", heading: "Welcome to DeskFleet", body: "Setup will install DeskFleet on this computer.", next: "Next" },
  file: "DeskFleet-Setup.exe",
  captured: "Captured",
  features: [
    { title: "Any MCP tool, any machine", body: "List the MCP servers configured on another Team machine and call their tools from wherever your agent runs." },
    { title: "Computer use, built in", body: "{auv} ships with DeskFleet. Agents take screenshots and use the mouse and keyboard, locally or on another machine." },
    { title: "Files travel with the task", body: "Upload a build, download the results. Whole directories move in one call." },
    { title: "You decide who reaches in", body: "Read and operate access are separate switches on each machine. Both start off." },
  ],
}

const zhCmnHansCN: typeof enUS = {
  kicker: "跨机器 MCP · Computer Use",
  title: "一个 Agent，调用团队的每台机器。",
  lead: "笔记本上的 Agent 可以直接使用团队里的其他机器：调用它们上面的 MCP 工具，随任务传输文件，并通过内置的 Computer Use 操作它们的桌面。",
  sceneLabel: "动画：MacBook Pro 上的 Claude Code 把安装包上传到 Windows 测试机，用 Computer Use 打开它，并返回截图。",
  local: { name: "MacBook Pro", agent: "Claude Code" },
  remote: { name: "Windows 测试机", agent: "Computer Use" },
  server: "团队服务器",
  author: "Maya",
  prompt: "把今天的构建装到 Windows 测试机上，确认安装程序能正常打开。",
  steps: {
    machines: { action: "查找机器", result: "Windows 测试机 · 已允许操作" },
    upload: { action: "上传文件", result: "DeskFleet-Setup.exe → 下载" },
    open: { action: "打开安装程序", result: "双击 DeskFleet-Setup.exe" },
    capture: { action: "检查屏幕", result: "已返回截图" },
  },
  reply: "安装程序在 Windows 上正常打开，显示了欢迎页面。截图已附上。",
  installer: { title: "DeskFleet 安装程序", heading: "欢迎使用 DeskFleet", body: "安装程序将在这台电脑上安装 DeskFleet。", next: "下一步" },
  file: "DeskFleet-Setup.exe",
  captured: "已截图",
  features: [
    { title: "任意机器上的 MCP 工具", body: "查看团队中其他机器配置的 MCP 服务器，在 Agent 所在的位置直接调用它们的工具。" },
    { title: "内置 Computer Use", body: "DeskFleet 自带 {auv}。Agent 可以截图、操作鼠标和键盘，无论在本机还是其他机器上。" },
    { title: "文件随任务流转", body: "上传构建，下载结果。整个目录一次调用即可传输。" },
    { title: "由你决定谁能访问", body: "每台机器的读取和操作权限分别开关，默认都处于关闭状态。" },
  ],
}

const jaJP: typeof enUS = {
  kicker: "マシン間 MCP · コンピューター操作",
  title: "ひとつのエージェントで、チームのすべてのマシンを。",
  lead: "ノート PC のエージェントから、チームの他のマシンへ。そのマシンの MCP ツールを呼び出し、作業に必要なファイルを転送し、内蔵のコンピューター操作でデスクトップを操作できます。",
  sceneLabel: "アニメーション：MacBook Pro の Claude Code が Windows テスト PC にインストーラーをアップロードし、コンピューター操作で開いてスクリーンショットを返します。",
  local: { name: "MacBook Pro", agent: "Claude Code" },
  remote: { name: "Windows テスト PC", agent: "コンピューター操作" },
  server: "チームサーバー",
  author: "Maya",
  prompt: "今日のビルドを Windows テスト PC にインストールして、セットアップが開くか確認して。",
  steps: {
    machines: { action: "マシンを検索", result: "Windows テスト PC · 操作を許可" },
    upload: { action: "ファイルをアップロード", result: "DeskFleet-Setup.exe → ダウンロード" },
    open: { action: "インストーラーを開く", result: "DeskFleet-Setup.exe をダブルクリック" },
    capture: { action: "画面を確認", result: "スクリーンショットを取得" },
  },
  reply: "Windows でセットアップが開き、ようこそ画面が表示されました。スクリーンショットを添付します。",
  installer: { title: "DeskFleet セットアップ", heading: "DeskFleet へようこそ", body: "このコンピューターに DeskFleet をインストールします。", next: "次へ" },
  file: "DeskFleet-Setup.exe",
  captured: "取得しました",
  features: [
    { title: "どのマシンの MCP ツールも", body: "チームの他のマシンに設定された MCP サーバーを一覧し、エージェントのいる場所からそのツールを呼び出せます。" },
    { title: "コンピューター操作を内蔵", body: "DeskFleet には {auv} が付属。エージェントがスクリーンショットを撮り、マウスとキーボードを操作します。ローカルでも、他のマシンでも。" },
    { title: "ファイルも作業と一緒に", body: "ビルドをアップロードし、結果をダウンロード。ディレクトリごと一度に転送できます。" },
    { title: "アクセスを決めるのはあなた", body: "読み取りと操作の権限は、マシンごとに個別に切り替え。どちらも最初はオフです。" },
  ],
}

export const agentRelayCopy = {
  "en-US": enUS,
  "zh-cmn-Hans-CN": zhCmnHansCN,
  "ja-JP": jaJP,
} satisfies Record<AppLocale, typeof enUS>
