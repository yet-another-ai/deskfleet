import { useWorkspaceAgentMode } from "../../services/workspace-agent-navigation.ts"
import { createHash } from "node:crypto"
import { getClient } from "@deskfleet/client/platform"
import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { reactive, ref } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import { agentElicitation, agentPermission, agentSnapshot } from "../../test/agent.ts"
import type { AgentSessionSummary, MachineSummary } from "../../stores/fleet-types.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { createHiddenWorkspaces, HIDDEN_WORKSPACES_STORAGE_KEY } from "../../composables/useHiddenWorkspaces.ts"
import { machineRuntimesKey, type MachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { createSidebarFilter } from "../../composables/useSidebarFilter.ts"
import { createSidebarOrder } from "../../composables/useSidebarOrder.ts"
import { createSidebarPanel } from "../../composables/useSidebarPanel.ts"
import type { GithubPullRequest } from "@deskfleet/client/central"
import type { SystemStatus } from "@deskfleet/client/system"
import { usePullRequestsStore } from "../../stores/pull-requests.ts"
import { useMachineBatteriesStore } from "../../stores/machine-batteries.ts"
import MachineSection from "./MachineSection.vue"

async function setup(
  machine: Partial<MachineSummary> = {},
  account?: AccountSession,
  pullRequest?: GithubPullRequest,
  superAgent?: SuperAgentApi,
  battery?: NonNullable<SystemStatus["battery"]>,
  runtimes?: MachineRuntimes,
) {
  const pinia = createPinia()
  setActivePinia(pinia)
  if (pullRequest) vi.spyOn(usePullRequestsStore(), "forSession").mockReturnValue([pullRequest])
  if (battery) vi.spyOn(useMachineBatteriesStore(), "forMachine").mockReturnValue(battery)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
      { path: "/workspaces/:workspaceId", name: "workspace", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
      { path: "/projects/new", name: "new-project", component: {} },
      { path: "/terminals/:terminalId", name: "terminal", component: {} },
    ],
  })
  await router.push("/machines/local-daemon/control?tab=files")
  const wrapper = mount(MachineSection, {
    props: { machine: {
      id: "local-daemon", name: "host", local: true, online: true, desktop: false,
      terminals: [{ id: "shell", title: "Machine shell", cwd: "/home/user" }], sessions: [], workspaces: [], ...machine,
    } },
    global: { plugins: [pinia, router, i18n], provide: {
      ...(account && { [accountSessionKey as symbol]: account }),
      ...(runtimes && { [machineRuntimesKey as symbol]: runtimes }),
      ...(superAgent && { [platformClientKey as symbol]: { ...getClient(), superAgent } }),
    } },
  })
  return { wrapper, router }
}

test("shows battery charge and state in the machine header", async () => {
  const { wrapper } = await setup({}, undefined, undefined, undefined, { percent: 68.4, state: "charging" })
  const indicator = wrapper.get("[data-machine-battery]")
  expect(indicator.attributes("aria-label")).toBe("Battery 68%, Charging")
  wrapper.unmount()
})

test("hides a stale battery indicator when the machine is offline", async () => {
  const { wrapper } = await setup({ online: false }, undefined, undefined, undefined, { percent: 68.4, state: "charging" })
  expect(wrapper.find("[data-machine-battery]").exists()).toBe(false)
  wrapper.unmount()
})

test.each([
  { local: true, desktop: true, expected: "Local control" },
  { local: true, desktop: false, expected: "Local control" },
  { local: false, desktop: true, expected: "Remote control" },
  { local: false, desktop: false, expected: "Remote control" },
])("machine header folds cleanly and renders a single control entry (local=$local, desktop=$desktop)", async ({ local, desktop, expected }) => {
  const { wrapper, router } = await setup({ local, desktop })
  const links = wrapper.findAll("a")
  expect(links).toHaveLength(1)
  expect(links[0]!.text()).toBe(expected)
  expect(wrapper.text().includes("This machine")).toBe(local)
  expect(links[0]!.attributes("href")).toBe("/machines/local-daemon/control")
  expect(links[0]!.attributes("aria-current")).toBe("page")
  expect(wrapper.find('[title="New terminal"]').exists()).toBe(false)
  await router.push("/machines/local-daemon/control?tab=terminal&terminal=shell")
  expect(links[0]!.attributes("aria-current")).toBe("page")
  wrapper.unmount()
})

test("new session buttons select their workspace, including from the creation page", async () => {
  const { wrapper, router } = await setup({
    workspaces: ["first", "second"].map(id => ({ id, name: id, directories: [{ path: `/${id}` }], sessions: [], terminals: [] })),
  })
  const fleet = useFleetStore()
  const folder = wrapper.get('button[aria-label="first"]')
  await folder.trigger("click")
  const buttons = wrapper.findAll('button[aria-label="New session"]')
  await buttons[0]!.trigger("click")
  await flushPromises()
  expect(fleet.targetWorkspaceId).toBe("first")
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(folder.attributes("aria-expanded")).toBe("false")
  await buttons[1]!.trigger("click")
  await flushPromises()
  expect(fleet.targetWorkspaceId).toBe("second")
  expect(router.currentRoute.value.name).toBe("new-session")
  wrapper.unmount()
})

test("workspace folders fold their terminals and sessions without navigating", async () => {
  const { wrapper, router } = await setup({
    desktop: true,
    workspaces: [{
      id: "workspace", name: "Project", directories: [{ path: "/project" }],
      terminals: [{ id: "workspace-shell", title: "Workspace shell", cwd: "/project" }],
      sessions: [{ id: "session", title: "Implement feature", provider: "Codex", archiveState: "active" }],
    }],
  })
  expect(wrapper.findAll("a").map(link => [link.text().trim(), link.attributes("href")])).toEqual([
    ["Local control", "/machines/local-daemon/control"],
    ["Workspace shell", "/terminals/workspace-shell"],
    ["Implement feature", "/sessions/session"],
  ])
  const folder = wrapper.get('button[aria-label="Project"]')
  const path = router.currentRoute.value.fullPath
  expect(folder.attributes("aria-expanded")).toBe("true")
  await folder.trigger("click")
  expect(folder.attributes("aria-expanded")).toBe("false")
  expect(wrapper.find('a[href="/sessions/session"]').exists()).toBe(false)
  expect(wrapper.find('a[href="/terminals/workspace-shell"]').exists()).toBe(false)
  expect(router.currentRoute.value.fullPath).toBe(path)
  await folder.trigger("click")
  expect(folder.attributes("aria-expanded")).toBe("true")
  expect(wrapper.get('a[href="/sessions/session"]').text()).toBe("Implement feature")
  expect(wrapper.get('a[href="/terminals/workspace-shell"]').text()).toBe("Workspace shell")
  expect(wrapper.text()).not.toContain("Machine shell")
  wrapper.unmount()
})

