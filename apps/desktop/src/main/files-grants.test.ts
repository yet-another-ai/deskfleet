import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, expect, test, vi } from "vitest"
import type { FileListing } from "@deskfleet/client/files"
import { FilesService } from "../../../daemon/src/files-service.ts"
import { canonicalGrantedPath, FileGrants, grantedPath } from "./files-grants.ts"

const fixtures: Array<{ path: string; grants: FileGrants[] }> = []
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "deskfleet-grants-"))
  const root = join(path, "selected"), outside = join(path, "outside")
  await Promise.all([mkdir(root), mkdir(outside)])
  await Promise.all([writeFile(join(root, "inside.txt"), "selected"), writeFile(join(outside, "secret.txt"), "secret")])
  const record = { path, grants: [] as FileGrants[] }
  fixtures.push(record)
  const authority = (options?: ConstructorParameters<typeof FileGrants>[0]) => {
    const grants = new FileGrants(options)
    record.grants.push(grants)
    return grants
  }
  return { root: await realpath(root), outside: await realpath(outside), authority }
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await Promise.all(fixture.grants.map(grants => grants.close()))
    // Each root is the absolute directory returned by mkdtemp under the OS temp directory.
    await rm(fixture.path, { recursive: true, force: true })
  }
})

test("missing, forged and another window's grants are rejected before file access", async () => {
  const { root, authority } = await fixture()
  const first = authority(), second = authority()
  const target = await first.issue(root, { read: true, write: true })
  expect(target.grantId).toMatch(/^[0-9a-f-]{36}$/u)
  await expect(first.assert({ kind: "local" }, "read", root)).rejects.toThrow("Local file access has expired")
  await expect(first.assert({ kind: "local", grantId: "forged" }, "read", root)).rejects.toThrow("Local file access has expired")
  await expect(second.assert(target, "read", root)).rejects.toThrow("Local file access has expired")
  expect(() => first.endpoint({ kind: "local", grantId: "forged" })).toThrow("Local file access has expired")
  expect(await first.assert(target, "read", join(root, "inside.txt"))).toBe(join(root, "inside.txt"))
})

test("local browsing is confined to the selected folder with an opaque grant", async () => {
  const { root, outside, authority } = await fixture()
  const grants = authority(), target = await grants.issue(root, { read: true, write: true })
  const endpoint = grants.endpoint(target)
  const listing = (await endpoint.call("list", {})).value as FileListing
  expect(listing).toMatchObject({ path: root, homePath: root, parentPath: null, roots: [{ path: root }], grantId: target.grantId })
  expect(listing.entries.map(entry => entry.name)).toEqual(["inside.txt"])
  await expect(endpoint.call("list", { path: outside })).rejects.toThrow("outside")
  await expect(endpoint.call("stat", { path: join(root, "..", "outside", "secret.txt") })).rejects.toThrow("outside")
  await expect(endpoint.call("read", { path: join(outside, "secret.txt"), offset: 0, length: 6 })).rejects.toThrow("outside")
  const reply = await endpoint.call("read", { path: join(root, "inside.txt"), offset: 0, length: 8 })
  expect(Buffer.from(reply.data!).toString()).toBe("selected")
})

test("preview grants bind a trusted Session root, reject absolute/file-URL escapes and cannot write", async () => {
  const { root, outside, authority } = await fixture()
  const grants = authority(), target = await grants.issue(root, { read: true, write: false, sessionId: "session" })
  const endpoint = grants.endpoint(target)
  expect((await endpoint.call("resolve", { sessionId: "session", uri: "inside.txt:2:1" })).value.path).toBe(join(root, "inside.txt"))
  expect((await endpoint.call("resolve", { sessionId: "session", uri: pathToFileURL(join(root, "inside.txt")).href })).value.path).toBe(join(root, "inside.txt"))
  for (const uri of ["../outside/secret.txt", "%2e%2e/outside/secret.txt", join(outside, "secret.txt"), pathToFileURL(join(outside, "secret.txt")).href]) {
    await expect(endpoint.call("resolve", { sessionId: "session", uri })).rejects.toThrow("outside")
  }
  await expect(endpoint.call("resolve", { sessionId: "other-session", uri: "inside.txt" })).rejects.toThrow("Session")
  await expect(endpoint.call("begin", { directory: root, name: "new.txt", kind: "file", conflict: "ask" })).rejects.toThrow("write access")
  const browse = grants.endpoint(await grants.issue(root, { read: true, write: true }))
  await expect(browse.call("resolve", { sessionId: "session", uri: "inside.txt" })).rejects.toThrow("Session")
})

