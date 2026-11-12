import assert from "node:assert/strict"
import fs from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test, { type TestContext } from "node:test"
import { FILE_CHUNK_BYTES } from "./files-protocol.ts"
import { FilesService } from "./files-service.ts"
import { SessionAttachments } from "./session-attachments.ts"

test("scheme-less Windows drive pathnames convert through fileURLToPath", () => {
  // sessionResourcePath wraps matching pathnames as `file://${uri}` on win32; Node must keep the drive once.
  assert.equal(fileURLToPath("file:///E:/projects/a%20b.png", { windows: true }), String.raw`E:\projects\a b.png`)
  assert.equal(fileURLToPath("file:///E:/projects/image.png", { windows: true }), String.raw`E:\projects\image.png`)
  assert.match("/E:/projects/image.png", /^\/[a-z]:[\\/]/iu)
  assert.doesNotMatch("E:/projects/image.png", /^\/[a-z]:[\\/]/iu)
  assert.doesNotMatch("/projects/image.png", /^\/[a-z]:[\\/]/iu)
})

async function fixture(context: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-files-")))
  const attachments = join(directory, "session-attachments")
  const service = new FilesService(async id => {
    assert.equal(id, "12")
    return directory
  }, async id => {
    assert.equal(id, "12")
    return join(attachments, id)
  }, async draftId => {
    assert.equal(draftId, "550e8400-e29b-41d4-a716-446655440000")
    return join(attachments, ".drafts", draftId)
  })
  context.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, attachments, service }
}

test("Session resources use captured cwd and return bounded binary reads", async context => {
  const { directory, service } = await fixture(context)
  const path = join(directory, "a b.png")
  const bytes = Buffer.from([0, 255, 4, 8])
  await writeFile(path, bytes)
  for (const uri of ["a%20b.png", path.replace(" ", "%20"), pathToFileURL(path).href, "a%20b.png:12:3", `${path}#L12-L20`, "a%20b.png#preview", `${pathToFileURL(path).href}:12#L8`]) {
    const result = await service.call("resolve", { sessionId: "12", uri })
    assert.equal(result.value.path, path)
  }
  if (process.platform === "win32") {
    assert.equal((await service.call("resolve", { sessionId: "12", uri: `${pathToFileURL(path).pathname}#L12` })).value.path, path)
  }
  const info = (await service.call("stat", { path })).value
  const read = await service.call("read", { path, offset: 1, length: 2, modifiedAt: info.modifiedAt })
  assert.deepEqual(read.data, bytes.subarray(1, 3))
  await assert.rejects(service.call("read", { path, offset: -1, length: 2 }), /offset/)
  await assert.rejects(service.call("read", { path, offset: 0, length: FILE_CHUNK_BYTES + 1 }), /chunk/)
  await assert.rejects(service.call("read", { path, offset: 0, length: 2, modifiedAt: info.modifiedAt - 1 }), { code: "changed" })
  await assert.rejects(service.call("resolve", { sessionId: "12", uri: "http://localhost:3000/a.png" }), { code: "unsupported" })
  const literal = join(directory, "literal#L12")
  await writeFile(literal, "fragment is part of the name")
  assert.equal((await service.call("resolve", { sessionId: "12", uri: "literal%23L12" })).value.path, literal)
})

test("session attachment upload writes into the managed session-attachments directory", async context => {
  const { attachments, service } = await fixture(context)
  const { transferId } = (await service.call("begin", { sessionId: "12", name: "spec.txt", kind: "file", conflict: "rename" })).value
  const payload = Buffer.from("attachment content\n")
  await service.call("write", { transferId, path: "", offset: 0 }, payload)
  await service.call("finish", { transferId, path: "", size: payload.byteLength })
  const committed = (await service.call("commit", { transferId })).value
  assert.equal(committed.path, await realpath(join(attachments, "12", "spec.txt")))
  assert.deepEqual(await readFile(committed.path), payload)

  const draftId = "550e8400-e29b-41d4-a716-446655440000"
  await assert.rejects(service.call("begin", { sessionId: "12", draftId, name: "both.txt", kind: "file", conflict: "rename" }), { code: "invalid" })
  const draftTransfer = (await service.call("begin", { draftId, name: "draft.mp4", kind: "file", conflict: "rename" })).value
  const draftPayload = Buffer.from("staged video bytes")
  await service.call("write", { transferId: draftTransfer.transferId, path: "", offset: 0 }, draftPayload)
  await service.call("finish", { transferId: draftTransfer.transferId, path: "", size: draftPayload.byteLength })
  const draftCommitted = (await service.call("commit", { transferId: draftTransfer.transferId })).value
  assert.equal(draftCommitted.path, await realpath(join(attachments, ".drafts", draftId, "draft.mp4")))
  assert.deepEqual(await readFile(draftCommitted.path), draftPayload)
})