test("opening a workspace terminal uses its first directory and leaves the folder collapsed", async () => {
  const { wrapper, router } = await setup({
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }, { path: "/another" }], terminals: [], sessions: [] }],
  })
  const terminal = { id: "workspace-shell", title: "Project shell", cwd: "/project", cols: 80, rows: 24, status: "running" as const }
  let finish!: (value: typeof terminal) => void
  const create = vi.spyOn(useTerminalsStore(), "create").mockReturnValue(new Promise(resolve => { finish = resolve }))
  const folder = wrapper.get('button[aria-label="Project"]')
  await folder.trigger("click")
  const button = wrapper.get('button[aria-label="Open terminal in default directory"]')
  await button.trigger("click")
  expect(create).toHaveBeenCalledExactlyOnceWith({ cwd: "/project" })
  expect(button.attributes("aria-disabled")).toBe("true")
  await button.trigger("click")
  expect(create).toHaveBeenCalledOnce()
  finish(terminal)
  await flushPromises()
  expect(router.currentRoute.value.name).toBe("terminal")
  expect(router.currentRoute.value.params.terminalId).toBe(terminal.id)
  expect(folder.attributes("aria-expanded")).toBe("false")
  expect(button.attributes("aria-disabled")).toBeUndefined()
  wrapper.unmount()
})

test("workspace terminal failures stay visible and allow retry", async () => {
  const { wrapper, router } = await setup({
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions: [] }],
  })
  const create = vi.spyOn(useTerminalsStore(), "create").mockRejectedValueOnce(new Error("Directory unavailable")).mockResolvedValue({
    id: "shell", title: "shell", cwd: "/project", cols: 80, rows: 24, status: "running",
  })
  const button = wrapper.get('button[aria-label="Open terminal in default directory"]')
  await button.trigger("click"); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toBe("Directory unavailable")
  expect(router.currentRoute.value.name).toBe("machine-control")
  await button.trigger("click"); await flushPromises()
  expect(create).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(router.currentRoute.value.name).toBe("terminal")
  wrapper.unmount()
})

test("an offline workspace cannot open a terminal", async () => {
  const { wrapper } = await setup({
    online: false,
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions: [] }],
  })
  const create = vi.spyOn(useTerminalsStore(), "create")
  const button = wrapper.get('button[aria-label="Open terminal in default directory"]')
  expect(button.attributes("aria-disabled")).toBe("true")
  await button.trigger("click")
  expect(create).not.toHaveBeenCalled()
  wrapper.unmount()
})

test("a workspace terminal on another machine opens that machine's terminal route", async () => {
  const openMachineRoute = vi.fn()
  const account = {
    account: ref({ serverUrl: "https://example.invalid", user: undefined }),
    teamId: ref<string | null>(null),
    machines: ref([]),
    central: { session: vi.fn(), onEvent: () => () => {} },
    machineId: ref("selected-machine"),
    localMachineId: ref("local-daemon"),
    openMachineRoute,
  } as unknown as AccountSession
  const { wrapper, router } = await setup({
    id: "remote-machine", local: false,
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/remote/project" }], terminals: [], sessions: [] }],
  }, account)
  const create = vi.spyOn(useTerminalsStore(), "create").mockResolvedValue({
    id: "remote-shell", title: "shell", cwd: "/remote/project", cols: 80, rows: 24, status: "running",
  })
  await wrapper.get('button[aria-label="Open terminal in default directory"]').trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledExactlyOnceWith({ cwd: "/remote/project" })
  expect(openMachineRoute).toHaveBeenCalledExactlyOnceWith("remote-machine", { name: "terminal", params: { terminalId: "remote-shell" } })
  expect(router.currentRoute.value.name).toBe("machine-control")
  wrapper.unmount()
})

function markWorking(sessionId: string, extras: Partial<ReturnType<typeof agentSnapshot>> = {}) {
  const live = agentSnapshot()
  live.session.id = sessionId
  live.turns = [{ id: "70", sessionId, initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: "now" }]
  Object.assign(live, extras)
  useAgentSessionsStore().views[sessionId] = { snapshot: live, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }
  return live
}

test("session rows distinguish working, permission, and question indicators", async () => {
  const { wrapper } = await setup({
    sessions: [{ id: "machine-session", title: "Machine chat", provider: "Codex", archiveState: "active" }],
    workspaces: [{
      id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [],
      sessions: [{ id: "workspace-session", title: "Implement feature", provider: "Codex", archiveState: "active" }],
    }],
  })
  expect(wrapper.findAll("[data-session-working]")).toHaveLength(0)
  const agents = useAgentSessionsStore()
  const live = markWorking("workspace-session")
  await flushPromises()
  const working = wrapper.findAll("[data-session-working]")
  expect(working).toHaveLength(1)
  expect(working[0]!.attributes("role")).toBe("status")
  expect(working[0]!.attributes("data-session-working")).toBe("working")
  expect(working[0]!.get("svg").classes()).toContain("animate-spin")
  expect(working[0]!.text()).toContain("Working")
  expect(wrapper.get('a[href="/sessions/workspace-session"]').find("[data-session-working]").exists()).toBe(true)
  expect(wrapper.find('a[href="/sessions/machine-session"] [data-session-working]').exists()).toBe(false)

  agents.views["workspace-session"]!.snapshot = { ...live, elicitations: [agentElicitation({ sessionId: "workspace-session", state: "pending" })] }
  await flushPromises()
  expect(wrapper.get('[data-session-working="question"]').classes()).toContain("text-ui-text-muted")
  expect(wrapper.get('[data-session-working="question"] svg').classes()).toContain("animate-bounce")

  agents.views["workspace-session"]!.snapshot = { ...live, permissions: [agentPermission({ sessionId: "workspace-session", state: "pending" })], elicitations: [agentElicitation({ sessionId: "workspace-session", state: "pending" })] }
  await flushPromises()
  expect(wrapper.get('[data-session-working="permission"]').classes()).toContain("text-ui-warning")
  expect(wrapper.get('[data-session-working="permission"] svg').classes()).toContain("animate-bounce")

  agents.views["workspace-session"]!.snapshot = { ...live, turns: [{ ...live.turns[0]!, state: "completed", endedAt: "now" }] }
  await flushPromises()
  expect(wrapper.findAll("[data-session-working]")).toHaveLength(0)
  wrapper.unmount()
})

