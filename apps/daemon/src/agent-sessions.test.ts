import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import type * as acp from "@agentclientprotocol/sdk"
import type { AgentClient, AgentConfig, AgentConnection, AgentProvider } from "./agents/acp.ts"
import { AgentProviders } from "./agent-providers.ts"
import { DaemonCatalog } from "./catalog.ts"
import { AgentSessions } from "./agent-sessions.ts"
import type { AgentActor, AgentReceipt, AgentSnapshot } from "./agent-protocol.ts"
import type { GitFileDiff, GitStatusSnapshot } from "./git-protocol.ts"

const execute = promisify(execFile)

class Provider implements AgentProvider {
  id = "fixture"
  client!: AgentClient
  prompts: string[] = []
  steers: string[] = []
  resumes: string[] = []
  cwds: string[] = []
  cancelCount = 0
  clients: AgentClient[] = []
  configs: AgentConfig[] = []
  closeCount = 0
  closeBarrier?: Promise<void>
  finishImmediately = false
  resumeWait?: { promise: Promise<void>; reject(error: Error): void }
  active?: { resolve: (result: acp.PromptResponse) => void; done: Promise<acp.PromptResponse> }
  async connect(config: AgentConfig, client: AgentClient): Promise<AgentConnection> {
    this.client = client
    this.clients.push(client)
    this.configs.push(structuredClone(config))
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, additionalDirectories: {} } }, _meta: { steering: { supported: true, supportsPromptRequired: true } } },
      newSession: async params => { this.cwds.push(params.cwd); return { sessionId: "provider-conversation" } },
      resume: async params => { this.resumes.push(params.sessionId); await this.resumeWait?.promise; return {} },
      prompt: async params => {
        this.prompts.push(params.prompt.map(item => item.type === "text" ? item.text : "").join(""))
        let resolve!: (result: acp.PromptResponse) => void
        const done = new Promise<acp.PromptResponse>(finish => { resolve = finish })
        this.active = { resolve, done }
        await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working 中文\n" } } })
        if (this.finishImmediately) this.finish()
        return done
      },
      steer: async params => {
        const text = params.prompt.map(item => item.type === "text" ? item.text : "").join("")
        this.steers.push(text)
        if (text === "race") { this.finish(); return { outcome: "inactive" } }
        if (text === "uncertain") throw new Error("Delivery response lost")
        return { outcome: "injected" }
      },
      cancel: async () => { this.cancelCount++; this.finish("cancelled") },
      close: async () => { this.closeCount++; this.resumeWait?.reject(new Error("Provider connection closed")); this.finish("cancelled"); await this.closeBarrier },
    }
  }
  finish(stopReason: acp.PromptResponse["stopReason"] = "end_turn"): void {
    const active = this.active; this.active = undefined; active?.resolve({ stopReason })
  }
  askPermission(): Promise<acp.RequestPermissionResponse> {
    return this.client.requestPermission!({
      sessionId: "provider-conversation", toolCall: { toolCallId: "tool-1", title: "Write file" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
    }, new AbortController().signal)
  }
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 400; n++) {
    const value = await read()
    if (predicate(value)) return value
    await delay(10)
  }
  throw new Error("Timed out waiting for Agent state")
}

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "df-agent-session-"))
  const repository = join(directory, "repository")
  await mkdir(repository)
  await execute("git", ["init", repository])
  await writeFile(join(repository, "README.md"), "fixture\n")
  await execute("git", ["-C", repository, "add", "."])
  await execute("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
  const daemon = join(directory, "daemon")
  await mkdir(daemon)
  const catalog = new DaemonCatalog(daemon)
  await catalog.init()
  const workspace = await catalog.native.createWorkspace("Fixture", [{ path: repository }])
  const provider = new Provider()
  const providers = new AgentProviders(daemon, provider)
  await providers.init()
  const service = new AgentSessions(catalog, catalog.native, provider, providers)
  await service.init()
  const actor: AgentActor = { ...service.actor(), kind: "user", userId: "alice" }
  const bob: AgentActor = { ...actor, userId: "bob", sourceMachine: { originId: "other-origin", id: "2" } }
  t.after(async () => { try { await service.close() } finally { await catalog.close(); await rm(directory, { recursive: true, force: true }) } })
  const create = { workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "worktree" }
  const snapshot = await service.handle("_deskfleet/session/create", create, actor) as AgentSnapshot
  assert.equal(snapshot.session.lifecycle, "ready")
  const sessionId = snapshot.session.id
  const read = () => service.journal.read(sessionId)
  const submit = (text: string, who = actor, delivery: "backlog" | "steer" = "backlog", turnId?: string) => {
    const params = { sessionId, operationId: randomUUID(), content: [{ type: "text", text }], delivery, ...(turnId ? { turnId } : {}) }
    return { params, result: service.handle("_deskfleet/input/submit", params, who) as Promise<AgentReceipt> }
  }
  return { catalog, service, provider, providers, actor, bob, create, snapshot, sessionId, read, submit, directory, repository }
}

