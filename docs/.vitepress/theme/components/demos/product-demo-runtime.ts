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
import type { TerminalListener } from "../../../../../packages/components/src/services/terminal-client.ts"
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
  // Embedded apps share the website's Vue runtime. Without a handler, development builds
  // rethrow component errors mid-render, which leaves Vue's effect stack corrupted and
  // breaks VitePress navigation. A failing demo must stay inside its own window.
  app.config.errorHandler = (error, _instance, info) => console.error(`[product demo: ${options.kind}] ${info}`, error)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: () => import("@deskfleet/components/views/NewSessionView.vue") },
    { path: "/schedules", name: "schedules", component: () => import("@deskfleet/components/views/ScheduledTasksView.vue"), meta: { hideDetails: true } },
    { path: "/sessions/archived", name: "archived-sessions", component: () => import("@deskfleet/components/views/ArchivedSessionsView.vue"), meta: { hideDetails: true } },
    { path: "/sessions/:sessionId", name: "session", component: () => import("@deskfleet/components/views/SessionView.vue"), props: true },
    { path: "/worktrees/:worktreeId", name: "worktree", component: () => import("@deskfleet/components/views/WorktreeView.vue"), props: true },
    { path: "/machines/:machineId/control", name: "machine-control", component: () => import("@deskfleet/components/views/RemoteControlView.vue"), props: true },
    { path: "/machines/:machineId/desktop", name: "machine-desktop", redirect: to => ({ name: "machine-control", params: { machineId: to.params.machineId }, query: { tab: "desktop" } }) },
    { path: "/machines/:machineId/terminals", name: "machine-terminals", redirect: to => ({ name: "machine-control", params: { machineId: to.params.machineId }, query: { tab: "terminal" } }) },
    { path: "/terminals/:terminalId", name: "terminal", component: () => import("@deskfleet/components/views/TerminalView.vue"), props: true },
    { path: "/settings", component: () => import("@deskfleet/components/views/SettingsView.vue"), meta: { fullWindow: true }, children: [
      { path: "", name: "settings", redirect: { name: "settings-preferences" } },
      { path: "preferences", name: "settings-preferences", component: () => import("@deskfleet/components/components/settings/PreferencesSettings.vue") },
      { path: "worktrees", name: "settings-worktrees", component: () => import("@deskfleet/components/components/settings/WorktreeSettings.vue") },
      { path: "appearance", name: "settings-appearance", component: () => import("@deskfleet/components/components/settings/AppearanceSettings.vue") },
      { path: "notifications", name: "settings-notifications", component: () => import("@deskfleet/components/components/settings/NotificationsSettings.vue") },
      // SettingsView links these unconditionally; a missing name throws while its sidebar renders.
      { path: "developer", children: [
        { path: "", name: "settings-developer", component: () => import("@deskfleet/components/components/settings/DeveloperSettings.vue") },
        { path: "nat", name: "settings-developer-nat", component: () => import("@deskfleet/components/components/settings/NatSettings.vue") },
      ] },
      { path: "about", name: "settings-about", component: () => import("@deskfleet/components/components/settings/AboutSettings.vue") },
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
    if (appearance.settings.theme === "system") delete target.dataset.theme
    else target.dataset.theme = appearance.settings.theme
    target.style.setProperty("--ui-font-interface", appearance.interfaceFont)
  }
  target.lang = intlLocale(locale)

  const layout = useLayoutStore(pinia)
  // Demos stay inside their app windows, including on narrow website viewports.
  // Compact drawers would portal over the website and block its install controls.
  Reflect.set(layout, "compact", ref(false))
  // Embedded applications get independent, nonpersistent layout preferences.
  for (const [key, value] of Object.entries({ sidebarOpen: options.sidebar ?? target.clientWidth >= 700, sidebarWidth: 260, sessionContext: "worktree", terminalPanelOpen: false, terminalPanelHeight: 220 })) Reflect.set(layout, key, ref(value))
  layout.toggleSidebar = () => { layout.sidebarOpen = !layout.sidebarOpen }

  const providers = useProvidersStore(pinia)
  providers.providers = structuredClone(demoProviders)
  providers.selectedId = "claude-code"
  providers.ready = providers.loaded = true
  providers.refresh = async () => {}
  const agents = useAgentSessionsStore(pinia)
  Reflect.set(agents, "draftConfiguration", ref({ provider: "claude-code" }))
  agents.state = "connected"
  agents.sessionPresence = { "303": ["Maya", "Alex"] }
  const fleet = useFleetStore(pinia)
  const terminals = useTerminalsStore(pinia)
  const data = fixtures(locale)
  const buildWorkspaces = data.machine.workspaces.filter(workspace => workspace.id === "202")
  data.machine.workspaces = data.machine.workspaces.filter(workspace => workspace.id !== "202")
  // The embedded demo owns its sample resource tree and the selectors that read it.
  Reflect.set(fleet, "machines", ref([data.machine, { id: "demo-build", name: say("Build server", "构建服务器", "ビルドサーバー"), local: false, online: true, desktop: false, terminals: [], sessions: [], workspaces: buildWorkspaces }]))
  const workspaces = computed(() => fleet.machines.flatMap(machine => machine.workspaces.map(workspace => ({ machine, workspace }))))
  const sessions = computed(() => [
    ...fleet.machines.flatMap(machine => machine.sessions.map(session => ({ machine, session, worktree: session.worktree }))),
    ...workspaces.value.flatMap(location => location.workspace.sessions.map(session => ({ ...location, session, worktree: session.worktree }))),
  ])
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
  Reflect.set(fleet, "newSessionTarget", computed(() => fleet.targetWorkspaceId ? fleet.findWorkspace(fleet.targetWorkspaceId) : (fleet.machines[0] ? { machine: fleet.machines[0] } : null)))
  fleet.localDesktopTarget = { id: "demo-machine", name: "Studio Mac", online: true, desktop: true }
  fleet.targetWorkspaceId = "201"
  Reflect.set(fleet, "canManageCatalog", ref(true))
  fleet.refreshLocal = fleet.refreshLocalCatalog = async () => {}
  fleet.refreshLocalDesktop = async () => fleet.localDesktopTarget
  terminals.refresh = async () => {}
  const terminalListeners = new Map<string, Set<TerminalListener>>()
  terminals.create = async ({ cwd = "/workspace/website", worktreeId, cols = 80, rows = 24 } = {}) => {
    const summary = { id: `terminal-${serial++}`, title: "zsh", cwd, cols, rows, status: "running" as const, ...(worktreeId ? { worktreeId } : {}) }
    terminals.sessions.push(summary)
    if (worktreeId) terminals.selected[worktreeId] = summary.id
    return summary
  }
  terminals.ensureWorktreeTerminal = async worktreeId => terminals.sessions.find(item => item.worktreeId === worktreeId && item.kind !== "acp") ?? terminals.create({ worktreeId, cwd: `/workspace/.worktrees/${worktreeId}` })
  terminals.attach = (sessionId, listener) => {
    const summary = terminals.sessions.find(item => item.id === sessionId) ?? { id: sessionId, title: "zsh", cwd: "/workspace/website", cols: 80, rows: 24, status: "running" as const }
    const set = terminalListeners.get(sessionId) ?? new Set<TerminalListener>()
    set.add(listener)
    terminalListeners.set(sessionId, set)
    queueMicrotask(() => {
      if (!set.has(listener)) return
      listener({ kind: "output", sessionId, data: btoa("studio-mac:website$ "), offset: 20 }, () => {})
      listener({ kind: "ready", sessionId }, () => {})
    })
    return { ready: Promise.resolve(summary), detach: () => { set.delete(listener) } }
  }
  terminals.input = async (sessionId, data) => {
    const out = data === "\r" ? "\r\nstudio-mac:website$ " : data
    const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(out)))
    for (const listener of terminalListeners.get(sessionId) ?? []) listener({ kind: "output", sessionId, data: encoded, offset: encoded.length }, () => {})
  }
  terminals.resize = async () => null
  terminals.hangup = async sessionId => { terminals.sessions = terminals.sessions.filter(item => item.id !== sessionId); delete terminals.titles[sessionId]; terminalListeners.delete(sessionId) }
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
  agents.attend = async () => true
  agents.leave = async () => {}
  agents.markRead = async (id, throughSeq) => {
    if (agents.sessions[id]) agents.sessions[id].lastReadSeq = throughSeq
    if (agents.views[id]?.snapshot) agents.views[id].snapshot.session.lastReadSeq = throughSeq
  }
  agents.markUnread = async id => {
    const session = agents.sessions[id]
    const completed = session?.lastCompletedSeq
    if (!session || !completed || BigInt(completed) === 0n || BigInt(completed) > BigInt(session.lastReadSeq ?? "0")) return
    const lastReadSeq = String(BigInt(completed) - 1n)
    session.lastReadSeq = lastReadSeq
    if (agents.views[id]?.snapshot) agents.views[id].snapshot.session.lastReadSeq = lastReadSeq
  }
  agents.checkOperation = async () => undefined
  agents.agentConfiguration = async params => configuration(locale, params.provider, params.model, params.reasoningEffort)
  agents.releaseAgentConfiguration = async () => {}
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
  agents.fork = async (sourceId, context) => {
    const source = snapshotFor(sourceId).session
    return agents.create(source.workspaceId, source.title, context, source.provider)
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
    agents.draftAttachments[id] = []
    agents.draftMentions[id] = []
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
  agents.respondToElicitation = async () => {}
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
  agents.remove = async id => {
    delete agents.sessions[id]
    delete agents.views[id]
    delete agents.configurations[id]
    for (const machine of fleet.machines) {
      machine.sessions = machine.sessions.filter(item => item.id !== id)
      for (const workspace of machine.workspaces) workspace.sessions = workspace.sessions.filter(item => item.id !== id)
    }
  }
  agents.composerReferences = async ({ kind, query, workspaceId = "201", sessionId }) => {
    const needle = query.toLocaleLowerCase()
    const items = kind === "file"
      ? ["src/WorkspacePicker.vue", "src/App.vue"].filter(name => name.toLocaleLowerCase().includes(needle)).map(name => ({
        name, description: "/workspace/website", reference: { kind: "file" as const, originId: "demo-machine", workspaceId, ...(sessionId ? { sessionId } : {}), directoryIndex: 0, sourceDirectory: "/workspace/website", relativePath: name },
      }))
      : Object.values(agents.sessions).filter(item => item.id !== sessionId && (item.title ?? "").toLocaleLowerCase().includes(needle)).map(item => ({
        name: item.title ?? item.id, description: "website", reference: { kind: "session" as const, originId: "demo-machine", workspaceId: item.workspaceId ?? workspaceId, sessionId: item.id },
      }))
    return { items, truncated: false }
  }
  agents.resolveComposerReferences = async () => []
  agents.gitBranches = async workspaceId => ({ workspaceId, currentBranch: "main", branches: ["main", "deskfleet/301", "deskfleet/303"] })
  agents.prepareGit = async (workspaceId, context) => ({
    workspaceId, context, status: "ready", repositories: [{ root: "/workspace/website", branch: "main", changes: [] }],
    ...(context === "worktree" ? { baseRevisions: [{ path: "/workspace/website", revision: "84b7f21" }] } : {}),
  })
  agents.gitStatus = async id => agents.sessions[id]?.workspaceId
    ? { sessionId: id, repositories: [{ id: `repository-${id}`, root: `/workspace/.worktrees/${id}`, branch: `deskfleet/${id}`, head: "84b7f21", changes: [{ path: "src/WorkspacePicker.vue", kind: "unstaged", status: "modified", additions: 7, deletions: 2 }] }], directories: [{ path: `/workspace/.worktrees/${id}`, repositoryId: `repository-${id}` }] }
    : { sessionId: id, repositories: [], directories: [{ path: "/Users/you", repositoryId: null }] }
  agents.gitDiff = async request => ({ ...request, patch: demoPatch, binary: false, truncated: false })
  // Fixture changes are static; observing them must not connect to a real daemon.
  agents.watchGit = async () => () => {}
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
