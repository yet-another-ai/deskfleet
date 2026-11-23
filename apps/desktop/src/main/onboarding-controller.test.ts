import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import type { LocalAgentState, DesktopPermissionKind, DesktopPermissionsState } from "@deskfleet/client/local-agent"
import type { AuvPermissionsState, LocalNetworkAccessRequest, OnboardingPermission } from "@deskfleet/client/onboarding"
import type { WindowsDesktopServiceState } from "@deskfleet/client/windows-desktop-service"
import { establishedDesktopProfile, OnboardingController } from "./onboarding-controller.ts"

const macPermissions = { permissionSteps: ["localNetwork", "fullDiskAccess", "screenCapture", "accessibility"] }
const waylandPermissions = { permissionSteps: ["screenCapture", "accessibility", "auv"] }
const auvPermissions = { permissionSteps: ["auv"] }
const windowsPermissions = { permissionSteps: ["windowsDesktopService"] }
const flow = "machine-control"
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
  const auv = {
    get: vi.fn(async (): Promise<AuvPermissionsState> => ({ status: "not-requested" })),
    request: vi.fn(async (): Promise<AuvPermissionsState> => ({ status: "saved" })),
  }
  const options = { path, platform, localAgent, localNetwork, windowsDesktopService, auv }
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
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "account" })
  expect(await f.restart().get()).toMatchObject({ step: "account", permissionSteps: [] })
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
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "complete" })
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
  expect(await resumed.advancePermission("accessibility")).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "auv" })
  expect(await resumed.permissions()).toEqual({ auv: { status: "not-requested" } })
  expect(f.auv.get).toHaveBeenCalledOnce()
  expect(await resumed.requestPermission("auv")).toEqual({ auv: { status: "saved" } })
  expect(f.auv.request).toHaveBeenCalledOnce()
  expect(await resumed.advancePermission("auv")).toEqual({ ...waylandPermissions, linuxDesktopBackend: "wayland", step: "complete" })
  expect(f.localAgent.requestPermission).toHaveBeenLastCalledWith("accessibility")
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
  expect(f.auv.get).not.toHaveBeenCalled()
  expect(f.auv.request).not.toHaveBeenCalled()
  await expect(f.controller.requestPermission("auv")).rejects.toThrow("unavailable")
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
  await expect(f.controller.requestPermission("auv")).rejects.toThrow("unavailable")
  expect(f.auv.get).not.toHaveBeenCalled()
  expect(f.auv.request).not.toHaveBeenCalled()
})

test.each(["darwin", "win32"] as const)("%s welcome never offers or queries Linux AUV authorization", async platform => {
  const f = await fixture(platform)
  const selected = await f.choose()
  expect(selected.permissionSteps).not.toContain("auv")
  expect(await f.controller.permissions()).not.toHaveProperty("auv")
  await expect(f.controller.requestPermission("auv")).rejects.toThrow("step has changed")
  expect(await f.controller.advancePermission("auv")).toEqual(selected)
  expect(f.auv.get).not.toHaveBeenCalled()
  expect(f.auv.request).not.toHaveBeenCalled()
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

test.each(["x11", null] as const)("Linux %s keeps only AUV's independent authorization after the machine choice", async backend => {
  const f = await fixture("linux")
  f.localAgent.state.linuxDesktopBackend = backend
  expect(await f.choose()).toEqual({ ...auvPermissions, step: "auv", linuxDesktopBackend: backend })
  expect(await f.controller.permissions()).toEqual({ auv: { status: "not-requested" } })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect(await f.controller.advancePermission("auv")).toEqual({ ...auvPermissions, step: "complete", linuxDesktopBackend: backend })
  expect(f.auv.request).not.toHaveBeenCalled()
})

test("a temporarily disconnected Wayland daemon retains saved permission guidance", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ flow, step: "accessibility" }))
  f.localAgent.state.linuxDesktopBackend = undefined
  f.localAgent.state.status = "error"
  expect(await f.restart().get()).toEqual({ ...waylandPermissions, step: "accessibility" })
  expect(await f.restart().advancePermission("accessibility")).toEqual({ permissionSteps: ["auv"], step: "auv" })
})

test("a late X11 hello normalizes saved Portal guidance and lets an in-flight Skip finish", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ flow, step: "screenCapture" }))
  f.localAgent.state.linuxDesktopBackend = undefined
  expect(await f.controller.get()).toEqual({ ...waylandPermissions, step: "screenCapture" })
  f.localAgent.refreshPermissions.mockImplementationOnce(async () => {
    f.localAgent.state.linuxDesktopBackend = "x11"
    return { linuxDesktopBackend: "x11", fullDiskAccessPermission: { status: "not-required" }, screenCapturePermission: { status: "not-required" }, accessibilityPermission: { status: "not-required" } }
  })
  await f.controller.permissions()
  // The saved Portal step is gone; Skip for it becomes a no-op on the AUV step.
  expect(await f.controller.advancePermission("screenCapture")).toEqual({ ...auvPermissions, step: "auv", linuxDesktopBackend: "x11" })
  expect(await f.restart().get()).toEqual({ ...auvPermissions, step: "auv", linuxDesktopBackend: "x11" })
  await expect(f.controller.requestPermission("screenCapture")).rejects.toThrow("step has changed")
  expect(await f.controller.advancePermission("auv")).toEqual({ ...auvPermissions, step: "complete", linuxDesktopBackend: "x11" })
})