test("collapsed workspace rows bubble a descendant working indicator", async () => {
  const { wrapper } = await setup({
    workspaces: [{
      id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [],
      sessions: [{ id: "workspace-session", title: "Implement feature", provider: "Codex", archiveState: "active" }],
    }],
  })
  const folder = wrapper.get('button[aria-label="Project"]')
  markWorking("workspace-session")
  await flushPromises()
  expect(wrapper.get('a[href="/sessions/workspace-session"] [data-session-working]').attributes("data-session-working")).toBe("working")
  expect(folder.find("[data-session-working]").exists()).toBe(false)

  await folder.trigger("click")
  expect(folder.attributes("aria-expanded")).toBe("false")
  expect(wrapper.find('a[href="/sessions/workspace-session"]').exists()).toBe(false)
  expect(folder.get("[data-session-working]").attributes("data-session-working")).toBe("working")
  expect(wrapper.findAll("[data-session-working]")).toHaveLength(1)

  await folder.trigger("click")
  expect(folder.attributes("aria-expanded")).toBe("true")
  expect(folder.find("[data-session-working]").exists()).toBe(false)
  expect(wrapper.get('a[href="/sessions/workspace-session"] [data-session-working]').attributes("data-session-working")).toBe("working")
  wrapper.unmount()
})

test("collapsed machine rows bubble the highest-priority descendant working indicator", async () => {
  const { wrapper } = await setup({
    sessions: [{ id: "machine-session", title: "Machine chat", provider: "Codex", archiveState: "active" }],
    workspaces: [{
      id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [],
      sessions: [
        { id: "working-session", title: "Working chat", provider: "Codex", archiveState: "active" },
        { id: "permission-session", title: "Permission chat", provider: "Codex", archiveState: "active" },
      ],
    }],
  })
  const machine = wrapper.get('[data-machine-id="local-daemon"]')
  const trigger = machine.get("button")
  markWorking("machine-session")
  markWorking("working-session")
  markWorking("permission-session", { permissions: [agentPermission({ sessionId: "permission-session", state: "pending" })] })
  await flushPromises()
  expect(wrapper.get('a[href="/sessions/machine-session"]').find("[data-session-working]").exists()).toBe(true)
  expect(wrapper.get('a[href="/sessions/working-session"] [data-session-working]').attributes("data-session-working")).toBe("working")
  expect(wrapper.get('a[href="/sessions/permission-session"] [data-session-working]').attributes("data-session-working")).toBe("permission")
  expect(trigger.find("[data-session-working]").exists()).toBe(false)

  await trigger.trigger("click")
  expect(machine.attributes("data-state")).toBe("closed")
  expect(wrapper.find('a[href^="/sessions/"]').exists()).toBe(false)
  expect(trigger.get("[data-session-working]").attributes("data-session-working")).toBe("permission")
  expect(wrapper.findAll("[data-session-working]")).toHaveLength(1)

  await trigger.trigger("click")
  expect(machine.attributes("data-state")).toBe("open")
  expect(trigger.find("[data-session-working]").exists()).toBe(false)
  expect(wrapper.get('a[href="/sessions/machine-session"]').find("[data-session-working]").exists()).toBe(true)
  expect(wrapper.get('a[href="/sessions/working-session"]').find("[data-session-working]").exists()).toBe(true)
  expect(wrapper.get('a[href="/sessions/permission-session"]').find('[data-session-working="permission"]').exists()).toBe(true)
  wrapper.unmount()
})

test.each(["machine", "workspace"])("%s session rows show unread results after working and clear on shared read updates", async scope => {
  const sessions = reactive<AgentSessionSummary[]>([
    { id: "session", title: "Investigate", provider: "Codex", archiveState: "active", lastCompletedSeq: "6", lastReadSeq: "5" },
  ])
  const { wrapper } = await setup(scope === "machine" ? { sessions } : {
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions }],
  })
  const indicator = wrapper.get("[data-session-unread]")
  expect(indicator.attributes("role")).toBe("status")
  expect(indicator.attributes("title")).toBe("Unread result")
  expect(indicator.text()).toBe("Unread result")

  const agents = useAgentSessionsStore()
  const live = agentSnapshot()
  live.session.id = "session"
  live.turns = [{ id: "70", sessionId: "session", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: "now" }]
  agents.views["session"] = { snapshot: live, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }
  await flushPromises()
  expect(wrapper.find("[data-session-working]").exists()).toBe(true)
  expect(wrapper.find("[data-session-unread]").exists()).toBe(false)

  agents.views["session"]!.snapshot!.turns[0]!.state = "completed"
  sessions[0]!.lastCompletedSeq = "9"
  await flushPromises()
  expect(wrapper.find("[data-session-working]").exists()).toBe(false)
  expect(wrapper.find("[data-session-unread]").exists()).toBe(true)
  sessions[0]!.lastReadSeq = "9"
  await flushPromises()
  expect(wrapper.find("[data-session-unread]").exists()).toBe(false)
  wrapper.unmount()
})

test.each(["machine", "workspace"])("%s session PR status stays beside unread and working indicators", async scope => {
  const sessions: AgentSessionSummary[] = [{ id: "session", title: "Add feature", provider: "Codex", archiveState: "active", lastCompletedSeq: "6", lastReadSeq: "5" }]
  const { wrapper } = await setup(scope === "machine" ? { sessions } : {
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions }],
  }, undefined, { number: 78, title: "Add feature", url: "https://github.com/acme/app/pull/78", state: "open" })
  const row = wrapper.get('a[href="/sessions/session"]')
  expect(row.get("[data-pull-request]").attributes("title")).toBe("PR #78 · Open · Add feature")
  expect(row.find("[data-session-unread]").exists()).toBe(true)
  const live = agentSnapshot()
  live.turns = [{ id: "70", sessionId: "session", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: "now" }]
  useAgentSessionsStore().views["session"] = { snapshot: live, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }
  await flushPromises()
  expect(row.find("[data-session-working]").exists()).toBe(true)
  expect(row.find("[data-session-unread]").exists()).toBe(false)
  expect(row.find("[data-pull-request]").exists()).toBe(true)
  expect(row.find("button, a").exists()).toBe(false)
  wrapper.unmount()
})

test.each(["machine", "workspace"])("%s session rows hide completed archives and reappear after restore", async scope => {
  const sessions = reactive<AgentSessionSummary[]>([
    { id: "active", title: "Active chat", archiveState: "active" },
    { id: "archiving", title: "Closing chat", archiveState: "archiving" },
    { id: "archived", title: "Archived chat", archiveState: "archived" },
    { id: "pending" },
  ])
  const { wrapper, router } = await setup(scope === "machine" ? { sessions } : {
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions }],
  })
  const visibleIds = () => wrapper.findAll('a[href^="/sessions/"]').map(link => link.attributes("href"))
  expect(visibleIds()).toEqual(["/sessions/active", "/sessions/archiving"])
  expect(wrapper.find('button[aria-label="Retry archive"]').exists()).toBe(true)
  const archivingIndicator = wrapper.get('a[href="/sessions/archiving"] [data-session-working="archiving"]')
  expect(archivingIndicator.attributes("title")).toContain("Archiving this session.")
  expect(archivingIndicator.get("svg").classes()).toContain("animate-pulse")

  await router.push("/sessions/archived"); await flushPromises()
  expect(wrapper.find('a[href="/sessions/archived"]').exists()).toBe(false)
  sessions[0]!.archiveState = "archived"
  await flushPromises()
  expect(visibleIds()).toEqual(["/sessions/archiving"])
  sessions[2]!.archiveState = "active"
  await flushPromises()
  expect(visibleIds()).toEqual(["/sessions/archiving", "/sessions/archived"])
  wrapper.unmount()
})

