import { afterEach, expect, test, vi } from "vitest"
import { BrowserFilesEndpoint } from "./browser-files.ts"
import { FileTransferManager } from "./file-transfers.ts"

type WriteHook = (name: string) => Promise<void>
class MemoryFile {
  readonly kind = "file"
  readonly name: string
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array()
  hook?: WriteHook
  constructor(name: string, hook?: WriteHook) { this.name = name; this.hook = hook }
  async getFile() { return new File([this.bytes], this.name, { lastModified: 1 }) }
  async createWritable() {
    const chunks: Uint8Array[] = []
    const stream = new WritableStream<Uint8Array | ArrayBuffer>({
      write: async value => { await this.hook?.(this.name); chunks.push(new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value))) },
      close: () => {
        this.bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
        let offset = 0
        for (const chunk of chunks) { this.bytes.set(chunk, offset); offset += chunk.length }
      },
    })
    return Object.assign(stream, {
      async write(value: Uint8Array | ArrayBuffer) { const writer = stream.getWriter(); try { await writer.write(value) } finally { writer.releaseLock() } },
      async close() { const writer = stream.getWriter(); try { await writer.close() } finally { writer.releaseLock() } },
    })
  }
}
class MemoryDirectory {
  readonly kind = "directory"
  readonly name: string
  readonly children = new Map<string, MemoryDirectory | MemoryFile>()
  hook?: WriteHook
  constructor(name: string, hook?: WriteHook) { this.name = name; this.hook = hook }
  async isSameEntry(other: MemoryDirectory) { return this === other }
  async *entries() { yield* this.children.entries() }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectory> {
    let child = this.children.get(name)
    if (!child && options?.create) { child = new MemoryDirectory(name, this.hook); this.children.set(name, child) }
    if (!child) throw new DOMException("Missing", "NotFoundError")
    if (child.kind !== "directory") throw new DOMException("File", "TypeMismatchError")
    return child
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    let child = this.children.get(name)
    if (!child && options?.create) { child = new MemoryFile(name, this.hook); this.children.set(name, child) }
    if (!child) throw new DOMException("Missing", "NotFoundError")
    if (child.kind !== "file") throw new DOMException("Directory", "TypeMismatchError")
    return child
  }
  async removeEntry(name: string) { if (!this.children.delete(name)) throw new DOMException("Missing", "NotFoundError") }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals() })
async function fixture(hook?: WriteHook) {
  const chosen = new MemoryDirectory("chosen"), storage = new MemoryDirectory("OPFS")
  const source = await chosen.getDirectoryHandle("bundle", { create: true })
  await source.getDirectoryHandle("empty", { create: true })
  const file = await source.getFileHandle("first.txt", { create: true })
  file.bytes = new TextEncoder().encode("first")
  const large = await source.getFileHandle("second.bin", { create: true })
  large.bytes = new Uint8Array(80_000).map((_, index) => index % 251)
  const destination = await chosen.getDirectoryHandle("destination", { create: true })
  destination.hook = hook
  vi.stubGlobal("window", { showDirectoryPicker: async () => chosen })
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } })
  const endpoint = new BrowserFilesEndpoint()
  await endpoint.choose()
  const manager = new FileTransferManager({ endpoint: async () => endpoint, chooseLocalDirectory: () => endpoint.choose() })
  cleanup.push(() => manager.close())
  const id = await manager.enqueue({ source: { target: { kind: "local" }, path: "/chosen/bundle" }, destination: { target: { kind: "local" }, path: "/chosen/destination" }, kind: "directory" })
  return { storage, destination, manager, id, endpoint }
}

test("browser receiver preserves empty directories and chunked file contents, then keeps both on retry", async () => {
  const { storage, destination, manager, id } = await fixture()
  await vi.waitFor(async () => { expect((await manager.transfers())[0]?.state).toBe("completed") })
  const bundle = await destination.getDirectoryHandle("bundle")
  expect((await bundle.getDirectoryHandle("empty")).children.size).toBe(0)
  expect((await bundle.getFileHandle("second.bin")).bytes).toEqual(new Uint8Array(80_000).map((_, index) => index % 251))
  expect(storage.children.size).toBe(0)
  const next = await manager.enqueue({ source: { target: { kind: "local" }, path: "/chosen/bundle" }, destination: { target: { kind: "local" }, path: "/chosen/destination" }, conflict: "replace" })
  await vi.waitFor(async () => { expect((await manager.transfers()).find(job => job.id === next)?.state).toBe("conflict") })
  await manager.retry(next, "rename")
  await vi.waitFor(async () => { expect((await manager.transfers()).find(job => job.id === next)?.state).toBe("completed") })
  expect((await destination.getDirectoryHandle("bundle (1)")).children.size).toBe(3)
  expect((await manager.transfers()).find(job => job.id === id)?.transferredBytes).toBe(80_005)
})

test.each(["cancel", "close"] as const)("browser %s interrupts final publication and preserves unrelated destination files", async action => {
  let started!: () => void, resume!: () => void
  const writing = new Promise<void>(resolve => { started = resolve })
  const release = new Promise<void>(resolve => { resume = resolve })
  const { storage, destination, manager, id } = await fixture(async name => { if (name === "second.bin") { started(); await release } })
  await writing
  const bundle = await destination.getDirectoryHandle("bundle")
  const unrelated = await bundle.getFileHandle("unrelated.txt", { create: true })
  unrelated.bytes = new TextEncoder().encode("other app")
  const stopped = action === "cancel" ? manager.cancel(id) : manager.close()
  resume(); await stopped
  const transfer = (await manager.transfers())[0]!
  expect(transfer.state).toBe("cancelled")
  expect(transfer.error).toContain("already saved")
  expect(new TextDecoder().decode((await bundle.getFileHandle("first.txt")).bytes)).toBe("first")
  expect(new TextDecoder().decode((await bundle.getFileHandle("unrelated.txt")).bytes)).toBe("other app")
  expect(storage.children.size).toBe(0)
})

