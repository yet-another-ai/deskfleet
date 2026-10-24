import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, parse, resolve } from "node:path"
import test from "node:test"
import { validateControlParams } from "./control-request.ts"
import { listDirectories } from "./filesystem.ts"

test("directory browsing returns ordered folders and navigable links on the owning machine", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-folders-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const target = join(directory, "target")
  await Promise.all([mkdir(target), mkdir(join(directory, "Alpha")), mkdir(join(directory, ".hidden")), writeFile(join(directory, "file.txt"), "file")])
  await symlink(target, join(directory, "linked"), "junction")
  await symlink(join(directory, "missing"), join(directory, "broken"), "junction")
  const listing = await listDirectories(directory)
  assert.equal(listing.path, resolve(directory))
  assert.equal(listing.parentPath, dirname(directory))
  assert.equal(listing.homePath, homedir())
  assert.deepEqual(listing.directories, [".hidden", "Alpha", "linked", "target"].map(name => ({
    name, path: join(directory, name), hidden: name.startsWith("."),
  })))
  assert.deepEqual((await listDirectories(join(directory, "linked"))).directories, [])
  assert.ok(listing.roots.some(root => root.path === parse(directory).root))
})

test("directory browsing starts at home and stops parent navigation at the filesystem root", async () => {
  assert.equal((await listDirectories()).path, resolve(homedir()))
  const root = parse(homedir()).root
  assert.equal((await listDirectories(root)).parentPath, null)
})

test("directory browsing rejects missing directories, files, and relative paths", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-folders-invalid-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "file.txt")
  await writeFile(file, "file")
  await assert.rejects(listDirectories(join(directory, "missing")), { code: "ENOENT" })
  await assert.rejects(listDirectories(file), { code: "ENOTDIR" })
  await assert.rejects(listDirectories("relative/path"), /absolute path/u)
  for (const path of [null, 123, "", "bad\0path", "x".repeat(4097)]) {
    assert.throws(() => validateControlParams("directoryList", { path }), /Invalid directory path/u)
  }
  assert.deepEqual(validateControlParams("directoryList", {}), {})
  // Paths are interpreted by the target daemon, not by the client's platform.
  assert.deepEqual(validateControlParams("directoryList", { path: "C:\\work" }), { path: "C:\\work" })
})
