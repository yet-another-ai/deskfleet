import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { AgentActor, AgentCommand, AgentEvent, AgentSnapshot } from "./agent-protocol.ts"
import type { ScheduleInput, ScheduleRun, ScheduledTask } from "./schedule-protocol.ts"
import { ScheduledTasks } from "./scheduled-tasks.ts"

const actor: AgentActor = { kind: "user", userId: "user-1", deviceId: "login-1" }
const input: ScheduleInput = { title: "Review changes", prompt: "Review yesterday's commits", workspaceId: "1", enabled: true,
  target: { kind: "new", provider: "codex", context: "directory", configuration: { model: "model-a", mode: "readonly" } }, trigger: { kind: "interval", minutes: 5 } }

function snapshot(id: string, workspaceId = "1"): AgentSnapshot {
  return { session: { id, workspaceId, title: "Scheduled", provider: "codex", context: "directory", lifecycle: "ready", archiveState: "active", lastEventSeq: "0", createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z" },
    inputs: [], turns: [], runs: [], permissions: [], elicitations: [] }
}

async function fixture(t: { after(action: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), "df-schedules-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let time = new Date("2026-10-26T00:00:00Z")
  let authorized = true
  let loseSubmissionResponse = false
  let nextSessionId = 3
  const snapshots = new Map<string, AgentSnapshot>([["1", snapshot("1")], ["2", snapshot("2", "2")]])
  const commands = new Map<string, AgentCommand>()
  const calls: { method: string; params: Record<string, unknown>; actor: AgentActor }[] = []
  const authorizations: AgentActor[] = []
  const listeners = new Set<(event: AgentEvent) => void>()
  const dependencies = {
    now: () => time,
    authorize: async (actor: AgentActor) => { authorizations.push(actor); if (!authorized) throw new Error("Team membership was removed"); return actor },
    catalog: { native: { snapshot: async () => ({ workspaces: [{ id: "1" }, { id: "2" }] }) } },
    providers: { get: (id: string) => { if (id !== "codex") throw new Error("Provider unavailable"); return { id } } },
    agents: {
      journal: {
        list: async () => [...snapshots.values()].map(value => structuredClone(value.session)),
        read: async (id: string) => { const value = snapshots.get(id); if (!value) throw new Error("Unknown Session"); return structuredClone(value) },
        command: async (id: string) => commands.get(id),
      },
      onEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      handle: async (method: string, params: Record<string, unknown>, actor: AgentActor) => {
        calls.push({ method, params, actor })
        if (method === "_deskfleet/session/create") {
          const result = snapshot(String(nextSessionId++), params.workspaceId as string)
          snapshots.set(result.session.id, result)
          return result
        }
        assert.equal(method, "_deskfleet/input/submit")
        const value = snapshots.get(params.sessionId as string)!
        value.inputs.push({ id: "10", sessionId: value.session.id, submissionCommandId: "20", author: actor, content: params.content as never,
          acceptedSeq: "1", state: "pending", requestedDelivery: "backlog", createdAt: time.toISOString() })
        const receipt = { sessionId: value.session.id, inputId: "10", operationId: params.operationId, commandId: "20" }
        commands.set(params.operationId as string, { status: "completed", result: receipt } as AgentCommand)
        if (loseSubmissionResponse) throw new Error("Submission response was lost")
        return receipt
      },
    },
  } as unknown as ConstructorParameters<typeof ScheduledTasks>[1]
  const scheduler = new ScheduledTasks(directory, dependencies)
  t.after(() => scheduler.close())
  await scheduler.init()
  const list = () => scheduler.handle("scheduleList", {}, actor) as Promise<ScheduledTask[]>
  const create = (changes: Partial<ScheduleInput> = {}) => scheduler.handle("scheduleCreate", { schedule: { ...input, ...changes } }, actor) as Promise<ScheduledTask>
  return { directory, dependencies, scheduler, list, create, snapshots, calls, commands, authorizations,
    setTime: (value: string) => { time = new Date(value) }, revoke: () => { authorized = false },
    loseSubmissionResponse: () => { loseSubmissionResponse = true },
    emit: (sessionId: string) => { for (const listener of listeners) listener({ sessionId, kind: "turn" } as AgentEvent) } }
}

test("scheduled dispatch persists configuration, queues the prompt, and records actual completion", async t => {
  const f = await fixture(t)
  const task = await f.create()
  assert.equal(task.nextRunAt, "2026-10-26T00:05:00.000Z")
  f.setTime("2026-10-26T00:05:00Z")
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()])
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0]!.params.model, "model-a")
  assert.equal(f.calls[0]!.params.mode, "readonly")
  assert.deepEqual(f.calls[1]!.params.content, [{ type: "text", text: input.prompt }])
  assert.equal(f.calls[1]!.params.delivery, "backlog")
  assert.equal(f.authorizations.length, 1)
  let result = (await f.list())[0]!
  assert.equal(result.runs.length, 1)
  assert.equal(result.lastRun?.state, "running")
  assert.equal(result.nextRunAt, "2026-10-26T00:10:00.000Z")
  const state = f.snapshots.get(result.lastRun!.sessionId!)!
  state.inputs[0]!.state = "delivered"
  state.turns.push({ id: "30", sessionId: state.session.id, initialInputId: "10", dispatchCommandId: "20", runGeneration: 1, state: "completed", startedAt: "2026-10-26T00:05:00Z", endedAt: "2026-10-26T00:06:00Z" })
  f.emit(state.session.id)
  result = (await f.list())[0]!
  assert.equal(result.lastRun?.state, "completed")
  assert.equal(result.lastRun?.finishedAt, "2026-10-26T00:06:00Z")
  assert.ok(!JSON.stringify(result).includes("login-1"))
  assert.ok(!JSON.stringify(result).includes("OperationId"))
})

