import { afterEach, expect, test, vi } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  const confirmSession = vi.fn(async (_directory: string) => true)
  const confirmOverwrite = vi.fn(async (_path: string) => false)
  const sessionDirectory = vi.fn(async (_sessionId: string) => source)
  const remoteEndpoint = vi.fn(async () => new FilesService(async () => source))
  const create = () => {
    const controller = new WindowFiles({ chooseDirectory, confirmSession, confirmOverwrite, sessionDirectory, remoteEndpoint })
    controllers.push(controller)
    return controller
  }
  return { source, destination, chooseDirectory, confirmSession, confirmOverwrite, sessionDirectory, remoteEndpoint, create }
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

test("native directory selection supplies isolated grants for browsing and copying", async () => {
  const f = await fixture(), controller = f.create(), other = f.create()
  await expect(controller.list({ kind: "local" })).rejects.toThrow("Choose a local folder")
  await expect(controller.list({ kind: "local", grantId: "forged" }, f.source)).rejects.toThrow("Choose a local folder")
  const source = await selected(controller)
  expect((await controller.list(source)).entries.map(entry => entry.name)).toEqual(["hello.txt"])
  await expect(other.list(source)).rejects.toThrow("Choose a local folder")
  await expect(controller.enqueue({ source: { target: source, path: join(f.source, "hello.txt") }, destination: { target: source, path: f.destination } })).rejects.toThrow("outside")
  f.chooseDirectory.mockResolvedValueOnce(f.destination)
  const destination = await selected(controller)
  const id = await controller.enqueue({ source: { target: source, path: join(f.source, "hello.txt") }, destination: { target: destination, path: f.destination } })
  expect((await finished(controller, id)).state).toBe("completed")
  expect(await readFile(join(f.destination, "hello.txt"), "utf8")).toBe("selected content")
  expect(await other.transfers()).toEqual([])
  await expect(other.cancel(id)).rejects.toThrow("Unknown file transfer")
  await expect(other.retry(id)).rejects.toThrow("Unknown file transfer")
  await controller.close()
  await expect(controller.list(source)).rejects.toThrow("expired")
})

test("Session consent uses its trusted directory and issues only Session-bound read access", async () => {
  const f = await fixture(), controller = f.create()
  const target = await controller.authorizeLocalSession("session")
  expect(target).not.toBeNull()
  expect(f.confirmSession).toHaveBeenCalledWith(f.source)
  expect(f.sessionDirectory.mock.calls.every(([id]) => id === "session")).toBe(true)
  const request = { target: target!, sessionId: "session", uri: "hello.txt" }
  expect(new TextDecoder().decode((await controller.readResource(request)).data)).toBe("selected content")
  await expect(controller.readResource({ ...request, sessionId: "other" })).rejects.toThrow("Session preview")
  await writeFile(join(f.destination, "private.txt"), "private")
  await expect(controller.readResource({ ...request, uri: pathToFileURL(join(f.destination, "private.txt")).href })).rejects.toThrow("outside")
  await expect(controller.enqueue({ source: { target: target!, path: join(f.source, "hello.txt") }, destination: { target: target!, path: f.source } })).rejects.toThrow("write access")
})

test("cancelled or changed Session consent issues no usable grant", async () => {
  const f = await fixture(), controller = f.create()
  f.confirmSession.mockResolvedValueOnce(false)
  expect(await controller.authorizeLocalSession("session")).toBeNull()
  f.sessionDirectory.mockResolvedValueOnce(f.source).mockResolvedValueOnce(f.destination)
  await expect(controller.authorizeLocalSession("session")).rejects.toThrow("Session directory changed")
  await expect(controller.readResource({ target: { kind: "local" }, sessionId: "session", uri: "hello.txt" })).rejects.toThrow("Choose a local folder")
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

test("pending Session consent cannot resurrect a closed document", async () => {
  const f = await fixture(), controller = f.create(), decision = deferred<boolean>(), shown = deferred<void>()
  f.confirmSession.mockImplementationOnce(() => { shown.resolve(); return decision.promise })
  const pending = controller.authorizeLocalSession("session")
  const rejected = expect(pending).rejects.toThrow("expired")
  await shown.promise
  await controller.close()
  decision.resolve(true)
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
  expect(f.confirmSession).not.toHaveBeenCalled()
})