test.each([
  { scope: "machine", online: true },
  { scope: "workspace", online: true },
  { scope: "machine", online: false },
  { scope: "workspace", online: false },
])("$scope session rows wait for archive metadata while online=$online", async ({ scope, online }) => {
  const sessions = reactive<AgentSessionSummary[]>([
    { id: "old-chat" },
    { id: "new-chat" },
  ])
  const { wrapper } = await setup(scope === "machine" ? { sessions, online } : {
    online,
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions }],
  })
  const visibleIds = () => wrapper.findAll('a[href^="/sessions/"]').map(link => link.attributes("href"))
  expect(visibleIds()).toEqual([])
  Object.assign(sessions[0]!, { title: "Archived chat", provider: "Codex", archiveState: "archived" })
  Object.assign(sessions[1]!, { title: "New chat", provider: "Codex", archiveState: "active" })
  await flushPromises()
  expect(visibleIds()).toEqual(["/sessions/new-chat"])
  expect(wrapper.get('a[href="/sessions/new-chat"]').text()).toBe("New chat")
  // An active Session can be visible before its execution context is provisioned.
  expect(sessions[1]!.worktree).toBeUndefined()
  wrapper.unmount()
})

test("a machine containing only archived sessions shows its empty state", async () => {
  const { wrapper } = await setup({ sessions: [{ id: "archived", title: "Archived chat", archiveState: "archived" }] })
  expect(wrapper.text()).toContain("No workspaces")
  expect(wrapper.find('a[href="/sessions/archived"]').exists()).toBe(false)
  wrapper.unmount()
})

test("workspace row context menu edits and deletes without expanding or collapsing", async () => {
  const { wrapper } = await setup({
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions: [] }],
  })
  const fleet = useFleetStore()
  fleet.localDesktopTarget = { id: "local-daemon", name: "host", online: true, desktop: false }
  fleet.catalogReady = true
  const update = vi.spyOn(fleet, "updateWorkspace").mockResolvedValue()
  const remove = vi.spyOn(fleet, "deleteWorkspace").mockResolvedValue()
  const page = new DOMWrapper(document.body)
  const folder = wrapper.get('button[aria-label="Project"]')
  expect(folder.attributes("aria-expanded")).toBe("true")

  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 80 })
  folder.element.dispatchEvent(event)
  await flushPromises()
  expect(event.defaultPrevented).toBe(true)
  expect(folder.attributes("aria-expanded")).toBe("true")
  expect(page.findAll('[role="menuitem"]').map(item => item.text())).toEqual(["Edit workspace", "Hide workspace", "Delete workspace"])

  await page.findAll('[role="menuitem"]').find(item => item.text() === "Edit workspace")!.trigger("click")
  await flushPromises()
  await page.get('[role="dialog"] input[name="workspace-name"]').setValue("Renamed")
  await page.get('[role="dialog"] form').trigger("submit")
  await flushPromises()
  expect(update).toHaveBeenCalledExactlyOnceWith("workspace", "Renamed", [{ path: "/project" }])
  expect(page.find('[role="dialog"]').exists()).toBe(false)
  expect(folder.attributes("aria-expanded")).toBe("true")

  folder.element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 80 }))
  await flushPromises()
  await page.findAll('[role="menuitem"]').find(item => item.text() === "Delete workspace")!.trigger("click")
  await flushPromises()
  expect(page.get('[role="dialog"]').text()).toContain("Project")
  await page.get('[role="dialog"] .ui-button-danger').trigger("click")
  await flushPromises()
  expect(remove).toHaveBeenCalledExactlyOnceWith("workspace")
  expect(page.find('[role="dialog"]').exists()).toBe(false)
  wrapper.unmount()
})

test.each(["machine", "workspace"] as const)("%s hover Archive confirms before acting and closes the dialog while archiving proceeds", async scope => {
  const sessions: AgentSessionSummary[] = [{ id: "30", title: "Active chat", context: scope === "machine" ? "directory" : "worktree", archiveState: "active" }]
  const { wrapper, router } = await setup(scope === "machine" ? { sessions } : {
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions }],
  })
  let finishArchive!: () => void
  const archive = vi.spyOn(useAgentSessionsStore(), "archive").mockImplementation(() => new Promise<void>(resolve => { finishArchive = resolve }))
  const page = new DOMWrapper(document.body)
  const button = wrapper.get('button[aria-label="Archive session"]')
  const confirmSelector = scope === "machine" ? ".ui-button-primary" : ".ui-button-danger"
  await button.trigger("click"); await flushPromises()
  expect(archive).not.toHaveBeenCalled()
  expect(page.get('[role="dialog"]').text()).toContain(scope === "machine" ? "working directory, and files will be retained" : "including its local changes protection")
  await page.get('[role="dialog"]').trigger("keydown", { key: "Escape" }); await flushPromises()
  expect(archive).not.toHaveBeenCalled()
  await button.trigger("click"); await flushPromises()
  await page.get(`[role="dialog"] ${confirmSelector}`).trigger("click"); await flushPromises()
  expect(archive).toHaveBeenCalledExactlyOnceWith("30")
  expect(page.find('[role="dialog"]').exists()).toBe(false)
  expect(router.currentRoute.value.name).toBe("machine-control")
  finishArchive()
  await flushPromises()
  wrapper.unmount()
})

