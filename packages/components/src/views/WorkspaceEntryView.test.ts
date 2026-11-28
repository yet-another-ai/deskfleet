import { useWorkspaceAgentMode } from "../services/workspace-agent-navigation.ts"
import { getClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { beforeEach, afterEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey, createAccountSession, type AccountSession } from "../composables/useAccountSession.ts"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { i18n } from "../i18n/index.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import WorkspaceEntryView from "./WorkspaceEntryView.vue"

vi.mock("./WorkspaceAgentView.vue", () => ({ default: { name: "WorkspaceAgentView", render: () => null } }))
vi.mock("./NewProjectView.vue", () => ({ default: { name: "NewProjectView", render: () => null } }))

let wrapper: VueWrapper | undefined
let account: AccountSession | undefined
const remote = machineFixture("remote", "team-1", "Existing Mac")
const local = machineFixture("local", "team-1", "Development Mac")

async function openHome(options: { web?: boolean; ios?: boolean; offline?: boolean; enrolled?: boolean; onLocal?: boolean; missingFromRoster?: boolean; createProject?: boolean; machine?: string; capable?: boolean; workspaceId?: string } = {}) {
  const { central } = fakeCentral({
    machines: options.enrolled && !options.missingFromRoster ? [remote, local] : [{ ...remote, online: !options.offline }],
    enrollment: {
      machineName: local.name, identity: { originId: local.originId, machineId: local.localMachineId },
      configured: !!options.enrolled, connected: !!options.enrolled, revoked: false,
      machineId: local.id, teamId: local.teamId, serverUrl: "https://fleet.example",
    },
  })
  account = createAccountSession(central)
  await flushPromises()
  account.selectMachine(options.onLocal ? local.id : remote.id)
  const openMachineRoute = vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  const client = {
    ...getClient(), platform: options.web || options.ios ? "web" as const : "darwin" as const,
    target: { id: account.machineId.value!, local: !!options.onLocal },
    remoteWorkspaceAgent: options.ios, mobile: options.ios,
    localChannels: options.web || options.ios ? undefined : { open: vi.fn(), close: vi.fn(), send: vi.fn(), onEvent: vi.fn() },
    superAgent: options.onLocal || options.capable ? { snapshot: vi.fn(), send: vi.fn(), correct: vi.fn(), settings: vi.fn() } : undefined,
  }
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", name: "new-session", component: {} }] })
  await router.push({ path: "/", query: { machine: options.machine } })
  wrapper = mount(WorkspaceEntryView, {
    props: { createProject: options.createProject, workspaceId: options.workspaceId },
    global: {
      plugins: [router, i18n],
      provide: { [accountSessionKey as symbol]: account, [platformClientKey as symbol]: client },
      stubs: { PaneHeader: true, WorkspaceAgentView: true, WorkspaceAgentSetupView: true, NewProjectView: true, NewSessionView: true },
    },
  })
  await flushPromises()
  return { page: wrapper, openMachineRoute }
}

afterEach(() => {
  wrapper?.unmount()
  account?.dispose()
})

test("shows setup on desktop with existing remote machines and no local registration", async () => {
  const { page, openMachineRoute } = await openHome()
  expect(page.find("workspace-agent-setup-view-stub").exists()).toBe(true)
  expect(page.find("new-session-view-stub").exists()).toBe(false)
  expect(openMachineRoute).not.toHaveBeenCalled()
})

test("opening home on a remote surface switches to the enrolled local machine", async () => {
  const { page, openMachineRoute } = await openHome({ enrolled: true })
  expect(openMachineRoute).toHaveBeenCalledExactlyOnceWith(local.id, { name: "new-session" })
  expect(page.find("new-session-view-stub").exists()).toBe(false)
})

test("stale local enrollment cannot switch the user to a machine outside the current roster", async () => {
  const { page, openMachineRoute } = await openHome({ enrolled: true, missingFromRoster: true })
  expect(openMachineRoute).not.toHaveBeenCalled()
  expect(page.find("new-session-view-stub").exists()).toBe(false)
})

test("the local machine opens its default workspace conversation", async () => {
  const { page, openMachineRoute } = await openHome({ enrolled: true, onLocal: true })
  expect(page.find("workspace-agent-view-stub").exists()).toBe(true)
  expect(page.find("new-session-view-stub").exists()).toBe(false)
  expect(openMachineRoute).not.toHaveBeenCalled()
})

test("the remote project folder picker stays on that machine for an old host", async () => {
  const { page, openMachineRoute } = await openHome({ enrolled: true, machine: remote.id, createProject: true })
  expect(openMachineRoute).not.toHaveBeenCalled()
  expect(page.find("new-project-view-stub").exists()).toBe(true)
})

test.each([undefined, "17"])("an old remote host displays its own upgrade path for workspace %s", async workspaceId => {
  const { page, openMachineRoute } = await openHome({ enrolled: true, machine: remote.id, workspaceId })
  expect(page.get("[data-agent-upgrade]").text()).toContain(remote.name)
  expect(page.find("workspace-agent-view-stub").exists()).toBe(false)
  expect(openMachineRoute).not.toHaveBeenCalled()
})

test("the remote agent works without enrollment of the viewing machine", async () => {
  const { page, openMachineRoute } = await openHome({ capable: true, machine: remote.id, workspaceId: "17" })
  expect(page.find("workspace-agent-view-stub").exists()).toBe(true)
  expect(openMachineRoute).not.toHaveBeenCalled()
})

test("a new project opens the folder picker on the requested local machine", async () => {
  const { page } = await openHome({ enrolled: true, onLocal: true, machine: local.id, createProject: true })
  expect(page.find("new-project-view-stub").exists()).toBe(true)
  expect(page.find("workspace-agent-view-stub").exists()).toBe(false)
})

test("an inaccessible machine link does not open a same-numbered local project", async () => {
  const { page, openMachineRoute } = await openHome({ enrolled: true, onLocal: true, machine: "deleted", workspaceId: "17" })
  expect(page.get('[role="alert"]').text()).toContain("unavailable")
  expect(page.find("workspace-agent-view-stub").exists()).toBe(false)
  expect(openMachineRoute).not.toHaveBeenCalled()
})

test("the browser keeps its manual session composer", async () => {
  const { page, openMachineRoute } = await openHome({ web: true })
  expect(page.find("new-session-view-stub").exists()).toBe(true)
  expect(openMachineRoute).not.toHaveBeenCalled()
})

test("iOS opens the selected remote default workspace without local setup", async () => {
  const { page, openMachineRoute } = await openHome({ ios: true, capable: true })
  expect(page.find("workspace-agent-view-stub").exists()).toBe(true)
  expect(page.find("workspace-agent-setup-view-stub").exists()).toBe(false)
  expect(openMachineRoute).not.toHaveBeenCalled()
})

test("the iOS new project picker follows the requested remote machine", async () => {
  const { page, openMachineRoute } = await openHome({ ios: true, capable: true, machine: remote.id, createProject: true })
  expect(page.find("new-project-view-stub").exists()).toBe(true)
  expect(openMachineRoute).not.toHaveBeenCalled()
})

test("iOS shows the old machine's upgrade state with navigation instead of creating a legacy session or project", async () => {
  const { page } = await openHome({ ios: true, machine: remote.id, createProject: true })
  expect(page.get("[data-agent-upgrade]").text()).toContain(remote.name)
  expect(page.find("pane-header-stub").exists()).toBe(true)
  expect(page.find("new-project-view-stub").exists()).toBe(false)
  expect(page.find("new-session-view-stub").exists()).toBe(false)
})

test("iOS offers a reconnect for an initially offline project and retains the live view if it drops offline later", async () => {
  const { page } = await openHome({ ios: true, capable: true, offline: true, workspaceId: "17" })
  expect(page.get("[data-agent-offline]").text()).toContain(remote.name)
  expect(page.find("workspace-agent-view-stub").exists()).toBe(false)
  const machine = account!.machine.value!
  machine.online = true
  await flushPromises()
  expect(page.find("workspace-agent-view-stub").exists()).toBe(true)
  machine.online = false
  await flushPromises()
  expect(page.find("workspace-agent-view-stub").exists()).toBe(true)
})

beforeEach(() => { useWorkspaceAgentMode().value = true })

afterEach(() => { useWorkspaceAgentMode().value = false })

test("an upgrade opens the session composer and switching project mode twice preserves the selected machine", async () => {
  useWorkspaceAgentMode().value = false
  const { page, openMachineRoute } = await openHome({ onLocal: true, enrolled: true })
  expect(page.findComponent({ name: "NewSessionView" }).exists()).toBe(true)
  expect(openMachineRoute).not.toHaveBeenCalled()
  useWorkspaceAgentMode().value = true
  await flushPromises()
  expect(page.findComponent({ name: "WorkspaceAgentView" }).exists()).toBe(true)
  useWorkspaceAgentMode().value = false
  await flushPromises()
  expect(page.findComponent({ name: "NewSessionView" }).exists()).toBe(true)
  expect(openMachineRoute).not.toHaveBeenCalled()
})
