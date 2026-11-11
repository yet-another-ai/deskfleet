import { afterEach, expect, test, vi } from "vitest"
import { EventEmitter } from "node:events"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CentralApi, CentralEvent } from "@deskfleet/client/central"
import { FILES_CHANGED_EVENT, type FileListing, type FilesApi, type FileTarget } from "@deskfleet/client/files"
import { FilesService } from "../../../daemon/src/files-service.ts"

vi.mock("electron", () => ({ app: { getPath: vi.fn() }, BrowserWindow: { fromWebContents: vi.fn() }, dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }))
vi.mock("./desktop-media.ts", () => ({ isDesktopMediaSender: () => true }))
vi.mock("./files-peer.ts", () => ({ createNativeFileEndpoint: vi.fn() }))
vi.mock("./daemon-client.ts", () => ({ DaemonClient: { connect: vi.fn() } }))
import { DaemonClient } from "./daemon-client.ts"
import { BrowserWindow, dialog, ipcMain, shell } from "electron"
import { createNativeFileEndpoint } from "./files-peer.ts"
import { installFiles, invokeFiles, localSessionAttachmentDirectory, localSessionDirectory } from "./files.ts"

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

test("file bridge forwards opaque grants and rejects malformed grant identifiers", async () => {
  const list = vi.fn(async () => ({}))
  const api = { list } as unknown as FilesApi
  await invokeFiles(api, "list", [{ kind: "local", grantId: "issued" }, "/selected"])
  expect(list).toHaveBeenCalledWith({ kind: "local", grantId: "issued" }, "/selected")
  await expect(invokeFiles(api, "list", [{ kind: "local", grantId: {} }])).rejects.toThrow("identifier")
  await expect(invokeFiles(api, "list", [{ kind: "local", grantId: "bad\0token" }])).rejects.toThrow("identifier")
})

test.each(["openResource", "revealResource"] as const)("native %s accepts only a validated scoped resource request", async method => {
  const handler = vi.fn(async () => {})
  const api = { [method]: handler } as unknown as FilesApi
  const request = { target: { kind: "machine", teamId: "team", machineId: "machine" }, sessionId: "session", uri: "file:///work/report.docx" }
  await invokeFiles(api, method, [{ ...request, canOpen: true, path: "/untrusted" }])
  expect(handler).toHaveBeenCalledExactlyOnceWith(request)
  await expect(invokeFiles(api, method, [{ ...request, uri: "bad\0path" }])).rejects.toThrow("path")
  await expect(invokeFiles({} as FilesApi, method, [request])).rejects.toThrow("unavailable")
})

class TestContents extends EventEmitter {
  destroyed = false
  readonly send = vi.fn()
  isDestroyed() { return this.destroyed }
}
const fileHosts: Array<{ close(): Promise<void> }> = []
const fileRoots: string[] = []
afterEach(async () => {
  await Promise.all(fileHosts.splice(0).map(host => host.close()))
  await Promise.all(fileRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})
async function hostFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-files-ipc-")))
  fileRoots.push(root)
  await writeFile(join(root, "visible.txt"), "selected")
  let accountEvent!: (event: CentralEvent) => void
  const central = {
    status: vi.fn(async () => ({ serverUrl: "https://fleet.example", user: { id: "user" }, siteAdmin: false })),
    onEvent: vi.fn((listener: (event: CentralEvent) => void) => { accountEvent = listener; return vi.fn() }),
  } as unknown as CentralApi
  const host = installFiles(central)
  fileHosts.push(host)
  const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1] as unknown as (event: { sender: TestContents }, method: string, args: unknown[]) => Promise<unknown>
  vi.mocked(BrowserWindow.fromWebContents).mockImplementation(contents => ({ webContents: contents }) as unknown as BrowserWindow)
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] })
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false })
  const request = (contents: TestContents, method: string, ...args: unknown[]) => handler({ sender: contents }, method, args)
  const choose = async (contents: TestContents): Promise<FileTarget> => {
    const listing = await request(contents, "chooseLocalDirectory") as FileListing
    return { kind: "local", grantId: listing.grantId }
  }
  return { root, host, request, choose, accountChanged: () => accountEvent({ type: "accountChanged" }) }
}

