import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { LocalAgentController, type LocalAgentConnection, type LocalAgentRuntime } from "./local-agent-controller.ts"
import type { ScreenCapturePermission } from "../shared/local-agent.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(running = false) {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-settings-"))
  directories.push(directory)
  const path = join(directory, "settings.json")
  let disconnect: ((error: Error) => void) | undefined
  let current: LocalAgentConnection | undefined
  let permission: ScreenCapturePermission = { status: "requesting" }
  let permissionChanged: ((permission: ScreenCapturePermission) => void) | undefined
  const shutdown = vi.fn(async () => {
    running = false
    current!.close()
  })
  const runtime: LocalAgentRuntime = {
    connect: vi.fn(async (onDisconnect, onPermissionChanged) => {
      if (!running) throw Object.assign(new Error("Not running"), { code: "ENOENT" })
      disconnect = onDisconnect
      permissionChanged = onPermissionChanged
      let closed = false
      current = {
        get closed() { return closed },
        get screenCapturePermission() { return permission },
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
    permissionChanged: (next: ScreenCapturePermission) => { permission = next; permissionChanged?.(next) },
  }
}

test("fresh settings start the local Agent by default and quitting closes the hosted daemon", async () => {
  const f = await fixture()
  expect(await f.controller.initialize()).toEqual({ enabled: true, status: "running", error: undefined, screenCapturePermission: { status: "requesting" } })
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
  expect(f.controller.state).toMatchObject({ status: "running", screenCapturePermission: { status: "denied" } })
  expect(f.emit).toHaveBeenLastCalledWith(f.controller.state)
  f.permissionChanged({ status: "granted" })
  expect(f.controller.state.screenCapturePermission).toEqual({ status: "granted" })

  await f.controller.setEnabled(false)
  expect(f.controller.state.screenCapturePermission).toBeUndefined()
  f.permissionChanged({ status: "denied" })
  expect(f.controller.state).toMatchObject({ status: "stopped", screenCapturePermission: undefined })

  await f.controller.setEnabled(true)
  expect(f.controller.state.screenCapturePermission).toEqual({ status: "denied" })
  f.disconnect()
  expect(f.controller.state.screenCapturePermission).toBeUndefined()
})

test("a reused daemon supplies its current permission even with auto-start disabled", async () => {
  const f = await fixture(true)
  f.permissionChanged({ status: "granted" })
  await writeFile(f.path, JSON.stringify({ localAgentEnabled: false }))
  expect(await f.controller.initialize()).toMatchObject({ enabled: false, status: "running", screenCapturePermission: { status: "granted" } })
  expect(f.runtime.start).not.toHaveBeenCalled()
  f.controller.detach()
  f.permissionChanged({ status: "denied" })
  expect(f.controller.state.screenCapturePermission).toEqual({ status: "granted" })
})
