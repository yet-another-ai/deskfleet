import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { LocalAgentController, type LocalAgentConnection, type LocalAgentRuntime } from "./local-agent-controller.ts"
import type { DesktopPermission, DesktopPermissionsState } from "../../../../packages/client/src/local-agent.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(running = false) {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-settings-"))
  directories.push(directory)
  const path = join(directory, "settings.json")
  let disconnect: ((error: Error) => void) | undefined
  let current: LocalAgentConnection | undefined
  let permissions: DesktopPermissionsState = { fullDiskAccessPermission: { status: "requesting" }, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } }
  let permissionsChanged: ((permissions: DesktopPermissionsState) => void) | undefined
  const shutdown = vi.fn(async () => {
    running = false
    current!.close()
  })
  const runtime: LocalAgentRuntime = {
    connect: vi.fn(async (onDisconnect, onPermissionsChanged) => {
      if (!running) throw Object.assign(new Error("Not running"), { code: "ENOENT" })
      disconnect = onDisconnect
      permissionsChanged = onPermissionsChanged
      let closed = false
      current = {
        get closed() { return closed },
        get desktopPermissions() { return permissions },
        refreshPermissions: vi.fn(async () => permissions),
        requestPermission: vi.fn(async () => permissions),
        shutdown,
        close() { closed = true; onDisconnect(new Error("Disconnected")) },
      }
      return current
    }),
    start: vi.fn(async () => { running = true }),
    waitForShutdown: vi.fn(async () => {}),
    close: vi.fn(async () => { running = false }),
  }
  const emit = vi.fn()
  return {
    path, runtime, emit, shutdown,
    controller: new LocalAgentController(path, runtime, emit),
    disconnect: () => { running = false; disconnect?.(new Error("Daemon exited")) },
    fullDiskAccessChanged: (next: DesktopPermission) => { permissions = { ...permissions, fullDiskAccessPermission: next }; permissionsChanged?.(permissions) },
    permissionChanged: (next: DesktopPermission) => { permissions = { ...permissions, screenCapturePermission: next }; permissionsChanged?.(permissions) },
    accessibilityChanged: (next: DesktopPermission) => { permissions = { ...permissions, accessibilityPermission: next }; permissionsChanged?.(permissions) },
  }
}

test("fresh settings start the local Agent by default and quitting closes the hosted daemon", async () => {
  const f = await fixture()
  expect(await f.controller.initialize()).toEqual({ enabled: true, status: "running", error: undefined, fullDiskAccessPermission: { status: "requesting" }, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } })
  expect(f.runtime.start).toHaveBeenCalledOnce()
  await f.controller.close()
  expect(f.runtime.close).toHaveBeenCalledOnce()
  expect(f.shutdown).not.toHaveBeenCalled()
})

test("an authenticated existing daemon is reused without hosting another", async () => {
  const f = await fixture(true)
  await f.controller.initialize()
  expect(f.runtime.start).not.toHaveBeenCalled()
  expect(f.controller.state.status).toBe("running")
})

test("welcome defers daemon startup until the server step is saved", async () => {
  const f = await fixture()
  expect(await f.controller.initialize({ start: false })).toEqual({ enabled: true, status: "stopped" })
  expect(f.runtime.connect).not.toHaveBeenCalled()
  expect(f.runtime.start).not.toHaveBeenCalled()
  expect((await f.controller.startIfEnabled()).status).toBe("running")
  expect(f.runtime.start).toHaveBeenCalledOnce()
})

test("welcome preserves disabled startup and cannot request access through a stopped daemon", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ localAgentEnabled: false }))
  expect(await f.controller.initialize({ start: false })).toEqual({ enabled: false, status: "stopped" })
  expect((await f.controller.startIfEnabled()).status).toBe("stopped")
  await expect(f.controller.requestPermission("fullDiskAccess")).rejects.toThrow("disabled")
  expect(f.runtime.start).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ localAgentEnabled: false })
})

test("explicit permission reads and requests update local Agent settings", async () => {
  const f = await fixture()
  await f.controller.initialize({ start: false })
  const result = await f.controller.refreshPermissions()
  expect(f.runtime.start).toHaveBeenCalledOnce()
  expect(f.controller.state).toMatchObject(result)
  const connection = await vi.mocked(f.runtime.connect).mock.results.at(-1)!.value
  expect(connection.refreshPermissions).toHaveBeenCalledOnce()
  await f.controller.requestPermission("accessibility")
  expect(connection.requestPermission).toHaveBeenCalledExactlyOnceWith("accessibility")
})