test("existing junctions or directory symlinks cannot escape reads, previews or destinations", async () => {
  const { root, outside, authority } = await fixture()
  await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir")
  const grants = authority(), target = await grants.issue(root, { read: true, write: true, sessionId: "session" })
  const endpoint = grants.endpoint(target)
  await expect(endpoint.call("read", { path: join(root, "escape", "secret.txt"), offset: 0, length: 6 })).rejects.toThrow("outside")
  await expect(endpoint.call("resolve", { sessionId: "session", uri: "escape/secret.txt" })).rejects.toThrow("outside")
  await expect(endpoint.call("begin", { directory: join(root, "escape"), name: "new.txt", kind: "file", conflict: "ask" })).rejects.toThrow("outside")
  const listing = (await endpoint.call("list", {})).value
  expect(listing.entries.map(entry => entry.name)).toEqual(["inside.txt"])
})

test("selected-root aliases resolve before authorization while outside aliases remain denied", async () => {
  const { root, outside, authority } = await fixture()
  const alias = `${root}-alias`, outsideAlias = `${outside}-alias`
  const type = process.platform === "win32" ? "junction" : "dir"
  await Promise.all([symlink(root, alias, type), symlink(outside, outsideAlias, type)])
  const grants = authority(), target = await grants.issue(alias, { read: true, write: true, sessionId: "session" })
  const endpoint = grants.endpoint(target)
  expect((await endpoint.call("list", { path: alias })).value.path).toBe(root)
  for (const uri of [join(alias, "inside.txt"), pathToFileURL(join(alias, "inside.txt")).href]) {
    expect((await endpoint.call("resolve", { sessionId: "session", uri })).value.path).toBe(join(root, "inside.txt"))
  }
  const read = await endpoint.call("read", { path: join(alias, "inside.txt"), offset: 0, length: 8 })
  expect(Buffer.from(read.data!).toString()).toBe("selected")
  expect(await grants.destination(target, alias, "new.txt")).toBe(join(root, "new.txt"))
  for (const uri of [join(outsideAlias, "secret.txt"), pathToFileURL(join(outsideAlias, "secret.txt")).href]) {
    await expect(endpoint.call("resolve", { sessionId: "session", uri })).rejects.toThrow("outside")
  }
  await expect(grants.destination(target, outsideAlias, "new.txt")).rejects.toThrow("outside")
})

test("write grants allow selected destinations and deny destinations or transfer IDs from elsewhere", async () => {
  const { root, outside, authority } = await fixture()
  const grants = authority(), target = await grants.issue(root, { read: true, write: true })
  const endpoint = grants.endpoint(target)
  await expect(endpoint.call("begin", { directory: outside, name: "new.txt", kind: "file", conflict: "ask" })).rejects.toThrow("outside")
  const { transferId } = (await endpoint.call("begin", { directory: root, name: "new.txt", kind: "file", conflict: "ask" })).value
  const other = grants.endpoint(await grants.issue(root, { read: true, write: true }))
  await expect(other.call("commit", { transferId })).rejects.toThrow("not authorized")
  await endpoint.call("write", { transferId, path: "", offset: 0 }, Buffer.from("new"))
  await endpoint.call("finish", { transferId, path: "", size: 3 })
  await endpoint.call("commit", { transferId })
  expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new")
})

test("replacement requires native confirmation for each transfer and defaults to denied", async () => {
  const { root, authority } = await fixture()
  const denied = authority(), deniedTarget = await denied.issue(root, { read: true, write: true })
  const request = { directory: root, name: "inside.txt", kind: "file", conflict: "replace" } as const
  await expect(denied.endpoint(deniedTarget).call("begin", request)).rejects.toThrow("not authorized")
  const confirmOverwrite = vi.fn(async () => true)
  const grants = authority({ confirmOverwrite }), target = await grants.issue(root, { read: true, write: true })
  const endpoint = grants.endpoint(target)
  for (const content of ["replacement", "another"]) {
    const { transferId } = (await endpoint.call("begin", request)).value
    await endpoint.call("write", { transferId, path: "", offset: 0 }, Buffer.from(content))
    await endpoint.call("finish", { transferId, path: "", size: content.length })
    await endpoint.call("commit", { transferId })
    expect(await readFile(join(root, "inside.txt"), "utf8")).toBe(content)
  }
  expect(confirmOverwrite).toHaveBeenCalledTimes(2)
  expect(confirmOverwrite).toHaveBeenCalledWith(join(root, "inside.txt"))
})

test("revocation invalidates tokens, pending issuance and an overwrite dialog before it can write", async () => {
  const { root, authority } = await fixture()
  let approve!: (value: boolean) => void, opened!: () => void
  const showing = new Promise<void>(resolve => { opened = resolve })
  const grants = authority({ confirmOverwrite: () => { opened(); return new Promise(resolve => { approve = resolve }) } })
  const target = await grants.issue(root, { read: true, write: true }), endpoint = grants.endpoint(target)
  const pending = endpoint.call("begin", { directory: root, name: "inside.txt", kind: "file", conflict: "replace" })
  await showing
  grants.revoke()
  approve(true)
  await expect(pending).rejects.toThrow("Local file access has expired")
  await expect(endpoint.call("read", { path: join(root, "inside.txt"), offset: 0, length: 8 })).rejects.toThrow("Local file access has expired")
  expect(await readFile(join(root, "inside.txt"), "utf8")).toBe("selected")
  const issuing = authority()
  const issue = issuing.issue(root, { read: true, write: true })
  issuing.revoke()
  await expect(issue).rejects.toThrow("Local file access has expired")
})

