import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { APPEARANCE_CHANGED_EVENT, DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from "../../../../packages/client/src/appearance.ts"
import type { AppearanceSettingsController } from "./appearance-settings.ts"

const { handle, nativeTheme, refreshTrayMenu } = vi.hoisted(() => ({
  handle: vi.fn(), nativeTheme: { themeSource: "system" }, refreshTrayMenu: vi.fn(),
}))
vi.mock("electron", () => ({
  ipcMain: { handle }, nativeTheme, app: { getPreferredSystemLanguages: () => ["en-US"] },
}))
vi.mock("./tray.ts", () => ({ refreshTrayMenu }))
import { attachAppearance, installAppearance } from "./appearance.ts"
import { getMainLocale, setMainLocale } from "./i18n.ts"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"

const renderers: EventEmitter[] = []
beforeEach(() => { vi.clearAllMocks(); nativeTheme.themeSource = "system" })
afterEach(() => { for (const renderer of renderers.splice(0)) renderer.emit("destroyed"); setMainLocale("en-US") })

function renderer(hash = "") {
  const mainFrame = { url: `${BUNDLED_RENDERER_URL}${hash}` }
  const sender = Object.assign(new EventEmitter(), { mainFrame, send: vi.fn(), isDestroyed: () => false })
  renderers.push(sender)
  const window = { webContents: sender } as unknown as BrowserWindow
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  return { sender, window, event }
}

function install(settings: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS }) {
  const controller = {
    get: vi.fn(() => settings),
    set: vi.fn((value: AppearanceSettings) => { settings = value; return value }),
  }
  installAppearance(controller as unknown as AppearanceSettingsController)
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, method: unknown, value?: unknown) => unknown
  return { controller, invoke }
}

test("saved appearance applies before windows and updates native language, theme, and all registered windows", () => {
  const saved: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS, language: "zh-cmn-Hans-CN", theme: "dark" }
  const { invoke } = install(saved)
  expect(nativeTheme.themeSource).toBe("dark")
  expect(getMainLocale()).toBe("zh-cmn-Hans-CN")
  expect(refreshTrayMenu).toHaveBeenCalledOnce()
  const main = renderer()
  const auxiliary = renderer("#/mermaid?code=graph")
  attachAppearance(main.window)
  attachAppearance(auxiliary.window)
  expect(invoke(auxiliary.event, "get")).toEqual({ ok: true, value: saved })
  const changed: AppearanceSettings = { ...saved, language: "system", theme: "light", terminalLigatures: true }
  expect(invoke(main.event, "set", changed)).toEqual({ ok: true, value: changed })
  expect(nativeTheme.themeSource).toBe("light")
  expect(getMainLocale()).toBe("en-US")
  expect(main.sender.send).toHaveBeenCalledWith(APPEARANCE_CHANGED_EVENT, changed)
  expect(auxiliary.sender.send).toHaveBeenCalledWith(APPEARANCE_CHANGED_EVENT, changed)
  auxiliary.sender.emit("destroyed")
  auxiliary.sender.send.mockClear()
  invoke(main.event, "set", DEFAULT_APPEARANCE_SETTINGS)
  expect(nativeTheme.themeSource).toBe("system")
  expect(auxiliary.sender.send).not.toHaveBeenCalled()
})

test("appearance validates writes and restricts IPC to registered application main frames", () => {
  const { controller, invoke } = install()
  const { window, event, sender } = renderer()
  expect(() => invoke(event, "get")).toThrow("restricted")
  attachAppearance(window)
  expect(() => invoke({ ...event, senderFrame: { ...sender.mainFrame } } as IpcMainInvokeEvent, "get")).toThrow("restricted")
  const url = sender.mainFrame.url
  sender.mainFrame.url = "https://example.com/"
  expect(() => invoke(event, "get")).toThrow("restricted")
  sender.mainFrame.url = url
  for (const value of [null, {}, { ...DEFAULT_APPEARANCE_SETTINGS, language: "fr" }, { ...DEFAULT_APPEARANCE_SETTINGS, theme: "sepia" }, { ...DEFAULT_APPEARANCE_SETTINGS, terminalFont: [] }, { ...DEFAULT_APPEARANCE_SETTINGS, terminalLigatures: "true" }]) {
    expect(invoke(event, "set", value)).toEqual({ ok: false, error: "Invalid appearance settings" })
  }
  expect(controller.set).not.toHaveBeenCalled()
  expect(invoke(event, "unknown")).toEqual({ ok: false, error: "Unknown appearance operation" })
  sender.emit("destroyed")
  expect(() => invoke(event, "get")).toThrow("restricted")
})

test("failed saves do not change native appearance or notify other windows", () => {
  const { controller, invoke } = install()
  const { window, event, sender } = renderer()
  attachAppearance(window)
  controller.set.mockImplementationOnce(() => { throw new Error("Disk unavailable") })
  refreshTrayMenu.mockClear()
  expect(invoke(event, "set", { ...DEFAULT_APPEARANCE_SETTINGS, theme: "dark", language: "zh-cmn-Hans-CN" }))
    .toEqual({ ok: false, error: "Disk unavailable" })
  expect(nativeTheme.themeSource).toBe("system")
  expect(getMainLocale()).toBe("en-US")
  expect(refreshTrayMenu).not.toHaveBeenCalled()
  expect(sender.send).not.toHaveBeenCalled()
})
