import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { expect, test, vi } from "vitest"
import type { WindowsDesktopServiceController } from "./windows-desktop-service-controller.ts"

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock("electron", () => ({ ipcMain: { handle }, app: {} }))
import { attachWindowsDesktopService, installWindowsDesktopServiceIpc } from "./windows-desktop-service.ts"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"

test("only the registered main renderer may request fixed service setup operations", async () => {
  const state = { available: true, installed: false, running: false }
  const controller = { get: vi.fn(async () => state), setEnabled: vi.fn(async () => ({ ...state, installed: true, running: true })) }
  installWindowsDesktopServiceIpc(controller as unknown as WindowsDesktopServiceController)
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent, method: string, value?: unknown) => Promise<unknown>
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const sender = Object.assign(new EventEmitter(), { mainFrame })
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  await expect(invoke(event, "setEnabled", true)).rejects.toThrow("restricted")
  attachWindowsDesktopService({ webContents: sender } as unknown as BrowserWindow)
  await expect(invoke({ ...event, senderFrame: { ...mainFrame } } as IpcMainInvokeEvent, "setEnabled", true)).rejects.toThrow("restricted")
  for (const value of [undefined, "install", "true", {}, 1]) expect(await invoke(event, "setEnabled", value)).toMatchObject({ ok: false })
  expect(await invoke(event, "execute", "install")).toMatchObject({ ok: false })
  expect(controller.setEnabled).not.toHaveBeenCalled()
  expect(await invoke(event, "get")).toEqual({ ok: true, value: state })
  expect(await invoke(event, "setEnabled", true)).toMatchObject({ ok: true, value: { installed: true, running: true } })
  expect(controller.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  controller.setEnabled.mockRejectedValueOnce(new Error("Administrator approval was cancelled"))
  expect(await invoke(event, "setEnabled", false)).toEqual({ ok: false, error: "Administrator approval was cancelled" })
  sender.emit("destroyed")
  await expect(invoke(event, "get")).rejects.toThrow("restricted")
})
