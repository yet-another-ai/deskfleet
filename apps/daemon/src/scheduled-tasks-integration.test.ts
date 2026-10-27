import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { openInMemoryCatalog } from "@deskfleet/native"
import { BackendAgent } from "../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor } from "./agent-protocol.ts"
import type { CatalogWorkspace } from "./catalog-protocol.ts"
import { MachineRuntime } from "./machine-runtime.ts"
import type { ScheduleRun, ScheduledTask } from "./schedule-protocol.ts"

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (ready(value)) return value
    await delay(10)
  }
  throw new Error("Timed out waiting for scheduled Session state")
}

test("machine scheduling uses real Session persistence, retains approvals, and recovers after restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-schedule-runtime-"))
  const working = join(directory, "working")
  await mkdir(working)
  const provider = new BackendAgent()
  const options = { agentQuotas: new TestAgentQuotas(), agentProvider: provider,
    peers: { create: async () => { throw new Error("Unexpected peer creation") }, close: async () => {} },
    capabilities: async () => ({ displays: [], audio: false }),
  }
  let runtime = new MachineRuntime(directory, options)
  t.after(async () => { try { await runtime.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  await runtime.init()
  const actor: AgentActor = { kind: "user", userId: "schedule-user", deviceId: "schedule-login" }
  const authorized: AgentActor[] = []
  runtime.current.central.authorizeDelegation = async value => { authorized.push(value); return value }
  const workspace = await runtime.current.operations.handle("workspaceCreate", { name: "Scheduled workspace", directories: [{ path: working }] }, actor) as CatalogWorkspace
  const task = await runtime.current.operations.handle("scheduleCreate", { schedule: {
    title: "Inspect changes", prompt: "Read yesterday's changes", workspaceId: workspace.id, enabled: true,
    target: { kind: "new", provider: "codex", context: "directory" }, trigger: { kind: "interval", minutes: 1 },
  } }, actor) as ScheduledTask
  const run = await runtime.current.operations.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(run.state, "running")
  assert.ok(run.sessionId)
  const first = await until(() => runtime.current.agents.journal.read(run.sessionId!), state => state.permissions.some(value => value.state === "pending"))
  assert.equal(first.session.title, "Inspect changes")
  assert.equal(first.session.workspaceId, workspace.id)
  assert.equal(first.inputs.length, 1)
  assert.deepEqual(first.inputs[0]!.content, [{ type: "text", text: "Read yesterday's changes" }])
  assert.deepEqual(first.inputs[0]!.author, actor)
  assert.equal(first.permissions[0]!.state, "pending", "Schedules never answer Agent permissions automatically")
  assert.equal((await runtime.current.agents.journal.list()).length, 1)
  assert.deepEqual(provider.prompts, ["Read yesterday's changes"])
  assert.deepEqual(authorized, [actor])

  t.mock.timers.enable({ apis: ["Date"], now: new Date(task.nextRunAt!) })
  await runtime.current.schedules.tick()
  const overlapping = await runtime.current.operations.handle("scheduleList", {}, actor) as ScheduledTask[]
  assert.equal(overlapping[0]!.lastRun?.state, "skipped")
  assert.equal(provider.prompts.length, 1)
  assert.equal((await runtime.current.agents.journal.list()).length, 1)
  await assert.rejects(runtime.current.operations.handle("workspaceDelete", { workspaceId: workspace.id }, actor), /scheduled tasks/u)

  await runtime.close()
  assert.equal(provider.closes, 1)
  t.mock.timers.tick(2 * 60 * 60 * 1000)
  runtime = new MachineRuntime(directory, options)
  await runtime.init()
  runtime.current.central.authorizeDelegation = async value => { authorized.push(value); return value }
  await runtime.current.schedules.tick()
  const restored = await runtime.current.operations.handle("scheduleList", {}, actor) as ScheduledTask[]
  const originalRun = restored[0]!.runs.find(value => value.id === run.id)!
  assert.ok(["failed", "interrupted"].includes(originalRun.state))
  assert.ok(Date.parse(restored[0]!.nextRunAt!) > Date.now(), "Missed occurrences advance without catch-up dispatch")
  assert.equal(provider.prompts.length, 1, "Restart does not resubmit the accepted prompt")
  const history = await runtime.current.agents.journal.read(run.sessionId!)
  assert.equal(history.inputs.length, 1)
  assert.ok(history.permissions.every(permission => permission.state !== "pending"))
  assert.equal(history.session.archiveState, "active")
})

test("Workspace deletion and scheduled task creation cannot leave a dangling target", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-schedule-workspace-"))
  const working = join(directory, "working")
  await mkdir(working)
  const runtime = new MachineRuntime(directory, { agentQuotas: new TestAgentQuotas(),
    agentProvider: new BackendAgent(), peers: { create: async () => { throw new Error("Unexpected peer creation") }, close: async () => {} },
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    capabilities: async () => ({ displays: [], audio: false }),
  })
  let releaseDeletion = () => {}
  t.after(async () => { releaseDeletion(); try { await runtime.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  await runtime.init()
  const actor: AgentActor = { kind: "user", userId: "schedule-user", deviceId: "schedule-login" }
  const { operations, catalog, schedules } = runtime.current
  const workspace = await operations.handle("workspaceCreate", { name: "To delete", directories: [{ path: working }] }, actor) as CatalogWorkspace
  let enteredDeletion = () => {}
  const entered = new Promise<void>(resolve => { enteredDeletion = resolve })
  const barrier = new Promise<void>(resolve => { releaseDeletion = resolve })
  const catalogHandle = catalog.handle.bind(catalog)
  catalog.handle = async request => {
    if (request.method === "workspaceDelete") { enteredDeletion(); await barrier }
    return catalogHandle(request)
  }
  let createEntered = false
  const scheduleHandle = schedules.handle.bind(schedules)
  schedules.handle = (method, value, who) => {
    if (method === "scheduleCreate") createEntered = true
    return scheduleHandle(method, value, who)
  }
  const deleting = operations.handle("workspaceDelete", { workspaceId: workspace.id }, actor)
  await entered
  const creating = operations.handle("scheduleCreate", { schedule: {
    title: "Must not become orphaned", prompt: "Inspect this Workspace", workspaceId: workspace.id, enabled: true,
    target: { kind: "new", provider: "codex", context: "directory" }, trigger: { kind: "manual" },
  } }, actor)
  const rejected = assert.rejects(creating, /Workspace was not found/u)
  await Promise.resolve()
  assert.equal(createEntered, false, "Target validation waits until the accepted Workspace deletion completes")
  releaseDeletion()
  await deleting
  await rejected
  assert.deepEqual(await operations.handle("scheduleList", {}, actor), [])
  assert.deepEqual((await catalog.native.snapshot()).workspaces, [])
})

test("scheduled Session creation cannot bypass Team admission capacity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-schedule-quota-"))
  const quotas = new TestAgentQuotas(); quotas.capacity = 0
  const runtime = new MachineRuntime(directory, {
    agentQuotas: quotas, agentProvider: new BackendAgent(),
    peers: { create: async () => { throw new Error("Unexpected peer creation") }, close: async () => {} },
    openCatalog: (_path, name) => openInMemoryCatalog(name),
    capabilities: async () => ({ displays: [], audio: false }),
  })
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }) })
  await runtime.init()
  runtime.current.central.authorizeDelegation = async actor => actor
  const actor: AgentActor = { kind: "user", userId: "member", deviceId: "login" }
  const workspace = await runtime.current.catalog.native.createWorkspace("Quota", [{ path: directory }])
  const task = await runtime.current.operations.handle("scheduleCreate", { schedule: {
    title: "Cannot exceed capacity", prompt: "Read the repository", enabled: true, workspaceId: workspace.id,
    target: { kind: "new", provider: "codex", context: "directory" }, trigger: { kind: "manual" },
  } }, actor) as ScheduledTask
  const run = await runtime.current.operations.handle("scheduleRun", { scheduleId: task.id }, actor) as ScheduleRun
  assert.equal(run.state, "failed")
  assert.match(run.error!, /Team Session allowance/)
  assert.equal((await runtime.current.agents.journal.list()).length, 0)
})
