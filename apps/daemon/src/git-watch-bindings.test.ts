import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { GitInspection } from "./git-inspection.ts"

const execute = promisify(execFile)
const git = async (root: string, ...args: string[]) => execute("git", ["-C", root, ...args], { encoding: "utf8" })

test("unavailable directory bindings retain errors without disabling healthy checkout observation", async context => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-git-bindings-")))
  const inspection = new GitInspection()
  context.after(async () => { inspection.close(); await rm(base, { recursive: true, force: true }) })
  const root = join(base, "repo"), missing = join(base, "missing"), file = join(base, "file.txt")
  await mkdir(root)
  await git(root, "init", "--initial-branch=main")
  await writeFile(file, "not a directory\n")
  const notifications: (string | undefined)[] = []
  const paths = [missing, root, file]
  const stop = await inspection.watch(paths, error => notifications.push(error))
  assert.match(notifications.at(-1)!, /missing/)
  assert.match(notifications.at(-1)!, /file\.txt/)
  const initial = await inspection.status("1", paths)
  assert.equal(initial.repositories.length, 1)
  assert.ok(initial.directories[0]?.error)
  assert.ok(initial.directories[2]?.error)
  const before = notifications.length
  await writeFile(join(root, "observed.txt"), "healthy checkout stays live\n")
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const status = await inspection.status("1", paths)
    if (notifications.length > before && status.repositories[0]?.changes.some(change => change.path === "observed.txt")) break
    await delay(20)
  }
  assert.ok(notifications.length > before, "healthy checkout must still send invalidations")
  assert.ok((await inspection.status("1", paths)).repositories[0]?.changes.some(change => change.path === "observed.txt"))
  assert.ok(notifications.every(error => error?.includes(missing)), "healthy events must not hide an unavailable binding")
  stop()
  const stopped = notifications.length
  await writeFile(join(root, "after-stop.txt"), "released\n")
  await delay(100)
  assert.equal(notifications.length, stopped)

  const allUnavailable: (string | undefined)[] = []
  const stopUnavailable = await inspection.watch([missing, file], error => allUnavailable.push(error))
  assert.equal(allUnavailable.length, 1)
  assert.match(allUnavailable[0]!, /Could not watch Git changes/)
  stopUnavailable()

  await mkdir(missing)
  const recovered: (string | undefined)[] = []
  const stopRecovered = await inspection.watch([missing, root], error => recovered.push(error))
  assert.ok(recovered.every(error => error === undefined))
  stopRecovered()
})
