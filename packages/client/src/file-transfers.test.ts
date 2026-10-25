import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { FilesService } from "../../../apps/daemon/src/files-service.ts"
import type { FileEndpoint } from "../../../apps/daemon/src/files-protocol.ts"
import type { FileTransfer } from "./files.ts"
import { FileTransferManager } from "./file-transfers.ts"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const remote = { kind: "machine", teamId: "1", machineId: "2" } as const
async function fixture(wrap?: (endpoint: FileEndpoint) => FileEndpoint) {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-copy-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, "source"), destination = join(directory, "destination")
  await mkdir(source); await mkdir(destination)
  const local = new FilesService(), receiver = new FilesService()
  const manager = new FileTransferManager({ endpoint: async target => target.kind === "local" ? local : wrap ? wrap(receiver) : receiver, chooseLocalDirectory: async () => null })
  cleanups.push(() => manager.close())
  return { source, destination, manager }
}
async function settled(manager: FileTransferManager, id: string, state: FileTransfer["state"]): Promise<FileTransfer> {
  let result: FileTransfer | undefined
  await vi.waitFor(async () => { result = (await manager.transfers()).find(job => job.id === id); expect(result?.state).toBe(state) })
  return result!
}

test("a folder is one queue item and copies chunked bytes, nested files, and empty directories", async () => {
  const { source, destination, manager } = await fixture()
  const folder = join(source, "assets")
  await mkdir(join(folder, "empty"), { recursive: true })
  await mkdir(join(folder, "nested"))
  const bytes = new Uint8Array(100_000).map((_, index) => index % 251)
  await writeFile(join(folder, "image.bin"), bytes)
  await writeFile(join(folder, "nested", "empty.txt"), "")
  const seen: FileTransfer[][] = []
  manager.onChanged(jobs => seen.push(jobs))
  const id = await manager.enqueue({ source: { target: { kind: "local" }, path: folder }, destination: { target: remote, path: destination } })
  const result = await settled(manager, id, "completed")
  expect(result.kind).toBe("directory")
  expect(result.totalBytes).toBe(bytes.length)
  expect(result.transferredBytes).toBe(bytes.length)
  expect(seen.every(jobs => jobs.length === 1)).toBe(true)
  expect(await readFile(join(destination, "assets", "image.bin"))).toEqual(Buffer.from(bytes))
  expect(await readdir(join(destination, "assets", "empty"))).toEqual([])
  expect(await readFile(join(destination, "assets", "nested", "empty.txt"), "utf8")).toBe("")
})

test("same-name conflicts leave the original intact and retry can keep both", async () => {
  const { source, destination, manager } = await fixture()
  await writeFile(join(source, "file.txt"), "new")
  await writeFile(join(destination, "file.txt"), "original")
  const id = await manager.enqueue({ source: { target: { kind: "local" }, path: join(source, "file.txt") }, destination: { target: remote, path: destination } })
  await settled(manager, id, "conflict")
  expect(await readFile(join(destination, "file.txt"), "utf8")).toBe("original")
  await manager.retry(id, "rename")
  await settled(manager, id, "completed")
  const copied = (await readdir(destination)).find(name => name !== "file.txt")!
  expect(await readFile(join(destination, copied), "utf8")).toBe("new")
})

test("cancellation waits for the current write and removes receiver staging", async () => {
  let wrote!: () => void, resume!: () => void
  const writing = new Promise<void>(resolve => { wrote = resolve })
  const release = new Promise<void>(resolve => { resume = resolve })
  const { source, destination, manager } = await fixture(endpoint => ({
    close: () => endpoint.close(),
    async call(method, params, data) {
      const result = await endpoint.call(method, params, data)
      if (method === "write") { wrote(); await release }
      return result
    },
  }))
  await writeFile(join(source, "large.bin"), new Uint8Array(80_000))
  const id = await manager.enqueue({ source: { target: { kind: "local" }, path: join(source, "large.bin") }, destination: { target: remote, path: destination } })
  await writing
  const cancellation = manager.cancel(id)
  resume(); await cancellation
  await settled(manager, id, "cancelled")
  expect(await readdir(destination)).toEqual([])
})

