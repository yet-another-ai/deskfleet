import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import type { LocalAgentState, DesktopPermissionKind, DesktopPermissionsState } from "../../../../packages/client/src/local-agent.ts"
import type { AuvPermissionsState, LocalNetworkAccessRequest } from "../../../../packages/client/src/onboarding.ts"
import type { WindowsDesktopServiceState } from "../../../../packages/client/src/windows-desktop-service.ts"
import { establishedDesktopProfile, OnboardingController } from "./onboarding-controller.ts"

const macPermissions = { permissionSteps: ["localNetwork", "fullDiskAccess", "screenCapture", "accessibility"] }
const waylandPermissions = { permissionSteps: ["screenCapture", "accessibility", "auv"] }
const auvPermissions = { permissionSteps: ["auv"] }
const windowsPermissions = { permissionSteps: ["windowsDesktopService"] }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(platform: NodeJS.Platform = "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-onboarding-"))
  directories.push(directory)
  const path = join(directory, "onboarding.json")
  const permissions: DesktopPermissionsState = { fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } }
  const state: LocalAgentState = { enabled: true, status: "running", ...(platform === "linux" ? { linuxDesktopBackend: "wayland" as const } : {}) }
  const localAgent = {
    state,
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
  const auv = {
    get: vi.fn(async (): Promise<AuvPermissionsState> => ({ status: "not-requested" })),
    request: vi.fn(async (): Promise<AuvPermissionsState> => ({ status: "saved" })),
  }
  const options = { path, platform, localAgent, localNetwork, windowsDesktopService, auv }
  return { ...options, controller: new OnboardingController(options), restart: () => new OnboardingController(options) }
}

test("welcome begins with platform permissions and resumes saved progress after restart", async () => {
  const f = await fixture()
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "localNetwork" })
  expect(await f.controller.permissions()).toEqual({ localNetwork: "not-requested" })
  expect(f.localNetwork.request).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect(await f.controller.requestPermission("localNetwork")).toEqual({ localNetwork: "attempted" })
  expect(f.localNetwork.request).toHaveBeenCalledOnce()
  expect(await f.controller.advancePermission("localNetwork")).toEqual({ ...macPermissions, step: "fullDiskAccess" })
  expect(await f.controller.permissions()).toMatchObject({ fullDiskAccessPermission: { status: "denied" } })
  await f.controller.requestPermission("fullDiskAccess")
  expect(f.localAgent.requestPermission).toHaveBeenCalledExactlyOnceWith("fullDiskAccess")
  expect(await f.controller.advancePermission("fullDiskAccess")).toEqual({ ...macPermissions, step: "screenCapture" })
  const resumed = f.restart()
  expect(await resumed.get()).toEqual({ ...macPermissions, step: "screenCapture" })
  await resumed.advancePermission("screenCapture")
  await resumed.advancePermission("accessibility")
  expect(await resumed.get()).toEqual({ ...macPermissions, step: "account" })
  expect(await resumed.complete()).toEqual({ ...macPermissions, step: "complete" })
  expect(await f.restart().get()).toEqual({ ...macPermissions, step: "complete" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "complete" })
})

test("macOS client requests local network access even when its local Agent is disabled", async () => {
  const f = await fixture()
  f.localAgent.state.enabled = false
  f.localAgent.state.status = "stopped"
  expect(await f.controller.get()).toEqual({ permissionSteps: ["localNetwork"], step: "localNetwork" })
  expect(await f.controller.permissions()).toEqual({ localNetwork: "not-requested" })
  expect(f.localNetwork.request).not.toHaveBeenCalled()
  expect(await f.controller.requestPermission("localNetwork")).toEqual({ localNetwork: "attempted" })
  expect(await f.controller.permissions()).toEqual({ localNetwork: "attempted" })
  expect(f.localNetwork.request).toHaveBeenCalledOnce()
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect(await f.controller.advancePermission("localNetwork")).toEqual({ permissionSteps: ["localNetwork"], step: "account" })
  expect(f.localAgent.state.enabled).toBe(false)
})

