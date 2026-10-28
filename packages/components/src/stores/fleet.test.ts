import { client as platformClient, configureClient, getClient } from "@deskfleet/client/platform"
import type { CatalogSnapshot } from "../../../client/src/catalog.ts"
import type { LocalEnrollment } from "../../../client/src/central.ts"
import { createPinia, getActivePinia, setActivePinia } from "pinia"
import { createApp } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { catalogFixture, sessionId, sessionWorktreeId, mainWorktreeId, workspaceId } from "../test/catalog.ts"
import { useFleetStore } from "./fleet.ts"
import { useAgentSessionsStore } from "./agent-sessions.ts"
import { useProvidersStore } from "./providers.ts"
import { useTerminalsStore } from "./terminals.ts"
import { agentSnapshot } from "../test/agent.ts"
import { fakeCentral } from "../test/central.ts"
import { accountSessionKey, createAccountSession, type AccountSession } from "../composables/useAccountSession.ts"
import { captureAnalyticsContext, trackEvent } from "../services/analytics.ts"

vi.mock("../services/analytics.ts", () => { const trackEvent = vi.fn(); return { trackEvent, captureAnalyticsContext: vi.fn(() => trackEvent) } })

const stores: ReturnType<typeof useFleetStore>[] = []
const accounts: AccountSession[] = []
const originalClient = getClient()
let changed: () => void
beforeEach(() => {
  vi.mocked(trackEvent).mockClear()
  setActivePinia(createPinia())
  vi.spyOn(platformClient.catalog, "onChanged").mockImplementation(listener => { changed = listener; return () => {} })
  vi.spyOn(platformClient.catalog, "list").mockResolvedValue(catalogFixture())
})
afterEach(() => {
  for (const store of stores.splice(0)) store.$dispose()
  for (const account of accounts.splice(0)) account.dispose()
  configureClient(originalClient)
  vi.restoreAllMocks()
})
function setup() { const store = useFleetStore(); stores.push(store); return store }

const localEnrollment = (): LocalEnrollment => ({
  configured: true, connected: true, revoked: false,
  serverUrl: "https://fleet.example", teamId: "team-1", machineId: "central-machine",
  identity: { originId: "local-origin", machineId: "1" }, machineName: "This computer",
})
async function setupAccount(targetId: string, enrollment?: LocalEnrollment) {
  configureClient({ ...getClient(), target: { id: targetId, local: false } })
  const fake = fakeCentral({ enrollment })
  const account = createAccountSession(fake.central)
  accounts.push(account)
  await vi.waitFor(() => expect(account.ready.value).toBe(true))
  const app = createApp({}).provide(accountSessionKey, account).use(getActivePinia()!)
  return { store: app.runWithContext(setup), account, fake }
}

test.each([
  { targetId: "central-machine", local: true },
  { targetId: "remote-machine", local: false },
  { targetId: "1", local: false },
])("identifies $targetId as local=$local using this client's central registration", async ({ targetId, local }) => {
  const { store } = await setupAccount(targetId, localEnrollment())
  expect(store.findMachine(targetId)?.local).toBe(local)
})

test("a browser account without a hosted daemon has no local machine", async () => {
  configureClient({ ...getClient(), platform: "web" })
  const { store } = await setupAccount("central-machine")
  expect(store.machines[0]?.local).toBe(false)
})

test("local identity follows enrollment refreshes and is independent of daemon presence", async () => {
  const { store, account, fake } = await setupAccount("central-machine", { ...localEnrollment(), configured: false })
  const machine = () => store.findMachine("central-machine")!
  expect(machine().local).toBe(false)

  fake.state.enrollment = localEnrollment()
  await account.refreshMachines()
  expect(machine().local).toBe(true)

  fake.state.enrollment.connected = false
  await account.refreshMachines()
  expect(machine().local).toBe(true)

  fake.state.enrollment.revoked = true
  await account.refreshMachines()
  expect(machine().local).toBe(false)

  fake.state.enrollment = { ...localEnrollment(), serverUrl: "https://another.example" }
  await account.refreshMachines()
  expect(machine().local).toBe(false)

  fake.state.enrollment = localEnrollment()
  await account.refreshMachines()
  expect(machine().local).toBe(true)
})