test("local workspace agents separate opening the project from expanding existing Sessions", async () => {
  useWorkspaceAgentMode().value = true
  const project = {
    id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [{ id: "workspace-shell", title: "Task shell", cwd: "/project" }],
    sessions: [{ id: "old", title: "Existing Session", archiveState: "active" as const, provider: "codex" }],
  }
  const { wrapper, router } = await setup({ workspaces: [
    project, { ...project, id: "private", name: "Private backing directory", directories: [{ path: `/data/super-agent-files/${"a".repeat(64)}` }] },
  ] }, undefined, undefined, { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() })
  expect(wrapper.text()).not.toContain("Private backing directory")
  expect(wrapper.find('a[title="Local control"]').exists()).toBe(true)
  const projectRow = wrapper.get("[data-project-workspace=workspace]")
  expect(projectRow.get("[data-open-project]").text()).toBe("Project")
  expect(projectRow.findAll("button").at(0)?.element).toBe(projectRow.get("[data-open-project]").element)
  const toggle = wrapper.get('button[aria-label="Sessions in Project"]')
  expect(toggle.attributes("aria-expanded")).toBe("false")
  expect(wrapper.find('a[href="/sessions/old?superFrom=workspace&superMachine=local-daemon"]').exists()).toBe(false)
  await wrapper.findAll("button").find(button => button.text() === "Project")!.trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe("/workspaces/workspace/agent?machine=local-daemon")
  expect(toggle.attributes("aria-expanded")).toBe("false")
  await toggle.trigger("click")
  expect(wrapper.get('a[href="/sessions/old?superFrom=workspace&superMachine=local-daemon"]').text()).toBe("Existing Session")
  expect(router.currentRoute.value.fullPath).toBe("/workspaces/workspace/agent?machine=local-daemon")
  expect(wrapper.find('button[aria-label="New session"]').exists()).toBe(false)
  expect(projectRow.get('a[href="/terminals/workspace-shell"]').text()).toBe("Task shell")
  const create = vi.spyOn(useTerminalsStore(), "create").mockResolvedValue({
    id: "new-shell", title: "shell", cwd: "/project", cols: 80, rows: 24, status: "running",
  })
  await projectRow.get('button[aria-label="Open terminal in default directory"]').trigger("click")
  await flushPromises()
  expect(create).toHaveBeenCalledExactlyOnceWith({ cwd: "/project" })
  expect(router.currentRoute.value.fullPath).toBe("/terminals/new-shell")
  expect(toggle.attributes("aria-expanded")).toBe("true")
  wrapper.unmount()
})

test("Copy ID uses the clicked project Worker's registration and leaves unassigned sessions out", async () => {
  useWorkspaceAgentMode().value = true
  const machineId = "second-machine"
  const account = createAccountSession(fakeCentral({ machines: [
    machineFixture("first-machine", "team-1", "Mac"),
    machineFixture(machineId, "team-1", "PC"),
  ] }).central)
  await flushPromises()
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("Denied")).mockResolvedValue()
  const session: AgentSessionSummary = { id: "42", title: "Review", context: "directory", archiveState: "active" }
  const { wrapper, router } = await setup({ id: machineId, local: false, online: false,
    sessions: [{ ...session, id: "43" }],
    workspaces: [{ id: "17", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions: [session] }],
  }, account, undefined, { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() })
  try {
    const page = new DOMWrapper(document.body)
    const route = router.currentRoute.value.fullPath
    await wrapper.get('button[aria-label="Sessions in Project"]').trigger("click")
    const row = wrapper.get('a[href^="/sessions/42"]')
    await row.trigger("contextmenu", { button: 2 })
    await flushPromises()
    await page.get("[data-session-action=copy-id]").trigger("click")
    await flushPromises()
    expect(wrapper.get("[data-worker-id-feedback]").attributes("role")).toBe("alert")
    expect(page.find('[role="menu"]').exists()).toBe(false)
    await row.trigger("contextmenu", { button: 2 })
    await flushPromises()
    await page.get("[data-session-action=copy-id]").trigger("click")
    await flushPromises()
    expect(copy).toHaveBeenCalledTimes(2)
    expect(copy).toHaveBeenLastCalledWith("@worker[team-1/second-machine/42]")
    expect(wrapper.get("[data-worker-id-feedback]").text()).toBe("Worker ID copied")
    expect(router.currentRoute.value.fullPath).toBe(route)

    await wrapper.get("[data-unassigned-sessions]").trigger("click")
    await wrapper.get('a[href^="/sessions/43"]').trigger("contextmenu", { button: 2 })
    await flushPromises()
    expect(page.get('[role="menu"]').find("[data-session-action=copy-id]").exists()).toBe(false)
  } finally {
    wrapper.unmount()
    account.dispose()
    copy.mockRestore()
  }
})

test("projects sharing a name and folder show a distinct ID on each project row", async () => {
  useWorkspaceAgentMode().value = true
  const example = { name: "A", directories: [{ path: "/code/A" }], sessions: [], terminals: [] }
  const { wrapper, router } = await setup({ workspaces: [{ ...example, id: "20" }, { ...example, id: "21" }] }, undefined, undefined, { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() })
  for (const id of ["20", "21"]) {
    const row = wrapper.get(`[data-project-workspace="${id}"]`)
    const link = row.get("[data-open-project]")
    expect(link.attributes("title")).toBe("/code/A")
    expect(link.text()).toContain(`#${id}`)
    expect(row.get(`button[aria-label="Sessions in A #${id}"]`).attributes("aria-expanded")).toBe("false")
    await link.trigger("click")
    await flushPromises()
    expect(router.currentRoute.value.params.workspaceId).toBe(id)
  }
  wrapper.unmount()
})

test("remote project actions and unassigned history stay scoped to the machine even with equal project IDs elsewhere", async () => {
  useWorkspaceAgentMode().value = true
  const account = createAccountSession(fakeCentral({ machines: [machineFixture("mac", "team-1", "Mac"), machineFixture("pc", "team-1", "Windows PC")] }).central)
  await flushPromises()
  vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  const row = { id: "17", name: "demo", directories: [{ path: "C:\\demo" }], terminals: [], sessions: [] }
  const { wrapper } = await setup({
    id: "pc", local: false, sessions: [{ id: "loose", title: "Standalone conversation", archiveState: "active" }], workspaces: [row],
  }, account, undefined, { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() })
  const machineToggle = wrapper.get("button[aria-expanded]")
  await machineToggle.trigger("click")
  expect(machineToggle.attributes("aria-expanded")).toBe("false")
  const header = new DOMWrapper(machineToggle.element.parentElement!)
  const createProject = header.get("[data-new-project]")
  expect(wrapper.findAll("[data-new-project]")).toHaveLength(1)
  expect(createProject.text()).toBe("")
  expect(createProject.attributes("aria-label")).toBe("New project")
  expect(createProject.attributes("title")).toBe("New project")
  const headerActions = header.findAll("button, a").map(item => item.element)
  const control = header.get('a[title="Remote control"]').element
  expect(headerActions[headerActions.indexOf(control) - 1]).toBe(createProject.element)
  await createProject.trigger("click")
  expect(account.openMachineRoute).toHaveBeenLastCalledWith("pc", { name: "new-project", query: { machine: "pc", team: "team-1" } })
  expect(machineToggle.attributes("aria-expanded")).toBe("false")
  await machineToggle.trigger("click")
  await wrapper.get("[data-open-project]").trigger("click")
  expect(account.openMachineRoute).toHaveBeenLastCalledWith("pc", { name: "workspace-agent", params: { workspaceId: "17" }, query: { machine: "pc", team: "team-1" } })
  expect(wrapper.text()).not.toContain("Standalone conversation")
  await wrapper.get("[data-unassigned-sessions]").trigger("click")
  expect(wrapper.get('a[href^="/sessions/loose"]').attributes("href")).toContain("superMachine=pc")
  expect(wrapper.get("[data-project-workspace]").text()).not.toContain("Standalone conversation")
  await wrapper.setProps({ machine: { ...wrapper.props("machine"), online: false } })
  vi.mocked(account.openMachineRoute).mockClear()
  expect(createProject.element.matches(":disabled, [aria-disabled=true]")).toBe(true)
  await createProject.trigger("click")
  expect(account.openMachineRoute).not.toHaveBeenCalled()
  wrapper.unmount()
  account.dispose()
})