for (const platform of ["darwin", "linux", "win32"] as const) {
  test.each([true, false])(`legacy ${platform} account progress finishes after machine choice without replaying permissions (enabled: %s)`, async enabled => {
    const f = await fixture(platform)
    await writeFile(f.path, JSON.stringify({ step: "account" }))
    expect(await f.controller.get()).toMatchObject({ step: "account", permissionSteps: [] })
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "account", resumePermission: "complete" })
    const signedIn = f.restart()
    expect(await signedIn.get()).toMatchObject({ step: "account", permissionSteps: [] })
    await signedIn.advanceAccount()
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "machineControl", resumePermission: "complete" })
    const choice = f.restart()
    expect(await choice.get()).toMatchObject({ step: "machineControl", permissionSteps: [] })
    expect(f.localAgent.setEnabled).not.toHaveBeenCalled()
    const completed = await choice.setMachineControlEnabled(enabled)
    expect(completed.step).toBe("complete")
    expect(completed).not.toHaveProperty("flow")
    expect(completed).not.toHaveProperty("resumePermission")
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "complete" })
    expect((await f.restart().get()).step).toBe("complete")
    expect(f.localAgent.setEnabled).toHaveBeenCalledExactlyOnceWith(enabled)
    expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
    expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
    expect(f.localNetwork.request).not.toHaveBeenCalled()
    expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
    expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
  })

  test.each([true, false])(`legacy completed ${platform} setup keeps its existing startup preference (enabled: %s)`, async enabled => {
    const f = await fixture(platform)
    f.localAgent.state.enabled = enabled
    await writeFile(f.path, JSON.stringify({ step: "complete" }))
    expect((await f.controller.get()).step).toBe("complete")
    expect((await f.restart().get()).step).toBe("complete")
    expect(f.localAgent.state.enabled).toBe(enabled)
    expect(f.localAgent.setEnabled).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "complete" })
  })
}

const legacyPermissions: { platform: NodeJS.Platform; permission: OnboardingPermission }[] = [
  ...["localNetwork", "fullDiskAccess", "screenCapture", "accessibility"].map(permission => ({ platform: "darwin" as const, permission: permission as OnboardingPermission })),
  ...["screenCapture", "accessibility"].map(permission => ({ platform: "linux" as const, permission: permission as OnboardingPermission })),
  { platform: "win32", permission: "windowsDesktopService" },
]
for (const { platform, permission } of legacyPermissions) {
  test.each([true, false])(`legacy ${platform} ${permission} progress waits for account and machine choice (enabled: %s)`, async enabled => {
    const f = await fixture(platform)
    await writeFile(f.path, JSON.stringify({ step: permission }))
    const initial = await f.controller.get()
    expect(initial).toEqual({ step: "account", permissionSteps: [], ...(platform === "linux" ? { linuxDesktopBackend: "wayland" } : {}) })
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "account", resumePermission: permission })
    await expect(f.controller.requestPermission(permission)).rejects.toThrow("step")
    await expect(f.controller.setMachineControlEnabled(enabled)).rejects.toThrow("step has changed")
    const signedIn = f.restart()
    await signedIn.advanceAccount()
    const choice = f.restart()
    expect(await choice.get()).toMatchObject({ step: "machineControl", permissionSteps: [] })
    expect(f.localAgent.setEnabled).not.toHaveBeenCalled()
    expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
    expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
    expect(f.windowsDesktopService.get).not.toHaveBeenCalled()
    const next = await choice.setMachineControlEnabled(enabled)
    const step = enabled || permission === "localNetwork" ? permission : "complete"
    expect(next.step).toBe(step)
    expect(next).not.toHaveProperty("flow")
    expect(next).not.toHaveProperty("resumePermission")
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step })
    expect(await f.restart().get()).toEqual(next)
    expect(f.localAgent.setEnabled).toHaveBeenCalledExactlyOnceWith(enabled)
    expect(f.localNetwork.request).not.toHaveBeenCalled()
    expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
  })
}