test.each(["unavailable", "not-required"] as const)("macOS reports a %s local network request without claiming authorization", async result => {
  const f = await fixture()
  f.localNetwork.request.mockResolvedValue(result)
  expect(await f.controller.requestPermission("localNetwork")).toEqual({ localNetwork: result })
  expect(await f.controller.permissions()).toEqual({ localNetwork: result })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "localNetwork" })
  const restarted = f.restart()
  expect(await restarted.permissions()).toEqual({ localNetwork: "not-requested" })
  expect(f.localNetwork.request).toHaveBeenCalledOnce()
})

test("skipping network guidance never requests access, and settings are limited to its active step", async () => {
  const f = await fixture()
  await f.controller.openLocalNetworkSettings()
  expect(f.localNetwork.openSettings).toHaveBeenCalledOnce()
  await f.controller.advancePermission("localNetwork")
  await expect(f.controller.openLocalNetworkSettings()).rejects.toThrow("step has changed")
  await expect(f.controller.requestPermission("localNetwork")).rejects.toThrow("step has changed")
  expect(f.localNetwork.request).not.toHaveBeenCalled()
  expect(f.localNetwork.openSettings).toHaveBeenCalledOnce()
})

test("a failed local network request can be retried without changing progress", async () => {
  const f = await fixture()
  f.localNetwork.request.mockRejectedValueOnce(new Error("Network request failed"))
  await expect(f.controller.requestPermission("localNetwork")).rejects.toThrow("Network request failed")
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "localNetwork" })
  expect(await f.controller.permissions()).toEqual({ localNetwork: "not-requested" })
  expect(await f.controller.requestPermission("localNetwork")).toEqual({ localNetwork: "attempted" })
})

test("an already completed profile does not restart for the added local network step", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ step: "complete" }))
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "complete" })
  await f.controller.openLocalNetworkSettings()
  expect(f.localNetwork.openSettings).toHaveBeenCalledOnce()
  expect(f.localNetwork.request).not.toHaveBeenCalled()
})

test("Linux guides screen and input access, reuses startup authorization, and resumes after restart", async () => {
  const f = await fixture("linux")
  f.localAgent.refreshPermissions.mockResolvedValue({
    fullDiskAccessPermission: { status: "not-required" },
    screenCapturePermission: { status: "requesting" },
    accessibilityPermission: { status: "requesting" },
  })
  expect(await f.controller.get()).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "screenCapture" })
  expect(await f.controller.permissions()).toMatchObject({ screenCapturePermission: { status: "requesting" } })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  await expect(f.controller.requestPermission("fullDiskAccess")).rejects.toThrow("step has changed")
  f.localAgent.refreshPermissions.mockResolvedValue({
    fullDiskAccessPermission: { status: "not-required" },
    screenCapturePermission: { status: "granted" },
    accessibilityPermission: { status: "granted" },
  })
  expect(await f.controller.permissions()).toMatchObject({ accessibilityPermission: { status: "granted" } })
  expect(await f.controller.advancePermission("screenCapture")).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "accessibility" })
  const resumed = f.restart()
  expect(await resumed.get()).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "accessibility" })
  expect(await resumed.advancePermission("accessibility")).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "auv" })
  expect(await resumed.advancePermission("auv")).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "account" })
  expect(await resumed.complete()).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "complete" })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("Linux welcome retries or defers desktop permissions without adding Full Disk Access", async () => {
  const f = await fixture("linux")
  await f.controller.get()
  await f.controller.requestPermission("screenCapture")
  expect(f.localAgent.requestPermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
  expect(await f.controller.advancePermission("screenCapture")).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "accessibility" })
  await f.controller.requestPermission("accessibility")
  expect(f.localAgent.requestPermission).toHaveBeenLastCalledWith("accessibility")
  expect(await f.controller.advancePermission("accessibility")).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "auv" })
})

