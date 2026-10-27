import { expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import { APPLICATIONS_CHANNEL } from "@deskfleet/client/applications"

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock("./desktop-media.ts", () => ({ isDesktopMediaSender: vi.fn(() => true) }))
vi.mock("@deskfleet/native", () => ({ scanLocalApplications: vi.fn(async () => []), openLocalApplication: vi.fn() }))
import { ipcMain } from "electron"
import { scanLocalApplications } from "@deskfleet/native"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { installLocalApplications } from "./applications.ts"

test("only the trusted main renderer can discover or launch local applications", async () => {
  installLocalApplications({} as CentralApi)
  const [channel, handler] = vi.mocked(ipcMain.handle).mock.calls.at(-1)!
  expect(channel).toBe(APPLICATIONS_CHANNEL)
  vi.mocked(isDesktopMediaSender).mockReturnValueOnce(false)
  await expect(handler({} as Electron.IpcMainInvokeEvent, "scan")).rejects.toThrow("restricted")
  expect(scanLocalApplications).not.toHaveBeenCalled()
  await expect(handler({} as Electron.IpcMainInvokeEvent, "scan")).resolves.toEqual([])
})