test.each(["refreshPermissions", "requestPermission"] as const)("pending %s cannot restore permissions during shutdown or clear its error", async method => {
  const f = await fixture(true)
  await f.controller.initialize()
  const connection = await vi.mocked(f.runtime.connect).mock.results.at(-1)!.value
  const permissions = connection.desktopPermissions
  let respond!: (permissions: DesktopPermissionsState) => void
  vi.mocked(connection[method]).mockImplementation(() => new Promise(resolve => { respond = resolve }))
  const response = method === "refreshPermissions" ? f.controller.refreshPermissions() : f.controller.requestPermission("fullDiskAccess")
  await vi.waitFor(() => expect(connection[method]).toHaveBeenCalledOnce())
  let failShutdown!: (error: Error) => void
  f.shutdown.mockImplementationOnce(() => new Promise((_resolve, reject) => { failShutdown = reject }))
  const stopping = f.controller.setEnabled(false)
  await vi.waitFor(() => expect(f.shutdown).toHaveBeenCalledOnce())
  expect(f.controller.state).toMatchObject({ status: "stopping", fullDiskAccessPermission: undefined })
  respond(permissions)
  await response
  expect(f.controller.state).toMatchObject({ status: "stopping", fullDiskAccessPermission: undefined, screenCapturePermission: undefined, accessibilityPermission: undefined })
  const afterFailure = method === "refreshPermissions" ? f.controller.refreshPermissions() : f.controller.requestPermission("fullDiskAccess")
  await vi.waitFor(() => expect(connection[method]).toHaveBeenCalledTimes(2))
  failShutdown(new Error("Shutdown failed"))
  await stopping
  respond(permissions)
  await afterFailure
  expect(f.controller.state).toMatchObject({ status: "error", error: "Shutdown failed", fullDiskAccessPermission: undefined, screenCapturePermission: undefined, accessibilityPermission: undefined })
})

test("switching off shuts down, waits for cleanup, and persists across launches", async () => {
  const f = await fixture()
  await f.controller.initialize()
  expect((await f.controller.setEnabled(false)).status).toBe("stopped")
  expect(f.shutdown).toHaveBeenCalledOnce()
  expect(f.runtime.waitForShutdown).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ localAgentEnabled: false })
  const next = new LocalAgentController(f.path, f.runtime)
  expect(await next.initialize()).toEqual({ enabled: false, status: "stopped", error: undefined })
  expect(f.runtime.start).toHaveBeenCalledOnce()
  expect((await next.setEnabled(true)).status).toBe("running")
  expect(f.runtime.start).toHaveBeenCalledTimes(2)
})

test("disabled auto-start does not terminate a separately running daemon on launch", async () => {
  const f = await fixture(true)
  await writeFile(f.path, JSON.stringify({ localAgentEnabled: false }))
  expect((await f.controller.initialize()).status).toBe("running")
  expect(f.shutdown).not.toHaveBeenCalled()
  expect(f.runtime.start).not.toHaveBeenCalled()
})

test("startup errors preserve enabled intent and can be retried", async () => {
  const f = await fixture()
  vi.mocked(f.runtime.start).mockRejectedValueOnce(new Error("Local daemon is already running"))
  expect(await f.controller.initialize()).toEqual({ enabled: true, status: "error", error: "Local daemon is already running" })
  expect((await f.controller.setEnabled(true)).status).toBe("running")
  f.disconnect()
  expect(f.controller.state).toEqual({ enabled: true, status: "error", error: "Daemon exited" })
})

test("authentication errors do not launch over an existing daemon", async () => {
  const f = await fixture(true)
  vi.mocked(f.runtime.connect).mockRejectedValue(new Error("Authentication failed"))
  expect((await f.controller.initialize()).error).toBe("Authentication failed")
  expect(f.runtime.start).not.toHaveBeenCalled()
})