test("Windows silently checks the optional service and installs only on an explicit welcome action", async () => {
  const f = await fixture("win32")
  expect(await f.controller.get()).toEqual({ ...windowsPermissions, step: "windowsDesktopService" })
  expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
  expect(await f.controller.permissions()).toEqual({ windowsDesktopService: { available: true, installed: false, running: false } })
  expect(f.windowsDesktopService.get).toHaveBeenCalledOnce()
  expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  await expect(f.controller.requestPermission("localNetwork")).rejects.toThrow("step has changed")
  await expect(f.controller.openLocalNetworkSettings()).rejects.toThrow("step has changed")
  expect(f.localNetwork.request).not.toHaveBeenCalled()
  expect(f.localNetwork.openSettings).not.toHaveBeenCalled()
  expect(await f.controller.requestPermission("windowsDesktopService")).toEqual({ windowsDesktopService: { available: true, installed: true, running: true } })
  expect(f.windowsDesktopService.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  expect(await f.restart().get()).toEqual({ ...windowsPermissions, step: "windowsDesktopService" })
  expect(await f.controller.advancePermission("windowsDesktopService")).toEqual({ ...windowsPermissions, step: "account" })
  expect(await f.restart().get()).toEqual({ ...windowsPermissions, step: "account" })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("Windows service elevation cancellation retains welcome progress and permits retry", async () => {
  const f = await fixture("win32")
  f.windowsDesktopService.setEnabled.mockRejectedValueOnce(new Error("Administrator approval was cancelled"))
  await expect(f.controller.requestPermission("windowsDesktopService")).rejects.toThrow("cancelled")
  expect(await f.restart().get()).toEqual({ ...windowsPermissions, step: "windowsDesktopService" })
  expect(await f.controller.requestPermission("windowsDesktopService")).toMatchObject({ windowsDesktopService: { running: true } })
  expect(f.windowsDesktopService.setEnabled).toHaveBeenCalledTimes(2)
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "windowsDesktopService" })
})

test("Windows service setup can be skipped without elevation, including builds without a helper", async () => {
  const f = await fixture("win32")
  const unavailable = new OnboardingController({ ...f, windowsDesktopService: undefined })
  expect(await unavailable.permissions()).toEqual({ windowsDesktopService: { available: false, installed: false, running: false } })
  await expect(unavailable.requestPermission("windowsDesktopService")).rejects.toThrow("unavailable")
  expect(await unavailable.advancePermission("windowsDesktopService")).toEqual({ ...windowsPermissions, step: "account" })
  expect(await f.restart().get()).toEqual({ ...windowsPermissions, step: "account" })
  expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
  expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("Windows without a local Agent skips service setup and never queries or installs it", async () => {
  const f = await fixture("win32")
  f.localAgent.state.enabled = false
  f.localAgent.state.status = "stopped"
  expect(await f.controller.get()).toEqual({ permissionSteps: [], step: "account" })
  await f.controller.complete()
  expect(await f.controller.permissions()).toEqual({})
  await expect(f.controller.requestPermission("windowsDesktopService")).rejects.toThrow("unavailable")
  expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
  expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
})

test.each(["account", "complete"] as const)("Windows saved %s progress does not restart for service guidance", async step => {
  const f = await fixture("win32")
  await writeFile(f.path, JSON.stringify({ step }))
  expect(await f.controller.get()).toEqual({ ...windowsPermissions, step })
  expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
})

test("an established Windows profile completes welcome without installing the service", async () => {
  const f = await fixture("win32")
  const controller = new OnboardingController({ ...f, established: () => true })
  expect(await controller.get()).toEqual({ ...windowsPermissions, step: "complete" })
  expect(await f.restart().get()).toEqual({ ...windowsPermissions, step: "complete" })
  expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
  expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
})

test("Windows normalizes a saved permission step before completing account setup", async () => {
  const f = await fixture("win32")
  await writeFile(f.path, JSON.stringify({ step: "screenCapture" }))
  expect(await f.controller.get()).toEqual({ ...windowsPermissions, step: "account" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "account" })
  expect(await f.controller.complete()).toEqual({ ...windowsPermissions, step: "complete" })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("disabled Linux local Agent preference skips local permissions", async () => {
  const f = await fixture("linux")
  f.localAgent.state.enabled = false
  f.localAgent.state.status = "stopped"
  expect(await f.controller.get()).toEqual({ permissionSteps: [], step: "account", linuxDesktopBackend: "wayland" })
  expect(f.localAgent.state.enabled).toBe(false)
})

test("Linux guides an attached running daemon when desktop auto-start is disabled", async () => {
  const f = await fixture("linux")
  f.localAgent.state.enabled = false
  expect(await f.controller.get()).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "screenCapture" })
  expect(f.localAgent.state.enabled).toBe(false)
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("an enabled Agent startup failure still exposes permission guidance for retry", async () => {
  const f = await fixture()
  f.localAgent.state.status = "error"
  f.localAgent.state.error = "Daemon startup failed"
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "localNetwork" })
  await f.controller.advancePermission("localNetwork")
  await f.controller.requestPermission("fullDiskAccess")
  expect(f.localAgent.requestPermission).toHaveBeenCalledExactlyOnceWith("fullDiskAccess")
})

test.each(["darwin", "linux", "win32"] as const)("old server setup progress resumes at the first %s step", async platform => {
  const f = await fixture(platform)
  await writeFile(f.path, JSON.stringify({ step: "server" }))
  const step = platform === "darwin" ? "localNetwork" : platform === "linux" ? "screenCapture" : "windowsDesktopService"
  const permissionSteps = platform === "darwin" ? macPermissions.permissionSteps : platform === "linux" ? waylandPermissions.permissionSteps : windowsPermissions.permissionSteps
  expect(await f.controller.get()).toEqual({ permissionSteps, step, ...(platform === "linux" ? { linuxDesktopBackend: "wayland" } : {}) })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step })
})

test("permission settings revisit completed setup while first-run requests remain ordered", async () => {
  const f = await fixture()
  await expect(f.controller.complete()).rejects.toThrow("step has changed")
  await expect(f.controller.requestPermission("accessibility")).rejects.toThrow("step has changed")
  await expect(f.controller.advancePermission("screenCapture")).rejects.toThrow("step has changed")
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "localNetwork" })
  await f.controller.advancePermission("localNetwork")
  await f.controller.advancePermission("fullDiskAccess")
  await f.controller.advancePermission("screenCapture")
  await f.controller.advancePermission("accessibility")
  await f.controller.complete()
  expect(await f.controller.permissions()).toMatchObject({ localNetwork: "not-requested", fullDiskAccessPermission: { status: "denied" } })
  expect(f.localNetwork.request).not.toHaveBeenCalled()
  await f.controller.requestPermission("accessibility")
  await f.controller.requestPermission("fullDiskAccess")
  expect(f.localAgent.requestPermission.mock.calls.map(([permission]) => permission)).toEqual(["accessibility", "fullDiskAccess"])
  expect(await f.controller.requestPermission("localNetwork")).toEqual({ localNetwork: "attempted" })
  expect(await f.controller.permissions()).toMatchObject({ localNetwork: "attempted" })
  await f.controller.openLocalNetworkSettings()
  expect(f.localNetwork.openSettings).toHaveBeenCalledOnce()
  await expect(f.controller.advancePermission("fullDiskAccess")).rejects.toThrow("step has changed")
  expect(await f.restart().get()).toEqual({ ...macPermissions, step: "complete" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "complete" })
})