test("folder upload commits one complete root and preserves empty files and directories", async context => {
  const { directory, service } = await fixture(context)
  const { transferId } = (await service.call("begin", { directory, name: "folder", kind: "directory", conflict: "ask" })).value
  await service.call("mkdir", { transferId, path: "empty" })
  await service.call("mkdir", { transferId, path: "nested" })
  await service.call("write", { transferId, path: "nested/file.bin", offset: 0 }, Buffer.from([1, 255]))
  await assert.rejects(service.call("commit", { transferId }), /Finish/)
  await service.call("write", { transferId, path: "nested/file.bin", offset: 2 }, Buffer.from([3]))
  await assert.rejects(service.call("finish", { transferId, path: "nested/file.bin", size: 4 }), /size/)
  await service.call("finish", { transferId, path: "nested/file.bin", size: 3 })
  await service.call("finish", { transferId, path: "zero.txt", size: 0 })
  assert.equal((await service.call("list", { path: directory })).value.entries.some(entry => entry.name === "folder"), false)
  const result = await service.call("commit", { transferId })
  assert.equal(result.value.path, await realpath(join(directory, "folder")))
  assert.deepEqual(await readFile(join(directory, "folder/nested/file.bin")), Buffer.from([1, 255, 3]))
  assert.equal((await readFile(join(directory, "folder/zero.txt"))).length, 0)
  assert.deepEqual(await readdir(join(directory, "folder/empty")), [])
})

test("staging rejects traversal, out-of-order writes and cleans cancellation", async context => {
  const { directory, service } = await fixture(context)
  const { transferId } = (await service.call("begin", { directory, name: "folder", kind: "directory", conflict: "ask" })).value
  for (const path of ["../escape", "/escape", "nested/../../escape", "nested\\escape", "C:escape", "a//b"]) {
    await assert.rejects(service.call("mkdir", { transferId, path }), { code: "invalid" })
  }
  await service.call("write", { transferId, path: "test", offset: 0 }, Buffer.from("first"))
  await assert.rejects(service.call("write", { transferId, path: "test", offset: 0 }, Buffer.from("other")), /offset/)
  await service.call("abort", { transferId })
  assert.deepEqual(await readdir(directory), [])
  const next = (await service.call("begin", { directory, name: "second", kind: "file", conflict: "ask" })).value
  await service.call("write", { transferId: next.transferId, path: "", offset: 0 }, Buffer.from("partial"))
  await service.close()
  assert.deepEqual(await readdir(directory), [])
  await assert.rejects(service.call("list", { path: directory }), { code: "closed" })
})

test("conflicts ask by default, skip, rename or explicitly replace", async context => {
  const { directory, service } = await fixture(context)
  const path = join(directory, "result.txt")
  await writeFile(path, "old")
  await assert.rejects(service.call("begin", { directory, name: "result.txt", kind: "file", conflict: "ask" }), { code: "conflict" })
  assert.equal((await service.call("begin", { directory, name: "result.txt", kind: "file", conflict: "skip" })).value.skipped, true)
  for (const conflict of ["rename", "replace"] as const) {
    const { transferId } = (await service.call("begin", { directory, name: "result.txt", kind: "file", conflict })).value
    await service.call("write", { transferId, path: "", offset: 0 }, Buffer.from(conflict))
    await service.call("finish", { transferId, path: "", size: conflict.length })
    const result = await service.call("commit", { transferId })
    assert.equal(await readFile(result.value.path, "utf8"), conflict)
  }
  assert.deepEqual((await readdir(directory)).sort(), ["result (1).txt", "result.txt"])
})

test("recursive listings do not follow directory symlinks", { skip: process.platform === "win32" }, async context => {
  const { directory, service } = await fixture(context)
  await mkdir(join(directory, "child"))
  await writeFile(join(directory, "file"), "value")
  await symlink(directory, join(directory, "child/loop"))
  await symlink(join(directory, "file"), join(directory, "linked-file"))
  assert.deepEqual((await service.call("list", { path: join(directory, "child") })).value.entries, [])
  await assert.rejects(service.call("list", { path: join(directory, "child"), strict: true }), { code: "unsupported" })
  await assert.rejects(service.call("list", { path: join(directory, "child/loop") }), { code: "unsupported" })
  assert.equal((await service.call("stat", { path: join(directory, "linked-file") })).value.kind, "file")
})

test("concurrent endpoints never overwrite a destination under ask or rename", async context => {
  const { directory, service } = await fixture(context)
  const other = new FilesService()
  context.after(() => other.close())
  for (const kind of ["file", "directory"] as const) {
    for (const conflict of ["ask", "rename"] as const) {
      const name = `${kind}-${conflict}`
      const prepared = await Promise.all([service, other].map(async (endpoint, index) => {
        const { transferId } = (await endpoint.call("begin", { directory, name, kind, conflict })).value
        const path = kind === "file" ? "" : "child"
        await endpoint.call("write", { transferId, path, offset: 0 }, Buffer.from(String(index)))
        await endpoint.call("finish", { transferId, path, size: 1 })
        return { endpoint, transferId }
      }))
      const results = await Promise.allSettled(prepared.map(({ endpoint, transferId }) => endpoint.call("commit", { transferId })))
      const succeeded = results.filter(result => result.status === "fulfilled")
      assert.equal(succeeded.length, conflict === "ask" ? 1 : 2)
      if (conflict === "ask") {
        const failed = results.find(result => result.status === "rejected")!
        assert.equal((failed as PromiseRejectedResult).reason.code, "conflict")
      }
      const contents = await Promise.all(succeeded.map(result => readFile(kind === "file" ? result.value.value.path : join(result.value.value.path, "child"), "utf8")))
      assert.equal(new Set(contents).size, succeeded.length)
      for (const transfer of prepared) await transfer.endpoint.call("abort", { transferId: transfer.transferId })
    }
  }
})

