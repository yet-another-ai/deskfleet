import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import type { LocalAgentState, DesktopPermissionKind, DesktopPermissionsState } from "../../../../packages/client/src/local-agent.ts"
import type { LocalNetworkAccessRequest } from "../../../../packages/client/src/onboarding.ts"
import type { WindowsDesktopServiceState } from "../../../../packages/client/src/windows-desktop-service.ts"
import { establishedDesktopProfile, OnboardingController } from "./onboarding-controller.ts"

const macPermissions = { permissionSteps: ["localNetwork", "fullDiskAccess", "screenCapture", "accessibility"] }
const waylandPermissions = { permissionSteps: ["screenCapture", "accessibility"] }
const windowsPermissions = { permissionSteps: ["windowsDesktopService"] }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(platform: NodeJS.Platform = "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-onboarding-"))
  directories.push(directory)
  const path = join(directory, "onboarding.json")
  const permissions: DesktopPermissionsState = { fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } }
  const state: LocalAgentState = { enabled: true, status: "stopped", ...(platform === "linux" ? { linuxDesktopBackend: "wayland" as const } : {}) }
  const localAgent = {
    state,
    setEnabled: vi.fn(async (enabled: boolean): Promise<LocalAgentState> => {
      state.enabled = enabled
      state.status = enabled ? "running" : "stopped"
      return { ...state }
    }),
    refreshPermissions: vi.fn(async () => permissions),
    requestPermission: vi.fn(async (_permission: DesktopPermissionKind) => permissions),
  }
  const localNetwork = {
    request: vi.fn(async (): Promise<LocalNetworkAccessRequest> => "attempted"),
    openSettings: vi.fn(async () => {}),
  }
  const serviceState: WindowsDesktopServiceState = { available: true, installed: false, running: false }
  const windowsDesktopService = {
    get: vi.fn(async () => serviceState),
    setEnabled: vi.fn(async (_enabled: boolean) => ({ ...serviceState, installed: true, running: true })),
  }
  const options = { path, platform, localAgent, localNetwork, windowsDesktopService }
  const controller = new OnboardingController(options)
  return {
    ...options, controller, restart: () => new OnboardingController(options),
    async choose(enabled = true) {
      await controller.advanceAccount()
      return controller.setMachineControlEnabled(enabled)
    },
  }
}

