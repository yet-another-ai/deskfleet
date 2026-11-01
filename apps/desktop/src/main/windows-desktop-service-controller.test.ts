import { expect, test, vi } from "vitest"
import { WindowsDesktopServiceController, type WindowsDesktopServiceCommand } from "./windows-desktop-service-controller.ts"

test("status never requests elevation and unavailable builds do not execute a helper", async () => {
  const run = vi.fn(async () => JSON.stringify({ installed: false, running: false }))
  const unavailable = new WindowsDesktopServiceController(false, run)
  expect(await unavailable.get()).toEqual({ available: false, installed: false, running: false })
  await expect(unavailable.setEnabled(true)).rejects.toThrow("unavailable")
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
  expect(run).not.toHaveBeenCalledWith("elevate-uninstall")
  finish("")
  await installing
})

test("malformed status is reported instead of being treated as an absent service", async () => {
  for (const value of ["", "null", "{}", '{"installed":true,"running":"false"}']) {
    const controller = new WindowsDesktopServiceController(true, async () => value)
    await expect(controller.get()).rejects.toThrow()
  }
})
