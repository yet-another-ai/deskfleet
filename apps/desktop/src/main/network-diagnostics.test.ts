import { beforeEach, expect, test, vi } from "vitest"
import { NETWORK_DIAGNOSTICS_CHANNEL, type NatTestResult } from "@deskfleet/client/network-diagnostics"
import { BUNDLED_RENDERER_URL } from "../shared/renderer-security.ts"

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock("@deskfleet/native", () => ({ testNat: vi.fn() }))
import { ipcMain } from "electron"
import { testNat } from "@deskfleet/native"
import { installNetworkDiagnostics } from "./network-diagnostics.ts"

const mainFrame = { url: BUNDLED_RENDERER_URL }
const event = { sender: { mainFrame }, senderFrame: mainFrame } as Electron.IpcMainInvokeEvent

function handler() {
  installNetworkDiagnostics()
  const [channel, invoke] = vi.mocked(ipcMain.handle).mock.calls.at(-1)!
  expect(channel).toBe(NETWORK_DIAGNOSTICS_CHANNEL)
  return invoke
}

beforeEach(() => vi.clearAllMocks())

test("only the trusted main renderer can start a local NAT probe", async () => {
  const invoke = handler()
  const untrustedFrame = { url: "https://example.com/" }
  const untrusted = { sender: { mainFrame: untrustedFrame }, senderFrame: untrustedFrame } as Electron.IpcMainInvokeEvent
  await expect(invoke(untrusted, "testNat", "stun.example.com:3478")).rejects.toThrow("restricted")
  await expect(invoke({ ...event, senderFrame: { ...mainFrame } } as Electron.IpcMainInvokeEvent, "testNat", "stun.example.com:3478")).rejects.toThrow("restricted")
  expect(testNat).not.toHaveBeenCalled()
})

test("validates the operation and server before invoking the native probe", async () => {
  const invoke = handler()
  await expect(invoke(event, "unknown", "stun.example.com:3478")).rejects.toThrow("Unknown")
  for (const server of [undefined, null, 42, {}, "", "   "]) {
    await expect(invoke(event, "testNat", server)).rejects.toThrow("hostname:port")
  }
  expect(testNat).not.toHaveBeenCalled()
})

test("returns the observed local result and allows retry after probe failure", async () => {
  const invoke = handler()
  vi.mocked(testNat).mockRejectedValueOnce(new Error("STUN server has no IPv4 address"))
  await expect(invoke(event, "testNat", "stun.example.com:3478")).rejects.toThrow("no IPv4 address")
  const result = {
    server: "203.0.113.1:3478", localAddress: "192.168.1.10:50000", publicAddress: "198.51.100.1:52000",
    mapping: "endpoint-independent", filtering: "address-and-port-dependent", status: "complete", durationMs: 4500,
  } satisfies NatTestResult
  vi.mocked(testNat).mockResolvedValueOnce(result)
  await expect(invoke(event, "testNat", "  stun.example.com:3478  ")).resolves.toEqual(result)
  expect(testNat).toHaveBeenLastCalledWith("stun.example.com:3478")
})