test("the default workspace opens independently of its trailing Worker disclosure", async () => {
  useWorkspaceAgentMode().value = true
  const account = createAccountSession(fakeCentral().central)
  await flushPromises()
  const navigate = vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  const owner = createHash("sha256").update(account.account.value.user!.id).digest("hex")
  const { wrapper } = await setup({ workspaces: [{
    id: "private", name: "Private files", directories: [{ path: `/data/super-agent-files/${owner}` }], terminals: [],
    sessions: [{ id: "worker", title: "Default worker", archiveState: "active" }],
  }] }, account, undefined, { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() })
  try {
    const row = wrapper.get("[data-default-workspace]")
    await vi.waitFor(() => expect(row.find('button[aria-label="Sessions in Default workspace"]').exists()).toBe(true))
    const [open, toggle] = row.findAll("button")
    expect(open!.text()).toBe("Default workspace")
    expect(toggle!.attributes("aria-expanded")).toBe("false")
    await open!.trigger("click")
    expect(navigate).toHaveBeenCalledExactlyOnceWith("local-daemon", { name: "new-session", query: { machine: "local-daemon", team: "team-1" } })
    expect(toggle!.attributes("aria-expanded")).toBe("false")
    await toggle!.trigger("click")
    expect(row.get('a[href^="/sessions/worker"]').text()).toBe("Default worker")
    expect(navigate).toHaveBeenCalledTimes(1)
  } finally {
    wrapper.unmount()
    account.dispose()
  }
})

test("project sidebar supports hide -> reopen persistence -> machine reveal -> unhide round-trip without stopping tasks or deleting data", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  useWorkspaceAgentMode().value = true
  const superAgent: SuperAgentApi = { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() }
  const workspaces = [
    {
      id: "ws-alpha", name: "alpha", directories: [{ path: "/code/alpha" }], terminals: [],
      sessions: [{ id: "running-1", title: "Running task", provider: "Codex", context: "directory" as const, archiveState: "active" as const }],
    },
    { id: "ws-beta", name: "beta", directories: [{ path: "/code/beta" }], terminals: [], sessions: [] },
    { id: "ws-gamma", name: "gamma", directories: [{ path: "/code/gamma" }], terminals: [], sessions: [] },
  ]
  const page = new DOMWrapper(document.body)
  const clickMenu = async (label: string) => {
    const item = page.findAll('[role="menuitem"]').find(entry => entry.text() === label)
    expect(item, `menu item "${label}" should exist`).toBeDefined()
    await item!.trigger("click")
    await flushPromises()
  }

  // First mount: hide alpha and beta; verify live task and catalog stay untouched.
  const first = await setup({ id: "mac-mini", name: "dev-host.local", workspaces }, undefined, undefined, superAgent)
  const fleet = useFleetStore()
  const agents = useAgentSessionsStore()
  const deleteWorkspace = vi.spyOn(fleet, "deleteWorkspace")
  const updateWorkspace = vi.spyOn(fleet, "updateWorkspace")
  const archiveSession = vi.spyOn(agents, "archive")
  const removeSession = vi.spyOn(agents, "remove")
  markWorking("running-1")
  await flushPromises()

  // Right-click machine before anything is hidden: "显示隐藏工作区" is disabled.
  const firstMachineHeader = first.wrapper.get('[data-machine-id="mac-mini"] button')
  firstMachineHeader.element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }))
  await flushPromises()
  expect(page.get('[data-machine-action="toggle-hidden-workspaces"]').text()).toBe("显示隐藏工作区")
  expect(page.get('[data-machine-action="toggle-hidden-workspaces"]').attributes("data-disabled")).toBeDefined()
  await page.get('[role="menu"]').trigger("keydown", { key: "Escape" })
  await flushPromises()

  // Hide alpha and beta via workspace context menu.
  first.wrapper.get('[data-project-workspace="ws-alpha"] [data-open-project]').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 60 }))
  await flushPromises()
  await clickMenu("隐藏工作区")

  first.wrapper.get('[data-project-workspace="ws-beta"] [data-open-project]').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 80 }))
  await flushPromises()
  await clickMenu("隐藏工作区")

  expect(first.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["ws-gamma"])
  expect(deleteWorkspace).not.toHaveBeenCalled()
  expect(updateWorkspace).not.toHaveBeenCalled()
  expect(archiveSession).not.toHaveBeenCalled()
  expect(removeSession).not.toHaveBeenCalled()
  expect(agents.isWorking("running-1")).toBe("working")
  first.wrapper.unmount()

  // Reopen app (fresh Pinia + component): alpha and beta remain hidden even if renamed, because stable IDs are persisted.
  const reopened = await setup({
    id: "mac-mini",
    name: "dev-host-renamed.local",
    workspaces: [
      { ...workspaces[0]!, name: "alpha-renamed" },
      workspaces[1]!,
      workspaces[2]!,
    ],
  }, undefined, undefined, superAgent)
  expect(reopened.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["ws-gamma"])

  // Right-click machine row -> "显示隐藏工作区": reveals hidden entries with distinct markers without unhiding them.
  const machineHeader = reopened.wrapper.get('[data-machine-id="mac-mini"] button')
  const machineEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 24, clientY: 32 })
  machineHeader.element.dispatchEvent(machineEvent)
  await flushPromises()
  expect(machineEvent.defaultPrevented).toBe(true)
  await clickMenu("显示隐藏工作区")

  expect(reopened.wrapper.find("[data-hidden-workspaces-header]").text()).toContain("已隐藏工作区")
  expect(reopened.wrapper.findAll('[data-project-workspace]:not([data-workspace-hidden])').map(row => row.attributes("data-project-workspace"))).toEqual(["ws-gamma"])
  const hiddenRows = reopened.wrapper.findAll('[data-project-workspace][data-workspace-hidden="true"]')
  expect(hiddenRows.map(row => row.attributes("data-project-workspace"))).toEqual(["ws-alpha", "ws-beta"])
  for (const row of hiddenRows) {
    expect(row.get("[data-workspace-hidden-badge]").text()).toBe("已隐藏")
  }

  // Clicking/viewing a hidden workspace does NOT unhide it.
  await reopened.wrapper.get('[data-project-workspace="ws-alpha"] [data-open-project]').trigger("click")
  await flushPromises()
  expect(reopened.router.currentRoute.value.fullPath).toBe("/workspaces/ws-alpha/agent?machine=mac-mini")
  expect(reopened.wrapper.get('[data-project-workspace="ws-alpha"]').attributes("data-workspace-hidden")).toBe("true")

  // Right-click one hidden entry -> "取消隐藏": restores only alpha to the regular list; beta stays hidden.
  reopened.wrapper.get('[data-project-workspace="ws-alpha"] [data-open-project]').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 120 }))
  await flushPromises()
  await clickMenu("取消隐藏")

  expect(reopened.wrapper.findAll('[data-project-workspace]:not([data-workspace-hidden])').map(row => row.attributes("data-project-workspace"))).toEqual(["ws-alpha", "ws-gamma"])
  expect(reopened.wrapper.findAll('[data-project-workspace][data-workspace-hidden="true"]').map(row => row.attributes("data-project-workspace"))).toEqual(["ws-beta"])

  // Dismiss hidden preview via machine context menu -> alpha stays visible, beta disappears again.
  machineHeader.element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 24, clientY: 32 }))
  await flushPromises()
  await clickMenu("收起隐藏工作区")
  expect(reopened.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["ws-alpha", "ws-gamma"])
  expect(reopened.wrapper.find("[data-hidden-workspaces-header]").exists()).toBe(false)
  reopened.wrapper.unmount()

  // Reopen app again: alpha stays visible in regular list, beta stays hidden.
  const final = await setup({ id: "mac-mini", name: "dev-host.local", workspaces }, undefined, undefined, superAgent)
  expect(final.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["ws-alpha", "ws-gamma"])
  final.wrapper.unmount()
})

