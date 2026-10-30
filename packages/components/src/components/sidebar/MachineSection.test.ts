import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { expect, test, vi } from "vitest"
import { reactive, ref } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { i18n } from "../../i18n/index.ts"
import { agentSnapshot } from "../../test/agent.ts"
import type { AgentSessionSummary, MachineSummary } from "../../stores/fleet-types.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import { accountSessionKey, type AccountSession } from "../../composables/useAccountSession.ts"
import MachineSection from "./MachineSection.vue"

async function setup(machine: Partial<MachineSummary> = {}, account?: AccountSession) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/machines/:machineId/control", name: "machine-control", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/terminals/:terminalId", name: "terminal", component: {} },
    ],
  })
  await router.push("/machines/local-daemon/control?tab=files")
  const wrapper = mount(MachineSection, {
    props: { machine: {
      id: "local-daemon", name: "host", local: true, online: true, desktop: false,
      terminals: [{ id: "shell", title: "Machine shell", cwd: "/home/user" }], sessions: [], workspaces: [], ...machine,
    } },
    global: { plugins: [pinia, router, i18n], provide: account ? { [accountSessionKey as symbol]: account } : {} },
  })
  return { wrapper, router }
}

test.each([
  { local: true, desktop: true, label: "Local control" },
  { local: true, desktop: false, label: "Local control" },
  { local: false, desktop: true, label: "Remote control" },
  { local: false, desktop: false, label: "Remote control" },
])("machines expose one control entry with local=$local and desktop=$desktop", async ({ local, desktop, label }) => {
  const { wrapper, router } = await setup({ local, desktop })
  const links = wrapper.findAll("a")
  expect(links.map(link => link.text())).toEqual([label])
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

test("workspace rows fold terminals and sessions without navigating", async () => {
  const { wrapper, router } = await setup({
    desktop: true,
    workspaces: [{
      id: "workspace", name: "Project", directories: [{ path: "/project" }],
      terminals: [{ id: "workspace-shell", title: "Workspace shell", cwd: "/project" }],
      sessions: [{ id: "session", title: "Implement feature", provider: "Codex" }],
    }],
  })
  expect(wrapper.findAll("a").map(link => [link.text(), link.attributes("href")])).toEqual([
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
  const account = { machineId: ref("selected-machine"), localMachineId: ref("local-daemon"), openMachineRoute } as unknown as AccountSession
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

test("session rows show a working indicator while a live turn is projected", async () => {
  const { wrapper } = await setup({
    sessions: [{ id: "machine-session", title: "Machine chat", provider: "Codex", archiveState: "active" }],
    workspaces: [{
      id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [],
      sessions: [{ id: "workspace-session", title: "Implement feature", provider: "Codex", archiveState: "active" }],
    }],
  })
  expect(wrapper.findAll("[data-session-working]")).toHaveLength(0)
  const agents = useAgentSessionsStore()
  const live = agentSnapshot()
  live.session.id = "workspace-session"
  live.turns = [{ id: "70", sessionId: "workspace-session", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: "now" }]
  agents.views["workspace-session"] = { snapshot: live, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }
  await flushPromises()
  const working = wrapper.findAll("[data-session-working]")
  expect(working).toHaveLength(1)
  expect(working[0]!.attributes("role")).toBe("status")
  expect(working[0]!.text()).toContain("Working")
  expect(wrapper.get('a[href="/sessions/workspace-session"]').find("[data-session-working]").exists()).toBe(true)
  expect(wrapper.find('a[href="/sessions/machine-session"] [data-session-working]').exists()).toBe(false)
  agents.views["workspace-session"] = {
    ...agents.views["workspace-session"]!,
    snapshot: { ...live, turns: [{ ...live.turns[0]!, state: "completed", endedAt: "now" }] },
  }
  await flushPromises()
  expect(wrapper.findAll("[data-session-working]")).toHaveLength(0)
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
  expect(visibleIds()).toEqual(["/sessions/active", "/sessions/archiving", "/sessions/pending"])
  expect(wrapper.find('button[aria-label="Retry archive"]').exists()).toBe(true)

  await router.push("/sessions/archived"); await flushPromises()
  expect(wrapper.find('a[href="/sessions/archived"]').exists()).toBe(false)
  sessions[0]!.archiveState = "archived"
  await flushPromises()
  expect(visibleIds()).toEqual(["/sessions/archiving", "/sessions/pending"])
  sessions[2]!.archiveState = "active"
  await flushPromises()
  expect(visibleIds()).toEqual(["/sessions/archiving", "/sessions/archived", "/sessions/pending"])
  wrapper.unmount()
})

test("a machine containing only archived sessions shows its empty state", async () => {
  const { wrapper } = await setup({ sessions: [{ id: "archived", title: "Archived chat", archiveState: "archived" }] })
  expect(wrapper.text()).toContain("No workspaces")
  expect(wrapper.find('a[href="/sessions/archived"]').exists()).toBe(false)
  wrapper.unmount()
})

test.each(["machine", "workspace"] as const)("%s hover Archive confirms before acting and retains cleanup errors for retry", async scope => {
  const sessions: AgentSessionSummary[] = [{ id: "30", title: "Active chat", context: scope === "machine" ? "directory" : "worktree", archiveState: "active" }]
  const { wrapper, router } = await setup(scope === "machine" ? { sessions } : {
    workspaces: [{ id: "workspace", name: "Project", directories: [{ path: "/project" }], terminals: [], sessions }],
  })
  const archive = vi.spyOn(useAgentSessionsStore(), "archive").mockRejectedValueOnce(new Error("Worktree cleanup failed")).mockResolvedValue()
  const page = new DOMWrapper(document.body)
  const button = wrapper.get('button[aria-label="Archive session"]')
  const confirmSelector = scope === "machine" ? ".ui-button-primary" : ".ui-button-danger"
  await button.trigger("click"); await flushPromises()
  expect(archive).not.toHaveBeenCalled()
  expect(page.get('[role="dialog"]').text()).toContain(scope === "machine" ? "working directory, and files will be retained" : "including uncommitted changes and untracked files")
  await page.get('[role="dialog"]').trigger("keydown", { key: "Escape" }); await flushPromises()
  expect(archive).not.toHaveBeenCalled()
  await button.trigger("click"); await flushPromises()
  await page.get(`[role="dialog"] ${confirmSelector}`).trigger("click"); await flushPromises()
  expect(page.get('[role="dialog"] [role="alert"]').text()).toBe("Worktree cleanup failed")
  await page.get(`[role="dialog"] ${confirmSelector}`).trigger("click"); await flushPromises()
  expect(archive).toHaveBeenCalledTimes(2)
  expect(archive).toHaveBeenLastCalledWith("30")
  expect(page.find('[role="dialog"]').exists()).toBe(false)
  expect(router.currentRoute.value.name).toBe("machine-control")
  wrapper.unmount()
})
