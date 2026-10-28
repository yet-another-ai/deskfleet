import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { AgentConnection, AgentProvider } from "./agents/acp.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { consumedTurns, CentralAgentQuotas } from "./agent-quotas.ts"
import { AgentSessions } from "./agent-sessions.ts"
import { DaemonCatalog } from "./catalog.ts"
import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"

class QuotaProvider implements AgentProvider {
  id = "codex"
  prompts = 0
  fail = false
  barrier?: Promise<void>
  async connect(): Promise<AgentConnection> {
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, additionalDirectories: {} } } },
      newSession: async () => ({ sessionId: randomUUID() }), resume: async () => ({}),
      setConfigOption: async () => ({ configOptions: [] }),
      prompt: async () => { this.prompts++; await this.barrier; if (this.fail) throw new Error("Lost response"); return { stopReason: "end_turn" } },
      steer: async () => ({ outcome: "inactive" }), cancel: async () => {}, close: async () => {},
    }
  }
}
async function until(read: () => Promise<AgentSnapshot>, ready: (value: AgentSnapshot) => boolean): Promise<AgentSnapshot> {
  for (let i = 0; i < 500; i++) { const value = await read(); if (ready(value)) return value; await delay(10) }
  throw new Error("Quota state did not settle")
}
async function setup(t: { after(fn: () => Promise<void>): void }, quotas = new TestAgentQuotas()) {
  const directory = await mkdtemp(join(tmpdir(), "df-quota-"))
  const working = join(directory, "working"); await mkdir(working)
  const catalog = new DaemonCatalog(directory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const workspace = await catalog.native.createWorkspace("Quota", [{ path: working }])
  const provider = new QuotaProvider()
  let sessions = new AgentSessions(catalog, catalog.native, provider, undefined, undefined, undefined, quotas)
  await sessions.init()
  t.after(async () => { await sessions.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const actor = sessions.actor()
  const create = () => sessions.handle("_deskfleet/session/create", { operationId: randomUUID(), workspaceId: workspace.id, context: "directory", provider: "codex" }, actor) as Promise<AgentSnapshot>
  const source = await create()
  const read = () => sessions.journal.read(source.session.id)
  const submit = (text = "next") => sessions.handle("_deskfleet/input/submit", { operationId: randomUUID(), sessionId: source.session.id, delivery: "backlog", content: [{ type: "text", text }] }, actor)
  const transition = (action: "archive" | "restore" | "resume" | "delete", sessionId = source.session.id) => sessions.handle(`_deskfleet/session/${action}`, { operationId: randomUUID(), sessionId }, actor)
  const restart = async () => {
    await sessions.close()
    sessions = new AgentSessions(catalog, catalog.native, provider, undefined, undefined, undefined, quotas)
    await sessions.init(); await sessions.reconcileAdmissions()
  }
  return { catalog, provider, quotas, create, read, submit, transition, restart, source, get sessions() { return sessions } }
}

test("Free stops at 30 concurrent submissions, retains backlog without a loop, and manually resumes after upgrade", async t => {
  const f = await setup(t); f.quotas.limit = 30
  await Promise.all(Array.from({ length: 32 }, (_, i) => f.submit(String(i))))
  const paused = await until(f.read, value => !!value.session.turnLimitReason)
  assert.equal(consumedTurns(paused), 30)
  assert.equal(f.provider.prompts, 30)
  assert.equal(paused.inputs.filter(input => input.state === "pending").length, 2)
  const checks = f.quotas.checks
  await delay(100)
  assert.equal(f.quotas.checks, checks, "a quota pause must not retry itself")
  f.quotas.limit = null
  await delay(50)
  assert.equal(f.provider.prompts, 30, "upgrade alone must not release queued input")
  const pending = paused.inputs.find(input => input.state === "pending" && input.error)!
  await f.sessions.handle("_deskfleet/input/retry", { sessionId: f.source.session.id, inputId: pending.id, operationId: randomUUID() }, f.sessions.actor())
  const resumed = await until(f.read, value => value.inputs.every(input => input.state === "delivered"))
  assert.equal(consumedTurns(resumed), 32)
  assert.equal(resumed.session.turnLimitReason, undefined)
  await f.restart(); f.quotas.limit = 30
  await f.submit()
  assert.equal(consumedTurns(await until(f.read, value => !!value.session.turnLimitReason)), 32)
  assert.equal(f.provider.prompts, 32, "downgrades and restart preserve paid-plan usage")
})

test("pre-dispatch failures do not consume, lost provider responses do, and offline authority retains input", async t => {
  const f = await setup(t); f.quotas.limit = 30
  const prepare = f.catalog.attachments.preparePrompt.bind(f.catalog.attachments)
  f.catalog.attachments.preparePrompt = async () => { throw new Error("Attachment unavailable") }
  await f.submit()
  const failed = await until(f.read, value => value.inputs[0]?.state === "failed")
  assert.equal(consumedTurns(failed), 0); assert.equal(f.provider.prompts, 0)
  f.catalog.attachments.preparePrompt = prepare
  f.provider.fail = true
  await f.sessions.handle("_deskfleet/input/retry", { sessionId: f.source.session.id, inputId: failed.inputs[0]!.id, operationId: randomUUID() }, f.sessions.actor())
  assert.equal(consumedTurns(await until(f.read, value => value.inputs[0]?.state === "uncertain")), 1)
  f.provider.fail = false; f.quotas.available = false
  await f.submit("offline")
  const offline = await until(f.read, value => !!value.session.turnLimitReason)
  assert.equal(consumedTurns(offline), 1)
  assert.equal(offline.inputs.at(-1)?.state, "pending")
  assert.equal(f.provider.prompts, 1)
  f.quotas.available = true
  await f.submit("online")
  assert.equal(consumedTurns(await until(f.read, value => value.inputs.at(-1)?.state === "delivered")), 3)
})

test("Team capacity reserves before allocation, archive releases, restore reserves a new generation, and delete releases", async t => {
  const quotas = new TestAgentQuotas(); quotas.capacity = 3
  const f = await setup(t, quotas)
  const results = await Promise.allSettled([f.create(), f.create(), f.create()])
  assert.equal(results.filter(value => value.status === "fulfilled").length, 2)
  assert.equal((await f.sessions.journal.list()).length, 3)
  const original = f.source.session.admissionGeneration!
  await f.transition("archive")
  assert.equal(quotas.admissions.get(original)?.status, "released")
  await f.transition("restore")
  const restored = await f.read()
  assert.notEqual(restored.session.admissionGeneration, original)
  assert.equal(quotas.admissions.get(restored.session.admissionGeneration!)?.status, "committed")
  await quotas.release(original, restored.session.id)
  assert.equal((await quotas.list()).length, 3, "stale releases cannot free a restored Session")
  await f.transition("delete")
  assert.equal((await quotas.list()).length, 2)
})

test("a lost confirmation or release is reconciled from durable local outcomes, never elapsed time", async t => {
  const quotas = new TestAgentQuotas()
  const confirm = quotas.confirm.bind(quotas), release = quotas.release.bind(quotas)
  quotas.confirm = async () => { throw new Error("Offline confirmation") }
  const f = await setup(t, quotas)
  assert.equal((await quotas.list())[0]?.status, "reserved")
  quotas.confirm = confirm
  await f.sessions.reconcileAdmissions()
  assert.equal((await quotas.list())[0]?.status, "committed")
  quotas.release = async () => { throw new Error("Offline release") }
  await assert.rejects(f.transition("archive"), /Offline release/)
  assert.equal((await f.read()).session.archiveState, "archived")
  assert.equal((await quotas.list()).length, 1)
  quotas.release = release
  await f.restart()
  assert.equal((await quotas.list()).length, 0)
  await f.transition("restore")
  quotas.release = async () => { throw new Error("Offline deletion release") }
  await f.transition("delete")
  assert.equal((await quotas.list()).length, 1)
  quotas.release = release
  await f.restart()
  assert.equal((await quotas.list()).length, 0, "deleted Session receipts reconcile a lost release")
  const unknown = randomUUID()
  await quotas.reserve({ operationId: unknown, kind: "create" }); await quotas.confirm(unknown, "99999")
  await f.sessions.reconcileAdmissions()
  assert.equal(quotas.admissions.get(unknown)?.status, "committed", "unknown outcomes are not freed by a timeout or missing snapshot")
})

test("central entitlements are fetched anew and an invalid response never becomes unlimited", async () => {
  let limit: unknown = 30, calls = 0
  const authority = new CentralAgentQuotas(async (method, path) => {
    assert.equal(method, "GET"); assert.equal(path, "/api/daemon/entitlements"); calls++; return { maxTurnsPerSession: limit }
  })
  assert.equal(await authority.turnLimit(), 30)
  limit = null; assert.equal(await authority.turnLimit(), null)
  limit = undefined; await assert.rejects(authority.turnLimit(), /Invalid/)
  assert.equal(calls, 3)
})

test("admission reconciliation reads the local Session list once per pass", async t => {
  const f = await setup(t)
  await f.create(); await f.create()
  const list = f.sessions.journal.list.bind(f.sessions.journal)
  let reads = 0
  f.sessions.journal.list = async () => { reads++; return list() }
  try {
    await f.sessions.reconcileAdmissions()
    assert.equal(reads, 1)
    assert.equal((await f.quotas.list()).filter(receipt => receipt.status === "committed").length, 3)
  } finally { f.sessions.journal.list = list }
})

test("an allocation completing after the reconciliation snapshot is not cancelled by stale local absence", async t => {
  const barrier = () => {
    let resolve!: () => void
    const promise = new Promise<void>(finish => { resolve = finish })
    return { promise, resolve }
  }
  const f = await setup(t)
  const allocate = f.catalog.native.agentCreateSession.bind(f.catalog.native)
  const confirm = f.quotas.confirm.bind(f.quotas)
  const allocationEntered = barrier(), allocationContinue = barrier()
  f.catalog.native.agentCreateSession = async request => {
    allocationEntered.resolve(); await allocationContinue.promise; return allocate(request)
  }
  const creating = f.create()
  await allocationEntered.promise
  const reconciliationEntered = barrier(), reconciliationContinue = barrier()
  f.quotas.confirm = async (generation, sessionId) => {
    if (generation !== f.source.session.admissionGeneration) throw new Error("Offline allocation confirmation")
    reconciliationEntered.resolve(); await reconciliationContinue.promise; return confirm(generation, sessionId)
  }
  const reconciling = f.sessions.reconcileAdmissions()
  try {
    await reconciliationEntered.promise
    allocationContinue.resolve()
    const created = await creating
    reconciliationContinue.resolve()
    await reconciling
    assert.equal(f.quotas.admissions.get(created.session.admissionGeneration!)?.status, "reserved")
    f.quotas.confirm = confirm
    await f.sessions.reconcileAdmissions()
    assert.equal(f.quotas.admissions.get(created.session.admissionGeneration!)?.status, "committed")
  } finally {
    allocationContinue.resolve(); reconciliationContinue.resolve()
    f.catalog.native.agentCreateSession = allocate; f.quotas.confirm = confirm
    await Promise.allSettled([creating, reconciling])
  }
})

test("in-flight allocations keep capacity, confirmed allocation failures cancel, and uncertain writes reconcile", async t => {
  const f = await setup(t)
  const allocate = f.catalog.native.agentCreateSession.bind(f.catalog.native)
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  f.catalog.native.agentCreateSession = async request => { entered(); await barrier; return allocate(request) }
  const creating = f.create()
  await reached
  await f.sessions.reconcileAdmissions()
  assert.equal((await f.quotas.list()).filter(value => value.status === "reserved").length, 1)
  release(); await creating
  f.catalog.native.agentCreateSession = async () => { throw new Error("Known allocation failure") }
  await assert.rejects(f.create(), /Known allocation failure/)
  assert.equal((await f.quotas.list()).length, 2, "known local failure cancels unused capacity")
  f.catalog.native.agentCreateSession = async request => { await allocate(request); throw new Error("Lost native write response") }
  await assert.rejects(f.create(), /Lost native write response/)
  assert.equal((await f.sessions.journal.list()).length, 3)
  assert.equal((await f.quotas.list()).filter(value => value.status === "committed").length, 3)
  f.catalog.native.agentCreateSession = allocate
})
