import { client as platformClient, configureClient, getClient } from "@deskfleet/client/platform"
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import App from "./App.vue"
import { accountSessionKey, createAccountSession } from "./composables/useAccountSession.ts"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { usePinnedSessionsStore } from "./stores/pinned-sessions.ts"
import { catalogFixture, sessionWorktreeId, mainWorktreeId, sessionId, workspaceId } from "./test/catalog.ts"
import { fakeCentral, machineFixture } from "./test/central.ts"
import type { LocalAgentState } from "../../client/src/local-agent.ts"
import { agentEvent, agentSnapshot } from "./test/agent.ts"
import OpenWithMenu from "./components/catalog/OpenWithMenu.vue"

const mounted: { wrapper: VueWrapper; pinia: ReturnType<typeof createPinia> }[] = []
const host = getClient()
async function mountApp(path = "/", pinia = createPinia(), realPortals = false, provide?: Record<PropertyKey, unknown>) {
  await router.push(path)
  const wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], provide, stubs: { ...(realPortals ? {} : { Teleport: { inheritAttrs: false, template: "<slot />" } }), LiveTerminal: { props: ["terminalId"], template: '<div data-terminal :data-id="terminalId" />' } } },
  })
  mounted.push({ wrapper, pinia })
  await flushPromises()
  return wrapper
}
function link(wrapper: VueWrapper, text: string) { return wrapper.findAll("a").find(a => a.text() === text)! }
function button(wrapper: VueWrapper, text: string) { return wrapper.findAll("button").find(entry => entry.text() === text)! }
function hydrateSession(pinia: ReturnType<typeof createPinia>, title = ""): void {
  const agents = useAgentSessionsStore(pinia)
  agents.sessions[sessionId] = { ...agentSnapshot().session, id: sessionId, workspaceId, title }
  vi.spyOn(agents, "refresh").mockResolvedValue()
}
async function workspaceAction(wrapper: VueWrapper, label: string): Promise<void> {
  await wrapper.get('button[aria-label="storefront"]').trigger("contextmenu", { button: 2, clientX: 24, clientY: 48 })
  await flushPromises()
  const item = wrapper.findAll('[role="menuitem"]').find(item => item.text() === label)!
  await item.trigger("click")
  await flushPromises()
}
const chips = (wrapper: VueWrapper) => wrapper.findAll("[data-composer-context]").map(chip => chip.text())
function panel(wrapper: VueWrapper) { return wrapper.get<HTMLElement>('aside[aria-label="Changes"]') }

// Compile lazy route modules during setup so a cold import cannot outlive a navigation
// test's deadline and complete during the following test (macOS CI Cluster B).
beforeAll(async () => {
  await Promise.all([
    import("./views/NewSessionView.vue"),
    import("./views/SessionView.vue"),
    import("./views/WorktreeView.vue"),
    import("./views/ArchivedSessionsView.vue"),
    import("./views/RemoteControlView.vue"),
    import("./components/terminal/TerminalShellWindow.vue"),
    import("./views/SettingsView.vue"),
    import("./components/settings/PreferencesSettings.vue"),
    import("./components/settings/AppearanceSettings.vue"),
    import("./components/settings/NotificationsSettings.vue"),
    import("./components/settings/PermissionsSettings.vue"),
    import("./components/settings/AboutSettings.vue"),
  ])
})

beforeEach(() => {
  window.localStorage.clear()
  vi.spyOn(platformClient.catalog, "list").mockResolvedValue(catalogFixture())
  vi.spyOn(platformClient.desktop, "target").mockResolvedValue({ id: "local-daemon", name: "test-host", online: true, desktop: true })
  vi.spyOn(platformClient.filesystem, "listDirectories").mockImplementation(async (path = "/") => ({
    path, parentPath: path === "/" ? null : "/", homePath: "/", roots: [{ name: "/", path: "/" }],
    directories: path === "/" ? ["notes", "code", "replacement"].map(name => ({ name, path: `/${name}`, hidden: false })) : [],
  }))
})
afterEach(async () => {
  for (const { wrapper, pinia } of mounted.splice(0)) { wrapper.unmount(); disposePinia(pinia) }
  // Shared hash router must reset even when a prior test timed out mid-navigation.
  await router.replace("/")
  vi.restoreAllMocks()
  configureClient(host)
  i18n.global.locale.value = "en-US"
})