test("overlap is skipped and a long active run survives bounded history", async t => {
  const f = await fixture(t)
  const task = await f.create({ trigger: { kind: "manual" } })
  await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor)
  for (let i = 0; i < 55; i += 1) {
    const skipped = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
    assert.equal(skipped.state, "skipped")
  }
  assert.equal(f.calls.length, 2)
  const result = (await f.list())[0]!
  assert.ok(result.runs.some(run => run.state === "running"))
  assert.ok(result.runs.length <= 51)
})

test("archiving a retained pending run releases manual and automatic scheduled dispatch", async t => {
  const f = await fixture(t)
  const task = await f.create()
  const first = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  const state = f.snapshots.get(first.sessionId!)!
  for (let i = 0; i < 50; i += 1) await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor)
  assert.ok((await f.list())[0]!.runs.some(run => run.id === first.id))

  state.session.archiveState = "archiving"
  f.emit(first.sessionId!)
  const closing = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(closing.state, "skipped", "Archive must finish closing resources before releasing overlap")
  state.session.archiveState = "archived"
  f.emit(first.sessionId!)
  assert.equal((await f.list())[0]!.runs.find(run => run.id === first.id)?.state, "interrupted")
  const manual = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(manual.state, "running")
  assert.notEqual(manual.sessionId, first.sessionId)
  assert.equal(state.inputs[0]!.state, "pending", "Archive preserves the original backlog")
  assert.ok((await f.list())[0]!.runs.some(run => run.id === first.id), "Archived pending input stays an overlap anchor")

  f.snapshots.get(manual.sessionId!)!.session.archiveState = "archived"
  f.emit(manual.sessionId!)
  f.setTime(task.nextRunAt!)
  await f.scheduler.tick()
  const automatic = (await f.list())[0]!.lastRun!
  assert.equal(automatic.state, "running")
  assert.notEqual(automatic.sessionId, manual.sessionId)
  assert.equal(f.calls.length, 6)
})

test("restoring an archived Session with pending input prevents overlapping scheduled dispatch", async t => {
  const f = await fixture(t)
  const task = await f.create()
  const run = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  const state = f.snapshots.get(run.sessionId!)!
  state.session.archiveState = "archived"
  f.emit(run.sessionId!)
  assert.equal((await f.list())[0]!.lastRun?.state, "interrupted")
  state.session.archiveState = "active"
  f.emit(run.sessionId!)
  const next = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(next.state, "skipped")
  assert.equal(f.calls.length, 2)
})

