import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test, { type TestContext } from "node:test"
import type { ContentBlock } from "@agentclientprotocol/sdk/unstable"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { prepareWorktreeBranchPrompt } from "./worktree-branch-naming.ts"

const exec = promisify(execFile)
const prompt: ContentBlock[] = [{ type: "text", text: "Fix the login timeout" }]
const origin = "a1234567-1234-1234-1234-123456789012"

function snapshot(): AgentSnapshot {
  return {
    session: { id: "7", workspaceId: "1", provider: "codex", title: "", context: "worktree",
      lifecycle: "ready", archiveState: "active", lastEventSeq: "0", createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z" },
    runs: [], inputs: [], turns: [], permissions: [], elicitations: [],
  }
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "df-branch-naming-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "source"), checkout = join(directory, "checkout")
  await mkdir(root)
  const git = async (path: string, ...args: string[]) => (await exec("git", ["-C", path, ...args], { windowsHide: true })).stdout.trimEnd()
  await git(root, "init", "--initial-branch=main")
  await git(root, "config", "user.name", "Fixture")
  await git(root, "config", "user.email", "fixture@example.test")
  await writeFile(join(root, "README.md"), "fixture\n")
  await git(root, "add", ".")
  await git(root, "-c", "commit.gpgsign=false", "commit", "-m", "Initial")
  await git(root, "worktree", "add", "--detach", checkout)
  return { root, checkout, git, directories: [{ path: checkout }] }
}

test("semantic naming gives the provider the first task and detached roots", async t => {
  const f = await setup(t)
  const result = await prepareWorktreeBranchPrompt(snapshot(), "1", f.directories, "semantic", origin, prompt)
  assert.equal(result.length, 2)
  assert.match((result[0] as { text: string }).text, /semantic prefix/)
  assert.match((result[0] as { text: string }).text, /fix\/login-timeout/)
  // Git resolves macOS /var aliases and Windows 8.3 paths to their physical paths.
  const checkout = (await realpath(f.checkout)).replaceAll("\\", "/")
  assert.ok((result[0] as { text: string }).text.includes(JSON.stringify(checkout)))
  assert.equal(result[1], prompt[0])
  assert.equal(await f.git(f.checkout, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
})

test("session naming creates a stable registration-qualified branch", async t => {
  const f = await setup(t)
  const result = await prepareWorktreeBranchPrompt(snapshot(), "1", f.directories, "session", origin, prompt)
  assert.equal(result, prompt)
  assert.equal(await f.git(f.checkout, "branch", "--show-current"), "deskfleet/session-a1234567-7")
})

test("user branches are preserved for both naming modes", async t => {
  const f = await setup(t)
  await f.git(f.checkout, "switch", "-c", "user-chosen")
  for (const mode of ["session", "semantic"] as const) {
    assert.equal(await prepareWorktreeBranchPrompt(snapshot(), "1", f.directories, mode, origin, prompt), prompt)
  }
  assert.equal(await f.git(f.checkout, "branch", "--show-current"), "user-chosen")
})

test("directory contexts and resumed or forked conversations do not rename branches", async t => {
  const f = await setup(t)
  const directory = snapshot(); directory.session.context = "directory"
  const resumed = snapshot()
  resumed.turns = [{ id: "1", sessionId: "7", initialInputId: "1", dispatchCommandId: "1", runGeneration: 1,
    state: "completed", consumed: true, startedAt: "2026-11-12T00:00:00Z" }]
  const forked = snapshot(); forked.session.inheritedTurnCount = 1
  for (const value of [directory, resumed, forked]) {
    assert.equal(await prepareWorktreeBranchPrompt(value, "2", f.directories, "session", origin, prompt), prompt)
  }
  assert.equal(await f.git(f.checkout, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD")
})

test("duplicate nested directories create one branch and retain files", async t => {
  const f = await setup(t)
  const nested = join(f.checkout, "nested")
  await mkdir(nested)
  await writeFile(join(nested, "local.txt"), "local edits")
  await prepareWorktreeBranchPrompt(snapshot(), "1", [...f.directories, { path: nested }], "session", origin, prompt)
  assert.equal(await f.git(f.checkout, "branch", "--show-current"), "deskfleet/session-a1234567-7")
  assert.match(await f.git(f.checkout, "status", "--porcelain"), /nested/)
})

test("distinct checkouts of one repository receive separate session branches", async t => {
  const f = await setup(t)
  const second = join(f.root, "..", "second")
  await f.git(f.root, "worktree", "add", "--detach", second)
  await prepareWorktreeBranchPrompt(snapshot(), "1", [...f.directories, { path: second }], "session", origin, prompt)
  assert.equal(await f.git(f.checkout, "branch", "--show-current"), "deskfleet/session-a1234567-7")
  assert.equal(await f.git(second, "branch", "--show-current"), "deskfleet/session-a1234567-7-2")
})