test("setting changes cannot overlap while daemon shutdown is pending", async () => {
  const f = await fixture(true)
  await f.controller.initialize()
  let release!: () => void
  vi.mocked(f.runtime.waitForShutdown).mockImplementation(() => new Promise(resolve => { release = resolve }))
  const stopping = f.controller.setEnabled(false)
  await vi.waitFor(() => expect(f.runtime.waitForShutdown).toHaveBeenCalledOnce())
  await expect(f.controller.setEnabled(true)).rejects.toThrow("changing state")
  release()
  await stopping
  expect(f.controller.state.status).toBe("stopped")
})

test("invalid settings do not silently enable the Agent", async () => {
  const f = await fixture()
  await writeFile(f.path, '{"localAgentEnabled":"false"}')
  expect((await f.controller.initialize()).error).toBe("Invalid desktop settings")
  expect(f.runtime.start).not.toHaveBeenCalled()
})

test("permission outcomes update Settings without changing Agent availability", async () => {
  const f = await fixture(true)
  await f.controller.initialize()
  f.permissionChanged({ status: "denied" })
  f.accessibilityChanged({ status: "granted" })
  f.fullDiskAccessChanged({ status: "denied" })
  expect(f.controller.state).toMatchObject({ status: "running", screenCapturePermission: { status: "denied" } })
  expect(f.controller.state.accessibilityPermission).toEqual({ status: "granted" })
  expect(f.controller.state.fullDiskAccessPermission).toEqual({ status: "denied" })
  expect(f.emit).toHaveBeenLastCalledWith(f.controller.state)
  f.permissionChanged({ status: "granted" })
  expect(f.controller.state.screenCapturePermission).toEqual({ status: "granted" })

  await f.controller.setEnabled(false)
  expect(f.controller.state.screenCapturePermission).toBeUndefined()
  expect(f.controller.state.accessibilityPermission).toBeUndefined()
  expect(f.controller.state.fullDiskAccessPermission).toBeUndefined()
  f.permissionChanged({ status: "denied" })
  f.accessibilityChanged({ status: "denied" })
  f.fullDiskAccessChanged({ status: "granted" })
  expect(f.controller.state).toMatchObject({ status: "stopped", fullDiskAccessPermission: undefined, screenCapturePermission: undefined, accessibilityPermission: undefined })

  await f.controller.setEnabled(true)
  expect(f.controller.state.screenCapturePermission).toEqual({ status: "denied" })
  expect(f.controller.state.accessibilityPermission).toEqual({ status: "denied" })
  expect(f.controller.state.fullDiskAccessPermission).toEqual({ status: "granted" })
  f.disconnect()
  expect(f.controller.state.screenCapturePermission).toBeUndefined()
  expect(f.controller.state.accessibilityPermission).toBeUndefined()
  expect(f.controller.state.fullDiskAccessPermission).toBeUndefined()
})

test("a reused daemon supplies its current permission even with auto-start disabled", async () => {
  const f = await fixture(true)
  f.permissionChanged({ status: "granted" })
  f.accessibilityChanged({ status: "denied" })
  f.fullDiskAccessChanged({ status: "denied" })
  await writeFile(f.path, JSON.stringify({ localAgentEnabled: false }))
  expect(await f.controller.initialize()).toMatchObject({ enabled: false, status: "running", fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "denied" } })
  expect(f.runtime.start).not.toHaveBeenCalled()
  f.controller.detach()
  f.permissionChanged({ status: "denied" })
  f.accessibilityChanged({ status: "granted" })
  f.fullDiskAccessChanged({ status: "granted" })
  expect(f.controller.state.screenCapturePermission).toEqual({ status: "granted" })
  expect(f.controller.state.accessibilityPermission).toEqual({ status: "denied" })
  expect(f.controller.state.fullDiskAccessPermission).toEqual({ status: "denied" })
})

test("permission events from an old connection cannot replace the restarted daemon's state", async () => {
  const f = await fixture(true)
  await f.controller.initialize()
  const oldPermissionEvent = vi.mocked(f.runtime.connect).mock.calls[0]![1]
  await f.controller.setEnabled(false)
  f.permissionChanged({ status: "denied" })
  f.accessibilityChanged({ status: "error", error: "Accessibility request failed" })
  f.fullDiskAccessChanged({ status: "denied" })
  await f.controller.setEnabled(true)
  oldPermissionEvent({ fullDiskAccessPermission: { status: "granted" }, screenCapturePermission: { status: "granted" }, accessibilityPermission: { status: "granted" } })
  expect(f.controller.state).toMatchObject({ status: "running", fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "error", error: "Accessibility request failed" } })
})
