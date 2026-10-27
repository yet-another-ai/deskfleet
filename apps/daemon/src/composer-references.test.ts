import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import type { AgentSessionRecord } from "./agent-protocol.ts"
import type { CatalogWorkspace } from "./catalog-protocol.ts"
import type { ComposerFileReference, ComposerReferenceCandidate } from "./composer-reference-protocol.ts"
import { ComposerReferences } from "./composer-references.ts"

const execute = promisify(execFile)
const git = async (root: string, ...args: string[]) => (await execute("git", ["-C", root, ...args], { encoding: "utf8" })).stdout.trimEnd()

async function fixture(context: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-references-")))
  context.after(() => rm(root, { recursive: true, force: true }))
  const workspaces: CatalogWorkspace[] = []
  const sessions = new Map<string, AgentSessionRecord>()
  const captured = new Map<string, string[]>()
  const catalog = {
    native: { snapshot: async () => ({ workspaces }) },
    sessionWorktree: async (id: string) => {
      const directories = captured.get(id)
      return directories ? { directories: directories.map(path => ({ path })) } : undefined
    },
  }
  const journal = {
    identity: { originId: "test-origin" },
    list: async () => [...sessions.values()],
    read: async (id: string) => {
      const session = sessions.get(id)
      if (!session) throw new Error("Agent Session was not found")
      return { session }
    },
  }
  function workspace(id: string, directories: string[]) {
    workspaces.push({ id, name: `Workspace ${id}`, worktrees: [{ id: `${id}0`, workspaceId: id, directories: directories.map(path => ({ path })) }] })
  }
  function session(id: string, workspaceId: string | undefined, directories: string[], changes: Partial<AgentSessionRecord> = {}) {
    sessions.set(id, { id, workspaceId, provider: "codex", title: `Session ${id}`, context: "directory", lifecycle: "ready",
      archiveState: "active", lastEventSeq: "10", createdAt: "2026-10-27T01:00:00Z", updatedAt: "2026-10-27T02:00:00Z", ...changes })
    captured.set(id, directories)
  }
  return { root, workspace, session, workspaces, sessions, captured, service: new ComposerReferences(catalog, journal) }
}

async function repository(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await git(root, "init", "--initial-branch=main")
  await git(root, "config", "user.name", "deskfleet test")
  await git(root, "config", "user.email", "test@example.invalid")
}

const file = (candidate: ComposerReferenceCandidate | undefined): ComposerFileReference => {
  assert.ok(candidate)
  assert.equal(candidate.reference.kind, "file")
  return candidate.reference as ComposerFileReference
}

test("file search uses all ordered bindings, filters Git ignores and never traverses symlinks or .git", async context => {
  const f = await fixture(context)
  const repo = join(f.root, "repo")
  const plain = join(f.root, "plain")
  await repository(repo)
  await mkdir(plain)
  await mkdir(join(repo, "src"))
  await mkdir(join(repo, "generated"))
  await writeFile(join(repo, ".gitignore"), "generated/\n*.log\n")
  await writeFile(join(repo, "src", "source.ts"), "source")
  await writeFile(join(repo, "generated", "hidden.ts"), "ignored")
  await writeFile(join(repo, "trace.log"), "ignored")
  await writeFile(join(plain, "notes.ts"), "plain")
  await mkdir(join(plain, ".git"))
  await writeFile(join(plain, ".git", "secret.ts"), "metadata")
  const outside = join(f.root, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "outside.ts"), "outside")
  await symlink(outside, join(repo, "linked"), process.platform === "win32" ? "junction" : "dir")
  f.workspace("1", [repo, plain])
  const result = await f.service.search({ workspaceId: "1", kind: "file", query: ".ts" })
  assert.equal(result.truncated, false)
  assert.deepEqual(result.items.map(item => item.name), ["src/source.ts", "notes.ts"])
  assert.deepEqual(result.items.map(item => file(item).directoryIndex), [0, 1])
  assert.equal(file(result.items[1]).sourceDirectory, plain)
  assert.equal(file(result.items[0]).sessionId, undefined)
  assert.equal((await f.service.search({ workspaceId: "1", kind: "file", query: "generated" })).items.length, 0)
})