test("maps configured directories onto the workspace and exposes only Session-owned worktrees", async () => {
  const store = setup()
  expect(store.machines).toHaveLength(1)
  expect(store.machines[0]?.local).toBe(true)
  expect(store.newSessionTarget?.workspace).toBeUndefined()
  await store.refreshLocalCatalog()
  expect(store.catalogIdentity).toEqual({ teamId: "1", machineId: "9007199254740999" })
  expect(store.machines[0]!.id).toBe("local-daemon")
  const workspace = store.findWorkspace(workspaceId)!.workspace
  expect(workspace.name).toBe("storefront")
  expect(workspace.directories.map(({ path }) => path)).toEqual(["/code/web", "/code/api"])
  expect(workspace.directories[0]!.git).toBeUndefined()
  expect(workspace).not.toHaveProperty("worktrees")
  expect(store.newSessionTarget!.workspace!.id).toBe(workspaceId)
  expect(store.findWorktree(mainWorktreeId)).toBeNull()
  expect(workspace.sessions).toHaveLength(1)
  const session = workspace.sessions[0]!
  expect(session.id).toBe(sessionId)
  expect(session).not.toHaveProperty("title")
  expect(session).not.toHaveProperty("provider")
  expect(session.worktree!.id).toBe(sessionWorktreeId)
  expect(session.worktree).not.toHaveProperty("sessions")
  expect(store.findSession(sessionId)?.session).toBe(session)
  expect(store.findWorktree(sessionWorktreeId)?.session).toBe(session)
})

test("findWorktree resolves machine-scoped Session worktrees", async () => {
  const store = setup()
  const snapshot = catalogFixture()
  snapshot.workspaces = []
  snapshot.sessions = [{ id: "41", sessionId: "40", directories: [{ path: "/home/demo" }] }]
  vi.mocked(platformClient.catalog.list).mockResolvedValue(snapshot)
  await store.refreshLocalCatalog()
  const agents = useAgentSessionsStore()
  agents.sessions["40"] = { ...agentSnapshot().session, id: "40", workspaceId: undefined, title: "Home chat", context: "directory", archiveState: "active" }
  const location = store.findWorktree("41")
  expect(location?.workspace).toBeUndefined()
  expect(location?.session.id).toBe("40")
  expect(location?.worktree.directories.map(({ path }) => path)).toEqual(["/home/demo"])
  expect(store.findSession("40")?.worktree?.id).toBe("41")
})

test("terminal ownership follows live changes and survives catalog refreshes", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const terminals = useTerminalsStore()
  terminals.sessions = [
    { id: "machine-terminal", title: "shell", cwd: "/code/web", cols: 80, rows: 24, status: "running" },
    { id: "session-terminal", title: "shell", cwd: "/worktrees/api/session", cols: 80, rows: 24, status: "running", worktreeId: sessionWorktreeId },
  ]
  expect(store.machines[0]!.terminals.map(terminal => terminal.id)).toEqual(["machine-terminal"])
  expect(store.findTerminal("machine-terminal")?.worktree).toBeUndefined()
  const session = store.findSession(sessionId)!
  expect(store.findTerminal("session-terminal")?.session).toBe(session.session)
  expect(store.findTerminal("session-terminal")?.worktree).toBe(session.worktree)

  terminals.sessions[1]!.title = "build"
  expect(store.findTerminal("session-terminal")?.terminal.title).toBe("build")
  vi.mocked(platformClient.catalog.list).mockResolvedValueOnce(catalogFixture())
  await store.refreshLocalCatalog()
  expect(store.findWorktree(sessionWorktreeId)?.worktree.terminals.map(terminal => terminal.id)).toEqual(["session-terminal"])

  terminals.sessions[0]!.worktreeId = sessionWorktreeId
  expect(store.machines[0]!.terminals).toEqual([])
  expect(store.findTerminal("machine-terminal")?.worktree?.id).toBe(sessionWorktreeId)
  delete terminals.sessions[1]!.worktreeId
  expect(store.machines[0]!.terminals.map(terminal => terminal.id)).toEqual(["session-terminal"])
  expect(store.findTerminal("session-terminal")?.session).toBeUndefined()

  terminals.sessions = []
  expect(store.findTerminal("machine-terminal")).toBeNull()
  expect(store.findTerminal("session-terminal")).toBeNull()
  expect(store.findWorktree(sessionWorktreeId)?.worktree.terminals).toEqual([])
})

