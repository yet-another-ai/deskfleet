import { afterEach, expect, test, vi } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { FileTarget, FileTransfer } from "@deskfleet/client/files"
import { FilesService } from "../../../daemon/src/files-service.ts"
import { WindowFiles } from "./files-controller.ts"

const roots: string[] = []
const controllers: WindowFiles[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-window-files-")))
  roots.push(root)
  const source = join(root, "source"), destination = join(root, "destination")
  await Promise.all([mkdir(source), mkdir(destination)])
  await writeFile(join(source, "hello.txt"), "selected content")
  const chooseDirectory = vi.fn(async (): Promise<string | null> => source)
  const confirmOverwrite = vi.fn(async (_path: string) => false)
  const sessionDirectory = vi.fn(async (_sessionId: string) => source)
  const remoteEndpoint = vi.fn(async () => new FilesService(async () => source))
  const create = () => {
    const controller = new WindowFiles({ chooseDirectory, confirmOverwrite, sessionDirectory, remoteEndpoint })
    controllers.push(controller)
    return controller
  }
  return { source, destination, chooseDirectory, confirmOverwrite, sessionDirectory, remoteEndpoint, create }
}
async function selected(controller: WindowFiles): Promise<Extract<FileTarget, { kind: "local" }>> {
  const listing = await controller.chooseLocalDirectory()
  expect(listing?.grantId).toBeTypeOf("string")
  return { kind: "local", grantId: listing!.grantId }
}
function finished(controller: WindowFiles, id: string): Promise<FileTransfer> {
  return new Promise(resolve => {
    const check = (values: FileTransfer[]) => {
      const value = values.find(value => value.id === id)
      if (value && ["completed", "failed", "cancelled", "conflict"].includes(value.state)) { unsubscribe(); resolve(value) }
    }
    const unsubscribe = controller.onChanged(check)
    void controller.transfers().then(check)
  })
}

test("desktop browsing and copying use OS access without directory selection", async () => {
  const f = await fixture(), controller = f.create(), other = f.create()
  const home = await controller.list({ kind: "local" })
  expect(home.path).toBe(await realpath(homedir()))
  expect(home.homePath).toBe(homedir())
  expect(home.grantId).toBeTypeOf("string")
  await expect(controller.list({ kind: "local", grantId: "forged" }, f.source)).rejects.toThrow("Local file access has expired")
  const source: FileTarget = { kind: "local", grantId: home.grantId }
  const listing = await controller.list(source, f.source)
  expect(listing.entries.map(entry => entry.name)).toEqual(["hello.txt"])
  expect(listing.parentPath).toBe(dirname(f.source))
  expect(listing.homePath).toBe(homedir())
  await expect(other.list(source)).rejects.toThrow("Local file access has expired")
  const id = await controller.enqueue({ source: { target: { kind: "local" }, path: join(f.source, "hello.txt") }, destination: { target: { kind: "local" }, path: f.destination } })
  expect((await finished(controller, id)).state).toBe("completed")
  expect(await readFile(join(f.destination, "hello.txt"), "utf8")).toBe("selected content")
  expect(f.chooseDirectory).not.toHaveBeenCalled()
  expect(await other.transfers()).toEqual([])
  await expect(other.cancel(id)).rejects.toThrow("Unknown file transfer")
  await expect(other.retry(id)).rejects.toThrow("Unknown file transfer")
  await controller.close()
  await expect(controller.list(source)).rejects.toThrow("expired")
})

test("choosing a directory navigates without confining later browsing to it", async () => {
  const f = await fixture(), controller = f.create()
  const listing = await controller.chooseLocalDirectory()
  expect(listing).toMatchObject({ path: f.source, parentPath: dirname(f.source), homePath: homedir() })
  const target: FileTarget = { kind: "local", grantId: listing!.grantId }
  expect((await controller.list(target, f.destination)).path).toBe(f.destination)
  expect((await controller.list(target)).path).toBe(await realpath(homedir()))
  expect(f.chooseDirectory).toHaveBeenCalledOnce()
})

test("uploads and downloads work before any local folder is selected", async () => {
  const f = await fixture(), controller = f.create()
  const local = { kind: "local" } as const
  const remote = { kind: "machine", machineId: "machine", teamId: "team" } as const
  const upload = await controller.enqueue({ source: { target: local, path: join(f.source, "hello.txt") }, destination: { target: remote, path: f.destination } })
  expect((await finished(controller, upload)).state).toBe("completed")
  const downloadDirectory = join(f.source, "download")
  await mkdir(downloadDirectory)
  const download = await controller.enqueue({ source: { target: remote, path: join(f.destination, "hello.txt") }, destination: { target: local, path: downloadDirectory } })
  expect((await finished(controller, download)).state).toBe("completed")
  expect(await readFile(join(downloadDirectory, "hello.txt"), "utf8")).toBe("selected content")
  expect(f.chooseDirectory).not.toHaveBeenCalled()
})

