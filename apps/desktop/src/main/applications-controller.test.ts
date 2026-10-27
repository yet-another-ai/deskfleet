import { expect, test, vi } from "vitest"
import type { AccountState, CentralApi, LocalEnrollment } from "@deskfleet/client/central"
import type { CatalogSnapshot } from "@deskfleet/client/catalog"
import { invokeApplications, LocalApplicationsController } from "./applications-controller.ts"

const request = { applicationId: "vscode", machineId: "registered-local", workspaceId: "12" }

function setup() {
  const account: AccountState = { serverUrl: "https://fleet.example", user: { id: "user", name: "User" }, siteAdmin: false }
  const local: LocalEnrollment = {
    configured: true, connected: true, revoked: false, serverUrl: account.serverUrl,
    machineId: "registered-local", teamId: "registered-team", machineName: "My computer",
    identity: { originId: "local-origin", machineId: "1" },
  }
  const snapshot: CatalogSnapshot = {
    teamId: "1", machineId: "1", machineName: "My computer", sessions: [],
    workspaces: [{ id: "12", name: "Project", worktrees: [
      { id: "14", workspaceId: "12", sessionId: "16", directories: [{ path: "/generated/session" }] },
      { id: "13", workspaceId: "12", directories: [{ path: "/code/project with spaces" }, { path: "/code/second" }] },
    ] }],
  }
  const replica = structuredClone(snapshot)
  const central = {
    status: vi.fn(async () => account),
    catalog: vi.fn(async () => ({ machineId: "registered-local", snapshot: replica, lastObservedAt: "2026-10-28T00:00:00Z" })),
    rpc: async <T>(_machineId: string, _method: string, _params: unknown): Promise<T> => snapshot as T,
  } satisfies Pick<CentralApi, "status" | "catalog" | "rpc">
  const rpc = vi.spyOn(central, "rpc")
  const launcher = { scan: vi.fn(async () => [{ id: "vscode", name: "VS Code", kind: "editor" as const }]), open: vi.fn(async () => {}) }
  const enrollment = vi.fn(async () => local)
  const api = new LocalApplicationsController(central, enrollment, launcher)
  return { api, account, local, snapshot, replica, central, rpc, launcher, enrollment }
}

test("opens the Workspace's ordered main directories, independently of Session worktrees", async () => {
  const f = setup()
  await f.api.openWorkspace(request)
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith("registered-local", "catalogList", {})
  expect(f.launcher.open).toHaveBeenLastCalledWith("vscode", "/code/project with spaces")
  await f.api.openWorkspace({ ...request, applicationId: "terminal", directoryIndex: 1 })
  expect(f.launcher.open).toHaveBeenLastCalledWith("terminal", "/code/second")
  await f.api.openWorkspace({ ...request, applicationId: "file-manager" })
  expect(f.launcher.open).toHaveBeenLastCalledWith("file-manager", "/code/project with spaces")
  expect(f.central.catalog).not.toHaveBeenCalled()
})

test("a newly created Workspace opens before it reaches the central replica", async () => {
  const f = setup()
  f.replica.workspaces = []
  await f.api.openWorkspace(request)
  expect(f.launcher.open).toHaveBeenCalledExactlyOnceWith("vscode", "/code/project with spaces")
  expect(f.central.catalog).not.toHaveBeenCalled()
})

test("directory selection follows the daemon's updated order while the replica is stale", async () => {
  const f = setup()
  f.snapshot.workspaces[0]!.worktrees[1]!.directories.reverse()
  expect(f.replica.workspaces[0]!.worktrees[1]!.directories[0]!.path).toBe("/code/project with spaces")
  await f.api.openWorkspace(request)
  expect(f.launcher.open).toHaveBeenLastCalledWith("vscode", "/code/second")
  await f.api.openWorkspace({ ...request, directoryIndex: 1 })
  expect(f.launcher.open).toHaveBeenLastCalledWith("vscode", "/code/project with spaces")
  expect(f.central.catalog).not.toHaveBeenCalled()
})