test("workspace creation selects its configured directories without exposing an empty main worktree", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const paths = [{ path: "/code/new" }]
  const created = { id: "20", name: "new workspace", worktrees: [{ id: "21", workspaceId: "20", directories: paths }] }
  const create = vi.spyOn(platformClient.catalog, "createWorkspace").mockResolvedValue(created)
  await store.createWorkspace("new workspace", paths)
  expect(create).toHaveBeenCalledWith("new workspace", paths)
  expect(store.newSessionTarget!.workspace!.id).toBe("20")
  expect(store.newSessionTarget!.workspace!.directories.map(({ path }) => ({ path }))).toEqual(paths)
  expect(store.newSessionTarget!.workspace!.sessions).toEqual([])
  expect(store.findWorktree("21")).toBeNull()
  expect(trackEvent).toHaveBeenCalledExactlyOnceWith("workspace_created", { directory_count: 1 })
})

test("failed workspace creation does not record a successful creation", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  vi.spyOn(platformClient.catalog, "createWorkspace").mockRejectedValue(new Error("Directory is unavailable"))
  await expect(store.createWorkspace("Private workspace", [{ path: "/private/project" }])).rejects.toThrow("Directory is unavailable")
  expect(trackEvent).not.toHaveBeenCalled()
})

test("workspace completion uses the context captured before its request", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const captured = vi.fn()
  vi.mocked(captureAnalyticsContext).mockReturnValueOnce(captured)
  const response = Promise.withResolvers<Awaited<ReturnType<typeof platformClient.catalog.createWorkspace>>>()
  vi.spyOn(platformClient.catalog, "createWorkspace").mockReturnValueOnce(response.promise)
  const operation = store.createWorkspace("Private workspace", [{ path: "/private/project" }])
  response.resolve({ id: "20", name: "Private workspace", worktrees: [] })
  await operation
  expect(trackEvent).not.toHaveBeenCalled()
  expect(captured).toHaveBeenCalledExactlyOnceWith("workspace_created", { directory_count: 1 })
})

test("workspace updates replace configured directories and retain Session paths; disconnection keeps the catalog read-only", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const updated = catalogFixture().workspaces[0]!
  updated.name = "renamed"
  updated.worktrees[0]!.directories.reverse()
  const update = vi.spyOn(platformClient.catalog, "updateWorkspace").mockResolvedValue(updated)
  const paths = [{ path: "/code/api" }, { path: "/code/web" }]
  await store.updateWorkspace(workspaceId, "renamed", paths)
  expect(update).toHaveBeenCalledWith(workspaceId, "renamed", paths)
  expect(store.findWorkspace(workspaceId)?.workspace.name).toBe("renamed")
  expect(store.findWorkspace(workspaceId)?.workspace.directories.map(({ path }) => path)).toEqual(paths.map(({ path }) => path))
  expect(store.findWorktree(mainWorktreeId)).toBeNull()
  expect(store.findSession(sessionId)?.worktree?.directories.map(({ path }) => path)).toEqual(["/worktrees/api/session"])
  expect(store.newSessionTarget!.workspace!.id).toBe(workspaceId)
  vi.mocked(platformClient.catalog.list).mockRejectedValueOnce(new Error("Daemon disconnected"))
  await store.refreshLocalCatalog()
  expect(store.catalogError).toBe("Daemon disconnected")
  expect(store.canManageCatalog).toBe(false)
  expect(store.findWorkspace(workspaceId)?.workspace.directories.map(({ path }) => path)).toEqual(paths.map(({ path }) => path))
  await expect(store.updateWorkspace(workspaceId, "retry", paths)).rejects.toThrow("Daemon disconnected")
  expect(update).toHaveBeenCalledTimes(1)
})