test("the app targets a workspace and waits for Session metadata without exposing an internal main worktree", async () => {
  const pinia = createPinia()
  const wrapper = await mountApp("/", pinia)
  expect(chips(wrapper)).toEqual(["test-hostThis machine", "storefront", "New worktree", "Codex"])
  expect(wrapper.get<HTMLButtonElement>('[aria-label="Send"]').element.disabled).toBe(true)
  expect(wrapper.get("aside").text()).not.toContain("Example team")
  expect(wrapper.get('button[aria-label="storefront"]').attributes("aria-expanded")).toBe("true")
  expect(wrapper.find('a[href*="/workspaces/"]').exists()).toBe(false)
  expect(wrapper.find(`a[href="#/sessions/${sessionId}"]`).exists()).toBe(false)
  hydrateSession(pinia)
  await flushPromises()
  expect(link(wrapper, `Session ${sessionId}`).attributes("href")).toBe(`#/sessions/${sessionId}`)
  expect(wrapper.find('a[href*="/worktrees/"]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain("Main worktree")
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
})

test("Pinned sessions appear above Workspaces while retaining their workspace entry", async () => {
  const pinia = createPinia()
  hydrateSession(pinia, "Pinned investigation")
  const wrapper = await mountApp("/", pinia)
  usePinnedSessionsStore(pinia).pin("local-daemon", sessionId, "Pinned investigation")
  await flushPromises()
  const sidebar = wrapper.get("aside")
  const pinned = sidebar.get("[data-pinned-sessions]")
  const workspaces = sidebar.findAll("span").find(element => element.text() === "Workspaces")!
  expect(pinned.element.compareDocumentPosition(workspaces.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(pinned.text()).toContain("Pinned investigation")
  expect(sidebar.get(`a[href="#/sessions/${sessionId}"]`).text()).toBe("Pinned investigation")
})

test("the archive route retains the sidebar without tiled windows", async () => {
  const pinia = createPinia()
  vi.spyOn(useAgentSessionsStore(pinia), "refresh").mockResolvedValue()
  const wrapper = await mountApp("/sessions/archived", pinia)
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(wrapper.get("main h1").text()).toBe("Archived sessions")
  expect(wrapper.get("aside").text()).toContain("Workspaces")
  expect(wrapper.get('[data-archived-sessions]').attributes("aria-current")).toBe("page")
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
  expect(wrapper.find('[aria-label="Add window"]').exists()).toBe(false)
})

test("workspace creation opens a dialog, requires paths, supports choosing the first path by reordering, and retains input after failure", async () => {
  const create = vi.spyOn(platformClient.catalog, "createWorkspace").mockRejectedValueOnce(new Error("Directory does not exist"))
  const wrapper = await mountApp()
  await wrapper.get('[aria-label="Add workspace"]').trigger("click")
  expect(wrapper.get('[role=dialog]').attributes("data-state")).toBe("open")
  await wrapper.get('input[name="workspace-name"]').setValue("notes")
  await wrapper.get("[role=dialog] form").trigger("submit")
  expect(create).not.toHaveBeenCalled()
  expect(wrapper.get('[role=dialog] [role="alert"]').text()).toBe("Choose at least one directory.")
  expect(wrapper.find('input[name^="directory-name"]').exists()).toBe(false)
  expect(wrapper.find('input[name^="directory-path"]').exists()).toBe(false)
  await wrapper.get('button[name="directory-path-0"]').trigger("click")
  await flushPromises()
  await wrapper.get('[role=dialog] [data-path="/notes"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await button(wrapper, "Add directory").trigger("click")
  await flushPromises()
  await wrapper.get('[role=dialog] [aria-label="Home"]').trigger("click")
  await flushPromises()
  await wrapper.get('[role=dialog] [data-path="/code"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await wrapper.get('[aria-label="Move directory 2 up"]').trigger("click")
  expect(wrapper.get('button[name="directory-path-0"]').text()).toContain("/code")
  await wrapper.get("[role=dialog] form").trigger("submit")
  await flushPromises()
  expect(wrapper.get('[role=dialog] [role="alert"]').text()).toBe("Directory does not exist")
  expect((wrapper.get('input[name="workspace-name"]').element as HTMLInputElement).value).toBe("notes")
  const paths = [{ path: "/code" }, { path: "/notes" }]
  expect(create).toHaveBeenCalledWith("notes", paths)
  create.mockResolvedValueOnce({ id: "9007199254741003", name: "notes", worktrees: [{ id: "9007199254741005", workspaceId: "9007199254741003", directories: paths }] })
  await wrapper.get("[role=dialog] form").trigger("submit")
  await flushPromises()
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(wrapper.find("[role=dialog]").exists()).toBe(false)
  expect(wrapper.get("main").text()).not.toContain("Main worktree")
  expect(wrapper.get("main").find('a[href*="/worktrees/"]').exists()).toBe(false)
  expect(chips(wrapper)).toEqual(["test-hostThis machine", "storefront", "New worktree", "Codex"].map((item, index) => index === 1 ? "notes" : item))
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
})

test("cancelling workspace creation closes its dialog without creating", async () => {
  const create = vi.spyOn(platformClient.catalog, "createWorkspace")
  const wrapper = await mountApp()
  await wrapper.get('[aria-label="Add workspace"]').trigger("click")
  await wrapper.get('input[name="workspace-name"]').setValue("notes")
  await button(wrapper, "Cancel").trigger("click")
  await vi.waitFor(() => expect(wrapper.find("[role=dialog]").exists()).toBe(false))
  expect(create).not.toHaveBeenCalled()
})

test("workspace edits update its configured directories without independent worktree maintenance", async () => {
  const value = catalogFixture().workspaces[0]!
  value.name = "renamed"
  value.worktrees[0]!.directories = [{ path: "/replacement" }, { path: "/code/web" }]
  const update = vi.spyOn(platformClient.catalog, "updateWorkspace").mockResolvedValue(value)
  const wrapper = await mountApp()
  expect(button(wrapper, "Add worktree")).toBeUndefined()
  await workspaceAction(wrapper, "Edit workspace")
  await wrapper.get('input[name="workspace-name"]').setValue("renamed")
  await wrapper.get('button[name="directory-path-1"]').trigger("click")
  await flushPromises()
  expect(platformClient.filesystem.listDirectories).toHaveBeenLastCalledWith("/code/api")
  await wrapper.get('[role=dialog] [aria-label="Home"]').trigger("click")
  await flushPromises()
  await wrapper.get('[role=dialog] [data-path="/replacement"]').trigger("click")
  await flushPromises()
  await button(wrapper, "Select folder").trigger("click")
  await wrapper.get('[aria-label="Move directory 2 up"]').trigger("click")
  await wrapper.get('[role="dialog"] form').trigger("submit")
  await flushPromises()
  expect(update).toHaveBeenCalledWith(workspaceId, "renamed", [{ path: "/replacement" }, { path: "/code/web" }])
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  expect(wrapper.find('button[aria-label="renamed"]').exists()).toBe(true)
  expect(button(wrapper, "Edit worktree")).toBeUndefined()
  expect(button(wrapper, "Delete worktree")).toBeUndefined()
  expect(wrapper.get("main").find('a[href*="/worktrees/"]').exists()).toBe(false)
})

test("workspace New session chooses that workspace before opening the composer and allows switching from the context bar", async () => {
  const snapshot = catalogFixture()
  snapshot.workspaces.push({ id: "2", name: "notes", worktrees: [{ id: "3", workspaceId: "2", directories: [{ path: "/notes" }] }] })
  vi.mocked(platformClient.catalog.list).mockResolvedValue(snapshot)
  const fake = fakeCentral({
    machines: [machineFixture("local-daemon", "team-1", "test-host"), machineFixture("remote-1", "team-1", "build-server", false)],
    enrollment: { configured: true, connected: true, revoked: false, serverUrl: "https://fleet.example", teamId: "team-1", machineId: "local-daemon", identity: { originId: "origin-local", machineId: "1" }, machineName: "test-host" },
  })
  const account = createAccountSession(fake.central)
  await vi.waitFor(() => expect(account.ready.value).toBe(true))
  const selectMachine = vi.spyOn(account, "selectMachine")
  try {
    const wrapper = await mountApp("/", createPinia(), false, { [accountSessionKey as symbol]: account })
    await wrapper.findAll('.workspace-row button[aria-label="New session"]')[1]!.trigger("click")
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
    expect(chips(wrapper)).toEqual(["test-hostThis machine", "notes", "New worktree", "Codex"])
    await wrapper.get("[data-composer-workspace]").trigger("click")
    await flushPromises()
    await wrapper.findAll('[aria-label="Workspace"] [role="menuitemradio"]').find(item => item.text() === "storefront")!.trigger("click")
    await new Promise(resolve => setTimeout(resolve, 0))
    await flushPromises()
    expect(chips(wrapper)).toEqual(["test-hostThis machine", "storefront", "New worktree", "Codex"])
    await wrapper.get("[data-composer-machine]").trigger("click")
    await flushPromises()
    expect(wrapper.findAll('[aria-label="Machine"] [role="menuitemradio"]').map(item => item.text())).toEqual(["test-host", "build-server Offline"])
    await wrapper.findAll('[aria-label="Machine"] [role="menuitemradio"]').find(item => item.text().includes("build-server"))!.trigger("click")
    await flushPromises()
    expect(selectMachine).toHaveBeenCalledExactlyOnceWith("remote-1")
    expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
  } finally {
    account.dispose()
  }
})

test("workspace deletion requires confirmation and clears its composer target", async () => {
  const remove = vi.spyOn(platformClient.catalog, "deleteWorkspace").mockResolvedValue()
  const wrapper = await mountApp()
  await workspaceAction(wrapper, "Delete workspace")
  expect(remove).not.toHaveBeenCalled()
  expect(wrapper.get('[role="dialog"]').text()).toContain("Its directories remain on disk")
  await button(wrapper, "Confirm deletion").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  expect(remove).toHaveBeenCalledWith(workspaceId)
  // Without a Workspace, the composer still targets the machine for chat.
  expect(chips(wrapper)).toEqual(["test-hostThis machine", "Codex"])
})

test("the workspace sidebar opens a terminal in its default directory and retains machine ownership", async () => {
  const cwd = "/code/web"
  const dial = vi.spyOn(platformClient.terminal, "dial").mockImplementation(async options => ({ id: options.terminalId, title: "shell", cwd, cols: 80, rows: 24, status: "running" }))
  const wrapper = await mountApp()
  await wrapper.get('button[aria-label="Open terminal in default directory"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("machine-control"))
  expect(dial).toHaveBeenCalledWith({ mode: "create", terminalId: expect.any(String), cols: 80, rows: 24, cwd })
  expect(router.currentRoute.value.query).toEqual({ tab: "terminal", terminal: dial.mock.calls[0]![0].terminalId })
  expect(wrapper.get('[role="tablist"][aria-label="Local control"] [aria-selected="true"]').text()).toBe("Terminal")
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
})

test("refresh failure preserves the workspace and disables its terminal action until retry", async () => {
  const wrapper = await mountApp()
  vi.mocked(platformClient.catalog.list).mockRejectedValueOnce(new Error("Daemon disconnected"))
  await button(wrapper, "Refresh").trigger("click")
  await flushPromises()
  expect(wrapper.get('aside [role="alert"]').text()).toBe("Daemon disconnected")
  expect(wrapper.find('button[aria-label="storefront"]').exists()).toBe(true)
  expect(wrapper.get('button[aria-label="Open terminal in default directory"]').attributes("aria-disabled")).toBe("true")
  await button(wrapper, "Refresh").trigger("click")
  await flushPromises()
  expect(wrapper.get('button[aria-label="Open terminal in default directory"]').attributes("aria-disabled")).toBeUndefined()
})

test("a session links to its own read-only worktree", async () => {
  const pinia = createPinia()
  vi.spyOn(useAgentSessionsStore(pinia), "watchGit").mockResolvedValue(() => {})
  const status = vi.spyOn(useAgentSessionsStore(pinia), "gitStatus").mockResolvedValue({
    sessionId, directories: [{ path: "/worktrees/api/session", repositoryId: "checkout" }],
    repositories: [{ id: "checkout", root: "/worktrees/api/session", branch: "session-branch", head: "abc123", changes: [] }],
  })
  const wrapper = await mountApp(`/sessions/${sessionId}`, pinia)
  expect(status).toHaveBeenCalledWith(sessionId, false)
  expect(panel(wrapper).text()).toContain("session-branch")
  expect(wrapper.find("main header").exists()).toBe(false)
  expect(wrapper.get('[data-window-tab-id="chat"]').text()).toContain(`Session ${sessionId}`)
  const worktreeLink = wrapper.get(`main a[href="#/worktrees/${sessionWorktreeId}"]`)
  expect(worktreeLink.text()).toBe("session-branch")
  expect(worktreeLink.attributes("title")).toBe("session-branch")
  await worktreeLink.trigger("click")
  // Preloaded WorktreeView still needs headroom when macOS CI shares the runner with rustc.
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("worktree"), { timeout: 3_000 })
  expect(wrapper.get("main header").text()).toContain("Worktree")
  expect(wrapper.get("main").text()).toContain("/worktrees/api/session")
  expect(button(wrapper, "New session")).toBeUndefined()
  expect(button(wrapper, "Edit worktree")).toBeUndefined()
  expect(button(wrapper, "Delete worktree")).toBeUndefined()
  await flushPromises()
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
  expect(wrapper.find('aside[aria-label="Changes"]').exists()).toBe(false)
})

test.each(["worktree", "directory"] as const)("archiving a %s Session stops Git observation and disables its unavailable filesystem actions", async context => {
  configureClient({ ...host, applications: { scan: vi.fn(async () => []), openWorkspace: vi.fn(async () => {}) } })
  const pinia = createPinia()
  const agents = useAgentSessionsStore(pinia)
  const snapshot = agentSnapshot()
  snapshot.session = { ...snapshot.session, id: sessionId, workspaceId, context }
  const event = { ...agentEvent(1, "acp", { sessionId: "provider", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Retained conversation" } } }), sessionId }
  agents.sessions[sessionId] = snapshot.session
  agents.views[sessionId] = { snapshot, events: [event], loading: false, error: null, historySeq: "1", snapshotSeq: "1" }
  vi.spyOn(agents, "open").mockResolvedValue()
  vi.spyOn(agents, "refresh").mockResolvedValue()
  const stop = vi.fn()
  const watch = vi.spyOn(agents, "watchGit").mockResolvedValue(stop)
  vi.spyOn(agents, "gitStatus").mockResolvedValue({ sessionId, directories: [], repositories: [] })
  const wrapper = await mountApp(`/sessions/${sessionId}`, pinia)
  expect(wrapper.findComponent(OpenWithMenu).exists()).toBe(true)
  expect(watch).toHaveBeenCalledTimes(2)

  const restore = vi.spyOn(agents, "restore").mockImplementation(async () => {
    agents.sessions[sessionId]!.archiveState = "active"
  })
  for (const archiveState of ["archiving", "archived"] as const) {
    agents.sessions[sessionId]!.archiveState = archiveState
    await flushPromises()
    expect(wrapper.findComponent(OpenWithMenu).exists()).toBe(context === "directory")
    expect(wrapper.find("textarea").exists()).toBe(false)
    expect(wrapper.find(".ui-notice button").exists()).toBe(archiveState === "archived")
    expect(wrapper.get('[aria-label="Conversation"]').text()).toContain("Retained conversation")
    expect(watch).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledTimes(2)
  }

  await router.push(`/worktrees/${sessionWorktreeId}`); await flushPromises()
  expect(wrapper.get('button[aria-label="Open terminal in /worktrees/api/session"]').attributes("disabled")).toBeDefined()
  expect(wrapper.get("main").text()).toContain("This session is archived")
  await router.push(`/sessions/${sessionId}`); await flushPromises()
  await wrapper.get(".ui-notice button").trigger("click"); await flushPromises()
  expect(restore).toHaveBeenCalledExactlyOnceWith(sessionId)
  expect(wrapper.findComponent(OpenWithMenu).exists()).toBe(true)
  expect(wrapper.find("textarea").exists()).toBe(true)
  expect(watch).toHaveBeenCalledTimes(4)
})

test("the internal main worktree has no directly accessible page", async () => {
  const wrapper = await mountApp(`/worktrees/${mainWorktreeId}`)
  expect(wrapper.get("main").text()).toContain("This worktree does not exist.")
  expect(wrapper.get("main").text()).not.toContain("/code/web")
  // The current section links to the requested URL; no resource advertises this worktree.
  const links = wrapper.findAll(`a[href="#/worktrees/${mainWorktreeId}"]`)
  expect(links.map(link => link.attributes("aria-label"))).toEqual(["Conversations"])
})

test("the localized composer and local footer do not expose an internal main worktree", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const wrapper = await mountApp()
  expect(chips(wrapper)).toHaveLength(4)
  expect(chips(wrapper)).toContain("新建工作树")
  expect(chips(wrapper)).toContain("storefront")
  expect(wrapper.text()).not.toContain("主工作树")
  expect(wrapper.get("footer").text()).toBe("本本地")
})

test("settings replaces the app layout, returns to the previous page, and refreshes resources after lifecycle transitions", async () => {
  const listeners = new Set<(state: LocalAgentState) => void>()
  vi.spyOn(platformClient.settings, "onChanged").mockImplementation(listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  vi.spyOn(platformClient.settings, "get").mockResolvedValue({ enabled: true, status: "running" })
  const list = vi.spyOn(platformClient.terminal, "list").mockResolvedValue([])
  const view = await mountApp()
  await view.get('button[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-preferences"))
  await flushPromises()
  expect(view.find("aside").exists()).toBe(false)
  expect(view.get('main nav [aria-current="page"]').text()).toBe("Preferences")
  expect(view.get("main h1").text()).toBe("Preferences")
  expect(view.get('main [role="switch"][aria-labelledby="launch-at-startup-label"]').attributes("disabled")).toBeDefined()
  expect(view.get("#launch-at-startup-label").text()).toBe("Launch at startup")
  expect(view.get("#keep-awake-label").text()).toBe("Keep Awake")
  expect(view.get('main [role="switch"][aria-labelledby="keep-awake-label"]').attributes("aria-checked")).toBe("false")
  expect(view.get("#auto-download-updates-label").text()).toBe("Automatically download updates")
  expect(view.get('main [role="switch"][aria-labelledby="auto-download-updates-label"]').attributes("aria-checked")).toBe("true")
  expect(view.get('main section[aria-labelledby="this-computer-heading"]').text()).toContain("Run local Agent")
  vi.mocked(platformClient.catalog.list).mockClear()
  list.mockClear()
  for (const listener of listeners) listener({ enabled: false, status: "stopping" })
  await flushPromises()
  expect(platformClient.catalog.list).not.toHaveBeenCalled()
  expect(list).not.toHaveBeenCalled()
  for (const [index, status] of (["stopped", "running", "error"] as const).entries()) {
    for (const listener of listeners) listener({ enabled: status === "running", status })
    await flushPromises()
    expect(platformClient.catalog.list).toHaveBeenCalledTimes(index + 1)
    expect(list).toHaveBeenCalledTimes(index + 1)
  }
  await button(view, "Back to app").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  await flushPromises()
  expect(listeners.size).toBe(1)
  expect(chips(view)).toContain("storefront")
  view.unmount()
  expect(listeners.size).toBe(0)
})

test("notifications have a dedicated settings section and retain the return destination", async () => {
  const view = await mountApp()
  await view.get('button[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-preferences"))
  await flushPromises()
  await view.get('main nav a[href="#/settings/notifications"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-notifications"))
  await flushPromises()
  expect(view.get('main nav [aria-current="page"]').text()).toBe("Notifications")
  expect(view.get("main h1").text()).toBe("Notifications")
  expect(view.findAll('main [role="switch"]')).toHaveLength(3)
  await button(view, "Back to app").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
})

test("completed desktop setup exposes permissions and About and retains the return destination", async () => {
  const check = vi.fn(async () => ({ status: "idle" as const, currentVersion: "0.2.0" }))
  const permissions = vi.fn(async () => ({ localNetwork: "not-requested" as const, fullDiskAccessPermission: { status: "granted" as const }, screenCapturePermission: { status: "denied" as const }, accessibilityPermission: { status: "granted" as const } }))
  const requestPermission = vi.fn(async () => ({}))
  configureClient({
    ...host, platform: "darwin",
    onboarding: {
      get: async () => ({ step: "complete", permissionSteps: ["localNetwork", "fullDiskAccess", "screenCapture", "accessibility"] }),
      permissions, requestPermission, openLocalNetworkSettings: vi.fn(),
      advancePermission: vi.fn(), complete: vi.fn(),
    },
    updates: { get: async () => ({ status: "idle", currentVersion: "0.2.0" }), check, install: vi.fn(), onChanged: () => () => {} },
  })
  const view = await mountApp()
  await view.get('button[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-preferences"))
  await view.get('main nav a[href="#/settings/permissions"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-permissions"))
  await flushPromises()
  expect(view.get("main h1").text()).toBe("Permissions")
  expect(view.findAll("[data-permission]")).toHaveLength(4)
  expect(permissions).toHaveBeenCalledOnce()
  expect(requestPermission).not.toHaveBeenCalled()
  await view.get('main nav a[href="#/settings/about"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-about"))
  await flushPromises()
  expect(view.get("main h1").text()).toBe("About")
  expect(view.text()).toContain("0.2.0")
  expect(check).not.toHaveBeenCalled()
  await button(view, "Check for updates").trigger("click")
  await flushPromises()
  expect(check).toHaveBeenCalledOnce()
  expect(view.text()).toContain("You’re up to date.")
  await button(view, "Back to app").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
})

test("Web settings expose About without desktop update controls or system permissions", async () => {
  configureClient({ ...host, platform: "web", updates: undefined })
  const view = await mountApp("/settings/preferences")
  expect(view.find('main nav a[href="#/settings/permissions"]').exists()).toBe(false)
  await view.get('main nav a[href="#/settings/about"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-about"))
  await flushPromises()
  expect(view.get("main h1").text()).toBe("About")
  expect(view.get('a[href="https://github.com/yet-another-ai/deskfleet/issues"]').attributes("target")).toBe("_blank")
  expect(view.text()).toContain("VueUse")
  expect(view.text()).toContain("Thank you to all open-source contributors.")
  expect(view.findAll("button").some(item => item.text() === "Check for updates")).toBe(false)
})

test("returning focus to the window refreshes the local machine", async () => {
  const list = vi.mocked(platformClient.catalog.list)
  await mountApp()
  const afterMount = list.mock.calls.length
  window.dispatchEvent(new Event("focus"))
  await flushPromises()
  expect(list.mock.calls.length).toBeGreaterThan(afterMount)
})

test("fixed sidebar and tiled window controls retain their layout behavior", async () => {
  const pinia = createPinia()
  hydrateSession(pinia)
  vi.spyOn(useAgentSessionsStore(pinia), "watchGit").mockResolvedValue(() => {})
  vi.spyOn(useAgentSessionsStore(pinia), "gitStatus").mockResolvedValue({
    sessionId, directories: [{ path: "/worktrees/api/session", repositoryId: "checkout" }],
    repositories: [{ id: "checkout", root: "/worktrees/api/session", branch: "session-branch", head: "abc123", changes: [{ path: "src/index.ts", kind: "unstaged", status: "modified", additions: 12, deletions: 3 }] }],
  })
  // Tab moves rely on Dockview's actual portal ownership; flattening teleports
  // reparents a moved group's menu into its old Vue subtree.
  const wrapper = await mountApp(`/sessions/${sessionId}`, pinia, true)
  const sidebar = () => wrapper.get<HTMLElement>("aside:not([aria-label])")
  const separator = () => wrapper.get<HTMLElement>('[role="separator"][aria-label="Resize sidebar"]')
  expect(sidebar().element.style.width).toBe("260px")
  expect(separator().attributes("aria-valuenow")).toBe("260")
  ;(separator().element as HTMLElement & { setPointerCapture: (id: number) => void }).setPointerCapture = vi.fn()
  await separator().trigger("pointerdown", { clientX: 260, pointerId: 1 })
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 340 }))
  await flushPromises()
  expect(sidebar().element.style.width).toBe("340px")
  expect(separator().attributes("aria-valuenow")).toBe("340")
  expect(window.localStorage.getItem("deskfleet.sidebar-width")).toBe("340")
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 900 }))
  await flushPromises()
  expect(sidebar().element.style.width).toBe("480px")
  window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }))
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 220 }))
  await flushPromises()
  expect(sidebar().element.style.width).toBe("480px")
  await separator().trigger("keydown", { key: "ArrowLeft", shiftKey: true })
  expect(sidebar().element.style.width).toBe("416px")
  expect(window.localStorage.getItem("deskfleet.sidebar-width")).toBe("416")
  expect(sidebar().find('[aria-label="Hide sidebar"]').exists()).toBe(false)
  expect(wrapper.find('.deskfleet-windows [aria-label="Hide sidebar"]').exists()).toBe(true)
  await wrapper.get('[aria-label="Hide sidebar"]').trigger("click")
  expect(wrapper.find('.deskfleet-windows [aria-label="Show sidebar"]').exists()).toBe(true)
  expect(window.localStorage.getItem("deskfleet.sidebar-open")).toBe("false")
  await router.push("/")
  await flushPromises()
  expect(wrapper.find('.deskfleet-windows').exists()).toBe(false)
  await wrapper.get('main [aria-label="Show sidebar"]').trigger("click")
  await router.push(`/sessions/${sessionId}`)
  await flushPromises()
  expect(sidebar().element.style.width).toBe("416px")
  expect(wrapper.find('[aria-label="Close Chat"]').exists()).toBe(false)
  await wrapper.get('[aria-label="Close Changes"]').trigger("click")
  await flushPromises()
  await wrapper.get('[aria-label="Add window"]').trigger("click")
  await flushPromises()
  const menu = new DOMWrapper(document.body)
  expect(menu.get('[data-window-type="changes"]').attributes("data-disabled")).toBeUndefined()
  await menu.get('[data-window-type="changes"]').trigger("click")
  await flushPromises()
  expect(panel(wrapper).attributes("aria-label")).toBe("Changes")
  await wrapper.get('[aria-label="Close Changes"]').trigger("click")
  await flushPromises()
  const changesButton = wrapper.get("button[data-composer-changes]")
  expect(changesButton.text()).toBe("+12 −3")
  await changesButton.trigger("click")
  await flushPromises()
  await wrapper.get('[aria-label="Add window"]').trigger("click")
  await flushPromises()
  expect(menu.get('[data-window-type="changes"]').attributes("data-disabled")).toBeDefined()
})

test("window headers prevent group drags while individual tabs remain draggable", async () => {
  const pinia = createPinia()
  hydrateSession(pinia)
  const wrapper = await mountApp(`/sessions/${sessionId}`, pinia)

  for (const header of wrapper.findAll(".dv-tabs-and-actions-container")) {
    const groupDrag = new Event("dragstart", { bubbles: true, cancelable: true })
    header.get(".dv-void-container").element.dispatchEvent(groupDrag)
    expect(groupDrag.defaultPrevented).toBe(true)

    const tab = header.get<HTMLElement>(".dv-tab")
    const tabDrag = new Event("dragstart", { bubbles: true, cancelable: true })
    expect(tab.element.draggable).toBe(true)
    tab.element.dispatchEvent(tabDrag)
    expect(tabDrag.defaultPrevented).toBe(false)
    await tab.trigger("dragend")
  }
})

test("only a selected Session uses tiled windows and offers new window tabs", async () => {
  const pinia = createPinia()
  hydrateSession(pinia)
  const wrapper = await mountApp("/", pinia)
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
  expect(wrapper.find('[aria-label="Add window"]').exists()).toBe(false)
  await link(wrapper, `Session ${sessionId}`).trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("session"))
  await flushPromises()
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(true)
  await wrapper.get('[aria-label="Add window"]').trigger("click")
  await flushPromises()
  expect(wrapper.find('[data-window-type="terminal"]').exists()).toBe(true)
  expect(wrapper.get('[data-window-type="terminal"]').text()).toBe("New terminal")
  expect(wrapper.get('[data-window-type="terminal"]').attributes("data-disabled")).toBeUndefined()
  await link(wrapper, "New session").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  await flushPromises()
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
  expect(wrapper.find('[aria-label="Add window"]').exists()).toBe(false)
})

test("each Session restores its own tiled window layout", async () => {
  const pinia = createPinia()
  hydrateSession(pinia)
  const wrapper = await mountApp(`/sessions/${sessionId}`, pinia, true)

  async function expectChangesMenuDisabled(disabled: boolean): Promise<void> {
    await wrapper.get('[aria-label="Add window"]').trigger("click")
    await flushPromises()
    expect(new DOMWrapper(document.body).get('[data-window-type="changes"]').attributes("data-disabled") !== undefined).toBe(disabled)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await flushPromises()
  }

  await wrapper.get('[aria-label="Close Changes"]').trigger("click")
  await flushPromises()
  await expectChangesMenuDisabled(false)

  const secondSessionId = "session-layout-2"
  await router.push(`/sessions/${secondSessionId}`)
  await flushPromises()
  await expectChangesMenuDisabled(true)

  await router.push(`/sessions/${sessionId}`)
  await flushPromises()
  await expectChangesMenuDisabled(false)
  expect(window.localStorage.getItem(`deskfleet.window-layout-v4:${sessionId}`)).toBeTruthy()
})

test("the Chat window tab uses the Session title and exposes its location as a tooltip", async () => {
  const pinia = createPinia()
  hydrateSession(pinia, "Initial title")
  const wrapper = await mountApp(`/sessions/${sessionId}`, pinia)
  const chatTab = () => wrapper.get('[data-window-tab-id="chat"]')
  expect(wrapper.find("main header").exists()).toBe(false)
  expect(chatTab().text()).toContain("Initial title")
  vi.useFakeTimers()
  try {
    await chatTab().trigger("pointermove", { pointerType: "mouse" })
    await vi.advanceTimersByTimeAsync(400)
    await flushPromises()
    expect(wrapper.get('[role="tooltip"]').text()).toBe("test-host / storefront")
  } finally {
    vi.useRealTimers()
  }

  useAgentSessionsStore(pinia).sessions[sessionId]!.title = "Renamed title"
  await flushPromises()
  expect(chatTab().text()).toContain("Renamed title")
})

test.each(["/details", `/workspaces/${workspaceId}`])("removed page %s falls back to the composer and Settings returns there", async path => {
  const wrapper = await mountApp(path)
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(wrapper.find('a[href="#/details"]').exists()).toBe(false)
  expect(wrapper.find(".deskfleet-windows").exists()).toBe(false)
  await wrapper.get('[aria-label="Settings"]').trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("settings-preferences"))
  await flushPromises()
  expect(wrapper.find('aside[aria-label="Changes"]').exists()).toBe(false)
  await button(wrapper, "Back to app").trigger("click")
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe("new-session"))
  await flushPromises()
  expect(wrapper.find('aside[aria-label="Changes"]').exists()).toBe(false)
})
