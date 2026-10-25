import { beforeEach, expect, test, vi } from "vitest"
import type { IpcMainInvokeEvent } from "electron"
import { ONBOARDING_CHANNEL } from "../../../../packages/client/src/onboarding.ts"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"
import type { OnboardingController } from "./onboarding-controller.ts"
import { installOnboarding } from "./onboarding.ts"

const mocks = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }))
beforeEach(() => vi.clearAllMocks())

function fixture() {
  const controller = { get: vi.fn(async () => ({ step: "server" })), saveServer: vi.fn(), permissions: vi.fn(), requestPermission: vi.fn(), advancePermission: vi.fn(), complete: vi.fn() }
  installOnboarding(controller as unknown as OnboardingController)
  expect(mocks.handle.mock.calls[0]![0]).toBe(ONBOARDING_CHANNEL)
  const invoke = mocks.handle.mock.calls[0]![1] as (event: IpcMainInvokeEvent, method: unknown, value?: unknown) => Promise<unknown>
  const mainFrame = { url: BUNDLED_RENDERER_URL }
  const event = { sender: { mainFrame }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  return { controller, event, invoke, mainFrame }
}

test("welcome IPC accepts only the main renderer and known permission actions", async () => {
  const f = fixture()
  expect(await f.invoke(f.event, "get")).toEqual({ step: "server" })
  await f.invoke(f.event, "requestPermission", "screenCapture")
  expect(f.controller.requestPermission).toHaveBeenCalledExactlyOnceWith("screenCapture")
  await expect(f.invoke(f.event, "requestPermission", "https://example.org/")).rejects.toThrow("Invalid welcome permission")
  await expect(f.invoke(f.event, "saveServer", {})).rejects.toThrow("Server address")
  await expect(f.invoke(f.event, "openExternal", "https://example.org/")).rejects.toThrow("Unknown welcome operation")
  await expect(f.invoke({ ...f.event, senderFrame: null }, "get")).rejects.toThrow("main renderer")
  await expect(f.invoke({ ...f.event, senderFrame: { url: BUNDLED_RENDERER_URL } } as IpcMainInvokeEvent, "get")).rejects.toThrow("main renderer")
  f.mainFrame.url = "https://example.org/"
  await expect(f.invoke(f.event, "get")).rejects.toThrow("main renderer")
  expect(f.controller.get).toHaveBeenCalledOnce()
})