test("revocation stops subsequent upload chunks and close cleans its unfinished staging", async () => {
  const { root, authority } = await fixture()
  const grants = authority(), endpoint = grants.endpoint(await grants.issue(root, { read: true, write: true }))
  const { transferId } = (await endpoint.call("begin", { directory: root, name: "new.txt", kind: "file", conflict: "ask" })).value
  grants.revoke()
  await expect(endpoint.call("write", { transferId, path: "", offset: 0 }, Buffer.from("no"))).rejects.toThrow("Local file access has expired")
  await grants.close()
  await expect(readFile(join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" })
})

test("bytes already read are withheld when the window or account is revoked before delivery", async () => {
  const { root, authority } = await fixture()
  let release!: () => void, started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const original = FilesService.prototype.call
  const call = vi.spyOn(FilesService.prototype, "call").mockImplementation(async function (this: FilesService, method, params, data) {
    const reply = await original.call(this, method, params, data)
    if (method === "read") { started(); await barrier }
    return reply as never
  })
  try {
    const grants = authority(), endpoint = grants.endpoint(await grants.issue(root, { read: true, write: true }))
    const read = endpoint.call("read", { path: join(root, "inside.txt"), offset: 0, length: 8 })
    await waiting
    grants.revoke()
    release()
    await expect(read).rejects.toThrow("Local file access has expired")
  } finally { release(); call.mockRestore() }
})

test("a selected root replaced by a junction loses access instead of following its new target", async () => {
  const { root, outside, authority } = await fixture()
  const grants = authority(), target = await grants.issue(root, { read: true, write: true })
  await rename(root, `${root}-previous`)
  await symlink(outside, root, process.platform === "win32" ? "junction" : "dir")
  await expect(grants.assert(target, "read", join(root, "secret.txt"))).rejects.toThrow("outside")
})

test("Windows drive and UNC containment rejects traversal, sibling prefixes, streams and device names", () => {
  expect(grantedPath("C:\\selected", "c:\\selected\\child.txt", "win32")).toBe("c:\\selected\\child.txt")
  expect(grantedPath("\\\\server\\share\\selected", "\\\\server\\share\\selected\\child.txt", "win32")).toBe("\\\\server\\share\\selected\\child.txt")
  for (const path of ["C:\\selected-other\\secret", "C:\\selected\\..\\secret", "D:\\selected\\secret", "C:inside.txt", "\\selected\\inside.txt", "C:\\selected\\inside.txt:stream", "\\\\?\\C:\\selected\\inside.txt", "\\\\.\\C:\\selected\\inside.txt", "C:\\selected\\NUL", "C:\\selected\\child. "]) {
    expect(() => grantedPath("C:\\selected", path, "win32")).toThrow("outside")
  }
  expect(() => grantedPath("\\\\server\\share\\selected", "\\\\server\\other\\selected\\secret", "win32")).toThrow("outside")
})

test("canonical Windows containment distinguishes case-sensitive directory roots and siblings", () => {
  const root = "C:\\base\\Project"
  expect(canonicalGrantedPath(root, "c:\\base\\Project\\child.txt", "win32")).toBe("c:\\base\\Project\\child.txt")
  expect(canonicalGrantedPath(root, root, "win32")).toBe(root)
  expect(canonicalGrantedPath("C:\\", root, "win32")).toBe(root)
  for (const path of ["C:\\base\\project", "C:\\base\\project\\secret.txt", "C:\\Base\\Project\\secret.txt", "C:\\base\\Project-other\\secret.txt"]) {
    expect(() => canonicalGrantedPath(root, path, "win32")).toThrow("outside")
  }
  const unc = "\\\\server\\share\\Project"
  expect(canonicalGrantedPath(unc, `${unc}\\child.txt`, "win32")).toBe(`${unc}\\child.txt`)
  expect(() => canonicalGrantedPath(unc, "\\\\server\\share\\project\\secret.txt", "win32")).toThrow("outside")
})

test.runIf(process.platform === "win32")("Windows ordinary case variations resolve to the authorized filesystem spelling", async () => {
  const { root, authority } = await fixture()
  const grants = authority(), target = await grants.issue(root, { read: true, write: true })
  const path = join(root, "inside.txt")
  expect(await grants.assert(target, "read", path.toUpperCase())).toBe(path)
  const listing = await grants.endpoint(target).call("list", { path: root.toUpperCase() })
  expect(listing.value.path).toBe(root)
})
