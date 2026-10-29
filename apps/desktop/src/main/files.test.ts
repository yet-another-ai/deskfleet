import { afterEach, expect, test, vi } from "vitest"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CentralApi, CentralEvent } from "@deskfleet/client/central"
import { FILES_CHANGED_EVENT, type FileListing, type FilesApi, type FileTarget } from "@deskfleet/client/files"

vi.mock("electron", () => ({ app: { getPath: vi.fn() }, BrowserWindow: { fromWebContents: vi.fn() }, dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock("./desktop-media.ts", () => ({ isDesktopMediaSender: () => true }))
vi.mock("./files-peer.ts", () => ({ createNativeFileEndpoint: vi.fn() }))
vi.mock("./daemon-client.ts", () => ({ DaemonClient: { connect: vi.fn() } }))
import { DaemonClient } from "./daemon-client.ts"
import { app, BrowserWindow, dialog, ipcMain } from "electron"
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
  const central = { onEvent: vi.fn((listener: (event: CentralEvent) => void) => { accountEvent = listener; return vi.fn() }) } as unknown as CentralApi
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

test.each(["machine", "machines/00000000-0000-0000-0000-000000000001"])("attachments use the desktop profile's active %s directory", async machine => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-attachments-")))
  fileRoots.push(profile)
  vi.mocked(app.getPath).mockReturnValue(profile)
  vi.mocked(DaemonClient.connect).mockResolvedValue({
    call: vi.fn(async () => ({ workspaces: [{ worktrees: [{ sessionId: "42", directories: [{ path: profile }] }] }] })),
    close: vi.fn(),
  } as unknown as DaemonClient)
  const headless = join(profile, "headless")
  vi.stubEnv("DESKFLEET_DAEMON_DIRECTORY", headless)
  await mkdir(headless)
  await writeFile(join(headless, "active-machine.json"), "invalid headless state")
  const daemon = join(profile, "daemon")
  await mkdir(daemon)
  if (machine !== "machine") await writeFile(join(daemon, "active-machine.json"), JSON.stringify({ directory: machine }))
  expect(await localSessionAttachmentDirectory("42")).toBe(join(daemon, machine, "session-attachments", "42"))
})
