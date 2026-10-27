import { expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import { PORTS_IPC_CHANNEL, type PortsApi } from "@deskfleet/client/ports"

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock("./desktop-media.ts", () => ({ isDesktopMediaSender: vi.fn(() => true) }))
vi.mock("./ports-peer.ts", () => ({ openNativePortForward: vi.fn() }))
import { ipcMain } from "electron"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { installPorts, invokePorts } from "./ports.ts"

const target = { teamId: "team", machineId: "machine" }
test("the hidden bridge validates loopback targets and applies ephemeral local port defaults", async () => {
  const start = vi.fn(async () => ({})), list = vi.fn(async () => []), stop = vi.fn(async () => {})
  const api = { start, list, stop } as unknown as PortsApi
  await invokePorts(api, "start", [{ target, targetPort: 3000 }])
  expect(start).toHaveBeenLastCalledWith({ target, localPort: 0, targetHost: "127.0.0.1", targetPort: 3000 })
  await invokePorts(api, "start", [{ target, targetHost: "::1", localPort: 41000, targetPort: 9229 }])
  expect(start).toHaveBeenLastCalledWith({ target, localPort: 41000, targetHost: "::1", targetPort: 9229 })
  for (const value of ["localhost", "0.0.0.0", "192.168.0.1", "127.1", "[::1]", null]) {
    await expect(invokePorts(api, "start", [{ target, targetPort: 3000, targetHost: value }])).rejects.toThrow("loopback")
  }
  await expect(invokePorts(api, "start", [{ target, targetPort: 3000, localHost: "0.0.0.0" }])).rejects.toThrow("always binds")
  for (const value of [-1, 65536, 1.5, "3000", null, NaN]) {
    await expect(invokePorts(api, "start", [{ target, targetPort: value }])).rejects.toThrow("TCP port")
    await expect(invokePorts(api, "start", [{ target, targetPort: 3000, localPort: value }])).rejects.toThrow("TCP port")
  }
  await expect(invokePorts(api, "start", [{ target, targetPort: 0 }])).rejects.toThrow("TCP port")
  await expect(invokePorts(api, "start", [{ target: { teamId: "", machineId: "machine" }, targetPort: 3000 }])).rejects.toThrow("identifier")
  await expect(invokePorts(api, "start", [{ target: { teamId: "team", machineId: "machine\0" }, targetPort: 3000 }])).rejects.toThrow("identifier")
  await expect(invokePorts(api, "connect", [])).rejects.toThrow("Unknown")
  await expect(invokePorts(api, "list", {})).rejects.toThrow("Invalid")
  await invokePorts(api, "list", [])
  await invokePorts(api, "stop", ["id"])
  expect(list).toHaveBeenCalledOnce()
  expect(stop).toHaveBeenCalledWith("id")
  expect(start).toHaveBeenCalledTimes(2)
})

test("only the trusted main renderer can invoke the app-owned forwarding service", async () => {
  const central = { onEvent: vi.fn(() => vi.fn()) } as unknown as CentralApi
  const installed = installPorts(central)
  const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1]
  expect(vi.mocked(ipcMain.handle).mock.calls.at(-1)![0]).toBe(PORTS_IPC_CHANNEL)
  vi.mocked(isDesktopMediaSender).mockReturnValueOnce(false)
  await expect(handler({} as Electron.IpcMainInvokeEvent, "list", [])).rejects.toThrow("restricted")
  expect(await handler({} as Electron.IpcMainInvokeEvent, "list", [])).toEqual([])
  await installed.close()
  expect(ipcMain.removeHandler).toHaveBeenCalledWith(PORTS_IPC_CHANNEL)
})