test.each(["darwin", "linux", "win32"] as const)("%s starts with sign-in and a persisted machine-control choice before any permissions", async platform => {
  const f = await fixture(platform)
  expect(await f.controller.get()).toMatchObject({ step: "account", permissionSteps: [] })
  await expect(f.controller.permissions()).rejects.toThrow("permission step")
  await expect(f.controller.requestPermission("screenCapture")).rejects.toThrow("step")
  await expect(f.controller.setMachineControlEnabled(true)).rejects.toThrow("step has changed")
  expect(await f.controller.advanceAccount()).toMatchObject({ step: "machineControl", permissionSteps: [] })
  expect(await f.restart().get()).toMatchObject({ step: "machineControl", permissionSteps: [] })
  expect(f.localAgent.setEnabled).not.toHaveBeenCalled()
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect(f.localNetwork.request).not.toHaveBeenCalled()
  expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
  const selected = await f.controller.setMachineControlEnabled(true)
  expect(selected.step).toBe(platform === "darwin" ? "localNetwork" : platform === "linux" ? "screenCapture" : "windowsDesktopService")
  expect(f.localAgent.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(await f.restart().get()).toEqual(selected)
})

test.each(["linux", "win32"] as const)("declining %s machine control finishes without querying or requesting host permissions", async platform => {
  const f = await fixture(platform)
  expect(await f.choose(false)).toMatchObject({ step: "complete", permissionSteps: [] })
  expect(f.localAgent.setEnabled).toHaveBeenCalledExactlyOnceWith(false)
  expect(f.localAgent.state.enabled).toBe(false)
  expect(await f.restart().get()).toMatchObject({ step: "complete", permissionSteps: [] })
  expect(await f.controller.permissions()).toEqual({})
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
  expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
})

test("macOS client keeps local network access when machine control is declined", async () => {
  const f = await fixture()
  expect(await f.choose(false)).toEqual({ step: "localNetwork", permissionSteps: ["localNetwork"] })
  expect(await f.controller.permissions()).toEqual({ localNetwork: "not-requested" })
  expect(f.localNetwork.request).not.toHaveBeenCalled()
  expect(await f.controller.requestPermission("localNetwork")).toEqual({ localNetwork: "attempted" })
  expect(await f.controller.advancePermission("localNetwork")).toEqual({ step: "complete", permissionSteps: ["localNetwork"] })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  await expect(f.controller.requestPermission("screenCapture")).rejects.toThrow("unavailable")
})

test("startup or stop failure keeps the machine choice available to retry", async () => {
  const f = await fixture("linux")
  await f.controller.advanceAccount()
  f.localAgent.setEnabled.mockResolvedValueOnce({ enabled: true, status: "error", error: "Daemon startup failed" })
  await expect(f.controller.setMachineControlEnabled(true)).rejects.toThrow("Daemon startup failed")
  expect(await f.restart().get()).toMatchObject({ step: "machineControl", permissionSteps: [] })
  f.localAgent.setEnabled.mockResolvedValueOnce({ enabled: false, status: "error", error: "Shutdown failed" })
  await expect(f.controller.setMachineControlEnabled(false)).rejects.toThrow("Shutdown failed")
  expect(await f.controller.get()).toMatchObject({ step: "machineControl" })
  expect(await f.controller.setMachineControlEnabled(false)).toMatchObject({ step: "complete" })
})

test("macOS permission progress resumes after restart and completes after the last permission", async () => {
  const f = await fixture()
  await f.choose()
  await f.controller.advancePermission("localNetwork")
  expect(await f.controller.permissions()).toMatchObject({ fullDiskAccessPermission: { status: "denied" } })
  await f.controller.requestPermission("fullDiskAccess")
  expect(f.localAgent.requestPermission).toHaveBeenCalledExactlyOnceWith("fullDiskAccess")
  expect(await f.controller.advancePermission("fullDiskAccess")).toEqual({ ...macPermissions, step: "screenCapture" })
  const resumed = f.restart()
  expect(await resumed.get()).toEqual({ ...macPermissions, step: "screenCapture" })
  await resumed.advancePermission("screenCapture")
  expect(await resumed.advancePermission("accessibility")).toEqual({ ...macPermissions, step: "complete" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "complete" })
})

test.each(["attempted", "unavailable", "not-required"] as const)("macOS reports a %s request without claiming authorization or persisting an attempt", async result => {
  const f = await fixture()
  await f.choose()
  f.localNetwork.request.mockResolvedValue(result)
  expect(await f.controller.requestPermission("localNetwork")).toEqual({ localNetwork: result })
  expect(await f.controller.permissions()).toEqual({ localNetwork: result })
  expect(await f.restart().permissions()).toEqual({ localNetwork: "not-requested" })
  expect(f.localNetwork.request).toHaveBeenCalledOnce()
})

test("network guidance can be skipped and failed requests retried without advancing", async () => {
  const f = await fixture()
  await f.choose()
  await f.controller.openLocalNetworkSettings()
  f.localNetwork.request.mockRejectedValueOnce(new Error("Network request failed"))
  await expect(f.controller.requestPermission("localNetwork")).rejects.toThrow("Network request failed")
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "localNetwork" })
  expect(await f.controller.requestPermission("localNetwork")).toEqual({ localNetwork: "attempted" })
  await f.controller.advancePermission("localNetwork")
  await expect(f.controller.openLocalNetworkSettings()).rejects.toThrow("step has changed")
  await expect(f.controller.requestPermission("localNetwork")).rejects.toThrow("step has changed")
  expect(f.localNetwork.openSettings).toHaveBeenCalledOnce()
})