test("startup releases a running run whose session journal is missing", async t => {
  const f = await fixture(t)
  const task = await f.create()
  const run = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  await f.scheduler.close()
  f.snapshots.delete(run.sessionId!)
  const reopened = new ScheduledTasks(f.directory, f.dependencies)
  t.after(() => reopened.close())
  await reopened.init()
  const released = await reopened.handle("scheduleList", {}, actor) as ScheduledTask[]
  assert.equal(released[0]!.lastRun?.state, "interrupted")
  assert.match(released[0]!.lastRun!.error!, /no longer available/u)
  const next = await reopened.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(next.state, "running")
  assert.notEqual(next.sessionId, run.sessionId)
})

test("startup keeps an unreadable active session blocking without aborting", async t => {
  const f = await fixture(t)
  const task = await f.create()
  const run = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  await f.scheduler.close()
  const journal = f.dependencies.agents.journal
  const read = journal.read.bind(journal)
  journal.read = async (id: string) => {
    if (id === run.sessionId) throw new Error("Snapshot is unavailable")
    return read(id)
  }
  const reopened = new ScheduledTasks(f.directory, f.dependencies)
  t.after(() => reopened.close())
  await reopened.init()
  const listed = await reopened.handle("scheduleList", {}, actor) as ScheduledTask[]
  assert.equal(listed[0]!.lastRun?.state, "running")
  const skipped = await reopened.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(skipped.state, "skipped")
})

test("archived pending input remains an overlap anchor after history eviction", async t => {
  const f = await fixture(t)
  const task = await f.create({ target: { kind: "existing", sessionId: "1" } })
  const first = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  const state = f.snapshots.get("1")!
  state.session.archiveState = "archived"
  f.emit("1")
  assert.equal((await f.list())[0]!.runs.find(run => run.id === first.id)?.state, "interrupted")
  for (let i = 0; i < 50; i += 1) {
    const failed = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
    assert.equal(failed.state, "failed")
    assert.match(failed.error!, /active and ready/u)
  }
  assert.ok((await f.list())[0]!.runs.some(run => run.id === first.id))
  assert.equal(state.inputs.length, 1)

  state.session.archiveState = "active"
  f.emit("1")
  const restored = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(restored.state, "skipped")
  assert.equal(state.inputs.length, 1, "Restoring a retained pending input does not accept a second backlog input")
  assert.equal(f.calls.length, 1)
})

test("a finished archived run is not retained past the history cap", async t => {
  const f = await fixture(t)
  const task = await f.create({ trigger: { kind: "manual" } })
  const first = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  const state = f.snapshots.get(first.sessionId!)!
  state.inputs[0]!.state = "delivered"
  state.turns.push({ id: "30", sessionId: state.session.id, initialInputId: "10", dispatchCommandId: "20", runGeneration: 1, state: "completed", startedAt: "2026-10-26T00:00:00Z", endedAt: "2026-10-26T00:01:00Z" })
  f.emit(state.session.id)
  state.session.archiveState = "archived"
  f.emit(state.session.id)
  const second = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(second.state, "running")
  for (let i = 0; i < 55; i += 1) {
    const skipped = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
    assert.equal(skipped.state, "skipped")
  }
  const runs = (await f.list())[0]!.runs
  assert.equal(runs.some(run => run.id === first.id), false)
  assert.ok(runs.some(run => run.id === second.id))
  assert.ok(runs.length <= 51)
})

test("unreadable active Sessions block overlap but missing Sessions do not", async t => {
  const f = await fixture(t)
  const task = await f.create()
  const run = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  const journal = f.dependencies.agents.journal
  const read = journal.read.bind(journal)
  const list = journal.list.bind(journal)
  journal.read = async id => {
    if (id === run.sessionId) throw new Error("Snapshot is unavailable")
    return read(id)
  }
  const unreadable = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(unreadable.state, "skipped")
  journal.list = async () => { throw new Error("Journal is unavailable") }
  const unavailable = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(unavailable.state, "skipped")
  journal.list = list
  f.snapshots.delete(run.sessionId!)
  const next = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(next.state, "running")
  assert.notEqual(next.sessionId, run.sessionId)
  assert.equal(f.calls.length, 4)
})