test("concurrent users share durable backlog and retries do not duplicate inputs or worktrees", async t => {
  const f = await setup(t)
  const again = await f.service.handle("_deskfleet/session/create", f.create, f.actor) as AgentSnapshot
  assert.equal(again.session.id, f.sessionId)
  const first = f.submit("hold")
  const receipt = await first.result
  await until(f.read, state => state.turns.some(turn => turn.state === "running") && f.provider.prompts.length === 1)
  const second = f.submit("next", f.bob)
  await second.result
  assert.deepEqual(await f.service.handle("_deskfleet/input/submit", first.params, f.actor), receipt)
  let state = await f.read()
  assert.equal(state.inputs.length, 2)
  assert.equal(state.inputs.find(input => input.author.userId === "bob")?.state, "pending")
  assert.deepEqual(f.provider.prompts, ["hold"])
  await assert.rejects(f.service.handle("_deskfleet/input/submit", { ...first.params, content: [{ type: "text", text: "different" }] }, f.actor), /reused/u)
  f.provider.finish()
  state = await until(f.read, state => state.turns.length === 2 && state.turns[1]?.state === "running" && f.provider.prompts.length === 2)
  assert.deepEqual(f.provider.prompts, ["hold", "next"])
  assert.equal(state.inputs[1]?.author.sourceMachine.id, "2")
  const events = await f.service.journal.history(f.sessionId, "0", 200)
  assert.deepEqual(events.map(event => event.seq), events.map((_, i) => String(i + 1)))
  assert.ok(events.some(event => event.kind === "acp"))
  assert.equal((await f.catalog.native.snapshot()).workspaces[0]?.worktrees.filter(worktree => worktree.sessionId).length, 1)
})

test("steering consumes a selected candidate once and keeps its author separate from its dispatcher", async t => {
  const f = await setup(t)
  await f.submit("hold").result
  let state = await until(f.read, state => state.turns.some(turn => turn.state === "running") && f.provider.prompts.length === 1)
  const turn = state.turns[0]!
  const candidate = await f.submit("change direction").result
  await f.service.handle("_deskfleet/input/steer", { sessionId: f.sessionId, operationId: randomUUID(), inputId: candidate.inputId, turnId: turn.id }, f.bob)
  state = await until(f.read, state => state.inputs.find(input => input.id === candidate.inputId)?.state === "delivered")
  const input = state.inputs.find(input => input.id === candidate.inputId)!
  assert.equal(input.author.userId, "alice")
  assert.equal(input.dispatcher?.userId, "bob")
  assert.equal(input.actualDelivery, "steer")
  assert.equal(input.turnId, turn.id)
  assert.deepEqual(f.provider.steers, ["change direction"])
  f.provider.finish()
  await until(f.read, state => state.turns.every(turn => turn.state === "completed"))
  await delay(30)
  assert.deepEqual(f.provider.prompts, ["hold"])
})

test("steer at the turn boundary becomes a tracked normal prompt and unknown delivery never retries", async t => {
  const f = await setup(t)
  await f.submit("hold").result
  const state = await until(f.read, state => state.turns.length === 1 && f.provider.prompts.length === 1)
  const steer = await f.submit("race", f.bob, "steer", state.turns[0]!.id).result
  await until(f.read, state => state.turns.length === 2 && state.turns[1]?.state === "running" && f.provider.prompts.length === 2)
  assert.deepEqual(f.provider.prompts, ["hold", "race"])
  const uncertain = await f.submit("uncertain", f.actor, "steer", (await f.read()).turns[1]!.id).result
  await until(f.read, state => state.inputs.find(input => input.id === uncertain.inputId)?.state === "uncertain")
  f.provider.finish()
  await until(f.read, state => state.inputs.find(input => input.id === steer.inputId)?.state === "delivered")
  await delay(30)
  assert.deepEqual(f.provider.prompts, ["hold", "race"])
})