test("legacy Portal progress completes when the chosen machine now uses X11", async () => {
  const f = await fixture("linux")
  await writeFile(f.path, JSON.stringify({ step: "screenCapture" }))
  f.localAgent.state.linuxDesktopBackend = undefined
  expect(await f.controller.get()).toEqual({ step: "account", permissionSteps: [] })
  await f.controller.advanceAccount()
  f.localAgent.state.linuxDesktopBackend = "x11"
  // AUV authorization stays available in Settings → Permissions for this profile.
  expect(await f.controller.setMachineControlEnabled(true)).toEqual({ step: "complete", permissionSteps: ["auv"], linuxDesktopBackend: "x11" })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.auv.request).not.toHaveBeenCalled()
})

test("legacy progress retains its resume point when a choice fails and rejects duplicate choices", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ step: "screenCapture" }))
  await f.controller.advanceAccount()
  let finish!: (value: LocalAgentState) => void
  f.localAgent.setEnabled.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const selecting = f.controller.setMachineControlEnabled(true)
  await vi.waitFor(() => expect(f.localAgent.setEnabled).toHaveBeenCalledOnce())
  await expect(f.controller.setMachineControlEnabled(false)).rejects.toThrow("changing state")
  finish({ enabled: true, status: "error", error: "Daemon startup failed" })
  await expect(selecting).rejects.toThrow("Daemon startup failed")
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "machineControl", resumePermission: "screenCapture" })
  const restarted = f.restart()
  expect(await restarted.get()).toEqual({ step: "machineControl", permissionSteps: [] })
  expect(await restarted.setMachineControlEnabled(true)).toEqual({ ...macPermissions, step: "screenCapture" })
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "screenCapture" })
})

test("failed legacy migration leaves the original progress available for retry", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ step: "fullDiskAccess" }))
  await mkdir(`${f.path}.tmp`)
  await expect(f.controller.get()).rejects.toThrow()
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "fullDiskAccess" })
  expect(f.localAgent.setEnabled).not.toHaveBeenCalled()
  await rm(`${f.path}.tmp`, { recursive: true })
  expect(await f.controller.get()).toEqual({ step: "account", permissionSteps: [] })
})

for (const platform of ["darwin", "linux", "win32"] as const) {
  test.each([true, false])(`legacy client-only ${platform} account guides newly enabled daemon permissions (enabled: %s)`, async enabled => {
    const f = await fixture(platform)
    f.localAgent.state.enabled = false
    await writeFile(f.path, JSON.stringify({ step: "account" }))
    expect(await f.controller.get()).toMatchObject({ step: "account", permissionSteps: [] })
    const firstDaemonPermission = platform === "darwin" ? "fullDiskAccess" : platform === "linux" ? "screenCapture" : "windowsDesktopService"
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "account", resumePermission: firstDaemonPermission })
    const signedIn = f.restart()
    await signedIn.advanceAccount()
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "machineControl", resumePermission: firstDaemonPermission })
    const choice = f.restart()
    expect(await choice.get()).toMatchObject({ step: "machineControl", permissionSteps: [] })
    expect(f.localAgent.setEnabled).not.toHaveBeenCalled()
    expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
    expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
    const next = await choice.setMachineControlEnabled(enabled)
    expect(next.step).toBe(enabled ? firstDaemonPermission : "complete")
    expect(await f.restart().get()).toEqual(next)
    expect(f.localAgent.setEnabled).toHaveBeenCalledExactlyOnceWith(enabled)
    expect(f.localNetwork.request).not.toHaveBeenCalled()
    expect(f.windowsDesktopService.setEnabled).not.toHaveBeenCalled()
  })
}

test.each(["wayland", "x11", null] as const)("legacy client-only Linux account waits for the chosen daemon's %s backend", async backend => {
  const f = await fixture("linux")
  f.localAgent.state.enabled = false
  f.localAgent.state.linuxDesktopBackend = undefined
  await writeFile(f.path, JSON.stringify({ step: "account" }))
  await f.controller.advanceAccount()
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "machineControl", resumePermission: "screenCapture" })
  const choice = f.restart()
  f.localAgent.setEnabled.mockImplementationOnce(async enabled => {
    Object.assign(f.localAgent.state, { enabled, status: "running", linuxDesktopBackend: backend })
    return { ...f.localAgent.state }
  })
  expect(await choice.setMachineControlEnabled(true)).toEqual({
    step: backend === "wayland" ? "screenCapture" : "complete",
    permissionSteps: backend === "wayland" ? ["screenCapture", "accessibility", "auv"] : ["auv"],
    linuxDesktopBackend: backend,
  })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(f.auv.request).not.toHaveBeenCalled()
})

test("legacy account with a separately running daemon keeps its completed permission progress", async () => {
  const f = await fixture()
  f.localAgent.state.enabled = false
  f.localAgent.state.status = "running"
  await writeFile(f.path, JSON.stringify({ step: "account" }))
  await f.controller.advanceAccount()
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ flow, step: "machineControl", resumePermission: "complete" })
  expect((await f.controller.setMachineControlEnabled(true)).step).toBe("complete")
  expect(f.localAgent.refreshPermissions).not.toHaveBeenCalled()
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})