test("completed settings keep client network access available with the local Agent disabled", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ step: "complete" }))
  f.localAgent.state.enabled = false
  f.localAgent.state.status = "stopped"
  expect(await f.controller.permissions()).toEqual({ localNetwork: "not-requested" })
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  await f.controller.requestPermission("localNetwork")
  await expect(f.controller.requestPermission("screenCapture")).rejects.toThrow("unavailable")
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test.each(["linux", "win32"] as const)("completed %s settings only request applicable permissions", async platform => {
  const f = await fixture(platform)
  await writeFile(f.path, JSON.stringify({ step: "complete" }))
  expect(await f.controller.permissions()).toMatchObject(platform === "linux" ? { screenCapturePermission: { status: "denied" } } : { windowsDesktopService: { available: true, installed: false, running: false } })
  expect(f.localAgent.refreshPermissions).toHaveBeenCalledTimes(platform === "linux" ? 1 : 0)
  if (platform === "linux") {
    await f.controller.requestPermission("accessibility")
    await f.controller.requestPermission("screenCapture")
    expect(f.localAgent.requestPermission).toHaveBeenCalledTimes(2)
    expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
  } else {
    await f.controller.requestPermission("windowsDesktopService")
    expect(f.windowsDesktopService.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
    expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  }
  await expect(f.controller.requestPermission("fullDiskAccess")).rejects.toThrow("unavailable")
  await expect(f.controller.requestPermission("localNetwork")).rejects.toThrow("unavailable")
  await expect(f.controller.openLocalNetworkSettings()).rejects.toThrow("step has changed")
  expect(f.localNetwork.request).not.toHaveBeenCalled()
  expect(f.localNetwork.openSettings).not.toHaveBeenCalled()
  expect((await f.restart().get()).step).toBe("complete")
})

test("failed progress writes preserve the active step", async () => {
  const f = await fixture()
  await f.controller.get()
  await mkdir(`${f.path}.tmp`)
  await expect(f.controller.advancePermission("localNetwork")).rejects.toThrow()
  expect(await f.controller.get()).toEqual({ ...macPermissions, step: "localNetwork" })
  expect(await f.restart().get()).toEqual({ ...macPermissions, step: "localNetwork" })
})

test("concurrent transitions cannot skip welcome steps", async () => {
  const f = await fixture()
  await f.controller.get()
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

test("an existing account or desktop settings profile does not restart welcome", async () => {
  const f = await fixture()
  const directory = join(f.path, "..")
  expect(await establishedDesktopProfile(directory)).toBe(false)
  await writeFile(join(directory, "account.json"), JSON.stringify({ serverUrl: "https://deskfleet.example", encryptedToken: "cipher" }))
  expect(await establishedDesktopProfile(directory)).toBe(true)
  const migrated = new OnboardingController({ ...f, established: () => establishedDesktopProfile(directory) })
  expect(await migrated.get()).toEqual({ ...macPermissions, step: "complete" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "complete" })
  expect(await f.restart().get()).toEqual({ ...macPermissions, step: "complete" })

  const settingsOnly = await fixture()
  const settingsDirectory = join(settingsOnly.path, "..")
  await writeFile(join(settingsDirectory, "settings.json"), JSON.stringify({ localAgentEnabled: true }))
  const resumed = new OnboardingController({ ...settingsOnly, established: () => establishedDesktopProfile(settingsDirectory) })
  expect(await resumed.get()).toEqual({ ...macPermissions, step: "complete" })
})

test("invalid persisted progress is reported", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ step: "anything" }))
  await expect(f.controller.get()).rejects.toThrow("Invalid welcome setup progress")
})