test("permission races resolve once, all decisions are audited, and a stale cancel cannot cancel the next turn", async t => {
  const f = await setup(t)
  await f.submit("hold").result
  let state = await until(f.read, state => state.turns.length === 1 && f.provider.prompts.length === 1)
  const firstTurn = state.turns[0]!
  const permissionResponse = f.provider.askPermission()
  state = await until(f.read, state => state.permissions.length === 1)
  const permissionId = state.permissions[0]!.id
  const decisions = [
    { sessionId: f.sessionId, operationId: randomUUID(), permissionId, optionId: "allow" },
    { sessionId: f.sessionId, operationId: randomUUID(), permissionId, optionId: "reject" },
  ]
  const results = await Promise.all(decisions.map((params, i) => f.service.handle("_deskfleet/permission/respond", params, i ? f.bob : f.actor)))
  assert.deepEqual(results[0], results[1])
  const answer = await permissionResponse
  assert.equal(answer.outcome.outcome, "selected")
  for (const decision of decisions) assert.equal((await f.service.journal.command(decision.operationId))?.status, "completed")
  await f.submit("next").result
  f.provider.finish()
  await until(f.read, state => state.turns.length === 2 && f.provider.prompts.length === 2)
  await f.service.handle("_deskfleet/turn/cancel", { sessionId: f.sessionId, operationId: randomUUID(), turnId: firstTurn.id }, f.bob)
  assert.equal(f.provider.cancelCount, 0)
})

test("fresh viewers replay history, stop retains backlog, and resume reuses the provider conversation", async t => {
  const f = await setup(t)
  await f.submit("hold").result
  await until(f.read, state => state.turns.length === 1 && f.provider.prompts.length === 1)
  await f.submit("after resume", f.bob).result
  const original = await f.service.handle("_deskfleet/session/subscribe", { sessionId: f.sessionId }, f.actor) as AgentSnapshot
  const observed = await f.service.handle("_deskfleet/session/subscribe", { sessionId: f.sessionId }, f.bob) as AgentSnapshot
  assert.equal(original.session.id, observed.session.id)
  await f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  assert.equal((await f.read()).inputs.find(input => input.author.userId === "bob")?.state, "pending")
  await f.service.handle("_deskfleet/session/resume", { sessionId: f.sessionId, operationId: randomUUID() }, f.bob)
  await until(f.read, state => state.turns.length === 2 && f.provider.prompts.length === 2)
  assert.deepEqual(f.provider.resumes, ["provider-conversation"])
  assert.deepEqual(f.provider.prompts, ["hold", "after resume"])
  const page = await f.service.handle("_deskfleet/session/history", { sessionId: f.sessionId, afterSeq: original.session.lastEventSeq }, f.bob) as unknown[]
  assert.ok(page.length > 0)
})

test("delete closes provider before removing owned checkouts and preserves the command receipt", async t => {
  const f = await setup(t)
  await f.submit("hold").result
  await until(f.read, state => state.turns.length === 1 && f.provider.prompts.length === 1)
  const params = { sessionId: f.sessionId, operationId: randomUUID() }
  await f.service.handle("_deskfleet/session/delete", params, f.actor)
  await assert.rejects(f.read(), /not found/u)
  assert.equal((await f.service.journal.command(params.operationId))?.status, "completed")
  assert.equal(await f.service.handle("_deskfleet/session/delete", params, f.actor), null)
  assert.equal((await f.catalog.native.snapshot()).workspaces[0]?.worktrees.length, 1)
})

test("resume waits for process shutdown and an old close callback cannot interrupt a new run", async t => {
  const f = await setup(t)
  await f.submit("hold").result
  await until(f.read, state => state.turns.length === 1 && f.provider.prompts.length === 1)
  await f.submit("after stop").result
  let release!: () => void
  f.provider.closeBarrier = new Promise<void>(resolve => { release = resolve })
  const stop = f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  await until(async () => f.provider.closeCount, count => count === 1)
  const resume = f.service.handle("_deskfleet/session/resume", { sessionId: f.sessionId, operationId: randomUUID() }, f.bob)
  await delay(20)
  assert.equal(f.provider.clients.length, 1)
  release()
  await Promise.all([stop, resume])
  f.provider.clients[0]!.onClose?.(new Error("late old-process close"))
  const state = await until(f.read, state => state.turns.length === 2 && f.provider.prompts.length === 2)
  assert.deepEqual(state.runs.map(run => run.state), ["stopped", "running"])
  assert.deepEqual(f.provider.prompts, ["hold", "after stop"])
})

