import { afterEach, beforeEach, expect, test, vi } from "vitest"

const { app } = vi.hoisted(() => ({ app: {
  isPackaged: true,
  getLoginItemSettings: vi.fn(),
  setLoginItemSettings: vi.fn(),
} }))
vi.mock("electron", () => ({ app }))
import { getLaunchAtStartup, setLaunchAtStartup } from "./launch-at-startup.ts"

beforeEach(() => {
  vi.resetAllMocks()
  app.isPackaged = true
})
afterEach(() => vi.unstubAllGlobals())

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
  { platform: "linux", packaged: true },
  { platform: "darwin", packaged: false },
  { platform: "win32", packaged: false },
])("does not access login items on $platform with packaged=$packaged", ({ platform, packaged }) => {
  vi.stubGlobal("process", { ...process, platform })
  app.isPackaged = packaged
  expect(getLaunchAtStartup()).toEqual({ available: false, enabled: false })
  expect(() => setLaunchAtStartup(true)).toThrow("unavailable")
  expect(app.getLoginItemSettings).not.toHaveBeenCalled()
  expect(app.setLoginItemSettings).not.toHaveBeenCalled()
})
