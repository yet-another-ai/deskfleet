import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import type { LocalAgentState, DesktopPermissionsState } from "../../../../packages/client/src/local-agent.ts"
import { establishedDesktopProfile, OnboardingController } from "./onboarding-controller.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(platform: NodeJS.Platform = "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-onboarding-"))
  directories.push(directory)
  const path = join(directory, "onboarding.json")
  const permissions: DesktopPermissionsState = { fullDiskAccessPermission: { status: "denied" }, screenCapturePermission: { status: "denied" }, accessibilityPermission: { status: "granted" } }
  const central = { setServer: vi.fn(async (serverUrl: string) => ({ serverUrl, siteAdmin: false })) }
  const state: LocalAgentState = { enabled: true, status: "running" }
  const localAgent = {
    state,
    startIfEnabled: vi.fn(async () => state),
    refreshPermissions: vi.fn(async () => permissions),
    requestPermission: vi.fn(async () => permissions),
  }
  const options = { path, platform, central, localAgent }
  return { ...options, controller: new OnboardingController(options), restart: () => new OnboardingController(options) }
}

test("welcome saves the server before starting the daemon and resumes permission steps after restart", async () => {
  const f = await fixture()
  expect(await f.controller.get()).toEqual({ step: "server" })
  expect(f.localAgent.startIfEnabled).not.toHaveBeenCalled()
  expect(await f.controller.saveServer("https://deskfleet.example")).toEqual({ step: "fullDiskAccess" })
  expect(f.central.setServer).toHaveBeenCalledExactlyOnceWith("https://deskfleet.example")
  expect(f.central.setServer.mock.invocationCallOrder[0]).toBeLessThan(f.localAgent.startIfEnabled.mock.invocationCallOrder[0]!)
  expect(await f.controller.permissions()).toMatchObject({ fullDiskAccessPermission: { status: "denied" } })
  await f.controller.requestPermission("fullDiskAccess")
  expect(f.localAgent.requestPermission).toHaveBeenCalledExactlyOnceWith("fullDiskAccess")
  expect(await f.controller.advancePermission("fullDiskAccess")).toEqual({ step: "screenCapture" })
  const resumed = f.restart()
  expect(await resumed.get()).toEqual({ step: "screenCapture" })
  await resumed.advancePermission("screenCapture")
  await resumed.advancePermission("accessibility")
  expect(await resumed.get()).toEqual({ step: "account" })
  expect(await resumed.complete()).toEqual({ step: "complete" })
  expect(await f.restart().get()).toEqual({ step: "complete" })
  expect(f.central.setServer).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "complete" })
})