test("Session resources load automatically from a shared read-only captured directory grant", async () => {
  const f = await fixture(), controller = f.create()
  const request = { target: { kind: "local" } as const, sessionId: "session", uri: "hello.txt" }
  const [file, preview] = await Promise.all([controller.resolveResource(request), controller.readResource(request)])
  expect(file.path).toBe(join(f.source, "hello.txt"))
  expect(new TextDecoder().decode(preview.data)).toBe("selected content")
  expect(f.sessionDirectory).toHaveBeenCalledExactlyOnceWith("session")
  expect(f.chooseDirectory).not.toHaveBeenCalled()

  f.chooseDirectory.mockResolvedValueOnce(f.destination)
  const id = await controller.saveResource(request)
  const transfer = await finished(controller, id!)
  expect(transfer.state).toBe("completed")
  expect(await readFile(join(f.destination, "hello.txt"), "utf8")).toBe("selected content")
  const target = transfer.source.target
  expect(target).toMatchObject({ kind: "local", grantId: expect.any(String) })
  expect(f.sessionDirectory).toHaveBeenCalledOnce()
  expect(new TextDecoder().decode((await controller.readResource(request)).data)).toBe("selected content")
  await expect(controller.readResource({ ...request, target, sessionId: "other" })).rejects.toThrow("Session preview")
  await writeFile(join(f.destination, "private.txt"), "private")
  await expect(controller.readResource({ ...request, uri: pathToFileURL(join(f.destination, "private.txt")).href })).rejects.toThrow("outside")
  await expect(controller.enqueue({ source: { target, path: join(f.source, "hello.txt") }, destination: { target, path: f.source } })).rejects.toThrow("write access")
})

test("Session resolution failures can retry independently of local file browsing", async () => {
  const f = await fixture(), controller = f.create()
  const request = { target: { kind: "local" } as const, sessionId: "session", uri: "hello.txt" }
  f.sessionDirectory.mockRejectedValueOnce(new Error("Session unavailable"))
  await expect(controller.readResource(request)).rejects.toThrow("Session unavailable")
  await expect(controller.list({ kind: "local" }, f.source)).resolves.toMatchObject({ path: f.source })
  await expect(controller.readResource({ ...request, target: { kind: "local", grantId: "forged" } })).rejects.toThrow("Local file access has expired")
  expect(new TextDecoder().decode((await controller.readResource(request)).data)).toBe("selected content")
  expect(f.sessionDirectory).toHaveBeenCalledTimes(2)
})

test("pending native folder selection cannot issue a grant after close", async () => {
  const f = await fixture(), controller = f.create(), selection = deferred<string | null>()
  f.chooseDirectory.mockReturnValueOnce(selection.promise)
  const pending = controller.chooseLocalDirectory()
  const rejected = expect(pending).rejects.toThrow("expired")
  await controller.close()
  selection.resolve(f.source)
  await rejected
})

test("pending Session resource resolution cannot resurrect a closed document", async () => {
  const f = await fixture(), controller = f.create(), directory = deferred<string>()
  f.sessionDirectory.mockReturnValueOnce(directory.promise)
  const pending = controller.readResource({ target: { kind: "local" }, sessionId: "session", uri: "hello.txt" })
  const rejected = expect(pending).rejects.toThrow("expired")
  await controller.close()
  directory.resolve(f.source)
  await rejected
})

test("retry replacement requires native consent for the exact destination", async () => {
  const f = await fixture(), controller = f.create()
  await writeFile(join(f.destination, "hello.txt"), "original")
  const source = await selected(controller)
  f.chooseDirectory.mockResolvedValueOnce(f.destination)
  const destination = await selected(controller)
  const id = await controller.enqueue({ source: { target: source, path: join(f.source, "hello.txt") }, destination: { target: destination, path: f.destination } })
  expect((await finished(controller, id)).state).toBe("conflict")
  expect(f.confirmOverwrite).not.toHaveBeenCalled()
  await controller.retry(id, "replace")
  expect((await finished(controller, id)).state).toBe("failed")
  expect(await readFile(join(f.destination, "hello.txt"), "utf8")).toBe("original")
  expect(f.confirmOverwrite).toHaveBeenCalledWith(join(f.destination, "hello.txt"))
  f.confirmOverwrite.mockResolvedValueOnce(true)
  await controller.retry(id, "replace")
  expect((await finished(controller, id)).state).toBe("completed")
  expect(await readFile(join(f.destination, "hello.txt"), "utf8")).toBe("selected content")
  expect(f.confirmOverwrite).toHaveBeenCalledTimes(2)
})

test("explicit remote machine endpoints retain their own filesystem authority", async () => {
  const f = await fixture(), controller = f.create()
  const target: FileTarget = { kind: "machine", machineId: "machine", teamId: "team" }
  expect((await controller.list(target, f.destination)).path).toBe(f.destination)
  expect(f.remoteEndpoint).toHaveBeenCalledWith(target)
  expect(f.chooseDirectory).not.toHaveBeenCalled()
  expect(f.sessionDirectory).not.toHaveBeenCalled()
})