test("Session removal keeps the workspace selected and workspace deletion reconciles the selection", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const updated = catalogFixture()
  updated.workspaces[0]!.worktrees = [updated.workspaces[0]!.worktrees[0]!]
  vi.mocked(platformClient.catalog.list).mockImplementation(async () => structuredClone(updated))
  changed()
  await vi.waitFor(() => expect(store.findWorktree(sessionWorktreeId)).toBeNull())
  expect(store.findSession(sessionId)).toBeNull()
  expect(store.newSessionTarget!.workspace!.id).toBe(workspaceId)
  updated.workspaces.push({ id: "20", name: "second", worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code/second" }] }] })
  await store.refreshLocalCatalog()
  store.targetWorkspace("20")
  expect(store.newSessionTarget!.workspace!.id).toBe("20")
  const remove = vi.spyOn(platformClient.catalog, "deleteWorkspace").mockResolvedValue()
  await store.deleteWorkspace("20")
  expect(store.newSessionTarget!.workspace!.id).toBe(workspaceId)
  await store.deleteWorkspace(workspaceId)
  expect(remove).toHaveBeenCalledWith(workspaceId)
  expect(store.newSessionTarget?.workspace).toBeUndefined()
  expect(store.newSessionTarget?.machine.id).toBe("local-daemon")
})

test("catalog notifications reconcile a selected workspace removed by another client", async () => {
  const store = setup()
  const snapshot = catalogFixture()
  snapshot.workspaces.push({ id: "20", name: "second", worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code/second" }] }] })
  vi.mocked(platformClient.catalog.list).mockResolvedValue(snapshot)
  await store.refreshLocalCatalog()
  store.targetWorkspace("20")
  vi.mocked(platformClient.catalog.list).mockResolvedValue(catalogFixture())
  changed()
  await vi.waitFor(() => expect(store.newSessionTarget!.workspace!.id).toBe(workspaceId))
  expect(store.findWorkspace("20")).toBeNull()
})


test("merges durable titles and keeps failed provisioning visible without fabricating a Worktree", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const agents = useAgentSessionsStore()
  agents.sessions = {
    [sessionId]: { ...agentSnapshot().session, id: sessionId, workspaceId, title: "A real title" },
    "failed": { ...agentSnapshot().session, id: "failed", workspaceId, lifecycle: "provision_failed", title: "Could not create context" },
  }
  await vi.waitFor(() => expect(store.findSession(sessionId)?.session.title).toBe("A real title"))
  expect(store.findSession("failed")?.session.title).toBe("Could not create context")
  expect(store.findSession("failed")?.worktree).toBeUndefined()
  await store.refreshLocalCatalog()
  expect(store.findSession(sessionId)?.session.title).toBe("A real title")
  expect(store.findSession("failed")).not.toBeNull()
  delete agents.sessions["failed"]
  await vi.waitFor(() => expect(store.findSession("failed")).toBeNull())
})

test("Session titles, context and archive state follow agent metadata without a catalog refresh", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const agents = useAgentSessionsStore()
  agents.sessions[sessionId] = { ...agentSnapshot().session, id: sessionId, workspaceId, title: "Initial title", context: "worktree", archiveState: "active" }
  expect(store.findSession(sessionId)?.session).toMatchObject({ title: "Initial title", context: "worktree", archiveState: "active" })

  Object.assign(agents.sessions[sessionId]!, { title: "Updated title", archiveState: "archived" })
  expect(store.findSession(sessionId)?.session).toMatchObject({ title: "Updated title", context: "worktree", archiveState: "archived" })
  expect(store.findSession(sessionId)?.worktree?.id).toBe(sessionWorktreeId)
  agents.sessions[sessionId]!.archiveState = "active"
  expect(store.findSession(sessionId)?.session.archiveState).toBe("active")
  expect(platformClient.catalog.list).toHaveBeenCalledOnce()
})

test("resolves provider identity only from successful snapshots and keeps it through refresh failures", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  agents.sessions = { [sessionId]: { ...agentSnapshot().session, id: sessionId, workspaceId, provider: "work-codex" } }
  await vi.waitFor(() => expect(store.findSession(sessionId)?.session.providerUnavailable).toBe(false))
  expect(store.findSession(sessionId)?.session.provider).toBeUndefined()
  const list = vi.spyOn(platformClient.providers, "list").mockResolvedValue({ revision: "test-settings", templates: [], providers: [
    { id: "work-codex", template: "codex", name: "Work Codex", icon: "deepseek", env: {} },
  ] })
  await providers.refresh()
  await vi.waitFor(() => expect(store.findSession(sessionId)?.session.provider).toBe("Work Codex"))
  expect(store.findSession(sessionId)?.session).toMatchObject({ providerIcon: "deepseek", providerTemplate: "codex", providerUnavailable: false })
  providers.providers[0]!.name = "Renamed Codex"
  providers.providers[0]!.icon = "openai"
  expect(store.findSession(sessionId)?.session).toMatchObject({ provider: "Renamed Codex", providerIcon: "openai" })
  list.mockRejectedValueOnce(new Error("Disconnected"))
  await providers.refresh()
  await store.refreshLocalCatalog()
  expect(store.findSession(sessionId)?.session).toMatchObject({ provider: "Renamed Codex", providerIcon: "openai", providerTemplate: "codex", providerUnavailable: false })
  list.mockResolvedValue({ revision: "test-settings-removed", templates: [], providers: [] })
  await providers.refresh()
  await vi.waitFor(() => expect(store.findSession(sessionId)?.session.providerUnavailable).toBe(true))
  expect(store.findSession(sessionId)?.session.provider).toBeUndefined()
  expect(store.findSession(sessionId)?.session.providerIcon).toBeUndefined()
})


