import { expect, test, vi } from "vitest"
import { WindowsDesktopServiceController, type WindowsDesktopServiceCommand } from "./windows-desktop-service-controller.ts"

test("status never requests elevation and unavailable builds do not execute a helper", async () => {
  const run = vi.fn(async () => JSON.stringify({ installed: false, running: false }))
  const unavailable = new WindowsDesktopServiceController(false, run)
  expect(await unavailable.get()).toEqual({ available: false, installed: false, running: false })
  await expect(unavailable.setEnabled(true)).rejects.toThrow("unavailable")
  await expect(unavailable.update()).rejects.toThrow("unavailable")
  await unavailable.reconcileOnStartup()
  expect(run).not.toHaveBeenCalled()
  const controller = new WindowsDesktopServiceController(true, run)
  expect(await controller.get()).toEqual({ available: true, installed: false, running: false })
  expect(run).toHaveBeenCalledExactlyOnceWith("status")
})

test("install, start, and removal return the actual post-operation service state", async () => {
  let state = { installed: false, running: false }
  const run = vi.fn(async (command: WindowsDesktopServiceCommand) => {
    if (command === "elevate-install") state = { installed: true, running: true }
    if (command === "elevate-uninstall") state = { installed: false, running: false }
    return JSON.stringify(state)
  })
  const controller = new WindowsDesktopServiceController(true, run)
  expect(await controller.setEnabled(true)).toEqual({ available: true, installed: true, running: true })
  await controller.setEnabled(true)
  expect(run.mock.calls.filter(([command]) => command === "elevate-install")).toHaveLength(1)
  state.running = false
  expect(await controller.setEnabled(true)).toMatchObject({ running: true })
  expect(run.mock.calls.filter(([command]) => command === "elevate-install")).toHaveLength(2)
  expect(await controller.setEnabled(false)).toEqual({ available: true, installed: false, running: false })
  await controller.setEnabled(false)
  expect(run.mock.calls.filter(([command]) => command === "elevate-uninstall")).toHaveLength(1)
})

test("startup reconciliation applies signed maintenance updates silently and never elevates", async () => {
  let state = {
    installed: true,
    running: true,
    maintenanceInstalled: true,
    updateAvailable: true,
    silentUpdateAvailable: true,
  }
  const run = vi.fn(async (command: WindowsDesktopServiceCommand) => {
    if (command === "maintenance-update") {
      state = { ...state, updateAvailable: false, silentUpdateAvailable: false }
      return ""
    }
    return JSON.stringify(state)
  })
  const controller = new WindowsDesktopServiceController(true, run)
  await controller.reconcileOnStartup()
  expect(run.mock.calls.map(([command]) => command)).toEqual(["status", "maintenance-update"])

  // Legacy/unsigned installs with updateAvailable=true but silentUpdateAvailable=false
  // must never trigger unattended UAC during startup.
  state = {
    installed: true,
    running: true,
    maintenanceInstalled: false,
    updateAvailable: true,
    silentUpdateAvailable: false,
  }
  run.mockClear()
  await controller.reconcileOnStartup()
  expect(run.mock.calls.map(([command]) => command)).toEqual(["status"])

  // A failing silent maintenance update during startup must never escalate to UAC.
  state = {
    installed: true,
    running: true,
    maintenanceInstalled: true,
    updateAvailable: true,
    silentUpdateAvailable: true,
  }
  const failingStartupRun = vi.fn(async (command: WindowsDesktopServiceCommand) => {
    if (command === "maintenance-update") throw new Error("untrusted signing key")
    return JSON.stringify(state)
  })
  const failingController = new WindowsDesktopServiceController(true, failingStartupRun)
  await expect(failingController.reconcileOnStartup()).rejects.toThrow("untrusted signing key")
  expect(failingStartupRun.mock.calls.map(([command]) => command)).toEqual(["status", "maintenance-update"])
})

