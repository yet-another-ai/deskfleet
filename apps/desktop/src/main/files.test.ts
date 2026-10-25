import { expect, test, vi } from "vitest"
import type { FilesApi } from "@deskfleet/client/files"

vi.mock("electron", () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {} }))
vi.mock("./desktop-media.ts", () => ({ isDesktopMediaSender: () => true }))
vi.mock("./files-peer.ts", () => ({ createNativeFileEndpoint: vi.fn() }))
vi.mock("./daemon-client.ts", () => ({ DaemonClient: { connect: vi.fn() } }))
import { DaemonClient } from "./daemon-client.ts"
import { invokeFiles, localSessionDirectory } from "./files.ts"

test("file bridge accepts explicit endpoints and rejects malformed write requests", async () => {
  const enqueue = vi.fn(async () => "transfer")
  const api = { enqueue } as unknown as FilesApi
  const request = { source: { target: { kind: "local" }, path: "/source" }, destination: { target: { kind: "machine", machineId: "2", teamId: "1" }, path: "/destination" }, conflict: "rename" }
  expect(await invokeFiles(api, "enqueue", [request])).toBe("transfer")
  expect(enqueue).toHaveBeenCalledWith(request)
  await expect(invokeFiles(api, "enqueue", [{ ...request, conflict: "delete" }])).rejects.toThrow("conflict")
  await expect(invokeFiles(api, "enqueue", [{ ...request, source: { target: { kind: "arbitrary" }, path: "/source" } }])).rejects.toThrow("target")
  await expect(invokeFiles(api, "enqueue", [{ ...request, destination: { ...request.destination, path: "bad\0path" } }])).rejects.toThrow("path")
  await expect(invokeFiles(api, "writeFile", [])).rejects.toThrow("Unknown")
  expect(enqueue).toHaveBeenCalledTimes(1)
})

test("local resources use the Session's captured directory and release the control connection", async () => {
  const call = vi.fn(async () => ({ workspaces: [{ worktrees: [
    { directories: [{ path: "/workspace/current" }] },
    { sessionId: "session", directories: [{ path: "/workspace/captured" }, { path: "/workspace/secondary" }] },
  ] }] }))
  const close = vi.fn()
  vi.mocked(DaemonClient.connect).mockResolvedValue({ call, close } as unknown as DaemonClient)
  expect(await localSessionDirectory("session")).toBe("/workspace/captured")
  expect(call).toHaveBeenCalledWith("catalogList", {})
  expect(close).toHaveBeenCalledOnce()
  await expect(localSessionDirectory("missing")).rejects.toThrow("unavailable")
  expect(close).toHaveBeenCalledTimes(2)
  call.mockRejectedValueOnce(new Error("Sign in and select a team"))
  await expect(localSessionDirectory("session")).rejects.toThrow("Sign in and select a team")
  expect(close).toHaveBeenCalledTimes(3)
})
