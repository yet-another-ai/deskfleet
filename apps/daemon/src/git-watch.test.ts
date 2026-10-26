import assert from "node:assert/strict"
import childProcess, { execFile } from "node:child_process"
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

async function eventually(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await condition()) return
    await delay(20)
  }
  assert.fail(message)
}

function controlledWatches(context: TestContext): Map<string, fs.WatchListener<string>> {
  const callbacks = new Map<string, fs.WatchListener<string>>()
  const original = fs.watch
  const mock = context.mock.method(fs, "watch", (path: fs.PathLike, options: fs.WatchOptions, callback: fs.WatchListener<string>) => {
    callbacks.set(String(path), callback)
    // FSEvents can deliver setup writes made before fs.watch was attached.
    // Supply only the event under test while retaining real watcher resources.
    return original(path, options, () => {})
  })
  syncBuiltinESMExports()
  context.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
  return callbacks
}

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
  const releases: Array<() => void> = []
  context.after(async () => {
    for (const release of releases.splice(0)) release()
    inspection.close()
    // Windows keeps fs.watch handles briefly after close (especially submodule
    // trees). Retry the same way smoke scripts clear temp directories.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  if (initialize) await repository(root)
  let events = 0
  const errors: string[] = []
  const stop = await inspection.watch([root], error => { events++; if (error) errors.push(error) })
  releases.push(stop)
  async function changed(action: () => Promise<unknown>) {
    const before = events
    await action()
    const until = Date.now() + 5_000
    while (events === before && Date.now() < until) await delay(20)
    assert.ok(events > before, "OS notification did not arrive")
    assert.deepEqual(errors, [])
  }
  async function watch(paths: string[], listener: (error?: string) => void) {
    const release = await inspection.watch(paths, listener)
    releases.push(release)
    return release
  }
  return { root, inspection, stop, watch, changed, errors, events: () => events }
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
  const callbacks = controlledWatches(context)
  const f = await fixture(context)
  const [first, second] = await Promise.all([f.inspection.status("1", [f.root]), f.inspection.status("2", [f.root])])
  assert.equal(first.repositories[0], second.repositories[0])
  assert.equal((await f.inspection.status("3", [f.root])).repositories[0], first.repositories[0])
  const forced = await f.inspection.status("1", [f.root], true)
  assert.notEqual(forced.repositories[0], first.repositories[0])
  let otherEvents = 0
  const stopOther = await f.watch([f.root], () => { otherEvents++ })
  f.stop()
  const before = f.events()
  await writeFile(join(f.root, "source.txt"), "still observed\n")
  callbacks.get(f.root)!("change", "source.txt")
  assert.equal(otherEvents, 1)
  assert.equal(f.events(), before)
  const invalidated = await f.inspection.status("1", [f.root])
  assert.notEqual(invalidated.repositories[0], forced.repositories[0])
  assert.equal(invalidated.repositories[0]!.changes[0]!.kind, "unstaged")
  stopOther()
  const stopped = otherEvents
  await writeFile(join(f.root, "source.txt"), "no observers\n")
  callbacks.get(f.root)!("change", "source.txt")
  assert.equal(otherEvents, stopped)
  const uncached = await f.inspection.status("1", [f.root])
  assert.notEqual((await f.inspection.status("1", [f.root])).repositories[0], uncached.repositories[0])
})

test("ignored events preserve the cached snapshot and ignored trees have no subscriptions", async context => {
  const callbacks = controlledWatches(context)
  let classified = 0
  const originalExecFile = childProcess.execFile
  const execMock = context.mock.method(childProcess, "execFile", (...args: Parameters<typeof childProcess.execFile>) => {
    const child = originalExecFile(...args)
    if (args[1]?.includes("check-ignore")) child.once("close", () => { classified++ })
    return child
  })
  syncBuiltinESMExports()
  context.after(() => { execMock.mock.restore(); syncBuiltinESMExports() })
  const f = await fixture(context)
  f.stop()
  await mkdir(join(f.root, "generated", "deep"), { recursive: true })
  await mkdir(join(f.root, "mixed"))
  await writeFile(join(f.root, "mixed", "tracked.txt"), "tracked\n")
  await git(f.root, "add", "mixed/tracked.txt")
  await writeFile(join(f.root, ".gitignore"), "generated/\nmixed/\n*.log\n")
  let events = 0
  const errors: string[] = []
  await f.watch([f.root], error => { events++; if (error) errors.push(error) })
  const before = await f.inspection.status("1", [f.root])
  assert.equal(callbacks.has(join(f.root, "generated")), false)
  assert.equal(callbacks.has(join(f.root, "generated", "deep")), false)
  assert.equal(callbacks.has(join(f.root, ".git", "objects")), false)
  assert.equal(callbacks.has(join(f.root, ".git", "logs")), false)
  assert.ok(callbacks.has(join(f.root, "mixed")), "tracked files keep their ignored parent watched")
  await writeFile(join(f.root, "generated", "deep", "build.txt"), "ignored\n")
  await writeFile(join(f.root, "new.log"), "ignored new file\n")
  await writeFile(join(f.root, ".git", "objects", "info", "watcher-test"), "unrelated object metadata\n")
  await writeFile(join(f.root, ".git", "logs", "watcher-test"), "unrelated reflog\n")
  const previous = classified
  callbacks.get(f.root)!("change", "generated")
  callbacks.get(f.root)!("rename", "new.log")
  callbacks.get(f.root)!("change", ".git/objects/info/watcher-test")
  callbacks.get(join(f.root, ".git"))!("change", "objects/info/watcher-test")
  callbacks.get(join(f.root, ".git"))!("change", "logs/watcher-test")
  callbacks.get(join(f.root, ".git"))!("rename", "index.lock")
  await eventually(() => classified > previous, "new ignored file was not classified by Git")
  // The child close callback resolves check-ignore; let its awaiting classifier finish.
  await new Promise<void>(resolve => setImmediate(resolve))
  callbacks.get(f.root)!("change", "new.log")
  assert.equal(events, 0)
  assert.equal((await f.inspection.status("1", [f.root])).repositories[0], before.repositories[0])
  await writeFile(join(f.root, "mixed", "tracked.txt"), "tracked change despite ignore\n")
  callbacks.get(join(f.root, "mixed"))!("change", "tracked.txt")
  assert.equal(events, 1)
  assert.notEqual((await f.inspection.status("1", [f.root])).repositories[0], before.repositories[0])
  assert.deepEqual(errors, [])
})