test("explicit update uses maintenance-update when signed and falls back to elevate-install on failure or legacy hosts", async () => {
  let state = {
    installed: true,
    running: true,
    maintenanceInstalled: true,
    updateAvailable: true,
    silentUpdateAvailable: true,
  }
  const run = vi.fn(async (command: WindowsDesktopServiceCommand) => {
    if (command === "maintenance-update" || command === "elevate-install") {
      state = {
        installed: true,
        running: true,
        maintenanceInstalled: true,
        updateAvailable: false,
        silentUpdateAvailable: false,
      }
      return ""
    }
    return JSON.stringify(state)
  })
  const controller = new WindowsDesktopServiceController(true, run)
  expect(await controller.update()).toMatchObject({ updateAvailable: false, maintenanceInstalled: true })
  expect(run.mock.calls.map(([command]) => command)).toEqual(["status", "maintenance-update", "status"])

  // When the installed maintenance service rejects the update (e.g. after key
  // rotation), explicit update() falls back to elevate-install to refresh both.
  state = {
    installed: true,
    running: true,
    maintenanceInstalled: true,
    updateAvailable: true,
    silentUpdateAvailable: true,
  }
  const fallbackRun = vi.fn(async (command: WindowsDesktopServiceCommand) => {
    if (command === "maintenance-update") throw new Error("desktop service manifest uses an untrusted signing key")
    if (command === "elevate-install") {
      state = {
        installed: true,
        running: true,
        maintenanceInstalled: true,
        updateAvailable: false,
        silentUpdateAvailable: false,
      }
      return ""
    }
    return JSON.stringify(state)
  })
  const fallbackController = new WindowsDesktopServiceController(true, fallbackRun)
  expect(await fallbackController.update()).toMatchObject({ updateAvailable: false, maintenanceInstalled: true })
  expect(fallbackRun.mock.calls.map(([command]) => command)).toEqual(["status", "maintenance-update", "elevate-install", "status"])

  // Legacy host missing DeskFleetMaintenance falls back to in-app UAC migration.
  state = {
    installed: true,
    running: true,
    maintenanceInstalled: false,
    updateAvailable: true,
    silentUpdateAvailable: false,
  }
  run.mockClear()
  expect(await controller.update()).toMatchObject({ updateAvailable: false, maintenanceInstalled: true })
  expect(run.mock.calls.map(([command]) => command)).toEqual(["status", "elevate-install", "status"])
})

test("rejected elevation leaves the service disabled and permits a later retry", async () => {
  const run = vi.fn(async (command: WindowsDesktopServiceCommand) => {
    if (command === "elevate-install") throw new Error("Administrator approval was cancelled")
    return JSON.stringify({ installed: false, running: false })
  })
  const controller = new WindowsDesktopServiceController(true, run)
  await expect(controller.setEnabled(true)).rejects.toThrow("cancelled")
  expect(await controller.get()).toMatchObject({ installed: false })
  await expect(controller.setEnabled(true)).rejects.toThrow("cancelled")
  expect(run.mock.calls.filter(([command]) => command === "elevate-install")).toHaveLength(2)
})

test("pending administrator approval prevents competing setup operations", async () => {
  let finish!: (value: string) => void
  const run = vi.fn(async (command: WindowsDesktopServiceCommand) => command === "elevate-install"
    ? new Promise<string>(resolve => { finish = resolve })
    : JSON.stringify({ installed: false, running: false }))
  const controller = new WindowsDesktopServiceController(true, run)
  const installing = controller.setEnabled(true)
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
  await expect(controller.setEnabled(false)).rejects.toThrow("already in progress")
  await expect(controller.update()).rejects.toThrow("already in progress")
  expect(run).not.toHaveBeenCalledWith("elevate-uninstall")
  finish("")
  await installing
})

test("malformed status is reported instead of being treated as an absent service", async () => {
  for (const value of [
    "",
    "null",
    "{}",
    '{"installed":true,"running":"false"}',
    '{"installed":true,"running":true,"maintenanceInstalled":"yes"}',
  ]) {
    const controller = new WindowsDesktopServiceController(true, async () => value)
    await expect(controller.get()).rejects.toThrow()
  }
})
