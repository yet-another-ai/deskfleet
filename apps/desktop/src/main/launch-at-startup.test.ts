import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const { app } = vi.hoisted(() => ({ app: {
  isPackaged: true,
  getPath: vi.fn(),
  getLoginItemSettings: vi.fn(),
  setLoginItemSettings: vi.fn(),
} }))
vi.mock("electron", () => ({ app }))
import { getLaunchAtStartup, refreshLaunchAtStartup, setLaunchAtStartup } from "./launch-at-startup.ts"

const directories: string[] = []

beforeEach(() => {
  vi.resetAllMocks()
  app.isPackaged = true
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function linux(configHome?: string) {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-startup-settings-"))
  directories.push(directory)
  app.getPath.mockReturnValue(directory)
  vi.stubGlobal("process", {
    ...process, platform: "linux", execPath: "/tmp/.mount_deskfleet/deskfleet",
    env: { ...process.env, XDG_CONFIG_HOME: configHome, APPIMAGE: "/opt/Desk Fleet/deskfleet-0.3.2.AppImage" },
  })
  return directory
}

test.each(["darwin", "win32"])("%s reads the system preference and returns the actual state after changes", (platform) => {
  vi.stubGlobal("process", { ...process, platform })
  app.getLoginItemSettings.mockReturnValue({ openAtLogin: false, executableWillLaunchAtLogin: false })
  expect(getLaunchAtStartup()).toEqual({ available: true, enabled: false })
  // Registration can fail to take effect without throwing; report the OS result.
  expect(setLaunchAtStartup(true)).toEqual({ available: true, enabled: false })
  expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true })
  app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: true })
  expect(setLaunchAtStartup(true)).toEqual({ available: true, enabled: true })
  app.getLoginItemSettings.mockReturnValue({ openAtLogin: false, executableWillLaunchAtLogin: false })
  expect(setLaunchAtStartup(false)).toEqual({ available: true, enabled: false })
  expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false })
  app.getLoginItemSettings.mockClear()
  app.setLoginItemSettings.mockClear()
  refreshLaunchAtStartup()
  expect(app.getLoginItemSettings).not.toHaveBeenCalled()
  expect(app.setLoginItemSettings).not.toHaveBeenCalled()
})

test("Windows respects a startup entry disabled through Task Manager", () => {
  vi.stubGlobal("process", { ...process, platform: "win32" })
  app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: false })
  expect(getLaunchAtStartup()).toEqual({ available: true, enabled: false })
})

test("macOS does not require Windows startup approval fields", () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" })
  app.getLoginItemSettings.mockReturnValue({ openAtLogin: true })
  expect(getLaunchAtStartup()).toEqual({ available: true, enabled: true })
})

test.each([
  { platform: "freebsd", packaged: true },
  { platform: "linux", packaged: false },
  { platform: "darwin", packaged: false },
  { platform: "win32", packaged: false },
])("does not access login items on $platform with packaged=$packaged", ({ platform, packaged }) => {
  vi.stubGlobal("process", { ...process, platform })
  app.isPackaged = packaged
  expect(getLaunchAtStartup()).toEqual({ available: false, enabled: false })
  expect(() => setLaunchAtStartup(true)).toThrow("unavailable")
  refreshLaunchAtStartup()
  expect(app.getPath).not.toHaveBeenCalled()
  expect(app.getLoginItemSettings).not.toHaveBeenCalled()
  expect(app.setLoginItemSettings).not.toHaveBeenCalled()
})

test.each([undefined, "", "relative/config"])("Linux uses the home config directory for XDG_CONFIG_HOME=%s", (configHome) => {
  const home = linux(configHome)
  const path = join(home, ".config", "autostart", "io.github.yet_another_ai.deskfleet.desktop")
  expect(getLaunchAtStartup()).toEqual({ available: true, enabled: false })
  refreshLaunchAtStartup()
  expect(existsSync(path)).toBe(false)
  expect(setLaunchAtStartup(true)).toEqual({ available: true, enabled: true })
  expect(readFileSync(path, "utf8")).toContain('Exec="/opt/Desk Fleet/deskfleet-0.3.2.AppImage"')
  expect(setLaunchAtStartup(false)).toEqual({ available: true, enabled: false })
  expect(existsSync(path)).toBe(false)
  expect(app.getLoginItemSettings).not.toHaveBeenCalled()
  expect(app.setLoginItemSettings).not.toHaveBeenCalled()
})

test("Linux refresh follows the current AppImage path and preserves externally disabled or deleted entries", () => {
  const home = linux()
  process.env.XDG_CONFIG_HOME = join(home, "custom-config")
  const path = join(process.env.XDG_CONFIG_HOME, "autostart", "io.github.yet_another_ai.deskfleet.desktop")
  setLaunchAtStartup(true)
  expect(existsSync(join(home, ".config"))).toBe(false)

  process.env.APPIMAGE = "/new location/deskfleet-0.3.3.AppImage"
  refreshLaunchAtStartup()
  expect(readFileSync(path, "utf8")).toContain('Exec="/new location/deskfleet-0.3.3.AppImage"')
  const disabled = readFileSync(path, "utf8") + "Hidden=true\n"
  writeFileSync(path, disabled)
  process.env.APPIMAGE = "/another/deskfleet.AppImage"
  refreshLaunchAtStartup()
  expect(getLaunchAtStartup()).toEqual({ available: true, enabled: false })
  expect(readFileSync(path, "utf8")).toBe(disabled)
  rmSync(path)
  refreshLaunchAtStartup()
  expect(existsSync(path)).toBe(false)
})

test("packaged Linux executables outside AppImage use process.execPath", () => {
  const home = linux()
  delete process.env.APPIMAGE
  vi.stubGlobal("process", { ...process, execPath: "/opt/deskfleet/deskfleet" })
  expect(setLaunchAtStartup(true)).toEqual({ available: true, enabled: true })
  const path = join(home, ".config", "autostart", "io.github.yet_another_ai.deskfleet.desktop")
  expect(readFileSync(path, "utf8")).toContain('Exec="/opt/deskfleet/deskfleet"')
})