test("Linux guides linked Portal permissions and resumes the saved selection", async () => {
  const f = await fixture("linux")
  await f.choose()
  f.localAgent.refreshPermissions.mockResolvedValue({ fullDiskAccessPermission: { status: "not-required" }, screenCapturePermission: { status: "requesting" }, accessibilityPermission: { status: "requesting" } })
  expect(await f.controller.permissions()).toMatchObject({ screenCapturePermission: { status: "requesting" } })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  await expect(f.controller.requestPermission("fullDiskAccess")).rejects.toThrow("step has changed")
  await f.controller.requestPermission("screenCapture")
  await f.controller.advancePermission("screenCapture")
  const resumed = f.restart()
  expect(await resumed.get()).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "accessibility" })
  await resumed.requestPermission("accessibility")
  expect(await resumed.advancePermission("accessibility")).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "complete" })
})

test("Windows service setup checks silently, installs explicitly, and supports elevation retry", async () => {
  const f = await fixture("win32")
  expect(await f.choose()).toEqual({ ...windowsPermissions, step: "windowsDesktopService" })
  expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
  expect(await f.controller.permissions()).toEqual({ windowsDesktopService: { available: true, installed: false, running: false } })
  expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
  f.windowsDesktopService.setEnabled.mockRejectedValueOnce(new Error("Administrator approval was cancelled"))
  await expect(f.controller.requestPermission("windowsDesktopService")).rejects.toThrow("cancelled")
  expect(await f.restart().get()).toEqual({ ...windowsPermissions, step: "windowsDesktopService" })
  expect(await f.controller.requestPermission("windowsDesktopService")).toMatchObject({ windowsDesktopService: { running: true } })
  expect(f.windowsDesktopService.setEnabled).toHaveBeenCalledTimes(2)
  expect(await f.controller.advancePermission("windowsDesktopService")).toEqual({ ...windowsPermissions, step: "complete" })
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("Windows service setup can be skipped in builds without a helper", async () => {
  const f = await fixture("win32")
  await f.choose()
  const unavailable = new OnboardingController({ ...f, windowsDesktopService: undefined })
  expect(await unavailable.permissions()).toEqual({ windowsDesktopService: { available: false, installed: false, running: false } })
  await expect(unavailable.requestPermission("windowsDesktopService")).rejects.toThrow("unavailable")
  expect(await unavailable.advancePermission("windowsDesktopService")).toEqual({ ...windowsPermissions, step: "complete" })
  expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
})

test("completed setup exposes only applicable permission actions without repeating the choice", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ step: "complete" }))
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "complete" })
  await f.controller.requestPermission("accessibility")
  await f.controller.requestPermission("localNetwork")
  await f.controller.openLocalNetworkSettings()
  expect(await f.controller.permissions()).toMatchObject({ localNetwork: "attempted", fullDiskAccessPermission: { status: "denied" } })
  await expect(f.controller.advanceAccount()).rejects.toThrow("step has changed")
  await expect(f.controller.setMachineControlEnabled(true)).rejects.toThrow("step has changed")
  await expect(f.controller.advancePermission("fullDiskAccess")).rejects.toThrow("step has changed")
  f.localAgent.state.enabled = false
  expect(await f.controller.permissions()).toEqual({ localNetwork: "attempted" })
  await expect(f.controller.requestPermission("screenCapture")).rejects.toThrow("unavailable")
})

test.each(["linux", "win32"] as const)("completed %s setup rejects irrelevant permissions", async platform => {
  const f = await fixture(platform)
  await writeFile(f.path, JSON.stringify({ step: "complete" }))
  expect(await f.controller.permissions()).toMatchObject(platform === "linux" ? { screenCapturePermission: { status: "denied" } } : { windowsDesktopService: { available: true, installed: false, running: false } })
  await f.controller.requestPermission(platform === "linux" ? "accessibility" : "windowsDesktopService")
  await expect(f.controller.requestPermission("fullDiskAccess")).rejects.toThrow("unavailable")
  await expect(f.controller.openLocalNetworkSettings()).rejects.toThrow("step has changed")
})

test("failed progress writes preserve the active step", async () => {
  const f = await fixture()
  await f.controller.get()
  await mkdir(`${f.path}.tmp`)
  await expect(f.controller.advanceAccount()).rejects.toThrow()
  expect(await f.controller.get()).toEqual({ permissionSteps: [], step: "account" })
  expect(await f.restart().get()).toEqual({ permissionSteps: [], step: "account" })
})