test("retried scheduled inputs track the current turn through completion", async t => {
  const f = await fixture(t)
  const task = await f.create({ trigger: { kind: "manual" } })
  const run = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  const state = f.snapshots.get(run.sessionId!)!
  const scheduledInput = state.inputs[0]!
  scheduledInput.state = "failed"
  scheduledInput.turnId = "30"
  scheduledInput.error = "Agent stopped before delivery"
  state.turns.push({ id: "30", sessionId: state.session.id, initialInputId: scheduledInput.id, dispatchCommandId: "20", runGeneration: 1,
    state: "interrupted", startedAt: "2026-10-26T00:00:00Z", endedAt: "2026-10-26T00:00:01Z", error: scheduledInput.error })
  f.emit(state.session.id)
  let result = (await f.list())[0]!.lastRun!
  assert.equal(result.state, "interrupted")
  assert.equal(result.error, scheduledInput.error)
  assert.equal(result.finishedAt, "2026-10-26T00:00:01Z")

  scheduledInput.state = "dispatching"
  scheduledInput.turnId = "31"
  scheduledInput.error = undefined
  state.turns.push({ id: "31", sessionId: state.session.id, initialInputId: scheduledInput.id, dispatchCommandId: "21", runGeneration: 2,
    state: "running", startedAt: "2026-10-26T00:01:00Z" })
  f.emit(state.session.id)
  result = (await f.list())[0]!.lastRun!
  assert.equal(result.state, "running")
  assert.equal(result.error, undefined)
  assert.equal(result.finishedAt, undefined)

  scheduledInput.state = "delivered"
  state.turns[1]!.state = "completed"
  state.turns[1]!.endedAt = "2026-10-26T00:02:00Z"
  f.emit(state.session.id)
  result = (await f.list())[0]!.lastRun!
  assert.equal(result.state, "completed")
  assert.equal(result.error, undefined)
  assert.equal(result.finishedAt, "2026-10-26T00:02:00Z")
})

test("every dispatch revalidates Team membership and failures are not retried", async t => {
  const f = await fixture(t)
  await f.create()
  f.revoke()
  f.setTime("2026-10-26T00:05:00Z")
  await f.scheduler.tick()
  await f.scheduler.tick()
  const task = (await f.list())[0]!
  assert.equal(task.lastRun?.state, "failed")
  assert.match(task.lastRun!.error!, /membership/u)
  assert.equal(task.nextRunAt, "2026-10-26T00:10:00.000Z")
  assert.equal(f.calls.length, 0)
  assert.equal(f.authorizations.length, 1)
})

test("restart skips missed deadlines and never replays a claimed dispatch", async t => {
  const f = await fixture(t)
  const task = await f.create()
  await f.scheduler.close()
  const path = join(f.directory, "scheduled-tasks.json")
  const saved = JSON.parse(await readFile(path, "utf8"))
  saved.tasks[0].runs = [{ id: "interrupted-run", state: "claimed", scheduledFor: task.nextRunAt, startedAt: task.nextRunAt, createOperationId: "create-op", inputOperationId: "input-op" }]
  await writeFile(path, JSON.stringify(saved))
  f.setTime("2026-10-27T00:00:00Z")
  const reopened = new ScheduledTasks(f.directory, f.dependencies)
  t.after(() => reopened.close())
  await reopened.init()
  await reopened.tick()
  const result = await reopened.handle("scheduleList", {}, actor) as ScheduledTask[]
  assert.equal(result[0]!.lastRun?.state, "interrupted")
  assert.equal(result[0]!.nextRunAt, "2026-10-27T00:05:00.000Z")
  assert.equal(f.calls.length, 0)
})

