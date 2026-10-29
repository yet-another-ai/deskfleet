import { computed, createApp, ref } from "vue"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { createPinia, disposePinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { createI18n } from "vue-i18n"
import { useAgentSessionsStore } from "@deskfleet/components/stores/agent-sessions.ts"
import { useFleetStore, type TerminalLocation } from "@deskfleet/components/stores/fleet.ts"
import { useLayoutStore } from "@deskfleet/components/stores/layout.ts"
import { useProvidersStore } from "@deskfleet/components/stores/providers.ts"
import { useTerminalsStore } from "@deskfleet/components/stores/terminals.ts"
import type { AgentEvent, AgentInput, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import en from "../../../../../packages/components/locales/en-US.json"
import ja from "../../../../../packages/components/locales/ja-JP.json"
import zh from "../../../../../packages/components/locales/zh-cmn-Hans-CN.json"
import { configureProductDemoHost } from "./product-demo-host.ts"
import { configuration, demoPatch, demoProviders, fixtures, input } from "./product-demo-fixtures.ts"

export interface ProductDemoOptions {
  kind: "agents" | "team" | "remote" | "session"
  locale?: AppLocale
  initialRoute?: string
  sidebar?: boolean
  details?: boolean
}

/** Mount the production application with browser-local state and no daemon connection. */
export async function mountProductDemo(target: HTMLElement, options: ProductDemoOptions) {
  const locale = options.locale ?? "en-US"
  const say = (en: string, zh: string, ja: string) => locale === "ja-JP" ? ja : locale === "zh-cmn-Hans-CN" ? zh : en
  configureProductDemoHost(locale)
  const { default: App } = await import("@deskfleet/components/App.vue")
  const { useAppearanceStore } = await import("@deskfleet/components/stores/appearance.ts")
  const pinia = createPinia()
  const app = createApp(App)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: () => import("@deskfleet/components/views/NewSessionView.vue") },
    { path: "/schedules", name: "schedules", component: () => import("@deskfleet/components/views/ScheduledTasksView.vue"), meta: { hideDetails: true } },
    { path: "/sessions/archived", name: "archived-sessions", component: () => import("@deskfleet/components/views/ArchivedSessionsView.vue"), meta: { hideDetails: true } },
    { path: "/sessions/:sessionId", name: "session", component: () => import("@deskfleet/components/views/SessionView.vue"), props: true },
    { path: "/workspaces/:workspaceId", name: "workspace", component: () => import("@deskfleet/components/views/WorkspaceView.vue"), props: true },
    { path: "/worktrees/:worktreeId", name: "worktree", component: () => import("@deskfleet/components/views/WorktreeView.vue"), props: true },
    { path: "/machines/:machineId/control", name: "machine-control", component: () => import("@deskfleet/components/views/RemoteControlView.vue"), props: true },
    { path: "/machines/:machineId/desktop", name: "machine-desktop", redirect: to => ({ name: "machine-control", params: { machineId: to.params.machineId }, query: { tab: "desktop" } }) },
    { path: "/machines/:machineId/terminals", name: "machine-terminals", redirect: to => ({ name: "machine-control", params: { machineId: to.params.machineId }, query: { tab: "terminal" } }) },
    { path: "/terminals/:terminalId", name: "terminal", component: () => import("@deskfleet/components/views/TerminalView.vue"), props: true },
    { path: "/settings", component: () => import("@deskfleet/components/views/SettingsView.vue"), meta: { fullWindow: true }, children: [
      { path: "", name: "settings", redirect: { name: "settings-preferences" } },
      { path: "preferences", name: "settings-preferences", component: () => import("@deskfleet/components/components/settings/PreferencesSettings.vue") },
      { path: "appearance", name: "settings-appearance", component: () => import("@deskfleet/components/components/settings/AppearanceSettings.vue") },
      { path: "notifications", name: "settings-notifications", component: () => import("@deskfleet/components/components/settings/NotificationsSettings.vue") },
      { path: "agents", name: "settings-agents", component: () => import("@deskfleet/components/components/settings/AgentsSettings.vue") },
      { path: "mcp-servers", name: "settings-mcp-servers", component: () => import("@deskfleet/components/components/settings/McpServersSettings.vue") },
      { path: "team", name: "settings-team", component: () => import("@deskfleet/components/components/team/TeamSettings.vue") },
    ] },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ] })
  app.use(pinia)
  app.use(router)
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: "en-US", messages: { "en-US": en, "zh-cmn-Hans-CN": zh, "ja-JP": ja } })
  app.use(i18n)

  // Appearance changes stay inside this embed and never apply to the website document.
  const appearance = useAppearanceStore(pinia)
  appearance.settings = { ...appearance.settings, language: locale }
  appearance.ready = true
  appearance.initialize = async () => {}
  appearance.set = async patch => {
    appearance.settings = { ...appearance.settings, ...patch }
    i18n.global.locale.value = appearance.settings.language === "system" ? locale : appearance.settings.language
    target.lang = intlLocale(i18n.global.locale.value)
    target.style.colorScheme = appearance.settings.theme === "system" ? "" : appearance.settings.theme
    target.style.setProperty("--ui-font-interface", appearance.interfaceFont)
  }
  target.lang = intlLocale(locale)

  const layout = useLayoutStore(pinia)
  // Embedded applications get independent, nonpersistent layout preferences.
  for (const [key, value] of Object.entries({ sidebarOpen: options.sidebar ?? target.clientWidth >= 700, sidebarWidth: 260, detailsOpen: options.details ?? false, detailsWidth: 288, sessionContext: "worktree", terminalPanelOpen: false, terminalPanelHeight: 220 })) Reflect.set(layout, key, ref(value))
  layout.toggleSidebar = () => { layout.sidebarOpen = !layout.sidebarOpen }
  layout.toggleDetails = () => { layout.detailsOpen = !layout.detailsOpen }

  const providers = useProvidersStore(pinia)
  providers.providers = structuredClone(demoProviders)
  providers.selectedId = "claude-code"
  providers.ready = providers.loaded = true
  providers.refresh = async () => {}
  const agents = useAgentSessionsStore(pinia)
  Reflect.set(agents, "draftConfiguration", ref({ provider: "claude-code" }))
  agents.state = "connected"
  const fleet = useFleetStore(pinia)
  const terminals = useTerminalsStore(pinia)
  const data = fixtures(locale)
  const buildWorkspaces = data.machine.workspaces.filter(workspace => workspace.id === "202")
  data.machine.workspaces = data.machine.workspaces.filter(workspace => workspace.id !== "202")
  // The embedded demo owns its sample resource tree and the selectors that read it.
  Reflect.set(fleet, "machines", ref([data.machine, { id: "demo-build", name: say("Build server", "构建服务器", "ビルドサーバー"), local: false, online: true, desktop: false, terminals: [], sessions: [], workspaces: buildWorkspaces }]))
  const workspaces = computed(() => fleet.machines.flatMap(machine => machine.workspaces.map(workspace => ({ machine, workspace }))))
  const sessions = computed(() => workspaces.value.flatMap(location => location.workspace.sessions.map(session => ({ ...location, session, worktree: session.worktree }))))
  const terminalLocations = computed<TerminalLocation[]>(() => [
    ...fleet.machines.flatMap(machine => machine.terminals.map(terminal => ({ machine, terminal }))),
    ...workspaces.value.flatMap(location => location.workspace.terminals.map(terminal => ({ ...location, terminal }))),
    ...sessions.value.flatMap(location => location.worktree?.terminals.map(terminal => ({ ...location, terminal })) ?? []),
  ])
  fleet.findMachine = id => fleet.machines.find(machine => machine.id === id) ?? null
  fleet.findWorkspace = id => workspaces.value.find(({ workspace }) => workspace.id === id) ?? null
  fleet.findSession = id => sessions.value.find(({ session }) => session.id === id) ?? null
  fleet.findWorktree = id => {
    const location = sessions.value.find(({ worktree }) => worktree?.id === id)
    return location?.worktree ? { ...location, worktree: location.worktree } : null
  }
  fleet.findTerminal = id => terminalLocations.value.find(({ terminal }) => terminal.id === id) ?? null
  Reflect.set(fleet, "newSessionTarget", computed(() => fleet.targetWorkspaceId ? fleet.findWorkspace(fleet.targetWorkspaceId) : null))
  fleet.localDesktopTarget = { id: "demo-machine", name: "Studio Mac", online: true, desktop: true }
  fleet.targetWorkspaceId = "201"
  Reflect.set(fleet, "canManageCatalog", ref(true))
  fleet.refreshLocal = fleet.refreshLocalCatalog = async () => {}
  fleet.refreshLocalDesktop = async () => fleet.localDesktopTarget
  terminals.refresh = async () => {}
  for (const [id, snapshot] of Object.entries(data.snapshots)) {
    agents.sessions[id] = snapshot.session
    agents.views[id] = { snapshot, events: data.events[id]!, loading: false, error: null, historySeq: snapshot.session.lastEventSeq, snapshotSeq: snapshot.session.lastEventSeq }
    agents.configurations[id] = configuration(locale, snapshot.session.provider)
  }

  let serial = 1000
  const snapshotFor = (id: string) => agents.views[id]!.snapshot!
  function append(id: string, kind: AgentEvent["kind"], payload: AgentEvent["payload"]) {
    const view = agents.views[id]!
    const seq = String(Number(view.snapshot!.session.lastEventSeq) + 1)
    view.events.push({ sessionId: id, seq, kind, payload: JSON.parse(JSON.stringify(payload)) as AgentEvent["payload"], createdAt: "", runGeneration: 1, turnId: view.snapshot!.turns.at(-1)?.id })
    view.snapshot!.session.lastEventSeq = seq
    view.snapshotSeq = view.historySeq = seq
  }
  const receipt = (sessionId: string, inputId?: string) => ({ operationId: `operation-${serial++}`, commandId: `command-${serial++}`, sessionId, inputId })
  const activeTurn = (snapshot: AgentSnapshot) => snapshot.turns.find(turn => turn.state === "running")
  const actor = { kind: "user" as const, userId: say("You", "你", "あなた") }
  agents.refresh = async () => {}
  agents.open = async () => {}
  agents.agentConfiguration = async params => configuration(locale, params.provider, params.model, params.reasoningEffort)
  agents.sessionConfiguration = async id => agents.configurations[id] ?? configuration(locale, agents.sessions[id]!.provider)
  agents.configureSession = async (id, choices) => {
    const result = configuration(locale, agents.sessions[id]!.provider, choices.model, choices.reasoningEffort)
    agents.configurations[id] = result
    return result
  }
  agents.create = async (workspaceId, title, context, provider) => {
    const id = String(serial++)
    const snapshot: AgentSnapshot = { session: { id, ...(workspaceId ? { workspaceId } : {}), title, context, provider, lifecycle: "ready", archiveState: "active", lastEventSeq: "0", createdAt: "", updatedAt: "", capabilities: { steering: true, resume: true } }, runs: [{ sessionId: id, generation: 1, state: "running", startedAt: "" }], inputs: [], turns: [], permissions: [], elicitations: [] }
    agents.views[id] = { snapshot, events: [], loading: false, error: null, snapshotSeq: "0", historySeq: "0" }
    agents.configurations[id] = configuration(locale, provider, agents.draftConfiguration.model, agents.draftConfiguration.reasoningEffort)
    const summary = { id, title, context, archiveState: "active" as const, provider: demoProviders.find(item => item.id === provider)?.name, providerTemplate: provider, worktree: { id: `worktree-${id}`, directories: [{ path: workspaceId ? `/workspace/.worktrees/${id}` : "/workspace" }], terminals: [] } }
    if (workspaceId) {
      const workspace = fleet.findWorkspace(workspaceId)!.workspace
      summary.worktree.directories = context === "directory" ? workspace.directories : summary.worktree.directories
      workspace.sessions.push(summary)
    } else {
      fleet.machines[0]!.sessions.push(summary)
    }
    agents.sessions[id] = snapshot.session
    return snapshot
  }
  agents.submit = async (id, text, delivery) => {
    const snapshot = snapshotFor(id)
    const queued = delivery === "backlog" && !!activeTurn(snapshot)
    const message = input(String(serial++), id, text, actor.userId, queued ? "pending" : "delivered")
    message.requestedDelivery = delivery
    message.actualDelivery = delivery === "steer" ? "steer" : "turn_start"
    snapshot.inputs.push(message)
    if (!queued) {
      append(id, "input", message)
      append(id, "acp", { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: say("Your request is now part of this sample session. Try the conversation controls, or inspect the changes in the side panel.", "你的要求已加入这个示例会话。可以继续体验对话操作，或在侧栏查看代码变更。", "リクエストをこのサンプルセッションに追加しました。会話の操作を試したり、サイドパネルで変更内容を確認したりできます。") } } })
    }
    agents.drafts[id] = ""
    return receipt(id, message.id)
  }
  function updateInput(id: string, inputId: string, state: AgentInput["state"]) {
    const message = snapshotFor(id).inputs.find(item => item.id === inputId)!
    message.state = state
    if (state === "delivered") { message.actualDelivery = "steer"; message.dispatcher = actor; append(id, "input", message) }
    return receipt(id, inputId)
  }
  agents.steer = async (id, inputId) => updateInput(id, inputId, "delivered")
  agents.withdraw = async (id, inputId) => updateInput(id, inputId, "withdrawn")
  agents.retry = async (id, inputId) => updateInput(id, inputId, "pending")
  agents.cancel = async (id, turnId) => { const turn = snapshotFor(id).turns.find(item => item.id === turnId); if (turn) turn.state = "cancelled"; return receipt(id) }
  agents.respond = async (id, permissionId, optionId) => {
    const permission = snapshotFor(id).permissions.find(item => item.id === permissionId)!
    Object.assign(permission, { state: "resolved", optionId, actor })
    append(id, "permission", permission)
  }
  agents.stop = async id => { const snapshot = snapshotFor(id); snapshot.runs.forEach(run => { run.state = "stopped" }); snapshot.turns.forEach(turn => { if (turn.state === "running") turn.state = "cancelled" }) }
  function archiveState(id: string, state: "active" | "archived"): void {
    snapshotFor(id).session.archiveState = state
    fleet.findSession(id)!.session.archiveState = state
  }
  agents.rename = async (id, title) => {
    Object.assign(snapshotFor(id).session, { title: title.trim(), titleCustomized: true })
    fleet.findSession(id)!.session.title = title.trim()
  }
  agents.archive = async id => { archiveState(id, "archived") }
  agents.restore = async id => { archiveState(id, "active") }
  agents.gitStatus = async id => ({ sessionId: id, repositories: [{ id: `repository-${id}`, root: `/workspace/.worktrees/${id}`, branch: `deskfleet/${id}`, head: "84b7f21", changes: [{ path: "src/WorkspacePicker.vue", kind: "unstaged", status: "modified", additions: 7, deletions: 2 }] }], directories: [{ path: `/workspace/.worktrees/${id}`, repositoryId: `repository-${id}` }] })
  agents.gitDiff = async request => ({ ...request, patch: demoPatch, binary: false, truncated: false })
  fleet.updateWorkspace = async (id, name, directories) => { const workspace = fleet.findWorkspace(id)!.workspace; workspace.name = name; workspace.directories = directories }
  fleet.deleteWorkspace = async id => { fleet.machines[0]!.workspaces = fleet.machines[0]!.workspaces.filter(item => item.id !== id); fleet.targetWorkspaceId = fleet.machines[0]!.workspaces[0]?.id ?? null }
  fleet.createWorkspace = async (name, directories) => {
    const id = String(serial++)
    fleet.machines[0]!.workspaces.push({ id, name, directories, sessions: [], terminals: [] })
    fleet.targetWorkspaceId = id
    return { id, name, worktrees: [{ id: `main-${id}`, workspaceId: id, directories }] }
  }
  const routes = { agents: "/", team: "/sessions/303", remote: "/machines/demo-machine/control?tab=desktop", session: "/sessions/301" }
  await router.replace(options.initialRoute ?? routes[options.kind])
  await router.isReady()
  app.mount(target)
  return () => { app.unmount(); disposePinia(pinia) }
}