test("an immediate resume waits for unexpected-close recovery before starting another generation", async t => {
  const f = await setup(t)
  f.provider.client.onClose?.(new Error("connection lost"))
  await f.service.handle("_deskfleet/session/resume", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  const state = await f.read()
  assert.deepEqual(state.runs.map(run => run.state), ["interrupted", "running"])
  assert.equal(state.runs[0]?.error, "connection lost")
})

test("immediately completed prompts drain every queued candidate without a lost dispatch wakeup", async t => {
  const f = await setup(t)
  await f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  f.provider.finishImmediately = true
  // The first message resumes the agent; the others queue while it starts.
  for (const text of ["one", "two", "three"]) await f.submit(text).result
  await until(f.read, state => state.inputs.every(input => input.state === "delivered"))
  assert.deepEqual(f.provider.prompts, ["one", "two", "three"])
})

test("interrupted creation returns a full snapshot and deletion recovers a missing final receipt", async t => {
  const f = await setup(t)
  const params = { ...f.create, operationId: randomUUID() }
  const created = await f.service.journal.create({
    id: await f.service.journal.id(), operationId: params.operationId, actor: f.actor,
    workspaceId: params.workspaceId, method: "_deskfleet/session/create", params,
    isCanonical: true, status: "accepted", receivedAt: new Date().toISOString(),
  }, params.workspaceId, "Interrupted", "worktree", params.provider)
  const result = await f.service.handle("_deskfleet/session/create", params, f.actor) as AgentSnapshot
  assert.equal(result.session.id, created.id)
  assert.equal(result.session.lifecycle, "provisioning")
  assert.deepEqual(result.turns, [])

  await f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  const deletion = { sessionId: f.sessionId, operationId: randomUUID() }
  await f.service.journal.commit(undefined, { command: {
    id: await f.service.journal.id(), operationId: deletion.operationId, actor: f.actor,
    sessionId: f.sessionId, method: "_deskfleet/session/delete", params: deletion,
    isCanonical: true, status: "accepted", receivedAt: new Date().toISOString(),
  } })
  await f.catalog.handle({ method: "workspaceSessionDestroy", params: { sessionId: f.sessionId } })
  assert.equal(await f.service.handle("_deskfleet/session/delete", deletion, f.actor), null)
  assert.equal((await f.service.journal.command(deletion.operationId))?.status, "completed")
})

test("shutdown closes a provider whose resume RPC is still waiting", { timeout: 10_000 }, async t => {
  const f = await setup(t)
  await f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  let reject!: (error: Error) => void
  f.provider.resumeWait = { promise: new Promise<void>((_, fail) => { reject = fail }), reject: error => reject(error) }
  const resuming = f.service.handle("_deskfleet/session/resume", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor).catch(error => error)
  await until(async () => f.provider.resumes.length, count => count === 1)
  await f.service.close()
  assert.match(String(await resuming), /Provider connection closed/u)
  assert.equal((await f.read()).runs.at(-1)?.state, "stopped")
})

test("a cancel waiting on persistence cannot cancel the next turn or its permission", async t => {
  const f = await setup(t)
  await f.submit("hold").result
  const first = await until(f.read, state => state.turns.length === 1 && f.provider.prompts.length === 1)
  await f.submit("next").result
  const read = f.service.journal.read.bind(f.service.journal)
  let intercept = false
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const unsubscribe = f.service.onEvent(event => {
    if (event.kind === "turn" && "state" in event.payload && event.payload.state === "cancelling") intercept = true
  })
  f.service.journal.read = async id => {
    const snapshot = await read(id)
    if (intercept) { intercept = false; entered(); await blocked }
    return snapshot
  }
  const cancel = f.service.handle("_deskfleet/turn/cancel", { sessionId: f.sessionId, operationId: randomUUID(), turnId: first.turns[0]!.id }, f.actor)
  await waiting
  f.provider.finish()
  await until(f.read, state => state.turns.length === 2 && f.provider.prompts.length === 2)
  const permission = f.provider.askPermission()
  const current = await until(f.read, state => state.permissions.some(value => value.state === "pending"))
  release()
  await cancel
  unsubscribe()
  assert.equal(f.provider.cancelCount, 0)
  assert.equal((await f.read()).permissions.at(-1)?.state, "pending")
  await f.service.handle("_deskfleet/permission/respond", { sessionId: f.sessionId, operationId: randomUUID(), permissionId: current.permissions.at(-1)!.id, optionId: "allow" }, f.actor)
  assert.equal((await permission).outcome.outcome, "selected")
})

test("shutdown also stops a resume already queued behind another stop", async t => {
  const f = await setup(t)
  let release!: () => void
  f.provider.closeBarrier = new Promise<void>(resolve => { release = resolve })
  const stopping = f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  await until(async () => f.provider.closeCount, count => count === 1)
  const resuming = f.service.handle("_deskfleet/session/resume", { sessionId: f.sessionId, operationId: randomUUID() }, f.bob).catch(error => error)
  await delay(20)
  const closing = f.service.close()
  release()
  await Promise.all([stopping, resuming, closing])
  assert.ok((await f.read()).runs.every(run => ["stopped", "failed", "interrupted"].includes(run.state)))
  assert.equal(f.provider.closeCount, f.provider.clients.length)
})

test("a directory Session works in the Workspace's own directories, even without Git, and deletion leaves them", async t => {
  const f = await setup(t)
  const plain = join(f.directory, "plain")
  await mkdir(plain)
  await writeFile(join(plain, "notes.txt"), "keep\n")
  const workspace = await f.catalog.native.createWorkspace("Plain", [{ path: plain }])
  const params = { workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "directory" }
  const snapshot = await f.service.handle("_deskfleet/session/create", params, f.actor) as AgentSnapshot
  assert.equal(snapshot.session.lifecycle, "ready")
  assert.equal(snapshot.session.context, "directory")
  const owned = (await f.catalog.native.snapshot()).workspaces.find(value => value.id === workspace.id)!.worktrees.find(value => value.sessionId === snapshot.session.id)
  assert.deepEqual(owned?.directories, [{ path: plain }])
  await until(async () => f.provider.cwds, cwds => cwds.includes(plain))
  await f.service.handle("_deskfleet/session/delete", { sessionId: snapshot.session.id, operationId: randomUUID() }, f.actor)
  assert.equal(await readFile(join(plain, "notes.txt"), "utf8"), "keep\n")
  assert.equal(f.snapshot.session.context, "worktree")
  assert.notEqual(f.provider.cwds[0], f.repository, "A worktree Session must not run in the source checkout")
})

test("Git reads use the captured Session checkout after Workspace edits and do not append history", async t => {
  const f = await setup(t)
  await f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  const worktree = await f.catalog.sessionWorktree(f.sessionId)
  assert.ok(worktree)
  await writeFile(join(worktree.directories[0]!.path, "README.md"), "Session edit\n")
  await writeFile(join(f.repository, "README.md"), "Source checkout edit\n")
  const replacement = join(f.directory, "replacement")
  await mkdir(replacement)
  await f.catalog.native.updateWorkspace(f.create.workspaceId, "Changed configuration", [{ path: replacement }])
  const before = await f.read()

  const status = await f.service.handle("_deskfleet/git/status", { sessionId: f.sessionId }, f.actor) as GitStatusSnapshot
  assert.equal(status.sessionId, f.sessionId)
  assert.equal(status.repositories.length, 1)
  const repository = status.repositories[0]!
  assert.ok(repository.changes.some(change => change.path === "README.md" && change.kind === "unstaged"))
  const diff = await f.service.handle("_deskfleet/git/diff", {
    sessionId: f.sessionId, repositoryId: repository.id, path: "README.md", kind: "unstaged",
  }, f.bob) as GitFileDiff
  assert.match(diff.patch, /\+Session edit/u)
  assert.doesNotMatch(diff.patch, /Source checkout edit/u)
  assert.equal((await f.read()).session.lastEventSeq, before.session.lastEventSeq)
  assert.deepEqual(await f.service.journal.history(f.sessionId, before.session.lastEventSeq), [])
})

test("a worktree Session still requires a committed Git checkout", async t => {
  const f = await setup(t)
  const plain = join(f.directory, "plain")
  await mkdir(plain)
  const workspace = await f.catalog.native.createWorkspace("Plain", [{ path: plain }])
  const snapshot = await f.service.handle("_deskfleet/session/create", { workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "worktree" }, f.actor) as AgentSnapshot
  assert.equal(snapshot.session.lifecycle, "provision_failed")
  assert.match(snapshot.session.error ?? "", /Git working tree/u)
  for (const method of ["_deskfleet/git/status", "_deskfleet/git/diff"] as const) {
    await assert.rejects(f.service.handle(method, { sessionId: snapshot.session.id }, f.actor), /no usable execution context/u)
  }
})

test("a new message resumes a stopped agent in its saved conversation and drains the backlog in order", async t => {
  const f = await setup(t)
  f.provider.finishImmediately = true
  await f.submit("first").result
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  await f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  await f.submit("queued while stopped", f.bob).result
  await until(f.read, state => state.turns.filter(turn => turn.state === "completed").length === 2)
  assert.deepEqual(f.provider.resumes, ["provider-conversation"])
  assert.deepEqual(f.provider.prompts, ["first", "queued while stopped"])
  assert.equal((await f.read()).runs.at(-1)?.state, "running")
})

test("a message to an agent that cannot resume its conversation is rejected instead of queued forever", async t => {
  const f = await setup(t)
  f.provider.finishImmediately = true
  await f.submit("first").result
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  await f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  await f.service.journal.serial(f.sessionId, async () => {
    const current = await f.read()
    const session = { ...current.session, capabilities: { steering: true, resume: false } }
    await f.service.journal.commit(current, { session, events: [f.service.journal.event(f.sessionId, "session", session)] })
  })
  await assert.rejects(f.submit("lost").result, /cannot resume/u)
  assert.equal((await f.read()).inputs.some(input => input.content.some(block => block.type === "text" && block.text === "lost")), false)
})

test("Sessions retain the chosen provider ID and read edited launch settings on the next run", async t => {
  const f = await setup(t)
  const configured = await f.providers.create({
    template: "codex", name: "Work account", binaryPath: "/tools/work-codex",
    env: { CODEX_HOME: "/work/account", TOKEN: "private-provider-value" },
  })
  const snapshot = await f.service.handle("_deskfleet/session/create", {
    ...f.create, operationId: randomUUID(), provider: configured.id,
  }, f.actor) as AgentSnapshot
  const sessionId = snapshot.session.id
  assert.equal(snapshot.session.provider, configured.id)
  assert.deepEqual(f.provider.configs.at(-1), {
    name: "Work account", binaryPath: "/tools/work-codex",
    env: { CODEX_HOME: "/work/account", TOKEN: "private-provider-value" },
  })
  const launches = f.provider.configs.length
  await f.providers.update(configured.id, { name: "Renamed account", binaryPath: "", env: { CODEX_HOME: "/work/updated" } })
  assert.equal(f.provider.configs.length, launches)
  assert.equal(f.provider.closeCount, 0)
  await f.service.handle("_deskfleet/session/stop", { sessionId, operationId: randomUUID() }, f.actor)
  await f.service.handle("_deskfleet/session/resume", { sessionId, operationId: randomUUID() }, f.actor)
  assert.equal(f.provider.configs.length, launches + 1)
  assert.deepEqual(f.provider.configs.at(-1), { name: "Renamed account", binaryPath: "codex", env: { CODEX_HOME: "/work/updated" } })
  assert.equal((await f.service.journal.read(sessionId)).session.provider, configured.id)
  assert.deepEqual(f.provider.resumes, ["provider-conversation"])
  const journal = await f.service.journal.history(sessionId, "0")
  assert.equal(JSON.stringify(journal).includes("private-provider-value"), false)
})

test("unknown providers cannot allocate Sessions and removing one preserves its running Session and history", async t => {
  const f = await setup(t)
  await assert.rejects(f.service.handle("_deskfleet/session/create", {
    ...f.create, operationId: randomUUID(), provider: "missing",
  }, f.actor), /provider.*(unavailable|not found)/iu)
  assert.equal((await f.service.journal.list()).length, 1)
  await f.providers.remove("codex")
  assert.equal(f.provider.closeCount, 0)
  f.provider.finishImmediately = true
  await f.submit("still running").result
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  await f.service.handle("_deskfleet/session/stop", { sessionId: f.sessionId, operationId: randomUUID() }, f.actor)
  await assert.rejects(f.service.handle("_deskfleet/session/resume", {
    sessionId: f.sessionId, operationId: randomUUID(),
  }, f.actor), /provider.*(unavailable|not found)/iu)
  const state = await f.read()
  assert.equal(state.session.provider, "codex")
  assert.equal(state.runs.at(-1)?.state, "failed")
  assert.match(state.session.error ?? "", /provider.*(unavailable|not found)/iu)
  assert.equal(state.turns[0]?.state, "completed")
  assert.equal(f.provider.configs.length, 1)
})