test("targets are scoped to an immutable Workspace and latest author owns future runs", async t => {
  const f = await fixture(t)
  await assert.rejects(f.create({ target: { kind: "existing", sessionId: "2" } }), /selected Workspace/u)
  const task = await f.create({ target: { kind: "existing", sessionId: "1" } })
  await assert.rejects(f.scheduler.handle("scheduleUpdate", { scheduleId: task.id, changes: { workspaceId: "2" } }, actor), /cannot be changed/u)
  const editor: AgentActor = { kind: "user", userId: "user-2", deviceId: "login-2" }
  await f.scheduler.handle("scheduleUpdate", { scheduleId: task.id, changes: { title: "New title" } }, editor)
  f.setTime("2026-10-26T00:05:00Z")
  await f.scheduler.tick()
  assert.deepEqual(f.authorizations, [editor])
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.method, "_deskfleet/input/submit")
  assert.equal(f.calls[0]!.params.sessionId, "1")
})

test("restart recovers a committed input receipt without resubmitting it", async t => {
  const f = await fixture(t)
  const task = await f.create()
  const run = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  await f.scheduler.close()
  const path = join(f.directory, "scheduled-tasks.json")
  const saved = JSON.parse(await readFile(path, "utf8"))
  const pending = saved.tasks[0].runs[0]
  pending.state = "claimed"
  delete pending.inputId
  f.commands.set(pending.inputOperationId, { result: { sessionId: run.sessionId, inputId: run.inputId } } as AgentCommand)
  await writeFile(path, JSON.stringify(saved))
  const reopened = new ScheduledTasks(f.directory, f.dependencies)
  t.after(() => reopened.close())
  await reopened.init()
  const recovered = await reopened.handle("scheduleList", {}, actor) as ScheduledTask[]
  assert.equal(recovered[0]!.lastRun?.inputId, run.inputId)
  assert.equal(recovered[0]!.lastRun?.state, "running")
  const next = await reopened.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(next.state, "skipped")
  assert.equal(f.calls.length, 2)
})

test("provider startup failure is visible while its pending input prevents duplicate dispatch", async t => {
  const f = await fixture(t)
  const task = await f.create()
  const run = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  const value = f.snapshots.get(run.sessionId!)!
  value.runs.push({ sessionId: run.sessionId!, generation: 1, state: "failed", startedAt: "2026-10-26T00:00:00Z", error: "Provider credentials expired" })
  f.emit(run.sessionId!)
  assert.equal((await f.list())[0]!.lastRun?.state, "failed")
  assert.match((await f.list())[0]!.lastRun!.error!, /credentials/u)
  const next = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(next.state, "skipped")
  assert.equal(f.calls.length, 2)
})

test("a lost input submission response recovers its receipt and prevents overlapping dispatch", async t => {
  const f = await fixture(t)
  const task = await f.create({ target: { kind: "existing", sessionId: "1" } })
  f.loseSubmissionResponse()
  const accepted = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(accepted.state, "running")
  assert.equal(accepted.inputId, "10")
  const next = await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(next.state, "skipped")
  assert.equal(f.calls.length, 1)
})

test("pause persists and manual runs use the requesting actor", async t => {
  const f = await fixture(t)
  const task = await f.create()
  await f.scheduler.handle("scheduleUpdate", { scheduleId: task.id, changes: { enabled: false } }, actor)
  f.setTime("2026-10-26T02:00:00Z")
  await f.scheduler.tick()
  assert.equal(f.calls.length, 0)
  assert.equal((await f.list())[0]!.nextRunAt, undefined)
  const caller: AgentActor = { kind: "user", userId: "user-3", deviceId: "login-3" }
  await f.scheduler.handle("scheduleRun", { scheduleId: task.id }, caller)
  assert.deepEqual(f.authorizations, [caller])
  await f.scheduler.handle("scheduleDelete", { scheduleId: task.id }, actor)
  assert.deepEqual(await f.list(), [])
  assert.equal(f.snapshots.size, 3, "Deleting a schedule preserves its Sessions")
})