test("requires the active local central registration, not a matching daemon database ID", async () => {
  for (const change of [
    (f: ReturnType<typeof setup>) => { f.local.configured = false },
    (f: ReturnType<typeof setup>) => { f.local.revoked = true },
    (f: ReturnType<typeof setup>) => { f.local.machineId = "remote-machine" },
    (f: ReturnType<typeof setup>) => { f.local.machineId = "1" },
    (f: ReturnType<typeof setup>) => { f.local.serverUrl = "https://other.example" },
    (f: ReturnType<typeof setup>) => { delete f.account.user },
  ]) {
    const f = setup()
    change(f)
    await expect(f.api.openWorkspace(request)).rejects.toThrow("local machine")
    expect(f.rpc).not.toHaveBeenCalled()
    expect(f.central.catalog).not.toHaveBeenCalled()
    expect(f.launcher.open).not.toHaveBeenCalled()
  }
})

test("removed directories and Workspaces never fall back to the central replica", async () => {
  const f = setup()
  await expect(f.api.openWorkspace({ ...request, workspaceId: "missing" })).rejects.toThrow("directory is unavailable")
  f.snapshot.workspaces[0]!.worktrees[1]!.directories.pop()
  await expect(f.api.openWorkspace({ ...request, directoryIndex: 1 })).rejects.toThrow("directory is unavailable")
  f.snapshot.workspaces = []
  await expect(f.api.openWorkspace(request)).rejects.toThrow("directory is unavailable")
  expect(f.replica.workspaces[0]!.worktrees[1]!.directories).toHaveLength(2)
  expect(f.central.catalog).not.toHaveBeenCalled()
  expect(f.launcher.open).not.toHaveBeenCalled()
})

test.each(["Team access denied", "Machine is offline"])("%s never falls back to the central replica", async message => {
  const f = setup()
  f.rpc.mockRejectedValueOnce(new Error(message))
  await expect(f.api.openWorkspace(request)).rejects.toThrow(message)
  expect(f.central.catalog).not.toHaveBeenCalled()
  expect(f.launcher.open).not.toHaveBeenCalled()
})

test("rejects remote targets and live catalogs from a different daemon", async () => {
  const f = setup()
  await expect(f.api.openWorkspace({ ...request, machineId: "remote-machine" })).rejects.toThrow("local machine")
  expect(f.rpc).not.toHaveBeenCalled()
  f.snapshot.machineId = "other-local-id"
  await expect(f.api.openWorkspace(request)).rejects.toThrow("Workspace machine does not match")
  expect(f.central.catalog).not.toHaveBeenCalled()
  expect(f.launcher.open).not.toHaveBeenCalled()
})

test("launch failures are returned and each scan refreshes the installed choices", async () => {
  const f = setup()
  expect(await f.api.scan()).toEqual([{ id: "vscode", name: "VS Code", kind: "editor" }])
  f.launcher.scan.mockResolvedValueOnce([])
  expect(await f.api.scan()).toEqual([])
  f.launcher.open.mockRejectedValueOnce(new Error("Editor is no longer installed"))
  await expect(f.api.openWorkspace(request)).rejects.toThrow("no longer installed")
})

test("the IPC contract accepts IDs and a directory index without forwarding commands or paths", async () => {
  const f = setup()
  await invokeApplications(f.api, "openWorkspace", { ...request, path: "/unexpected", command: "unexpected" })
  expect(f.launcher.open).toHaveBeenCalledExactlyOnceWith("vscode", "/code/project with spaces")
  for (const directoryIndex of [-1, 0.5, "0", null, NaN, Infinity]) {
    await expect(invokeApplications(f.api, "openWorkspace", { ...request, directoryIndex })).rejects.toThrow("directory index")
  }
  for (const input of [null, [], {}, { ...request, applicationId: "" }, { ...request, machineId: "x\0" }]) {
    await expect(invokeApplications(f.api, "openWorkspace", input)).rejects.toThrow()
  }
  await expect(invokeApplications(f.api, "exec", request)).rejects.toThrow("Unknown")
  expect(f.launcher.open).toHaveBeenCalledOnce()
  await expect(invokeApplications(f.api, "scan", undefined)).resolves.toEqual([{ id: "vscode", name: "VS Code", kind: "editor" }])
})