test("two machines with same-name and same-id workspaces keep hidden state and machine reveal strictly isolated", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  useWorkspaceAgentMode().value = true
  const superAgent: SuperAgentApi = { snapshot: vi.fn(), send: vi.fn(), settings: vi.fn(), correct: vi.fn() }
  const account = createAccountSession(fakeCentral({
    machines: [
      machineFixture("machine-a", "team-1", "dev-host.local"),
      machineFixture("machine-b", "team-1", "workstation.local"),
    ],
  }).central)
  await flushPromises()

  const sharedRuntimes: MachineRuntimes = {
    opened: new Map([["machine-a", {} as never], ["machine-b", {} as never]]),
    sidebarScrollTop: 0,
    sidebarFilter: createSidebarFilter(),
    sidebarOrder: createSidebarOrder("team-1"),
    sidebarPanel: createSidebarPanel(),
    hiddenWorkspaces: createHiddenWorkspaces("team-1"),
    open: vi.fn(),
  }
  const sharedWorkspaces = [
    { id: "7", name: "deskfleet-sa", directories: [{ path: "/code/deskfleet-sa" }], terminals: [], sessions: [] },
    { id: "8", name: "notes", directories: [{ path: "/code/notes" }], terminals: [], sessions: [] },
  ]
  const page = new DOMWrapper(document.body)
  const clickMenu = async (label: string) => {
    const item = page.findAll('[role="menuitem"]').find(entry => entry.text() === label)
    expect(item, `menu item "${label}" should exist`).toBeDefined()
    await item!.trigger("click")
    await flushPromises()
  }

  const machineA = await setup({ id: "machine-a", name: "dev-host.local", workspaces: sharedWorkspaces }, account, undefined, superAgent, undefined, sharedRuntimes)
  const machineB = await setup({ id: "machine-b", name: "workstation.local", local: false, workspaces: sharedWorkspaces }, account, undefined, superAgent, undefined, sharedRuntimes)
  try {
    // Hide "deskfleet-sa" (id: 7) on machine A only -> machine B is unaffected.
    machineA.wrapper.get('[data-project-workspace="7"] [data-open-project]').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 60 }))
    await flushPromises()
    await clickMenu("隐藏工作区")

    expect(machineA.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["8"])
    expect(machineB.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["7", "8"])

    // Hide "deskfleet-sa" (id: 7) on machine B as well.
    machineB.wrapper.get('[data-project-workspace="7"] [data-open-project]').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 160 }))
    await flushPromises()
    await clickMenu("隐藏工作区")
    expect(machineB.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["8"])

    // Right-click machine A -> "显示隐藏工作区": ONLY machine A reveals its hidden entry; machine B stays hidden.
    machineA.wrapper.get('[data-machine-id="machine-a"] button').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }))
    await flushPromises()
    await clickMenu("显示隐藏工作区")

    expect(machineA.wrapper.findAll('[data-project-workspace][data-workspace-hidden="true"]').map(row => row.attributes("data-project-workspace"))).toEqual(["7"])
    expect(machineB.wrapper.findAll('[data-project-workspace][data-workspace-hidden="true"]')).toHaveLength(0)
    expect(machineB.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["8"])

    // Unhide "deskfleet-sa" on machine A -> machine A restores it to regular list; machine B remains hidden.
    machineA.wrapper.get('[data-project-workspace="7"] [data-open-project]').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 80 }))
    await flushPromises()
    await clickMenu("取消隐藏")

    expect(machineA.wrapper.findAll('[data-project-workspace]:not([data-workspace-hidden])').map(row => row.attributes("data-project-workspace"))).toEqual(["7", "8"])
    expect(machineA.wrapper.find("[data-hidden-workspaces-header]").exists()).toBe(false)
    expect(machineB.wrapper.findAll("[data-project-workspace]").map(row => row.attributes("data-project-workspace"))).toEqual(["8"])
    expect(sharedRuntimes.hiddenWorkspaces.isHidden("machine-a", "7")).toBe(false)
    expect(sharedRuntimes.hiddenWorkspaces.isHidden("machine-b", "7")).toBe(true)
  } finally {
    machineA.wrapper.unmount()
    machineB.wrapper.unmount()
    account.dispose()
  }
})

