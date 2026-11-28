import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { FILE_PREVIEW_BYTES } from "@deskfleet/protocol/files"
import { FilesService } from "../files/service.ts"
import { SessionAttachments } from "../agent/attachments.ts"
import { SuperAttachmentStore, attachmentInfo, previewSuperAttachments, superAttachments } from "./attachments.ts"

test("workspace attachments honor project roots and authenticated file selection, retaining bytes across retries and workers", async t => {
  const dir = await mkdtemp(join(tmpdir(), "workspace-attachments-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = join(dir, "A"), elsewhere = join(dir, "private")
  await Promise.all([mkdir(project), mkdir(elsewhere)])
  const source = join(elsewhere, "notes.txt")
  await writeFile(source, "explicit selection")
  const catalog = new SessionAttachments(dir)
  const grants = (uid: string, path: string) => catalog.fileGrant(uid, path)
  const store = new SuperAttachmentStore(dir, grants)
  const picker = new FilesService(undefined, undefined, undefined, path => grants("alice", path))
  t.after(() => picker.close())
  const file = (await picker.call("list", { path: elsewhere })).value.entries[0]!
  const link = {type: "resource_link", name: file.name, uri: pathToFileURL(file.path).href, size: file.size}
  const blocks = superAttachments([{ ...link, _meta: { "deskfleet/attachmentGrant": file.attachmentGrant } }])
  const key = store.key("one", blocks)
  assert.ok(file.attachmentGrant)
  await assert.rejects(store.save("bob", key, blocks, [project]), /authorize/)
  await assert.rejects(store.save("alice", key, superAttachments([link]), [project]), /authorize/)
  await symlink(source, join(project, "escape"))
  await assert.rejects(store.save("alice", key, superAttachments([{ ...link, uri: pathToFileURL(join(project,"escape")).href }]), [project]), /authorize/)
  await Promise.all([store.save("alice", key, blocks, [project]), store.save("alice", key, blocks, [project])])
  await rm(source)
  await store.save("alice", key, blocks, [project])
  const restored = await store.load("alice", [key, key])
  assert.equal(restored.length, 1)
  assert.equal(restored[0]!.type, "resource_link")
  assert.equal(restored[0]!._meta, undefined)
  assert.equal(await readFile(fileURLToPath(restored[0]!.uri), "utf8"), "explicit selection")
  assert.equal((await previewSuperAttachments(restored)).previews[0]?.excerpt, "explicit selection")
  assert.deepEqual(await store.preview("alice", [key], 0), { type: "resource_link", data: Buffer.from("explicit selection").toString("base64"), mimeType: "application/octet-stream" })
  assert.deepEqual(await store.preview("bob", [key], 0), { type: "unavailable" })
  await truncate(fileURLToPath(restored[0]!.uri), FILE_PREVIEW_BYTES + 1)
  assert.deepEqual(await store.preview("alice", [key], 0), { type: "tooLarge" })
  const savedPath = fileURLToPath(restored[0]!.uri)
  await rm(savedPath)
  await writeFile(source, "replacement outside private attachment storage")
  await symlink(source, savedPath)
  assert.deepEqual(await store.preview("alice", [key], 0), { type: "unavailable" })
  await assert.rejects(store.load("bob", [key]))
  const rootFile = join(project,"inside.txt")
  await writeFile(rootFile, "inside the project")
  const inProject = superAttachments([{...link, uri:pathToFileURL(rootFile).href}])
  const localKey = store.key("two", inProject)
  await store.save("alice", localKey, inProject, [await realpath(project)])
  assert.equal((await previewSuperAttachments(await store.load("alice", [localKey]))).previews[0]?.excerpt, "inside the project")
})

test("project history restores only canonical GitHub issue and PR links with their snapshot titles and MIME types", async t => {
  const root = await mkdtemp(join(tmpdir(), "workspace-github-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SuperAttachmentStore(root, () => { throw new Error("Embedded resources do not need a grant") })
  for (const [index, uri] of ["https://github.com/org/project/issues/1", "https://github.com/org/project/pull/2",
    "https://github.com/../org/pull/2", "file:///secret", "https://github.com.example/org/project/pull/2"].entries()) {
    const title = "GitHub Issue org/project#1 · Example"
    const text = `${title}\n${uri}\n\nBody`
    const resource = { uri, mimeType: "text/markdown", text }
    const blocks = superAttachments([{ type: "resource", resource }])
    const key = store.key("msg", blocks)
    await store.save("alice", key, blocks, [])
    assert.deepEqual(await store.load("alice", [key]), blocks)
    if (index < 2) assert.equal(attachmentInfo(blocks[0]!).name, title)
    assert.deepEqual(await store.preview("alice", [key], 0), { type: "resource", text, ...(index < 2 && { uri, mimeType: "text/markdown" }) })
  }
})
