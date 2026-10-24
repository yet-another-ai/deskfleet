import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { catalogFixture, sessionId, sessionWorktreeId, mainWorktreeId, workspaceId } from "../test/catalog.ts"
import { useFleetStore } from "./fleet.ts"
import { useAgentSessionsStore } from "./agent-sessions.ts"
import { agentSnapshot } from "../test/agent.ts"

const stores: ReturnType<typeof useFleetStore>[] = []
let changed: () => void
beforeEach(() => {
  setActivePinia(createPinia())
  vi.spyOn(window.deskfleet.catalog, "onChanged").mockImplementation(listener => { changed = listener; return () => {} })
  vi.spyOn(window.deskfleet.catalog, "list").mockResolvedValue(catalogFixture())
})
afterEach(() => {
  for (const store of stores.splice(0)) store.$dispose()
  vi.restoreAllMocks()
})
function setup() { const store = useFleetStore(); stores.push(store); return store }

test("maps configured directories onto the workspace and exposes only Session-owned worktrees", async () => {
  const store = setup()
  expect(store.machines).toHaveLength(1)
  expect(store.newSessionTarget).toBeNull()
  await store.refreshLocalCatalog()
  expect(store.catalogIdentity).toEqual({ teamId: "1", machineId: "9007199254740999" })
  expect(store.machines[0]!.id).toBe("local-daemon")
  const workspace = store.findWorkspace(workspaceId)!.workspace
  expect(workspace.name).toBe("storefront")
  expect(workspace.directories.map(({ path }) => path)).toEqual(["/code/web", "/code/api"])
  expect(workspace.directories[0]!.git).toBeUndefined()
  expect(workspace).not.toHaveProperty("worktrees")
  expect(store.newSessionTarget?.workspace.id).toBe(workspaceId)
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
  session.worktree!.terminals.push({ id: "session-terminal", title: "shell", cwd: "/worktrees/api/session" })
  expect(store.findTerminal("session-terminal")?.session).toBe(session)
  expect(store.findTerminal("session-terminal")?.worktree).toBe(session.worktree)
})

test("workspace creation selects its configured directories without exposing an empty main worktree", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const paths = [{ path: "/code/new" }]
  const created = { id: "20", name: "new workspace", worktrees: [{ id: "21", workspaceId: "20", directories: paths }] }
  const create = vi.spyOn(window.deskfleet.catalog, "createWorkspace").mockResolvedValue(created)
  await store.createWorkspace("new workspace", paths)
  expect(create).toHaveBeenCalledWith("new workspace", paths)
  expect(store.newSessionTarget?.workspace.id).toBe("20")
  expect(store.newSessionTarget?.workspace.directories.map(({ path }) => ({ path }))).toEqual(paths)
  expect(store.newSessionTarget?.workspace.sessions).toEqual([])
  expect(store.findWorktree("21")).toBeNull()
})

test("workspace updates replace configured directories and retain Session paths; disconnection keeps the catalog read-only", async () => {
  const store = setup()
  await store.refreshLocalCatalog()
  const updated = catalogFixture().workspaces[0]!
  updated.name = "renamed"
  updated.worktrees[0]!.directories.reverse()
  const update = vi.spyOn(window.deskfleet.catalog, "updateWorkspace").mockResolvedValue(updated)
  const paths = [{ path: "/code/api" }, { path: "/code/web" }]
  await store.updateWorkspace(workspaceId, "renamed", paths)
  expect(update).toHaveBeenCalledWith(workspaceId, "renamed", paths)
  expect(store.findWorkspace(workspaceId)?.workspace.name).toBe("renamed")
  expect(store.findWorkspace(workspaceId)?.workspace.directories.map(({ path }) => path)).toEqual(paths.map(({ path }) => path))
  expect(store.findWorktree(mainWorktreeId)).toBeNull()
  expect(store.findSession(sessionId)?.worktree?.directories.map(({ path }) => path)).toEqual(["/worktrees/api/session"])
  expect(store.newSessionTarget?.workspace.id).toBe(workspaceId)
  vi.mocked(window.deskfleet.catalog.list).mockRejectedValueOnce(new Error("Daemon disconnected"))
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
  vi.mocked(window.deskfleet.catalog.list).mockResolvedValue(updated)
  changed()
  await vi.waitFor(() => expect(store.findWorktree(sessionWorktreeId)).toBeNull())
  expect(store.findSession(sessionId)).toBeNull()
  expect(store.newSessionTarget?.workspace.id).toBe(workspaceId)
  updated.workspaces.push({ id: "20", name: "second", worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code/second" }] }] })
  await store.refreshLocalCatalog()
  store.targetWorkspace("20")
  expect(store.newSessionTarget?.workspace.id).toBe("20")
  const remove = vi.spyOn(window.deskfleet.catalog, "deleteWorkspace").mockResolvedValue()
  await store.deleteWorkspace("20")
  expect(store.newSessionTarget?.workspace.id).toBe(workspaceId)
  await store.deleteWorkspace(workspaceId)
  expect(remove).toHaveBeenCalledWith(workspaceId)
  expect(store.newSessionTarget).toBeNull()
})

test("catalog notifications reconcile a selected workspace removed by another client", async () => {
  const store = setup()
  const snapshot = catalogFixture()
  snapshot.workspaces.push({ id: "20", name: "second", worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code/second" }] }] })
  vi.mocked(window.deskfleet.catalog.list).mockResolvedValue(snapshot)
  await store.refreshLocalCatalog()
  store.targetWorkspace("20")
  vi.mocked(window.deskfleet.catalog.list).mockResolvedValue(catalogFixture())
  changed()
  await vi.waitFor(() => expect(store.newSessionTarget?.workspace.id).toBe(workspaceId))
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
