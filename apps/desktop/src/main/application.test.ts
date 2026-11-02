import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { beforeEach, expect, test, vi } from "vitest"
import type { BackgroundLifecycle } from "./lifecycle.ts"

const { handle } = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock("electron", () => ({ ipcMain: { handle } }))
import { APPLICATION_RESTART_CHANNEL } from "@deskfleet/client/application"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"
import { attachApplication, installApplication } from "./application.ts"

beforeEach(() => vi.clearAllMocks())

test("only a registered main renderer can restart the application", async () => {
  const lifecycle = { restart: vi.fn() } as unknown as BackgroundLifecycle
  installApplication(lifecycle)
  expect(handle).toHaveBeenCalledWith(APPLICATION_RESTART_CHANNEL, expect.any(Function))
  const invoke = handle.mock.calls.at(-1)![1] as (event: IpcMainInvokeEvent) => void
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const sender = Object.assign(new EventEmitter(), { mainFrame })
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent

  expect(() => invoke(event)).toThrow("restricted")
  attachApplication({ webContents: sender } as unknown as BrowserWindow)
  expect(() => invoke({ ...event, senderFrame: { ...mainFrame } } as IpcMainInvokeEvent)).toThrow("restricted")
  expect(invoke(event)).toBeUndefined()
  expect(lifecycle.restart).toHaveBeenCalledOnce()

  sender.emit("destroyed")
  expect(() => invoke(event)).toThrow("restricted")
})
