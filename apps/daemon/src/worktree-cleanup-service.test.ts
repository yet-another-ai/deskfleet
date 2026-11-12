import assert from "node:assert/strict"
import test from "node:test"
import { WorktreeCleanup } from "./worktree-cleanup.ts"
import { cleanupGitEligible, cleanupSessionIdle, cleanupTimeReason } from "./worktree-cleanup-policy.ts"
import { defaultWorktreePreferences, readWorktreePreferences, validateWorktreePreferences, writeWorktreePreferences } from "./worktree-preferences.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import type { AgentSessions } from "./agent-sessions.ts"
import type { DaemonCatalog } from "./catalog.ts"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const now = Date.parse("2026-11-12T00:00:00Z")
const ago = (days: number) => new Date(now - days * 86_400_000).toISOString()
function snapshot(): AgentSnapshot {
  return {
    session: { id: "1", provider: "test", title: "Task", context: "worktree", lifecycle: "ready", archiveState: "active", lastEventSeq: "12", createdAt: ago(10), updatedAt: ago(8) },
    runs: [], inputs: [{ id: "1", sessionId: "1", submissionCommandId: "1", author: { kind: "user", userId: "7" }, content: [{ type: "text", text: "task" }], acceptedSeq: "1", state: "delivered", requestedDelivery: "backlog", createdAt: ago(8) }],
    turns: [{ id: "1", sessionId: "1", initialInputId: "1", dispatchCommandId: "1", runGeneration: 1, state: "completed", startedAt: ago(8), endedAt: ago(7) }],
    permissions: [], elicitations: [],
  }
}

test("cleanup timers use durable activity and only completed, idle turns settle", () => {
  const settings = defaultWorktreePreferences().cleanup
  const state = snapshot()
  assert.equal(cleanupTimeReason(state, settings, now), "inactive")
  settings.inactive = false
  assert.equal(cleanupTimeReason(state, settings, now), "settled")
  state.turns[0]!.state = "failed"
  assert.equal(cleanupTimeReason(state, settings, now), undefined)
  assert.equal(cleanupGitEligible(state), false)
  state.turns[0]!.state = "completed"
  settings.inactive = true; settings.settled = false
  state.session.viewers = [{ userId: "7", seenAt: ago(0) }]
  assert.equal(cleanupTimeReason(state, settings, now), undefined)
  state.session.viewers = []
  state.inputs[0]!.createdAt = ago(1)
  assert.equal(cleanupTimeReason(state, settings, now), undefined)
  state.inputs[0]!.state = "pending"
  assert.equal(cleanupSessionIdle(state), false)
  state.inputs[0]!.state = "uncertain"
  assert.equal(cleanupSessionIdle(state), false)
  state.inputs[0]!.state = "delivered"
  state.runs = [{ sessionId: "1", generation: 2, state: "starting", startedAt: ago(0) }]
  assert.equal(cleanupSessionIdle(state), false)
})

test("archived cleanup is independently enabled and directory Sessions are never eligible", () => {
  const state = snapshot(), settings = defaultWorktreePreferences().cleanup
  state.session.archiveState = "archived"
  assert.equal(cleanupTimeReason(state, settings, now), "archived")
  settings.archived = false
  assert.equal(cleanupTimeReason(state, settings, now), undefined)
  assert.equal(cleanupGitEligible(state), false)
  state.session.context = "directory"
  assert.equal(cleanupSessionIdle(state), false)
})

test("settled zero runs on the next cleanup, but a never-started Session is not unchanged", () => {
  const state = snapshot(), settings = defaultWorktreePreferences().cleanup
  settings.inactive = false; settings.settledDays = 0
  state.turns[0]!.endedAt = ago(0)
  assert.equal(cleanupTimeReason(state, settings, now), "settled")
  state.turns = []
  assert.equal(cleanupTimeReason(state, settings, now), undefined)
  assert.equal(cleanupGitEligible(state), false)
})