test("search respects parent Git ignores inside a nested directory binding and searches nested repositories", async context => {
  const f = await fixture(context)
  await repository(f.root)
  const binding = join(f.root, "src")
  await mkdir(binding)
  await writeFile(join(f.root, ".gitignore"), "src/ignored/\n")
  await mkdir(join(binding, "ignored"))
  await writeFile(join(binding, "ignored", "hidden.txt"), "hidden")
  await writeFile(join(binding, "visible.txt"), "visible")
  const nested = join(binding, "nested")
  await repository(nested)
  await writeFile(join(nested, ".gitignore"), "secret.txt\n")
  await writeFile(join(nested, "secret.txt"), "hidden")
  await writeFile(join(nested, "public.txt"), "public")
  f.workspace("1", [binding])
  assert.deepEqual((await f.service.search({ workspaceId: "1", kind: "file", query: ".txt" })).items.map(item => item.name), ["visible.txt", "nested/public.txt"])
})

test("draft file references resolve inside newly captured generated worktrees and fail for source-only files", async context => {
  const f = await fixture(context)
  const source = join(f.root, "source")
  const worktree = join(f.root, "worktree")
  await repository(source)
  await writeFile(join(source, "tracked.txt"), "committed")
  await mkdir(join(source, "nested"))
  await writeFile(join(source, "nested", "second.txt"), "second")
  await git(source, "add", ".")
  await git(source, "commit", "--no-gpg-sign", "-m", "initial")
  await git(source, "worktree", "add", "--detach", worktree, "HEAD")
  await writeFile(join(source, "draft.txt"), "source only")
  f.workspace("1", [source, join(source, "nested")])
  const draft = await f.service.search({ workspaceId: "1", kind: "file", query: ".txt" })
  const tracked = file(draft.items.find(item => item.name === "tracked.txt"))
  const untracked = file(draft.items.find(item => item.name === "draft.txt"))
  const second = file(draft.items.find(item => item.name === "second.txt"))
  assert.equal(second.directoryIndex, 1)
  f.session("10", "1", [worktree, join(worktree, "nested")], { context: "worktree" })
  assert.deepEqual(await f.service.resolve({ sessionId: "10", references: [tracked] }), [
    { type: "resource_link", uri: pathToFileURL(join(worktree, "tracked.txt")).href, name: "tracked.txt", size: 9 },
  ])
  assert.deepEqual(await f.service.resolve({ sessionId: "10", references: [second] }), [
    { type: "resource_link", uri: pathToFileURL(join(worktree, "nested", "second.txt")).href, name: "second.txt", size: 6 },
  ])
  await assert.rejects(f.service.resolve({ sessionId: "10", references: [untracked] }), /unavailable in this Session.*draft.txt/u)
  await writeFile(join(worktree, "session-only.txt"), "session")
  const existing = await f.service.search({ sessionId: "10", kind: "file", query: "session-only" })
  assert.equal(file(existing.items[0]).sourceDirectory, worktree)
  assert.equal(file(existing.items[0]).sessionId, "10")
  assert.equal((await f.service.resolve({ sessionId: "10", references: [file(existing.items[0])] }))[0]?.type, "resource_link")
})