function pendingCatalog() {
  let resolve!: (snapshot: CatalogSnapshot) => void
  const promise = new Promise<CatalogSnapshot>(done => { resolve = done })
  return { promise, resolve }
}

test("catalog notifications keep the loaded workspace and title stable while a background request is pending", async () => {
  const store = setup()
  const initial = pendingCatalog()
  vi.mocked(platformClient.catalog.list).mockReturnValueOnce(initial.promise)
  const loading = store.refreshLocalCatalog()
  expect(store.catalogLoading).toBe(true)
  expect(store.findWorkspace(workspaceId)).toBeNull()
  initial.resolve(catalogFixture())
  await loading
  const workspace = store.findWorkspace(workspaceId)!.workspace
  expect(store.catalogLoading).toBe(false)
  const background = pendingCatalog()
  vi.mocked(platformClient.catalog.list).mockReturnValueOnce(background.promise)
  changed()
  expect(store.catalogLoading).toBe(false)
  expect(store.findWorkspace(workspaceId)!.workspace).toBe(workspace)
  expect(store.newSessionTarget!.workspace!.id).toBe(workspaceId)
  const updated = catalogFixture()
  updated.workspaces[0]!.name = "Updated by another client"
  background.resolve(updated)
  await vi.waitFor(() => expect(store.findWorkspace(workspaceId)?.workspace.name).toBe("Updated by another client"))
  expect(store.catalogLoading).toBe(false)
})

test("background failure and recovery retain visible content without hiding the error or enabling writes early", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  vi.mocked(platformClient.catalog.list).mockRejectedValueOnce(new Error("Connection lost"))
  await store.refreshLocalCatalog()
  expect(store.catalogError).toBe("Connection lost")
  expect(store.canManageCatalog).toBe(false)
  const recovery = pendingCatalog()
  vi.mocked(platformClient.catalog.list).mockReturnValueOnce(recovery.promise)
  const refreshing = store.refreshLocalCatalog()
  expect(store.catalogLoading).toBe(false)
  expect(store.catalogError).toBe("Connection lost")
  expect(store.canManageCatalog).toBe(false)
  expect(store.findWorkspace(workspaceId)?.workspace.name).toBe("storefront")
  recovery.resolve(catalogFixture())
  await refreshing
  expect(store.catalogError).toBeNull()
  expect(store.canManageCatalog).toBe(true)
})

test("selecting a different machine starts with its own initial loading state and no previous workspace", async () => {
  const first = setup()
  await first.refreshLocalCatalog()
  const host = getClient()
  configureClient({ ...host, target: { id: "another-machine", local: false } })
  try {
    setActivePinia(createPinia())
    const next = setup()
    const initial = pendingCatalog()
    vi.mocked(platformClient.catalog.list).mockReturnValueOnce(initial.promise)
    const loading = next.refreshLocalCatalog()
    expect(next.targetId).toBe("another-machine")
    expect(next.catalogLoading).toBe(true)
    expect(next.catalogIdentity).toBeNull()
    expect(next.findWorkspace(workspaceId)).toBeNull()
    expect(first.findWorkspace(workspaceId)?.workspace.name).toBe("storefront")
    initial.resolve({ teamId: "2", machineId: "3", machineName: "another", workspaces: [], sessions: [] })
    await loading
    expect(next.catalogLoading).toBe(false)
    expect(next.catalogIdentity).toEqual({ teamId: "2", machineId: "3" })
  } finally { configureClient(host) }
})
