import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readWorktreeRoot, writeWorktreeRoot } from "./worktree-settings.ts"

test("worktree storage preferences persist, create the selected directory, and reset to the default", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-worktree-settings-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const host = join(directory, "daemon")
  const root = join(directory, "other disk", "worktrees")
  assert.equal(await readWorktreeRoot(host), null)
  await writeWorktreeRoot(host, root)
  assert.equal(await readWorktreeRoot(host), root)
  assert.ok((await stat(root)).isDirectory())
  await writeWorktreeRoot(host, null)
  assert.equal(await readWorktreeRoot(host), null)
  await stat(root)
})

test("invalid or inaccessible storage preferences do not overwrite the saved root", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-worktree-settings-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "worktrees")
  await writeWorktreeRoot(directory, root)
  for (const value of ["", "relative/path", "~/worktrees", `${root}\0`, 1, undefined]) {
    await assert.rejects(writeWorktreeRoot(directory, value as string), /absolute directory path/u)
  }
  const file = join(directory, "file")
  await writeFile(file, "keep")
  await assert.rejects(writeWorktreeRoot(directory, file))
  assert.equal(await readFile(file, "utf8"), "keep")
  assert.equal(await readWorktreeRoot(directory), root)
})

test("a malformed settings file is reported instead of falling back to the home directory", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-worktree-settings-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(directory, { recursive: true })
  for (const value of ["{", "null", "{}", '{"root":"relative"}', '{"root":false}']) {
    await writeFile(join(directory, "worktree-settings.json"), value)
    await assert.rejects(readWorktreeRoot(directory))
  }
})
