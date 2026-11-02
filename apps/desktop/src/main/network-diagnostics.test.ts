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

function handler(stunUrls = ["stun:owned.example:3478"]) {
  const networkConfiguration = vi.fn(async () => ({ stunUrls }))
  installNetworkDiagnostics({ networkConfiguration })
  const [channel, invoke] = vi.mocked(ipcMain.handle).mock.calls.at(-1)!
  expect(channel).toBe(NETWORK_DIAGNOSTICS_CHANNEL)
  return { invoke, networkConfiguration }
}

beforeEach(() => vi.clearAllMocks())

test("only the trusted main renderer can start a local NAT probe", async () => {
  const { invoke, networkConfiguration } = handler()
  const untrustedFrame = { url: "https://example.com/" }
  const untrusted = { sender: { mainFrame: untrustedFrame }, senderFrame: untrustedFrame } as Electron.IpcMainInvokeEvent
  await expect(invoke(untrusted, "testNat")).rejects.toThrow("restricted")
  await expect(invoke({ ...event, senderFrame: { ...mainFrame } } as Electron.IpcMainInvokeEvent, "testNat")).rejects.toThrow("restricted")
  expect(networkConfiguration).not.toHaveBeenCalled()
  expect(testNat).not.toHaveBeenCalled()
})

test("validates the operation before reading the service configuration", async () => {
  const { invoke, networkConfiguration } = handler()
  await expect(invoke(event, "unknown")).rejects.toThrow("Unknown")
  expect(networkConfiguration).not.toHaveBeenCalled()
  expect(testNat).not.toHaveBeenCalled()
})

test("uses deployment order and never accepts a renderer-supplied STUN server", async () => {
  const { invoke, networkConfiguration } = handler(["stun:owned.example:3478", "stun:backup.example:3479"])
  await invoke(event, "testNat", "untrusted.example:9999")
  expect(networkConfiguration).toHaveBeenCalledExactlyOnceWith()
  expect(testNat).toHaveBeenCalledExactlyOnceWith("owned.example:3478")
})

test.each([
  [["stun:owned.example"], "owned.example:3478"],
  [["STUN:192.0.2.1:5349?transport=udp"], "192.0.2.1:5349"],
  [["stuns:secure.example:5349", "stun:[2001:db8::1]:3478", "stun:tcp.example?transport=tcp", "stun:owned.example:3479"], "owned.example:3479"],
] as const)("selects a UDP IPv4-compatible endpoint from %j", async (urls, endpoint) => {
  const { invoke } = handler([...urls])
  await invoke(event, "testNat")
  expect(testNat).toHaveBeenCalledExactlyOnceWith(endpoint)
})

test.each([
  [[]],
  [["stuns:secure.example:5349"]],
  [["stun:[2001:db8::1]:3478"]],
  [["stun:owned.example:0", "stun:owned.example:65536", "turn:relay.example:3478"]],
])("reports missing compatible service configuration without probing %j", async (urls) => {
  const { invoke } = handler(urls)
  await expect(invoke(event, "testNat")).rejects.toThrow("no IPv4 UDP STUN server configured")
  expect(testNat).not.toHaveBeenCalled()
})

test("does not probe if fetching the service configuration fails", async () => {
  const { invoke, networkConfiguration } = handler()
  networkConfiguration.mockRejectedValueOnce(new Error("Service unavailable"))
  await expect(invoke(event, "testNat")).rejects.toThrow("Service unavailable")
  expect(testNat).not.toHaveBeenCalled()
})

test("returns the local result and refreshes service configuration on retry", async () => {
  const { invoke, networkConfiguration } = handler()
  vi.mocked(testNat).mockRejectedValueOnce(new Error("STUN server has no IPv4 address"))
  await expect(invoke(event, "testNat")).rejects.toThrow("no IPv4 address")
  const result = {
    server: "203.0.113.1:3478", localAddress: "192.168.1.10:50000", publicAddress: "198.51.100.1:52000",
    mapping: "endpoint-independent", filtering: "address-and-port-dependent", status: "complete", durationMs: 4500,
  } satisfies NatTestResult
  networkConfiguration.mockResolvedValueOnce({ stunUrls: ["stun:updated.example:3479"] })
  vi.mocked(testNat).mockResolvedValueOnce(result)
  await expect(invoke(event, "testNat")).resolves.toEqual(result)
  expect(networkConfiguration).toHaveBeenCalledTimes(2)
  expect(testNat).toHaveBeenLastCalledWith("updated.example:3479")
})