test.each(["x11", null] as const)("Linux %s skips native consent and retains independent AUV guidance", async backend => {
  const f = await fixture("linux")
  f.localAgent.state.linuxDesktopBackend = backend
  expect(await f.controller.get()).toEqual({ ...auvPermissions, step: "auv", linuxDesktopBackend: backend })
  expect(await f.controller.permissions()).toEqual({ auv: { status: "not-requested" } })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  await f.controller.advancePermission("auv")
  expect(f.auv.request).not.toHaveBeenCalled()
  expect(await f.controller.complete()).toEqual({ ...auvPermissions, step: "complete", linuxDesktopBackend: backend })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "complete" })
})

test("switching from Wayland to X11 skips saved Portal consent steps", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ step: "accessibility" }))
  f.localAgent.state.linuxDesktopBackend = "x11"
  expect(await f.restart().get()).toEqual({ ...auvPermissions, step: "auv", linuxDesktopBackend: "x11" })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("a permission refresh that reconnects to X11 normalizes and persists the AUV step", async () => {
  const f = await fixture("linux")
  f.localAgent.state.linuxDesktopBackend = undefined
  f.localAgent.state.status = "error"
  await writeFile(f.path, JSON.stringify({ step: "screenCapture" }))
  expect(await f.controller.get()).toEqual({ ...waylandPermissions, step: "screenCapture" })
  f.localAgent.refreshPermissions.mockImplementationOnce(async () => {
    f.localAgent.state.linuxDesktopBackend = "x11"
    f.localAgent.state.status = "running"
    return { linuxDesktopBackend: "x11", fullDiskAccessPermission: { status: "not-required" }, screenCapturePermission: { status: "not-required" }, accessibilityPermission: { status: "not-required" } }
  })
  expect(await f.controller.permissions()).toMatchObject({ linuxDesktopBackend: "x11" })
  expect(await f.controller.get()).toEqual({ ...auvPermissions, step: "auv", linuxDesktopBackend: "x11" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "auv" })
  await f.controller.advancePermission("auv")
  expect(await f.controller.complete()).toEqual({ ...auvPermissions, step: "complete", linuxDesktopBackend: "x11" })
})