test("IPC grants and transfer events stay with the requesting window", async () => {
  const f = await hostFixture(), first = new TestContents(), second = new TestContents()
  const target = await f.choose(first)
  await expect(f.request(second, "list", target)).rejects.toThrow("Local file access has expired")
  expect((await f.request(first, "list", target, f.root) as FileListing).entries[0]?.name).toBe("visible.txt")
  const id = await f.request(first, "enqueue", { source: { target, path: join(f.root, "visible.txt") }, destination: { target, path: f.root } })
  expect(first.send).toHaveBeenCalledWith(FILES_CHANGED_EVENT, expect.arrayContaining([expect.objectContaining({ id })]))
  expect(second.send).not.toHaveBeenCalled()
  await expect(f.request(second, "cancel", id)).rejects.toThrow("Unknown file transfer")
  await expect(f.request(second, "retry", id)).rejects.toThrow("Unknown file transfer")
})

test("hash routing and hiding preserve grants, full document navigation revokes them", async () => {
  const f = await hostFixture(), contents = new TestContents(), target = await f.choose(contents)
  contents.emit("did-start-navigation", {}, "deskfleet://app/#/files", true, true)
  contents.emit("did-start-navigation", {}, "https://frame.test", false, false)
  contents.emit("hide")
  await expect(f.request(contents, "list", target, f.root)).resolves.toMatchObject({ path: f.root })
  contents.emit("did-start-navigation", {}, "deskfleet://app/", false, true)
  await expect(f.request(contents, "list", target)).rejects.toThrow("Local file access has expired")
  expect(contents.send).toHaveBeenCalledWith(FILES_CHANGED_EVENT, [])
})

test("account changes revoke every window and old transfer identifiers", async () => {
  const f = await hostFixture(), first = new TestContents(), second = new TestContents()
  const firstTarget = await f.choose(first), secondTarget = await f.choose(second)
  const id = await f.request(first, "enqueue", { source: { target: firstTarget, path: join(f.root, "visible.txt") }, destination: { target: firstTarget, path: f.root } })
  f.accountChanged()
  await expect(f.request(first, "list", firstTarget)).rejects.toThrow("Local file access has expired")
  await expect(f.request(second, "list", secondTarget)).rejects.toThrow("Local file access has expired")
  await expect(f.request(first, "retry", id)).rejects.toThrow("Unknown file transfer")
})

test.each(["navigation", "account", "crash", "destroy"])("pending directory selection cannot survive %s", async cause => {
  const f = await hostFixture(), contents = new TestContents()
  let complete!: (result: Electron.OpenDialogReturnValue) => void
  vi.mocked(dialog.showOpenDialog).mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
  const pending = f.request(contents, "chooseLocalDirectory")
  const rejected = expect(pending).rejects.toThrow("expired")
  if (cause === "navigation") contents.emit("did-start-navigation", {}, "deskfleet://app/", false, true)
  else if (cause === "account") f.accountChanged()
  else if (cause === "crash") contents.emit("render-process-gone", {})
  else { contents.destroyed = true; contents.emit("destroyed") }
  complete({ canceled: false, filePaths: [f.root] })
  await rejected
})

test("local Session resources require an explicit authorized Team and Machine target", async () => {
  await expect(localSessionDirectory("1")).rejects.toThrow("authorized Team and Machine")
  await expect(localSessionAttachmentDirectory("1")).rejects.toThrow("authorized Team and Machine")
  expect(DaemonClient.connect).not.toHaveBeenCalled()
})

test("native open verifies this daemon registration and forwards its resolved path to the OS", async () => {
  const f = await hostFixture(), contents = new TestContents()
  const endpoint = new FilesService(async () => f.root)
  vi.mocked(createNativeFileEndpoint).mockReturnValue(endpoint as unknown as ReturnType<typeof createNativeFileEndpoint>)
  const call = vi.fn(async () => ({ machineName: "This computer", registrations: [{
    configured: true, connected: true, revoked: false, serverUrl: "https://fleet.example", teamId: "team", machineId: "machine",
    identity: { originId: "origin", machineId: "local-database-id" }, machineName: "This computer",
  }] }))
  const close = vi.fn()
  vi.mocked(DaemonClient.connect).mockResolvedValue({ call, close } as unknown as Awaited<ReturnType<typeof DaemonClient.connect>>)
  vi.mocked(shell.openPath).mockResolvedValueOnce("").mockResolvedValueOnce("No application is associated with this file")
  const request = { target: { kind: "machine", teamId: "team", machineId: "machine" }, sessionId: "session", uri: "visible.txt:2" }
  await f.request(contents, "openResource", request)
  expect(call).toHaveBeenCalledWith("centralStatus", {})
  expect(close).toHaveBeenCalledOnce()
  expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(join(f.root, "visible.txt"))
  await expect(f.request(contents, "openResource", request)).rejects.toThrow("No application")
  expect(close).toHaveBeenCalledTimes(2)
  await f.request(contents, "revealResource", request)
  expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(join(f.root, "visible.txt"))
  expect(close).toHaveBeenCalledTimes(3)
})