async function receiverFixture(stageWrite?: WriteHook) {
  const chosen = new MemoryDirectory("chosen"), storage = new MemoryDirectory("OPFS", stageWrite)
  vi.stubGlobal("window", { showDirectoryPicker: async () => chosen })
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => storage } })
  const endpoint = new BrowserFilesEndpoint()
  cleanup.push(() => endpoint.close())
  await endpoint.choose()
  return { endpoint, chosen, storage }
}

test("browser keep-both starts at (1) and commit still skips or renames a name that appears later", async () => {
  const { endpoint, chosen } = await receiverFixture()
  await chosen.getFileHandle("notes.txt", { create: true })
  const renamed = (await endpoint.call("begin", { directory: "/chosen", name: "notes.txt", kind: "file", conflict: "rename" })).value
  expect(renamed.skipped).toBe(false)
  await endpoint.call("write", { transferId: renamed.transferId, path: "", offset: 0 }, new TextEncoder().encode("kept"))
  await endpoint.call("finish", { transferId: renamed.transferId, path: "", size: 4 })
  expect((await endpoint.call("commit", { transferId: renamed.transferId })).value.path).toBe("/chosen/notes (1).txt")

  const late = (await endpoint.call("begin", { directory: "/chosen", name: "later.txt", kind: "file", conflict: "rename" })).value
  await endpoint.call("write", { transferId: late.transferId, path: "", offset: 0 }, new TextEncoder().encode("new"))
  await endpoint.call("finish", { transferId: late.transferId, path: "", size: 3 })
  await chosen.getFileHandle("later.txt", { create: true })
  expect((await endpoint.call("commit", { transferId: late.transferId })).value.path).toBe("/chosen/later (1).txt")

  const skipped = (await endpoint.call("begin", { directory: "/chosen", name: "existing.txt", kind: "file", conflict: "skip" })).value
  await endpoint.call("write", { transferId: skipped.transferId, path: "", offset: 0 }, new TextEncoder().encode("x"))
  await endpoint.call("finish", { transferId: skipped.transferId, path: "", size: 1 })
  const occupied = await chosen.getFileHandle("existing.txt", { create: true })
  occupied.bytes = new TextEncoder().encode("stay")
  const result = await endpoint.call("commit", { transferId: skipped.transferId })
  expect(result.value).toEqual({ path: "/chosen/existing.txt", skipped: true })
  expect(new TextDecoder().decode((await chosen.getFileHandle("existing.txt")).bytes)).toBe("stay")
})

test("browser receiver serializes pipelined mkdir, writes, finish, and commit for one upload", async () => {
  const { endpoint, chosen, storage } = await receiverFixture()
  const { transferId } = (await endpoint.call("begin", { directory: "/chosen", name: "bundle", kind: "directory", conflict: "ask" })).value
  const chunks = Array.from({ length: 32 }, (_, index) => new Uint8Array(32768).fill(index))
  const mkdir = [endpoint.call("mkdir", { transferId, path: "empty" }), endpoint.call("mkdir", { transferId, path: "nested" })]
  const writes = chunks.map((data, index) => endpoint.call("write", { transferId, path: "nested/result.bin", offset: index * 32768 }, data))
  const finish = endpoint.call("finish", { transferId, path: "nested/result.bin", size: 32 * 32768 })
  const commit = endpoint.call("commit", { transferId })
  await Promise.all([...mkdir, ...writes, finish])
  expect((await commit).value.path).toBe("/chosen/bundle")
  const bundle = await chosen.getDirectoryHandle("bundle")
  expect((await bundle.getDirectoryHandle("empty")).children.size).toBe(0)
  const bytes = (await (await bundle.getDirectoryHandle("nested")).getFileHandle("result.bin")).bytes
  expect(bytes.length).toBe(32 * 32768)
  expect(Buffer.from(bytes).equals(Buffer.concat(chunks))).toBe(true)
  expect(storage.children.size).toBe(0)
})

test.each(["abort", "close"] as const)("browser %s rejects queued upload mutations before they touch the filesystem", async action => {
  let started!: () => void, resume!: () => void
  const writing = new Promise<void>(resolve => { started = resolve })
  const release = new Promise<void>(resolve => { resume = resolve })
  let writeCount = 0
  const { endpoint, chosen, storage } = await receiverFixture(async () => { writeCount++; started(); await release })
  const { transferId } = (await endpoint.call("begin", { directory: "/chosen", name: "file.bin", kind: "file", conflict: "ask" })).value
  const results = Promise.allSettled([
    endpoint.call("write", { transferId, path: "", offset: 0 }, new Uint8Array(32768)),
    endpoint.call("write", { transferId, path: "", offset: 32768 }, new Uint8Array(32768)),
    endpoint.call("finish", { transferId, path: "", size: 65536 }),
    endpoint.call("commit", { transferId }),
  ])
  await writing
  const stopped = action === "abort" ? endpoint.call("abort", { transferId }) : endpoint.close()
  resume(); await stopped
  expect((await results).map(result => result.status)).toEqual(["fulfilled", "rejected", "rejected", "rejected"])
  expect(writeCount).toBe(1)
  expect(chosen.children.size).toBe(0)
  expect(storage.children.size).toBe(0)
})