test("late skip preserves a new destination and strict listings include similarly named user files", async context => {
  const { directory, service } = await fixture(context)
  const name = ".deskfleet-transfer-user-file"
  const { transferId } = (await service.call("begin", { directory, name, kind: "file", conflict: "skip" })).value
  await service.call("finish", { transferId, path: "", size: 0 })
  await writeFile(join(directory, name), "created meanwhile")
  assert.equal((await service.call("commit", { transferId })).value.skipped, true)
  assert.equal(await readFile(join(directory, name), "utf8"), "created meanwhile")
  assert.deepEqual((await service.call("list", { path: directory, strict: true })).value.entries.map(entry => entry.name), [name])
})

test("stat and list canonicalize ancestor aliases while preserving a file link's name", { skip: process.platform === "win32" }, async context => {
  const { directory, service } = await fixture(context)
  const original = join(directory, "original"), alias = join(directory, "alias")
  await mkdir(join(original, "nested"), { recursive: true })
  await writeFile(join(original, "actual.txt"), "contents")
  await symlink(original, alias)
  await symlink(join(original, "actual.txt"), join(directory, "named-link.txt"))
  assert.equal((await service.call("stat", { path: join(alias, "nested") })).value.path, join(original, "nested"))
  assert.equal((await service.call("list", { path: join(alias, "nested") })).value.path, join(original, "nested"))
  const link = (await service.call("stat", { path: join(directory, "named-link.txt") })).value
  assert.equal(link.name, "named-link.txt")
  assert.equal(link.path, join(original, "actual.txt"))
})

test("failed replacement rollback retains the original even after abort and peer closure", async context => {
  const { directory, service } = await fixture(context)
  const destination = join(directory, "folder")
  await mkdir(destination)
  await writeFile(join(destination, "original.txt"), "keep the original")
  const { transferId } = (await service.call("begin", { directory, name: "folder", kind: "directory", conflict: "replace" })).value
  await service.call("finish", { transferId, path: "replacement.txt", size: 0 })
  const move = fs.promises.rename
  let backup = ""
  context.mock.method(fs.promises, "rename", async (source: Parameters<typeof move>[0], target: Parameters<typeof move>[1]) => {
    if (String(target).endsWith("previous")) { backup = String(target); return move(source, target) }
    throw new Error("Filesystem refused publication and restoration")
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(service.call("commit", { transferId }), (error: Error & { code?: string }) => {
      assert.equal(error.code, "recovery_required")
      assert(error.message.includes(backup))
      return true
    })
  } finally { context.mock.restoreAll(); syncBuiltinESMExports() }
  await service.call("abort", { transferId })
  await service.close()
  assert.equal(await readFile(join(backup, "original.txt"), "utf8"), "keep the original")
})

test("SessionAttachments stages draft uploads, adopts them into the Session directory, and leaves non-draft links untouched", async context => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-session-attachments-")))
  context.after(async () => { await rm(root, { recursive: true, force: true }) })
  const attachments = new SessionAttachments(root)
  const draftId = "550e8400-e29b-41d4-a716-446655440000"
  const draftDir = await attachments.draftDirectory(draftId)
  const stagedPath = join(draftDir, "clip.mp4")
  const payload = Buffer.from("staged video")
  await writeFile(stagedPath, payload)
  const externalPath = join(root, "README.md")
  await writeFile(externalPath, "external")

  const adopted = await attachments.adoptDrafts("12", [
    { type: "resource_link", uri: pathToFileURL(stagedPath).href, name: "clip.mp4", mimeType: "video/mp4", size: payload.byteLength },
    { type: "resource_link", uri: pathToFileURL(externalPath).href, name: "README.md", size: 8 },
    { type: "text", text: "Trim this clip" },
  ])
  assert.equal(adopted.length, 3)
  const first = adopted[0] as { type: "resource_link"; uri: string; name: string; size?: number }
  const second = adopted[1] as { type: "resource_link"; uri: string }
  assert.equal(fileURLToPath(first.uri), join(await attachments.directory("12"), "clip.mp4"))
  assert.deepEqual(await readFile(fileURLToPath(first.uri)), payload)
  await assert.rejects(readdir(draftDir), { code: "ENOENT" })
  assert.equal(second.uri, pathToFileURL(externalPath).href)
})