test("preferences round trip, validate day ranges, and reject corrupt saved settings", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-cleanup-preferences-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settings = defaultWorktreePreferences()
  assert.deepEqual(await readWorktreePreferences(directory), settings)
  settings.cleanup.archived = false; settings.cleanup.settledDays = 0
  await writeWorktreePreferences(directory, settings)
  assert.deepEqual(await readWorktreePreferences(directory), settings)
  const saved = await readFile(join(directory, "worktree-preferences.json"), "utf8")
  for (const days of [-1, 0.5, 3651, NaN, "5"]) {
    await assert.rejects(writeWorktreePreferences(directory, { ...settings, cleanup: { ...settings.cleanup, settledDays: days as number } }))
  }
  assert.equal(await readFile(join(directory, "worktree-preferences.json"), "utf8"), saved)
  assert.throws(() => validateWorktreePreferences({ ...settings, cleanup: { ...settings.cleanup, inactiveDays: 0 } }))
  assert.throws(() => validateWorktreePreferences({ ...settings, cleanup: { ...settings.cleanup, archived: "true" } }))
  await writeFile(join(directory, "worktree-preferences.json"), "{")
  await assert.rejects(readWorktreePreferences(directory))
})

function serviceFixture() {
  const state = snapshot(), preferences = defaultWorktreePreferences(), removed: string[] = [], errors: string[] = []
  let protectedChanges = false, included = true, watched = false, merged = true, lookups = 0, refreshes = 0
  const agents = {
    resumeArchiving: async () => {},
    journal: { list: async () => [state.session], read: async () => structuredClone(state) },
    presence: () => watched ? [{ sessionId: "1", userIds: ["7"] }] : [],
    cleanupWorktree: async (id: string, sequence: string) => { assert.equal(sequence, "12"); removed.push(id) },
  } as unknown as AgentSessions
  const catalog = {
    getWorktreePreferences: async () => preferences,
    refreshSessionWorktreeDefaults: async () => { refreshes++ },
    inspectSessionWorktreeCleanup: async () => ({ hasCheckouts: true, protected: protectedChanges, repositories: [{ path: "/owned", includedInDefault: included }] }),
    snapshot: async () => ({ githubBranches: [{ sessionId: "1", repositories: [{ repository: "org/repo", headRepository: "org/repo", branch: "feat/task" }] }] }),
  } as unknown as DaemonCatalog
  const service = new WorktreeCleanup({ agents, catalog, now: () => now, report: id => errors.push(id), pullRequest: async () => {
    lookups++
    return { pullRequest: { number: 1, title: "Task", url: "https://github.com/org/repo/pull/1", state: merged ? "merged" : "open" } }
  } })
  return { service, state, preferences, removed, errors, setProtection: (v: boolean) => { protectedChanges = v }, setIncluded: (v: boolean) => { included = v },
    setWatched: (v: boolean) => { watched = v }, setMerged: (v: boolean) => { merged = v }, lookups: () => lookups, refreshes: () => refreshes }
}

test("scheduler skips protected/watched Sessions, checks merged PR AND default ancestry", async () => {
  const f = serviceFixture()
  f.preferences.cleanup.inactive = false; f.preferences.cleanup.settled = false; f.preferences.cleanup.unchanged = false
  f.setWatched(true); await f.service.run(); assert.equal(f.refreshes(), 0)
  f.setWatched(false); f.setProtection(true); await f.service.run(); assert.deepEqual(f.removed, [])
  f.setProtection(false); f.setIncluded(false); await f.service.run(); assert.equal(f.lookups(), 0)
  f.setIncluded(true); f.setMerged(false); await f.service.run(); assert.deepEqual(f.removed, [])
  f.setMerged(true); await f.service.run(); assert.deepEqual(f.removed, ["1"])
  await f.service.close(); await f.service.run(); assert.equal(f.removed.length, 1)
})

test("archived retained checkouts honor their own toggle and inactive cleanup needs no GitHub access", async () => {
  const f = serviceFixture()
  f.state.session.archiveState = "archived"; f.preferences.cleanup.archived = false
  await f.service.run(); assert.deepEqual(f.removed, [])
  f.preferences.cleanup.archived = true
  await f.service.run(); assert.deepEqual(f.removed, ["1"]); assert.equal(f.lookups(), 0)
  f.state.session.archiveState = "active"; f.setIncluded(false)
  await f.service.run(); assert.equal(f.removed.length, 2); assert.equal(f.refreshes(), 0)
  await f.service.close()
})