test("a temporarily disconnected Wayland daemon preserves its saved permission step", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ step: "accessibility" }))
  f.localAgent.state.linuxDesktopBackend = undefined
  f.localAgent.state.status = "error"
  f.localAgent.state.error = "Local Agent disconnected"
  expect(await f.restart().get()).toEqual({ ...waylandPermissions, step: "accessibility" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "accessibility" })
  expect(await f.restart().advancePermission("accessibility")).toEqual({ ...auvPermissions, step: "auv" })
})

test("a fresh Linux Agent does not assume Wayland Portal steps before hello", async () => {
  const f = await fixture("linux")
  f.localAgent.state.linuxDesktopBackend = undefined
  f.localAgent.state.status = "error"
  f.localAgent.state.error = "Daemon startup failed"
  expect(await f.controller.get()).toEqual({ ...auvPermissions, step: "auv" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "auv" })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  await f.controller.advancePermission("auv")
  expect(await f.controller.complete()).toEqual({ ...auvPermissions, step: "complete" })
})

test("X11 hello after a missing-backend Portal step lets Skip reach AUV guidance", async () => {
  const f = await fixture("linux")
  f.localAgent.state.linuxDesktopBackend = undefined
  await writeFile(f.path, JSON.stringify({ step: "screenCapture" }))
  const controller = f.restart()
  expect(await controller.get()).toEqual({ ...waylandPermissions, step: "screenCapture" })
  f.localAgent.state.linuxDesktopBackend = "x11"
  expect(await controller.advancePermission("screenCapture")).toEqual({ ...auvPermissions, step: "auv", linuxDesktopBackend: "x11" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "auv" })
  await expect(controller.requestPermission("screenCapture")).rejects.toThrow("step has changed")
  await controller.advancePermission("auv")
  expect(await controller.complete()).toEqual({ ...auvPermissions, step: "complete", linuxDesktopBackend: "x11" })
})

test("AUV welcome checks silently, requests its own authorization, and resumes its step", async () => {
  const f = await fixture("linux")
  await f.controller.advancePermission("screenCapture")
  await f.controller.advancePermission("accessibility")
  expect(await f.restart().get()).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "auv" })
  expect(await f.controller.permissions()).toEqual({ auv: { status: "not-requested" } })
  expect(f.auv.request).not.toHaveBeenCalled()
  expect(await f.controller.requestPermission("auv")).toEqual({ auv: { status: "saved" } })
  expect(f.auv.request).toHaveBeenCalledOnce()
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect((await f.restart().get()).step).toBe("auv")
  expect((await f.controller.advancePermission("auv")).step).toBe("account")
})

test("completed Linux setup exposes AUV without restarting welcome or authorizing on refresh", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ step: "complete" }))
  f.auv.get.mockResolvedValue({ status: "saved" })
  expect((await f.controller.get()).step).toBe("complete")
  expect(await f.controller.permissions()).toMatchObject({ auv: { status: "saved" }, screenCapturePermission: { status: "denied" } })
  expect(f.auv.request).not.toHaveBeenCalled()
  await f.controller.requestPermission("auv")
  expect(f.auv.request).toHaveBeenCalledOnce()
  expect((await f.restart().get()).step).toBe("complete")
})

test("pending AUV authorization cannot be duplicated or skipped and failure can be retried", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ step: "auv" }))
  let finish!: (state: AuvPermissionsState) => void
  f.auv.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const request = f.controller.requestPermission("auv")
  await vi.waitFor(() => expect(f.auv.request).toHaveBeenCalledOnce())
  await expect(f.controller.requestPermission("auv")).rejects.toThrow("changing state")
  await expect(f.controller.advancePermission("auv")).rejects.toThrow("changing state")
  finish({ status: "error", error: "Authorization cancelled" })
  expect(await request).toEqual({ auv: { status: "error", error: "Authorization cancelled" } })
  expect((await f.restart().get()).step).toBe("auv")
  expect(await f.controller.requestPermission("auv")).toEqual({ auv: { status: "saved" } })
})

test.each(["darwin", "win32"] as const)("%s cannot request the Linux AUV authorization", async platform => {
  const f = await fixture(platform)
  await writeFile(f.path, JSON.stringify({ step: "complete" }))
  await f.controller.permissions()
  await expect(f.controller.requestPermission("auv")).rejects.toThrow("unavailable")
  expect(f.auv.get).not.toHaveBeenCalled()
  expect(f.auv.request).not.toHaveBeenCalled()
})
