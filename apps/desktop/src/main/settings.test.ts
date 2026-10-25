import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { beforeEach, expect, test, vi } from "vitest"
import type { LocalAgentController } from "./local-agent-controller.ts"
import type { KeepAwakeController } from "./keep-awake.ts"
import type { NotificationSettingsController } from "./notification-settings.ts"

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock("electron", () => ({ ipcMain: { handle } }))
vi.mock("./launch-at-startup.ts", () => ({ getLaunchAtStartup: vi.fn(), setLaunchAtStartup: vi.fn() }))
import { getLaunchAtStartup, setLaunchAtStartup } from "./launch-at-startup.ts"
import { attachSettings, installSettings } from "./settings.ts"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"

beforeEach(() => vi.clearAllMocks())

test("notification preferences validate all fields and restrict IPC to the registered renderer", async () => {
  const preferences = { enabled: true, taskCompleted: false, taskNeedsInput: true }
  const notifications = { get: vi.fn(() => preferences), set: vi.fn(() => preferences) }
  installSettings({} as LocalAgentController, {} as KeepAwakeController, notifications as unknown as NotificationSettingsController)
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, method: string, value?: unknown) => Promise<unknown>
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const sender = Object.assign(new EventEmitter(), { mainFrame })
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  await expect(invoke(event, "setNotifications", preferences)).rejects.toThrow("restricted")
  attachSettings({ webContents: sender } as unknown as BrowserWindow)
  await expect(invoke({ ...event, senderFrame: { ...mainFrame } } as IpcMainInvokeEvent, "setNotifications", preferences)).rejects.toThrow("restricted")
  for (const value of [true, null, {}, { enabled: true }, { ...preferences, taskCompleted: "false" }, { ...preferences, taskNeedsInput: 1 }]) {
    expect(await invoke(event, "setNotifications", value)).toMatchObject({ ok: false })
  }
  expect(notifications.set).not.toHaveBeenCalled()
  expect(await invoke(event, "getNotifications")).toEqual({ ok: true, value: preferences })
  expect(await invoke(event, "setNotifications", preferences)).toEqual({ ok: true, value: preferences })
  expect(notifications.set).toHaveBeenCalledExactlyOnceWith(preferences)
  notifications.set.mockImplementationOnce(() => { throw new Error("Could not save notifications") })
  expect(await invoke(event, "setNotifications", preferences)).toEqual({ ok: false, error: "Could not save notifications" })
  sender.emit("destroyed")
  await expect(invoke(event, "getNotifications")).rejects.toThrow("restricted")
})

test("only a registered main renderer can change the local Agent preference", async () => {
  const controller = { state: { enabled: true, status: "running" }, setEnabled: vi.fn() }
  installSettings(controller as unknown as LocalAgentController, {} as KeepAwakeController, {} as NotificationSettingsController)
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, method: string, value?: unknown) => Promise<unknown>
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const sender = Object.assign(new EventEmitter(), { mainFrame })
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  await expect(invoke(event, "setLocalAgentEnabled", false)).rejects.toThrow("restricted")
  attachSettings({ webContents: sender } as unknown as BrowserWindow)
  await expect(invoke({ ...event, senderFrame: { ...mainFrame } } as IpcMainInvokeEvent, "setLocalAgentEnabled", false)).rejects.toThrow("restricted")
  expect(await invoke(event, "get")).toEqual({ ok: true, value: controller.state })
  expect(await invoke(event, "setLocalAgentEnabled", "false")).toEqual({ ok: false, error: "Local Agent setting must be a boolean" })
  expect(controller.setEnabled).not.toHaveBeenCalled()
  controller.setEnabled.mockResolvedValue({ enabled: false, status: "stopped" })
  expect(await invoke(event, "setLocalAgentEnabled", false)).toEqual({ ok: true, value: { enabled: false, status: "stopped" } })
  sender.emit("destroyed")
  await expect(invoke(event, "get")).rejects.toThrow("restricted")
})

test("startup settings use the same renderer restriction and validate writes", async () => {
  installSettings({} as LocalAgentController, {} as KeepAwakeController, {} as NotificationSettingsController)
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, method: string, value?: unknown) => Promise<unknown>
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const sender = Object.assign(new EventEmitter(), { mainFrame })
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  await expect(invoke(event, "setLaunchAtStartup", true)).rejects.toThrow("restricted")
  attachSettings({ webContents: sender } as unknown as BrowserWindow)
  await expect(invoke({ ...event, senderFrame: { ...mainFrame } } as IpcMainInvokeEvent, "setLaunchAtStartup", true)).rejects.toThrow("restricted")
  expect(await invoke(event, "setLaunchAtStartup", "true")).toEqual({ ok: false, error: "Launch at startup setting must be a boolean" })
  expect(setLaunchAtStartup).not.toHaveBeenCalled()
  vi.mocked(getLaunchAtStartup).mockReturnValue({ available: true, enabled: false })
  expect(await invoke(event, "getLaunchAtStartup")).toEqual({ ok: true, value: { available: true, enabled: false } })
  vi.mocked(setLaunchAtStartup).mockReturnValue({ available: true, enabled: true })
  expect(await invoke(event, "setLaunchAtStartup", true)).toEqual({ ok: true, value: { available: true, enabled: true } })
  expect(setLaunchAtStartup).toHaveBeenCalledExactlyOnceWith(true)
  vi.mocked(setLaunchAtStartup).mockImplementation(() => { throw new Error("Login item update failed") })
  expect(await invoke(event, "setLaunchAtStartup", false)).toEqual({ ok: false, error: "Login item update failed" })
  sender.emit("destroyed")
  await expect(invoke(event, "getLaunchAtStartup")).rejects.toThrow("restricted")
})

test("Keep Awake settings restrict callers, validate writes, and report failures", async () => {
  const keepAwake = { get: vi.fn(() => ({ enabled: false })), setEnabled: vi.fn((enabled: boolean) => ({ enabled })) }
  installSettings({} as LocalAgentController, keepAwake as unknown as KeepAwakeController, {} as NotificationSettingsController)
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, method: string, value?: unknown) => Promise<unknown>
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const sender = Object.assign(new EventEmitter(), { mainFrame })
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  await expect(invoke(event, "setKeepAwake", true)).rejects.toThrow("restricted")
  attachSettings({ webContents: sender } as unknown as BrowserWindow)
  await expect(invoke({ ...event, senderFrame: { ...mainFrame } } as IpcMainInvokeEvent, "setKeepAwake", true)).rejects.toThrow("restricted")
  expect(await invoke(event, "setKeepAwake", "true")).toEqual({ ok: false, error: "Keep Awake setting must be a boolean" })
  expect(keepAwake.setEnabled).not.toHaveBeenCalled()
  expect(await invoke(event, "getKeepAwake")).toEqual({ ok: true, value: { enabled: false } })
  expect(await invoke(event, "setKeepAwake", true)).toEqual({ ok: true, value: { enabled: true } })
  expect(keepAwake.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  keepAwake.setEnabled.mockImplementationOnce(() => { throw new Error("Could not save Keep Awake") })
  expect(await invoke(event, "setKeepAwake", false)).toEqual({ ok: false, error: "Could not save Keep Awake" })
  keepAwake.get.mockImplementationOnce(() => { throw new Error("Invalid Keep Awake settings") })
  expect(await invoke(event, "getKeepAwake")).toEqual({ ok: false, error: "Invalid Keep Awake settings" })
  sender.emit("destroyed")
  await expect(invoke(event, "getKeepAwake")).rejects.toThrow("restricted")
})