test("file resolution rejects changed bindings, foreign scopes, traversal, ignored files and symlink escapes", async context => {
  const f = await fixture(context)
  const root = join(f.root, "workspace")
  await repository(root)
  await writeFile(join(root, "file.txt"), "file")
  await writeFile(join(root, ".gitignore"), "hidden.txt\n")
  await writeFile(join(root, "hidden.txt"), "hidden")
  const outside = join(f.root, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "file.txt"), "outside")
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
  f.workspace("1", [root])
  f.session("10", "1", [root])
  const reference = file((await f.service.search({ workspaceId: "1", kind: "file", query: "file.txt" })).items[0])
  for (const changes of [
    { originId: "other-origin" }, { workspaceId: "2" }, { sessionId: "11" }, { directoryIndex: 9 },
    { sourceDirectory: outside }, { relativePath: "../outside/file.txt" }, { relativePath: "/etc/passwd" },
    { relativePath: "linked/file.txt" }, { relativePath: "hidden.txt" }, { relativePath: ".git/config" },
  ]) await assert.rejects(f.service.resolve({ sessionId: "10", references: [{ ...reference, ...changes }] }))
  f.workspaces[0]!.worktrees[0]!.directories = [{ path: outside }]
  await assert.rejects(f.service.resolve({ sessionId: "10", references: [reference] }), /source directory has changed/u)
  const existing = file((await f.service.search({ sessionId: "10", kind: "file", query: "file.txt" })).items[0])
  assert.equal(existing.sourceDirectory, root)
  assert.equal((await f.service.resolve({ sessionId: "10", references: [existing] }))[0]?.type, "resource_link")
})

test("session references stay in the Workspace, include archived history and preserve origin-qualified identity", async context => {
  const f = await fixture(context)
  f.workspace("1", [f.root])
  f.workspace("2", [f.root])
  f.session("10", "1", [f.root])
  f.session("11", "1", [f.root], { title: "Past investigation", archiveState: "archived" })
  f.session("12", "2", [f.root], { title: "Other Workspace" })
  f.session("13", undefined, [f.root], { title: "Machine Session" })
  const result = await f.service.search({ sessionId: "10", kind: "session", query: "investigation" })
  assert.deepEqual(result.items.map(item => item.reference), [{ kind: "session", originId: "test-origin", workspaceId: "1", sessionId: "11" }])
  assert.equal(result.items[0]?.archived, true)
  const reference = result.items[0]!.reference
  f.sessions.get("11")!.title = "Renamed investigation"
  f.sessions.get("11")!.lastEventSeq = "9007199254740993"
  const [block] = await f.service.resolve({ sessionId: "10", references: [reference] })
  assert.equal(block?.type, "text")
  if (block?.type !== "text") return
  assert.match(block.text, /Renamed investigation/u)
  assert.match(block.text, /deskfleet_session\(\{"sessionId":"11"\}\)/u)
  assert.match(block.text, /decimal string for max\(0, BigInt\(session.lastEventSeq\) - 100n\)/u)
  assert.match(block.text, /deskfleet_session_history with sessionId "11", that afterSeq, and limit 100/u)
  assert.doesNotMatch(block.text, /9007199254740993/u)
  assert.equal(f.sessions.get("11")!.archiveState, "archived")
  await assert.rejects(f.service.resolve({ sessionId: "10", references: [{ ...reference, sessionId: "12" }] }), /outside/u)
  await assert.rejects(f.service.search({ sessionId: "10", workspaceId: "2", kind: "session", query: "" }), /outside/u)
})

test("search limits report truncation and machine-scoped composition never scans home", async context => {
  const f = await fixture(context)
  await writeFile(join(f.root, "first.txt"), "first")
  await writeFile(join(f.root, "second.txt"), "second")
  f.workspace("1", [f.root])
  f.session("10", undefined, [f.root])
  assert.deepEqual(await f.service.search({ kind: "file", query: "" }), { items: [], truncated: false })
  assert.deepEqual(await f.service.search({ sessionId: "10", kind: "file", query: "" }), { items: [], truncated: false })
  assert.deepEqual(await f.service.search({ sessionId: "10", kind: "session", query: "" }), { items: [], truncated: false })
  const result = await f.service.search({ workspaceId: "1", kind: "file", query: ".txt", limit: 1 })
  assert.equal(result.items.length, 1)
  assert.equal(result.truncated, true)
  for (const value of [null, [], {}, { kind: "file", query: 3 }, { kind: "file", query: "", limit: 0 }, { workspaceId: "../1", kind: "file", query: "" }]) {
    await assert.rejects(f.service.search(value))
  }
  for (const value of [null, [], {}, { sessionId: "10", references: [null] }, { sessionId: "10", references: ["file"] }]) {
    await assert.rejects(f.service.resolve(value))
  }
})