test("concurrent transitions cannot skip the machine choice or an active permission request", async () => {
  const f = await fixture()
  await f.controller.advanceAccount()
  let finishChoice!: (value: LocalAgentState) => void
  f.localAgent.setEnabled.mockImplementationOnce(() => new Promise(done => { finishChoice = done }))
  const choosing = f.controller.setMachineControlEnabled(true)
  await vi.waitFor(() => expect(f.localAgent.setEnabled).toHaveBeenCalledOnce())
  await expect(f.controller.setMachineControlEnabled(false)).rejects.toThrow("changing state")
  finishChoice({ enabled: true, status: "running" })
  await choosing
  await f.controller.advancePermission("localNetwork")
  let resolve!: (value: DesktopPermissionsState) => void
  f.localAgent.requestPermission.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const requesting = f.controller.requestPermission("fullDiskAccess")
  await vi.waitFor(() => expect(f.localAgent.requestPermission).toHaveBeenCalledOnce())
  await expect(f.controller.advancePermission("fullDiskAccess")).rejects.toThrow("changing state")
  resolve({ fullDiskAccessPermission: { status: "granted" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "denied" } })
  await requesting
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "fullDiskAccess" })
})

test.each(["account.json", "settings.json"])("an established profile with %s keeps its existing preference and completed setup", async name => {
  const f = await fixture()
  const directory = join(f.path, "..")
  expect(await establishedDesktopProfile(directory)).toBe(false)
  await writeFile(join(directory, name), "{}")
  expect(await establishedDesktopProfile(directory)).toBe(true)
  const migrated = new OnboardingController({ ...f, established: () => establishedDesktopProfile(directory) })
  expect(await migrated.get()).toEqual({ ...macPermissions, step: "complete" })
  expect(await f.restart().get()).toEqual({ ...macPermissions, step: "complete" })
  expect(f.localAgent.setEnabled).not.toHaveBeenCalled()
})

test("invalid progress is reported and old server setup returns to account", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ step: "anything" }))
  await expect(f.controller.get()).rejects.toThrow("Invalid welcome setup progress")
  await writeFile(f.path, JSON.stringify({ step: "server" }))
  expect(await f.restart().get()).toEqual({ permissionSteps: [], step: "account" })
})

test.each(["x11", null] as const)("Linux %s finishes the machine choice without Portal guidance", async backend => {
  const f = await fixture("linux")
  f.localAgent.state.linuxDesktopBackend = backend
  expect(await f.choose()).toEqual({ permissionSteps: [], step: "complete", linuxDesktopBackend: backend })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
})

test("a temporarily disconnected Wayland daemon retains saved permission guidance", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ step: "accessibility" }))
  f.localAgent.state.linuxDesktopBackend = undefined
  f.localAgent.state.status = "error"
  expect(await f.restart().get()).toEqual({ ...waylandPermissions, step: "accessibility" })
  expect(await f.restart().advancePermission("accessibility")).toEqual({ permissionSteps: [], step: "complete" })
})

test("a late X11 hello normalizes saved Portal guidance and lets an in-flight Skip finish", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ step: "screenCapture" }))
  f.localAgent.state.linuxDesktopBackend = undefined
  expect(await f.controller.get()).toEqual({ ...waylandPermissions, step: "screenCapture" })
  f.localAgent.refreshPermissions.mockImplementationOnce(async () => {
    f.localAgent.state.linuxDesktopBackend = "x11"
    return { linuxDesktopBackend: "x11", fullDiskAccessPermission: { status: "not-required" }, screenCapturePermission: { status: "not-required" }, accessibilityPermission: { status: "not-required" } }
  })
  await f.controller.permissions()
  expect(await f.controller.advancePermission("screenCapture")).toEqual({ permissionSteps: [], step: "complete", linuxDesktopBackend: "x11" })
  expect(await f.restart().get()).toEqual({ permissionSteps: [], step: "complete", linuxDesktopBackend: "x11" })
  await expect(f.controller.requestPermission("screenCapture")).rejects.toThrow("unavailable")
})