test("a rejected pipelined write drains outstanding chunks and removes staging without committing", async () => {
  let writes = 0, commits = 0
  let abortStarted!: () => void, resumeCleanup!: () => void
  const aborting = new Promise<void>(resolve => { abortStarted = resolve })
  const release = new Promise<void>(resolve => { resumeCleanup = resolve })
  const { source, destination, manager } = await fixture(endpoint => ({
    close: () => endpoint.close(),
    async call(method, params, data) {
      if (method === "commit") ++commits
      if (method === "abort") { abortStarted(); await release }
      const result = await endpoint.call(method, params, data)
      if (method === "write" && ++writes === 2) throw new Error("Destination write failed")
      return result
    },
  }))
  await writeFile(join(source, "payload.bin"), new Uint8Array(2 * 1024 * 1024))
  const id = await manager.enqueue({ source: { target: { kind: "local" }, path: join(source, "payload.bin") }, destination: { target: remote, path: destination } })
  try {
    await aborting
    expect((await manager.transfers()).find(job => job.id === id)?.state).toBe("transferring")
    expect((await readdir(destination)).some(name => name.startsWith(".deskfleet-transfer-"))).toBe(true)
  } finally { resumeCleanup() }
  const result = await settled(manager, id, "failed")
  expect(result.error).toBe("Destination write failed")
  expect(commits).toBe(0)
  expect(await readdir(destination)).toEqual([])
})

test("directory symlinks fail a folder task instead of silently omitting children", async () => {
  const { symlink } = await import("node:fs/promises")
  const { source, destination, manager } = await fixture()
  await mkdir(join(source, "bundle"))
  await mkdir(join(source, "original"))
  await symlink(join(source, "original"), join(source, "bundle", "link"), process.platform === "win32" ? "junction" : "dir")
  const id = await manager.enqueue({ source: { target: { kind: "local" }, path: join(source, "bundle") }, destination: { target: remote, path: destination } })
  await settled(manager, id, "failed")
  expect(await readdir(destination)).toEqual([])
})

test("the same endpoint cannot copy a directory into its own descendant", async () => {
  const { source, manager } = await fixture()
  await mkdir(join(source, "child"))
  const id = await manager.enqueue({ source: { target: { kind: "local" }, path: source }, destination: { target: { kind: "local" }, path: join(source, "child") }, kind: "directory" })
  const result = await settled(manager, id, "failed")
  expect(result.error).toContain("itself")
  expect(await readdir(join(source, "child"))).toEqual([])
})

test.each([
  ["preview.BMP", "image/bmp", [0x42, 0x4d]],
  ["preview.ico", "image/vnd.microsoft.icon", [0, 0, 1, 0]],
])("reads %s resources with their image MIME type", async (name, mimeType, bytes) => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-resource-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const endpoint = new FilesService(async () => directory)
  const manager = new FileTransferManager({ endpoint: async () => endpoint, chooseLocalDirectory: async () => null })
  cleanups.push(() => manager.close())
  await writeFile(join(directory, name), new Uint8Array(bytes))
  const result = await manager.readResource({ target: remote, sessionId: "12", uri: name })
  expect(result).toEqual({ name, mimeType, data: new Uint8Array(bytes) })
})

test("closing the account interrupts pending file calls before waiting for the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-close-copy-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const source = join(directory, "input.bin"), destination = join(directory, "output")
  await writeFile(source, new Uint8Array(100)); await mkdir(destination)
  const local = new FilesService(), receiver = new FilesService()
  let started!: () => void, reject!: (error: Error) => void
  const reading = new Promise<void>(resolve => { started = resolve })
  const manager = new FileTransferManager({
    chooseLocalDirectory: async () => null,
    endpoint: async target => target.kind === "machine" ? receiver : {
      async call(method, params, data) {
        if (method === "read") { started(); return await new Promise((_resolve, fail) => { reject = fail }) }
        return local.call(method, params, data)
      },
      async close() { reject(new Error("Connection closed")); await local.close() },
    },
  })
  cleanups.push(() => manager.close())
  const id = await manager.enqueue({ source: { target: { kind: "local" }, path: source }, destination: { target: remote, path: destination } })
  await reading
  await manager.close()
  expect((await manager.transfers()).find(job => job.id === id)?.state).toBe("cancelled")
  expect(await readdir(destination)).toEqual([])
})
