import assert from "node:assert/strict"
import fs from "node:fs"
import { mkdtemp, realpath, rename, rm, utimes, writeFile, type FileHandle } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { FILE_CHUNK_BYTES, FILE_MAX_OPEN_READS } from "./files-protocol.ts"
import { FilesService } from "./files-service.ts"

async function fixture(context: TestContext, bytes = Buffer.alloc(FILE_CHUNK_BYTES * 2 + 3, 42)) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-file-reads-")))
  const path = join(directory, "source.bin"), service = new FilesService()
  await writeFile(path, bytes)
  const file = (await service.call("stat", { path })).value
  const handles: FileHandle[] = [], originalOpen = fs.promises.open
  context.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args)
    if (String(args[0]) === path) handles.push(handle)
    return handle
  })
  syncBuiltinESMExports()
  context.after(async () => {
    context.mock.restoreAll(); syncBuiltinESMExports()
    await service.close(); await rm(directory, { recursive: true, force: true })
  })
  return { directory, path, service, file, bytes, handles }
}

test("a read session reuses one native handle across pipelined chunks and releases it explicitly", async context => {
  const { path, service, file, bytes, handles } = await fixture(context)
  const { readId } = (await service.call("openRead", { path, modifiedAt: file.modifiedAt })).value
  const chunks = await Promise.all(Array.from({ length: 3 }, (_, index) => service.call("read", {
    path, readId, offset: index * FILE_CHUNK_BYTES, length: Math.min(FILE_CHUNK_BYTES, file.size - index * FILE_CHUNK_BYTES), modifiedAt: file.modifiedAt,
  })))
  assert.deepEqual(Buffer.concat(chunks.map(chunk => chunk.data!)), bytes)
  assert.equal(handles.length, 1)
  assert.ok(handles[0]!.fd >= 0)
  await service.call("closeRead", { readId })
  assert.equal(handles[0]!.fd, -1)
  await service.call("closeRead", { readId })
  await assert.rejects(service.call("read", { path, readId, offset: 0, length: 1 }), { code: "not_found" })
})

test("source changes fail reads and final validation still closes the retained handle", async context => {
  const { path, service, file, handles } = await fixture(context)
  const { readId } = (await service.call("openRead", { path, modifiedAt: file.modifiedAt })).value
  await service.call("read", { path, readId, offset: 0, length: 1 })
  await writeFile(path, "truncated")
  await assert.rejects(service.call("read", { path, readId, offset: 1, length: 1 }), { code: "changed" })
  await assert.rejects(service.call("closeRead", { readId }), { code: "changed" })
  assert.equal(handles[0]!.fd, -1)
})

test("a replacement with the same size and timestamp cannot silently reuse the old source handle", async context => {
  const { path, service, bytes, handles } = await fixture(context)
  const timestamp = 1_700_000_000
  await utimes(path, timestamp, timestamp)
  const file = (await service.call("stat", { path })).value
  const { readId } = (await service.call("openRead", { path, modifiedAt: file.modifiedAt })).value
  await rename(path, `${path}.previous`)
  await writeFile(path, Buffer.alloc(bytes.length, 99))
  await utimes(path, timestamp, timestamp)
  const replacement = (await service.call("stat", { path })).value
  assert.equal(replacement.modifiedAt, file.modifiedAt)
  assert.equal(replacement.size, file.size)
  await assert.rejects(service.call("read", { path, readId, offset: 0, length: 1 }), { code: "changed" })
  await assert.rejects(service.call("closeRead", { readId }), { code: "changed" })
  assert.equal(handles[0]!.fd, -1)
})

test("read sessions are path-bound, bounded per peer, and all close with the endpoint", async context => {
  const { directory, path, service, handles } = await fixture(context)
  const opened = await Promise.all(Array.from({ length: FILE_MAX_OPEN_READS }, () => service.call("openRead", { path })))
  await assert.rejects(service.call("openRead", { path }), { code: "busy" })
  await assert.rejects(service.call("read", { path: join(directory, "other.bin"), readId: opened[0]!.value.readId, offset: 0, length: 1 }), { code: "invalid" })
  assert.equal(handles.length, FILE_MAX_OPEN_READS)
  await service.close()
  assert.ok(handles.every(handle => handle.fd === -1))
})