test("classic workspace sidebar hides, reveals on collapsed machine expansion, and unhides", async () => {
  const { wrapper } = await setup({
    workspaces: [
      { id: "ws-1", name: "First", directories: [{ path: "/first" }], terminals: [], sessions: [] },
      { id: "ws-2", name: "Second", directories: [{ path: "/second" }], terminals: [], sessions: [] },
    ],
  })
  const page = new DOMWrapper(document.body)
  const clickMenu = async (label: string) => {
    const item = page.findAll('[role="menuitem"]').find(entry => entry.text() === label)
    expect(item, `menu item "${label}" should exist`).toBeDefined()
    await item!.trigger("click")
    await flushPromises()
  }

  wrapper.get('button[aria-label="First"]').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 60 }))
  await flushPromises()
  await clickMenu("Hide workspace")
  expect(wrapper.findAll("[data-workspace-id]").map(row => row.attributes("data-workspace-id"))).toEqual(["ws-2"])

  // Collapse the machine first; revealing hidden workspaces from the machine menu expands it.
  const machineToggle = wrapper.get('[data-machine-id="local-daemon"] button')
  await machineToggle.trigger("click")
  expect(wrapper.get('[data-machine-id="local-daemon"]').attributes("data-state")).toBe("closed")

  machineToggle.element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 }))
  await flushPromises()
  await clickMenu("Show hidden workspaces")
  expect(wrapper.get('[data-machine-id="local-daemon"]').attributes("data-state")).toBe("open")
  expect(wrapper.get('[data-workspace-id="ws-1"]').attributes("data-workspace-hidden")).toBe("true")
  expect(wrapper.get('[data-workspace-id="ws-1"] [data-workspace-hidden-badge]').text()).toBe("Hidden")

  wrapper.get('[data-workspace-id="ws-1"] button[aria-label="First"]').element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 120 }))
  await flushPromises()
  await clickMenu("Unhide workspace")
  expect(wrapper.findAll('[data-workspace-id]:not([data-workspace-hidden])').map(row => row.attributes("data-workspace-id"))).toEqual(["ws-1", "ws-2"])
  expect(wrapper.find("[data-hidden-workspaces-header]").exists()).toBe(false)
  wrapper.unmount()
})

afterEach(() => {
  useWorkspaceAgentMode().value = false
  localStorage.removeItem(HIDDEN_WORKSPACES_STORAGE_KEY)
  i18n.global.locale.value = "en-US"
})

test("pinned sessions are deduplicated out of the machine tree and reappear on unpin", async () => {
  const { usePinnedSessionsStore } = await import("../../stores/pinned-sessions.ts")
  const { wrapper } = await setup({
    workspaces: [{
      id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [],
      sessions: [
        { id: "pinned-session", title: "Pinned chat", archiveState: "active" },
        { id: "other-session", title: "Regular chat", archiveState: "active" },
      ],
    }],
  })
  const pins = usePinnedSessionsStore()
  expect(wrapper.find('a[href="/sessions/pinned-session"]').exists()).toBe(true)
  pins.pin("local-daemon", "pinned-session", "Pinned chat")
  await flushPromises()
  expect(wrapper.find('a[href="/sessions/pinned-session"]').exists()).toBe(false)
  expect(wrapper.find('a[href="/sessions/other-session"]').exists()).toBe(true)

  pins.unpin("local-daemon", "pinned-session")
  await flushPromises()
  expect(wrapper.find('a[href="/sessions/pinned-session"]').exists()).toBe(true)
  wrapper.unmount()
})

test("workspace-less sessions fold inside the Chat folder, bubble working state, and start no-workspace sessions", async () => {
  const { wrapper, router } = await setup({
    sessions: [{ id: "machine-session", title: "Machine chat", provider: "Codex", archiveState: "active" }],
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions: [] }],
  })
  const fleet = useFleetStore()
  fleet.targetWorkspace("workspace")
  const folder = wrapper.get('button[aria-label="Chat"]')
  expect(folder.attributes("aria-expanded")).toBe("true")
  expect(wrapper.get('a[href="/sessions/machine-session"]').text()).toBe("Machine chat")

  markWorking("machine-session")
  await flushPromises()
  expect(folder.find("[data-session-working]").exists()).toBe(false)

  await folder.trigger("click")
  expect(folder.attributes("aria-expanded")).toBe("false")
  expect(wrapper.find('a[href="/sessions/machine-session"]').exists()).toBe(false)
  expect(folder.get("[data-session-working]").attributes("data-session-working")).toBe("working")

  const newButtons = wrapper.findAll('button[aria-label="New session"]')
  await newButtons[0]!.trigger("click")
  await flushPromises()
  expect(fleet.targetWorkspaceId).toBeNull()
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(folder.attributes("aria-expanded")).toBe("false")
  wrapper.unmount()
})

test.each([false, true])("mobile touch buttons hide/unhide workspaces and toggle hidden workspaces without right-click (projectHome=%s)", async projectHome => {
  useWorkspaceAgentMode().value = projectHome
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
      { path: "/workspaces/:workspaceId", name: "workspace", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
      { path: "/projects/new", name: "new-project", component: {} },
      { path: "/terminals/:terminalId", name: "terminal", component: {} },
    ],
  })
  await router.push("/")
  const mobileClient = {
    ...getClient(),
    platform: "web" as const,
    mobile: true,
    remoteWorkspaceAgent: projectHome,
  }
  const wrapper = mount(MachineSection, {
    attachTo: document.body,
    props: { machine: {
      id: "remote-mac", name: "Mac mini", local: false, online: true, desktop: false, terminals: [], sessions: [],
      workspaces: [
        { id: "ws-1", name: "Alpha", directories: [{ path: "/code/alpha" }], terminals: [], sessions: [] },
        { id: "ws-2", name: "Beta", directories: [{ path: "/code/beta" }], terminals: [], sessions: [] },
      ],
    } },
    global: { plugins: [pinia, router, i18n], provide: { [platformClientKey as symbol]: mobileClient } },
  })
  const page = () => new DOMWrapper(document.body)
  const rowSelector = projectHome ? "[data-project-workspace]" : "[data-workspace-id]"
  const rowAttr = projectHome ? "data-project-workspace" : "data-workspace-id"

  expect(wrapper.find("[data-machine-toggle-hidden]").exists()).toBe(false)
  const alphaRow = wrapper.get(`[${rowAttr}="ws-1"]`)
  await alphaRow.get("[data-workspace-menu-trigger]").trigger("click")
  await flushPromises()
  const hideItem = page().get('[data-workspace-action="hide"]')
  expect(hideItem.classes()).toContain("min-h-11")
  await hideItem.trigger("click")
  await flushPromises()

  expect(wrapper.findAll(rowSelector).map(row => row.attributes(rowAttr))).toEqual(["ws-2"])
  const revealButton = wrapper.get("[data-machine-toggle-hidden]")
  expect(revealButton.attributes("aria-pressed")).toBe("false")
  await revealButton.trigger("click")
  await flushPromises()

  expect(wrapper.get("[data-machine-toggle-hidden]").attributes("aria-pressed")).toBe("true")
  const revealedAlpha = wrapper.get(`[${rowAttr}="ws-1"]`)
  expect(revealedAlpha.attributes("data-workspace-hidden")).toBe("true")

  await revealedAlpha.get("[data-workspace-menu-trigger]").trigger("click")
  await flushPromises()
  await page().get('[data-workspace-action="unhide"]').trigger("click")
  await flushPromises()

  expect(wrapper.findAll(`${rowSelector}:not([data-workspace-hidden])`).map(row => row.attributes(rowAttr))).toEqual(["ws-1", "ws-2"])
  expect(wrapper.find("[data-machine-toggle-hidden]").exists()).toBe(false)
  wrapper.unmount()
})
