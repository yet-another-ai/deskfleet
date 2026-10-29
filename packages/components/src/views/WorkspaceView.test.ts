import { configureClient, getClient } from "@deskfleet/client/platform"
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import type { LocalApplication } from "../../../client/src/applications.ts"
import { i18n } from "../i18n/index.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { agentSnapshot } from "../test/agent.ts"
import { catalogFixture, sessionId, workspaceId } from "../test/catalog.ts"
import WorkspaceView from "./WorkspaceView.vue"

const originalClient = getClient()
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  configureClient(originalClient)
  vi.restoreAllMocks()
})
const installed: LocalApplication[] = [
  { id: "vscode", name: "VS Code", kind: "editor" },
  { id: "cursor", name: "Cursor", kind: "editor" },
  { id: "vscodium", name: "VSCodium", kind: "editor" },
  { id: "zed", name: "Zed", kind: "editor" },
  { id: "terminal", name: "Host terminal", kind: "terminal" },
  { id: "file-manager", name: "Host file manager", kind: "fileManager" },
]

async function setup(options: { local?: boolean; platform?: "linux" | "web"; applications?: boolean; online?: boolean; sessions?: ReturnType<typeof agentSnapshot>["session"][] } = {}) {
  const applications = {
    scan: vi.fn(async (): Promise<LocalApplication[]> => installed),
    openWorkspace: vi.fn(async () => {}),
  }
  configureClient({
    ...originalClient,
    platform: options.platform ?? "linux",
    target: { id: "machine-1", local: options.local ?? true },
    applications: options.applications === false ? undefined : applications,
    catalog: { ...originalClient.catalog, list: async () => catalogFixture() },
    desktop: { ...originalClient.desktop, target: async () => ({ id: "machine-1", name: "My laptop", online: options.online ?? true, desktop: true }) },
  })
  const pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore()
  const agents = useAgentSessionsStore()
  for (const session of options.sessions ?? []) agents.sessions[session.id] = session
  await fleet.refreshLocal()
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/workspaces/:workspaceId", name: "workspace", component: WorkspaceView },
    { path: "/sessions/:sessionId", name: "session", component: {} },
    { path: "/", name: "new-session", component: {} },
  ] })
  await router.push({ name: "workspace", params: { workspaceId } })
  const wrapper = mount(WorkspaceView, {
    props: { workspaceId }, attachTo: document.body,
    global: { plugins: [pinia, router, i18n] },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia) })
  return { wrapper, applications, agents, fleet }
}

const page = () => new DOMWrapper(document.body)
const menuItems = () => page().findAll('[role="menuitem"]')
async function openMenu(wrapper: VueWrapper, label = "Open default directory with"): Promise<void> {
  const trigger = wrapper.get<HTMLButtonElement>(`button[aria-label="${label}"]`)
  trigger.element.focus()
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
}
async function choose(name: string): Promise<void> {
  const item = menuItems().find(item => item.text() === name)!
  ;(item.element as HTMLElement).focus()
  await item.trigger("keydown", { key: "Enter" })
  await flushPromises()
}

test("the workspace lists active and archiving sessions while retaining archived sessions in the fleet", async () => {
  const session = { ...agentSnapshot().session, workspaceId }
  const { wrapper, fleet } = await setup({ sessions: [
    { ...session, id: "30", title: "Active chat", archiveState: "active" },
    { ...session, id: "31", title: "Archiving chat", archiveState: "archiving" },
    { ...session, id: "32", title: "Archived chat", archiveState: "archived" },
  ] })
  expect(wrapper.findAll('a[href^="/sessions/"]').map(link => link.attributes("href"))).toEqual([
    `/sessions/${sessionId}`, "/sessions/30", "/sessions/31",
  ])
  expect(wrapper.text()).not.toContain("Archived chat")
  expect(fleet.findSession("32")?.session.archiveState).toBe("archived")
})

test("archiving the last workspace session shows the empty state and restoring brings it back", async () => {
  const { wrapper, agents } = await setup({ sessions: [
    { ...agentSnapshot().session, id: sessionId, workspaceId, title: "Workspace chat" },
  ] })
  const sessionLink = () => wrapper.find(`a[href="/sessions/${sessionId}"]`)
  expect(sessionLink().text()).toBe("Workspace chat")
  agents.sessions[sessionId]!.archiveState = "archiving"
  await flushPromises()
  expect(sessionLink().exists()).toBe(true)
  agents.sessions[sessionId]!.archiveState = "archived"
  await flushPromises()
  expect(sessionLink().exists()).toBe(false)
  expect(wrapper.text()).toContain("No sessions yet.")
  agents.sessions[sessionId]!.archiveState = "active"
  await flushPromises()
  expect(sessionLink().text()).toBe("Workspace chat")
  expect(wrapper.text()).not.toContain("No sessions yet.")
})

