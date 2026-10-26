import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs, { type FSWatcher } from "node:fs"
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { GitInspection } from "./git-inspection.ts"

const execute = promisify(execFile)
const git = async (root: string, ...args: string[]) => (await execute("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trimEnd()

async function repository(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await git(root, "init", "--initial-branch=main")
  await git(root, "config", "core.autocrlf", "false")
  await git(root, "config", "user.name", "deskfleet test")
  await git(root, "config", "user.email", "test@example.invalid")
  await writeFile(join(root, "source.txt"), "first\n")
  await git(root, "add", ".")
  await git(root, "commit", "--no-gpg-sign", "-m", "initial")
}

async function fixture(context: TestContext, initialize = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-git-watch-")))
  const inspection = new GitInspection()
  context.after(async () => { inspection.close(); await rm(root, { recursive: true, force: true }) })
  if (initialize) await repository(root)
  let events = 0
  const errors: string[] = []
  const stop = await inspection.watch([root], error => { events++; if (error) errors.push(error) })
  async function changed(action: () => Promise<unknown>) {
    const before = events
    await action()
    const until = Date.now() + 5_000
    while (events === before && Date.now() < until) await delay(20)
    assert.ok(events > before, "OS notification did not arrive")
    assert.deepEqual(errors, [])
  }
  return { root, inspection, stop, changed, errors, events: () => events }
}

test("OS events refresh tracked edits, atomic saves, new directories, staging and deletion", async context => {
  const f = await fixture(context)
  const status = () => f.inspection.status("1", [f.root])
  assert.equal((await status()).repositories[0]!.changes.length, 0)
  await f.changed(() => writeFile(join(f.root, "source.txt"), "changed\n"))
  assert.equal((await status()).repositories[0]!.changes[0]!.kind, "unstaged")
  await f.changed(async () => {
    await writeFile(join(f.root, "temporary.txt"), "atomic replacement\n")
    await rename(join(f.root, "temporary.txt"), join(f.root, "source.txt"))
  })
  await f.changed(() => writeFile(join(f.root, "source.txt"), "after atomic save\n"))
  await f.changed(() => git(f.root, "add", "source.txt"))
  assert.equal((await status()).repositories[0]!.changes[0]!.kind, "staged")
  await f.changed(async () => {
    await mkdir(join(f.root, "nested", "deeper"), { recursive: true })
    await writeFile(join(f.root, "nested", "deeper", "new.txt"), "new\n")
  })
  await delay(350)
  await f.changed(() => writeFile(join(f.root, "nested", "deeper", "new.txt"), "later\n"))
  assert.ok((await status()).repositories[0]!.changes.some(change => change.path === "nested/deeper/new.txt"))
  await f.changed(() => rm(join(f.root, "source.txt")))
  assert.ok((await status()).repositories[0]!.changes.some(change => change.status === "deleted"))
})

test("watched checkouts share cached and concurrent reads until invalidated, forced, or released", async context => {
  const f = await fixture(context)
  const [first, second] = await Promise.all([f.inspection.status("1", [f.root]), f.inspection.status("2", [f.root])])
  assert.equal(first.repositories[0], second.repositories[0])
  assert.equal((await f.inspection.status("3", [f.root])).repositories[0], first.repositories[0])
  const forced = await f.inspection.status("1", [f.root], true)
  assert.notEqual(forced.repositories[0], first.repositories[0])
  let otherEvents = 0
  const stopOther = await f.inspection.watch([f.root], () => { otherEvents++ })
  f.stop()
  const before = f.events()
  await writeFile(join(f.root, "source.txt"), "still observed\n")
  const until = Date.now() + 5_000
  while (!otherEvents && Date.now() < until) await delay(20)
  assert.ok(otherEvents > 0)
  assert.equal(f.events(), before)
  stopOther()
  const stopped = otherEvents
  await writeFile(join(f.root, "source.txt"), "no observers\n")
  await delay(150)
  assert.equal(otherEvents, stopped)
  const uncached = await f.inspection.status("1", [f.root])
  assert.notEqual((await f.inspection.status("1", [f.root])).repositories[0], uncached.repositories[0])
})

test("ignored trees and new ignored files stay quiet while tracked ignored paths and ignore rules remain live", async context => {
  const f = await fixture(context)
  f.stop()
  await mkdir(join(f.root, "generated", "deep"), { recursive: true })
  await mkdir(join(f.root, "mixed"))
  await writeFile(join(f.root, "mixed", "tracked.txt"), "tracked\n")
  await git(f.root, "add", "mixed/tracked.txt")
  await writeFile(join(f.root, ".gitignore"), "generated/\nmixed/\n*.log\n")
  let events = 0
  const errors: string[] = []
  await f.inspection.watch([f.root], error => { events++; if (error) errors.push(error) })
  await f.inspection.status("1", [f.root])
  await writeFile(join(f.root, "generated", "deep", "build.txt"), "ignored\n")
  await writeFile(join(f.root, "new.log"), "ignored new file\n")
  await writeFile(join(f.root, ".git", "objects", "info", "watcher-test"), "unrelated object metadata\n")
  await writeFile(join(f.root, ".git", "logs", "watcher-test"), "unrelated reflog\n")
  await delay(250)
  assert.equal(events, 0)
  await writeFile(join(f.root, "mixed", "tracked.txt"), "tracked change despite ignore\n")
  const until = Date.now() + 5_000
  while (!events && Date.now() < until) await delay(20)
  assert.ok(events > 0)
  await writeFile(join(f.root, ".gitignore"), "*.log\n")
  await delay(350)
  const before = events
  await writeFile(join(f.root, "generated", "deep", "build.txt"), "now visible\n")
  const deadline = Date.now() + 5_000
  while (events === before && Date.now() < deadline) await delay(20)
  assert.ok(events > before)
  assert.deepEqual(errors, [])
})

test("linked worktrees observe their separate index and HEAD plus common refs", async context => {
  const f = await fixture(context)
  const worktree = join(f.root, "linked")
  await git(f.root, "worktree", "add", "--detach", worktree, "HEAD")
  let events = 0
  const errors: string[] = []
  await f.inspection.watch([worktree], error => { events++; if (error) errors.push(error) })
  await f.inspection.status("2", [worktree])
  await git(worktree, "switch", "-c", "watched")
  await delay(150)
  assert.ok(events > 0)
  assert.equal((await f.inspection.status("2", [worktree])).repositories[0]!.branch, "watched")
  await writeFile(join(worktree, "source.txt"), "linked\n")
  await delay(100)
  await f.inspection.status("2", [worktree])
  const before = events
  await git(worktree, "add", "source.txt")
  await delay(150)
  assert.ok(events > before)
  assert.equal((await f.inspection.status("2", [worktree])).repositories[0]!.changes[0]!.kind, "staged")
  const previous = events
  await git(f.root, "update-ref", "refs/heads/another", "HEAD")
  await delay(150)
  assert.ok(events > previous)
  assert.deepEqual(errors, [])
})

test("a plain directory can become a repository without another subscription", async context => {
  const f = await fixture(context, false)
  assert.equal((await f.inspection.status("1", [f.root])).repositories.length, 0)
  await f.changed(() => repository(f.root))
  await delay(350)
  assert.equal((await f.inspection.status("1", [f.root])).repositories.length, 1)
  await f.changed(() => writeFile(join(f.root, "source.txt"), "initialized\n"))
  assert.equal((await f.inspection.status("1", [f.root])).repositories[0]!.changes.length, 1)
})

test("replacing a watched directory rebinds its OS watch to the new directory", async context => {
  const f = await fixture(context)
  await f.changed(() => mkdir(join(f.root, "nested")))
  await delay(250)
  await f.changed(async () => {
    await rename(join(f.root, "nested"), join(f.root, "old"))
    await mkdir(join(f.root, "nested"))
    await writeFile(join(f.root, "nested", "new.txt"), "replacement\n")
  })
  await delay(350)
  await f.changed(() => writeFile(join(f.root, "nested", "new.txt"), "after replacement\n"))
})

test("submodules use their own ignore rules and watch metadata outside the working tree", async context => {
  const f = await fixture(context)
  const source = join(f.root, "source-repository")
  await repository(source)
  await git(f.root, "-c", "protocol.file.allow=always", "submodule", "add", source, "module")
  await git(f.root, "commit", "--no-gpg-sign", "-am", "submodule")
  await delay(400)
  const module = join(f.root, "module")
  await f.changed(() => writeFile(join(module, "source.txt"), "module change\n"))
  await f.changed(() => git(module, "add", "source.txt"))
  assert.deepEqual(f.errors, [])
  assert.ok((await f.inspection.status("1", [f.root])).repositories[0]!.changes.some(change => change.path === "module"))
})

test("watcher failures stay visible through surviving events and another viewer can retry the shared watcher", async context => {
  const watchers = new Map<string, FSWatcher>()
  const original = fs.watch
  const mock = context.mock.method(fs, "watch", (...args: Parameters<typeof fs.watch>) => {
    const watcher = original(...args)
    watchers.set(String(args[0]), watcher)
    return watcher
  })
  syncBuiltinESMExports()
  context.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  const f = await fixture(context)
  f.stop()
  await mkdir(join(f.root, "nested"))
  await writeFile(join(f.root, "nested", "tracked.txt"), "tracked\n")
  await git(f.root, "add", ".")
  const other = join(f.root, "other")
  await repository(other)
  const first: (string | undefined)[] = []
  const second: (string | undefined)[] = []
  const stop = await f.inspection.watch([f.root, other], error => { first.push(error) })
  await f.inspection.watch([f.root, other], error => { second.push(error) })
  const failed = watchers.get(f.root)!
  failed.emit("error", new Error("injected lost subtree"))
  await writeFile(join(f.root, "nested", "tracked.txt"), "surviving watcher\n")
  await delay(100)
  assert.ok(second.length > 1)
  assert.match(second.at(-1)!, /injected lost subtree/u)
  await writeFile(join(other, "source.txt"), "healthy checkout must preserve the other error\n")
  await delay(100)
  assert.match(second.at(-1)!, /injected lost subtree/u)
  stop()
  await f.inspection.watch([f.root, other], error => { first.push(error) })
  assert.notEqual(watchers.get(f.root), failed)
  assert.equal(second.at(-1), undefined)
  const before = second.length
  await writeFile(join(f.root, "source.txt"), "recovered root watcher\n")
  const until = Date.now() + 5_000
  while (second.length === before && Date.now() < until) await delay(20)
  assert.ok(second.length > before)
  assert.equal(second.at(-1), undefined)
})