test("Linux guides screen and input access, reuses startup authorization, and resumes after restart", async () => {
  const f = await fixture("linux")
  f.localAgent.refreshPermissions.mockResolvedValue({
    fullDiskAccessPermission: { status: "not-required" },
    screenCapturePermission: { status: "requesting" },
    accessibilityPermission: { status: "requesting" },
  })
  expect(await f.controller.saveServer("https://deskfleet.example")).toEqual({ step: "screenCapture" })
  expect(f.localAgent.startIfEnabled).toHaveBeenCalledOnce()
  expect(await f.controller.permissions()).toMatchObject({ screenCapturePermission: { status: "requesting" } })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  await expect(f.controller.requestPermission("fullDiskAccess")).rejects.toThrow("step has changed")
  f.localAgent.refreshPermissions.mockResolvedValue({
    fullDiskAccessPermission: { status: "not-required" },
    screenCapturePermission: { status: "granted" },
    accessibilityPermission: { status: "granted" },
  })
  expect(await f.controller.permissions()).toMatchObject({ accessibilityPermission: { status: "granted" } })
  expect(await f.controller.advancePermission("screenCapture")).toEqual({ step: "accessibility" })
  const resumed = f.restart()
  expect(await resumed.get()).toEqual({ step: "accessibility" })
  expect(await resumed.advancePermission("accessibility")).toEqual({ step: "account" })
  expect(await resumed.complete()).toEqual({ step: "complete" })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("Linux welcome retries or defers desktop permissions without adding Full Disk Access", async () => {
  const f = await fixture("linux")
  await f.controller.saveServer("https://deskfleet.example")
  await f.controller.requestPermission("screenCapture")
  expect(f.localAgent.requestPermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
  expect(await f.controller.advancePermission("screenCapture")).toEqual({ step: "accessibility" })
  await f.controller.requestPermission("accessibility")
  expect(f.localAgent.requestPermission).toHaveBeenLastCalledWith("accessibility")
  expect(await f.controller.advancePermission("accessibility")).toEqual({ step: "account" })
})

test("Windows skips OS permission steps", async () => {
  const f = await fixture("win32")
  expect(await f.controller.saveServer("https://deskfleet.example")).toEqual({ step: "account" })
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test.each(["darwin", "linux"] as const)("disabled local Agent preference skips %s local permissions", async platform => {
  const f = await fixture(platform)
  f.localAgent.state.enabled = false
  f.localAgent.state.status = "stopped"
  expect(await f.controller.saveServer("https://deskfleet.example")).toEqual({ step: "account" })
  expect(f.localAgent.state.enabled).toBe(false)
})

test("Linux guides an attached running daemon when desktop auto-start is disabled", async () => {
  const f = await fixture("linux")
  f.localAgent.state.enabled = false
  expect(await f.controller.saveServer("https://deskfleet.example")).toEqual({ step: "screenCapture" })
  expect(f.localAgent.state.enabled).toBe(false)
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
})

test("server validation and daemon startup failures keep welcome on the server step", async () => {
  const f = await fixture()
  f.central.setServer.mockRejectedValueOnce(new Error("Use HTTPS"))
  await expect(f.controller.saveServer("http://deskfleet.example")).rejects.toThrow("HTTPS")
  expect(f.localAgent.startIfEnabled).not.toHaveBeenCalled()
  expect(await f.controller.get()).toEqual({ step: "server" })
  f.localAgent.state.status = "error"
  f.localAgent.state.error = "Daemon startup failed"
  await expect(f.controller.saveServer("https://deskfleet.example")).rejects.toThrow("Daemon startup failed")
  expect(await f.restart().get()).toEqual({ step: "server" })
})

test("permissions cannot be requested out of order or after setup completes", async () => {
  const f = await fixture()
  await expect(f.controller.permissions()).rejects.toThrow("permission step")
  await expect(f.controller.complete()).rejects.toThrow("step has changed")
  await f.controller.saveServer("https://deskfleet.example")
  await expect(f.controller.requestPermission("accessibility")).rejects.toThrow("step has changed")
  await expect(f.controller.advancePermission("screenCapture")).rejects.toThrow("step has changed")
  expect(f.localAgent.requestPermission).not.toHaveBeenCalled()
  expect(await f.controller.get()).toEqual({ step: "fullDiskAccess" })
})

test("failed progress writes preserve the active step", async () => {
  const f = await fixture()
  await f.controller.saveServer("https://deskfleet.example")
  await mkdir(`${f.path}.tmp`)
  await expect(f.controller.advancePermission("fullDiskAccess")).rejects.toThrow()
  expect(await f.controller.get()).toEqual({ step: "fullDiskAccess" })
  expect(await f.restart().get()).toEqual({ step: "fullDiskAccess" })
})

test("concurrent transitions cannot skip welcome steps", async () => {
  const f = await fixture()
  let resolve!: () => void
  f.central.setServer.mockImplementationOnce(serverUrl => new Promise(done => { resolve = () => done({ serverUrl, siteAdmin: false }) }))
  const saving = f.controller.saveServer("https://deskfleet.example")
  await vi.waitFor(() => expect(f.central.setServer).toHaveBeenCalledOnce())
  await expect(f.controller.complete()).rejects.toThrow("changing state")
  resolve()
  await saving
  expect(await f.controller.get()).toEqual({ step: "fullDiskAccess" })
})

test("an existing account or desktop settings profile does not restart welcome", async () => {
  const f = await fixture()
  const directory = join(f.path, "..")
  expect(await establishedDesktopProfile(directory)).toBe(false)
  await writeFile(join(directory, "account.json"), JSON.stringify({ serverUrl: "https://deskfleet.example", encryptedToken: "cipher" }))
  expect(await establishedDesktopProfile(directory)).toBe(true)
  const migrated = new OnboardingController({ ...f, established: () => establishedDesktopProfile(directory) })
  expect(await migrated.get()).toEqual({ step: "complete" })
  expect(f.localAgent.startIfEnabled).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ step: "complete" })
  expect(await f.restart().get()).toEqual({ step: "complete" })

  const settingsOnly = await fixture()
  const settingsDirectory = join(settingsOnly.path, "..")
  await writeFile(join(settingsDirectory, "settings.json"), JSON.stringify({ localAgentEnabled: true }))
  const resumed = new OnboardingController({ ...settingsOnly, established: () => establishedDesktopProfile(settingsDirectory) })
  expect(await resumed.get()).toEqual({ step: "complete" })
  expect(settingsOnly.localAgent.startIfEnabled).not.toHaveBeenCalled()
})

test("invalid persisted progress is reported", async () => {
  const f = await fixture()
  await writeFile(f.path, JSON.stringify({ step: "anything" }))
  await expect(f.controller.get()).rejects.toThrow("Invalid welcome setup progress")
})