test.each([
  { name: "remote machine with a host API", local: false },
  { name: "Web client with a host API", platform: "web" as const },
  { name: "local machine without a host API", applications: false },
])("Open with is unavailable for $name", async options => {
  const { wrapper, applications } = await setup(options)
  expect(wrapper.text()).not.toContain("Open with")
  expect(wrapper.find('[aria-label="Open /code/api with"]').exists()).toBe(false)
  expect(applications.scan).not.toHaveBeenCalled()
  expect(applications.openWorkspace).not.toHaveBeenCalled()
})

test("Open with scans on demand and opens the default directory without sending its path", async () => {
  const { wrapper, applications } = await setup()
  expect(applications.scan).not.toHaveBeenCalled()
  await openMenu(wrapper)
  expect(applications.scan).toHaveBeenCalledOnce()
  expect(menuItems().map(item => item.text())).toEqual(["VS Code", "Cursor", "VSCodium", "Zed", "Terminal", "File manager", "Rescan"])
  await choose("VS Code")
  expect(applications.openWorkspace).toHaveBeenCalledExactlyOnceWith({ applicationId: "vscode", machineId: "machine-1", workspaceId })
  expect(page().find('[role="menu"]').exists()).toBe(false)
})

test("the menu shows scanning and empty states, and Rescan refreshes installed choices", async () => {
  const { wrapper, applications } = await setup()
  let finish!: (applications: LocalApplication[]) => void
  applications.scan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await openMenu(wrapper)
  expect(page().get('[role="status"]').text()).toBe("Scanning installed apps…")
  expect(menuItems().find(item => item.text() === "Rescan")!.attributes("data-disabled")).toBeDefined()
  finish([])
  await flushPromises()
  expect(page().get('[role="status"]').text()).toBe("No supported apps found.")
  applications.scan.mockResolvedValueOnce([installed[1]!])
  await choose("Rescan")
  expect(applications.scan).toHaveBeenCalledTimes(2)
  expect(menuItems().map(item => item.text())).toEqual(["Cursor", "Rescan"])
  expect(applications.openWorkspace).not.toHaveBeenCalled()
})

test.each([
  { name: "Terminal", id: "terminal" },
  { name: "File manager", id: "file-manager" },
])("an additional directory opens in the external $name by its configured index", async ({ name, id }) => {
  const { wrapper, applications } = await setup()
  await openMenu(wrapper, "Open /code/api with")
  await choose(name)
  expect(applications.openWorkspace).toHaveBeenCalledExactlyOnceWith({ applicationId: id, machineId: "machine-1", workspaceId, directoryIndex: 1 })
})

test("scan failures stay visible in the menu and can be retried with Rescan", async () => {
  const { wrapper, applications } = await setup()
  applications.scan.mockRejectedValueOnce(new Error("Host scan failed"))
  await openMenu(wrapper)
  expect(page().get('[role="alert"]').text()).toBe("Could not scan apps: Host scan failed")
  await choose("Rescan")
  expect(page().find('[role="alert"]').exists()).toBe(false)
  expect(menuItems().map(item => item.text())).toContain("Zed")
})

test("launch failures remain visible after the menu closes and allow another attempt", async () => {
  const { wrapper, applications } = await setup()
  applications.openWorkspace.mockRejectedValueOnce(new Error("Application was removed"))
  await openMenu(wrapper)
  await choose("Cursor")
  expect(page().find('[role="menu"]').exists()).toBe(false)
  expect(wrapper.get('[role="alert"]').text()).toBe("Could not open Cursor: Application was removed")
  await openMenu(wrapper)
  await choose("Zed")
  expect(applications.openWorkspace).toHaveBeenCalledTimes(2)
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})

test("an unavailable local daemon disables both default and additional directory actions", async () => {
  const { wrapper, applications } = await setup({ online: false })
  expect(wrapper.get('button[aria-label="Open default directory with"]').attributes("disabled")).toBeDefined()
  expect(wrapper.get('button[aria-label="Open /code/api with"]').attributes("disabled")).toBeDefined()
  expect(applications.scan).not.toHaveBeenCalled()
})