test("OS events refresh tracked ignored paths and directories exposed by changed ignore rules", async context => {
  const f = await fixture(context)
  f.stop()
  await mkdir(join(f.root, "generated", "deep"), { recursive: true })
  await mkdir(join(f.root, "mixed"))
  await writeFile(join(f.root, "mixed", "tracked.txt"), "tracked\n")
  await git(f.root, "add", "mixed/tracked.txt")
  await writeFile(join(f.root, ".gitignore"), "generated/\nmixed/\n*.log\n")
  await writeFile(join(f.root, "generated", "deep", "build.txt"), "ignored\n")
  const errors: string[] = []
  await f.watch([f.root], error => { if (error) errors.push(error) })
  const changes = async () => (await f.inspection.status("1", [f.root])).repositories[0]!.changes
  assert.equal((await changes()).some(change => change.path === "generated/deep/build.txt"), false)
  await writeFile(join(f.root, "mixed", "tracked.txt"), "tracked change despite ignore\n")
  await eventually(async () => (await changes()).some(change => change.path === "mixed/tracked.txt" && change.kind === "unstaged"), "tracked ignored file did not invalidate its snapshot")
  await writeFile(join(f.root, ".gitignore"), "*.log\n")
  await eventually(async () => (await changes()).some(change => change.path === "generated/deep/build.txt" && change.additions === 1), "changed ignore rules did not expose the directory")
  await writeFile(join(f.root, "generated", "deep", "build.txt"), "now visible\nand watched\n")
  await eventually(async () => (await changes()).some(change => change.path === "generated/deep/build.txt" && change.additions === 2), "newly exposed directory did not refresh its cached contents")
  assert.deepEqual(errors, [])
})

test("linked worktrees observe their separate index and HEAD plus common refs", async context => {
  // Drive metadata invalidation through the same controlled watches as the
  // ignore tests. Linked-worktree HEAD/index/refs updates are easy for macOS
  // FSEvents to deliver after the short eventually window used elsewhere.
  const callbacks = controlledWatches(context)
  const f = await fixture(context)
  const worktree = join(f.root, "linked")
  await git(f.root, "worktree", "add", "--detach", worktree, "HEAD")
  const errors: string[] = []
  await f.watch([worktree], error => { if (error) errors.push(error) })
  // Git may print forward-slash absolute paths on Windows; fs.watch keys use
  // the platform form returned by realpath, matching GitWatch's subscriptions.
  const [gitDir, commonDir] = await Promise.all(
    (await git(worktree, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")).split("\n").map(path => realpath(path!)),
  )
  const notify = (directory: string, event: "change" | "rename", filename: string) => {
    const callback = callbacks.get(directory)
    assert.ok(callback, `missing watch for ${directory}`)
    callback(event, filename)
  }
  const status = async () => (await f.inspection.status("2", [worktree])).repositories[0]!
  const initial = await status()
  assert.equal(initial.branch, null)
  await git(worktree, "switch", "-c", "watched")
  notify(gitDir!, "change", "HEAD")
  await eventually(async () => (await status()).branch === "watched", "worktree HEAD change did not invalidate its detached snapshot")
  await writeFile(join(worktree, "source.txt"), "linked\n")
  notify(worktree, "change", "source.txt")
  await eventually(async () => (await status()).changes.some(change => change.path === "source.txt" && change.kind === "unstaged"), "worktree edit did not invalidate its clean snapshot")
  await git(worktree, "add", "source.txt")
  notify(gitDir!, "change", "index")
  await eventually(async () => (await status()).changes.some(change => change.path === "source.txt" && change.kind === "staged"), "separate worktree index did not invalidate its unstaged snapshot")
  const next = await git(f.root, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "advance common ref")
  await git(f.root, "update-ref", "refs/heads/watched", next)
  notify(join(commonDir!, "refs", "heads"), "change", "watched")
  await eventually(async () => (await status()).head === next, "common ref change did not invalidate the worktree HEAD snapshot")
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
  const stop = await f.watch([f.root, other], error => { first.push(error) })
  await f.watch([f.root, other], error => { second.push(error) })
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
  await f.watch([f.root, other], error => { first.push(error) })
  assert.notEqual(watchers.get(f.root), failed)
  assert.equal(second.at(-1), undefined)
  const before = second.length
  await writeFile(join(f.root, "source.txt"), "recovered root watcher\n")
  const until = Date.now() + 5_000
  while (second.length === before && Date.now() < until) await delay(20)
  assert.ok(second.length > before)
  assert.equal(second.at(-1), undefined)
})
