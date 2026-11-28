import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { HttpError } from "@deskfleet/client/request-diagnostics"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { AgentProviders } from "../providers/providers.ts"
import { AgentSessions } from "../agent/sessions.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import { TestAgentQuotas } from "../fixtures/agent-quotas.ts"
import { MachineOperations } from "../machine/operations.ts"
import { ProviderSetup } from "../providers/setup.ts"
import type { SchedulePrivateEvent, ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import { ScheduledTasks } from "../schedules/scheduled-tasks.ts"
import { classifyJournalReadError } from "./follow-up-evidence.ts"
import type { FollowUpAuthReceipt, FollowUpRunsPage } from "@deskfleet/protocol/super-agent-follow-up"
import { LocalFollowUpStore, MemoryFollowUpStore } from "./follow-up-store.ts"
import { SuperFollowUpService } from "./follow-up.ts"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import type { ScheduleCommandHost } from "./schedule.ts"
import { SuperAgentService, type SuperUserState } from "./service.ts"
import { LocalSuperStore } from "./store.ts"
import { looksCleanNoRisk, type TriageModel } from "./triage.ts"
import { superWorkspaces } from "./workspaces.ts"
import { TerminalSessions } from "../terminals/terminals.ts"

const userA: AgentActor = { kind: "user", userId: "user-a", deviceId: "login-a" }

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    assert.ok(Date.now() < deadline, "Timed out waiting for expected state")
    await delay(15)
  }
}

function makeBackend(replyFor: (prompt: string) => { text?: string; error?: string }) {
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
        const plan = replyFor(promptText)
        if (plan.error) throw new Error(plan.error)
        if (plan.text && plan.text.length > 0) {
          await client.onUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: plan.text } },
          })
        }
        return { stopReason: "end_turn" }
      },
    }
  }
  return backend
}

interface HarnessOptions {
  backend?: BackendAgent
  scheduleAuthorize?: (actor: AgentActor) => Promise<AgentActor>
  followUpAuthorize?: (actor: AgentActor) => Promise<AgentActor>
  triageModel?: (userId: string) => TriageModel | undefined
  /** When true, mimics production `machine-runtime.ts` order (`followUpStore.init()` before `ScheduledTasks`). */
  productionInitOrder?: boolean
  retryBaseMs?: number
  retryMaxMs?: number
}

async function openHarness(directory: string, options: HarnessOptions = {}) {
  const catalog = new DaemonCatalog(directory)
  await catalog.init()
  const backend = options.backend ?? new BackendAgent()
  const providers = new AgentProviders(directory, backend)
  await providers.init()
  const quotas = new TestAgentQuotas()
  const agents = new AgentSessions(catalog, catalog.native, backend, providers, undefined, undefined, quotas)
  await agents.init()
  const terminals = new TerminalSessions({ directory: join(directory, "terminals") })
  await terminals.init()
  const setup = new ProviderSetup(terminals, { directory })
  const scheduleAuth = options.scheduleAuthorize ?? (async actor => actor)
  const followUpAuth = options.followUpAuthorize ?? scheduleAuth
  const superStore = new LocalSuperStore<SuperUserState>(catalog.native)
  await superStore.init()
  const followUpStore = new LocalFollowUpStore(catalog.native)
  let schedules: ScheduledTasks
  if (options.productionInitOrder) {
    await followUpStore.init()
    schedules = new ScheduledTasks(directory, {
      agents, catalog, providers, authorize: scheduleAuth,
      isSubscribed: scheduleId => followUpStore.listSources().some(src =>
        src.sourceKind === "schedule"
        && src.sourceId === scheduleId
        && src.state.enabled
        && !src.state.pausedReason
        && (() => {
          const auth = followUpStore.getAuth(src.userId)
          return !!auth && !auth.globalDisabled && Object.values(auth.grants).some(g => g.enabled)
        })()),
    })
    await schedules.init()
  } else {
    schedules = new ScheduledTasks(directory, { agents, catalog, providers, authorize: scheduleAuth })
    await schedules.init()
  }
  const operations = new MachineOperations({ agents, catalog, providers, terminals, setup, schedules, capabilities: async () => ({ displays: [], audio: false }) })
  const ws = superWorkspaces(catalog, directory)
  const followUp = new SuperFollowUpService({
    followUpStore, superStore, agents, schedules, authorize: followUpAuth,
    workspaces: ws.workspaces,
    triageModel: options.triageModel,
    retryBaseMs: options.retryBaseMs ?? 40,
    retryMaxMs: options.retryMaxMs ?? 200,
  })
  const scheduleHost: ScheduleCommandHost = {
    handleSchedule: (method, params, actor) => operations.handle(method, params, actor),
    listSchedules: () => schedules.snapshot(),
    subscribeSchedule: params => followUp.subscribeSchedule(params).then(() => {}),
    isFollowUpAuthorized: uid => followUp.isAuthorized(uid),
    getScheduleSubscription: (uid, wid, sid) => followUp.getScheduleSubscription(uid, wid, sid),
    listScheduleRuns: async (uid, wid, sid, limit) => (await followUp.listRuns({ userId: uid, workspaceId: wid, sourceKind: "schedule", sourceId: sid, limit })).runs,
  }
  const frontDesk = new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "machine-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => (async () => ({ reason: "default", actions: [{ kind: "answer", text: "ok" }] })),
    agents, store: superStore, followUp, schedules: scheduleHost, authorize: followUpAuth,
    providers: () => providers.metadata().providers, ...ws,
  })
  await followUp.init()
  await frontDesk.init()
  return {
    catalog, providers, agents, schedules, operations, superStore, followUpStore, followUp, frontDesk,
    enableAuth: (actor: AgentActor, installationId: string) =>
      frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "enable", installationId, deviceLabel: installationId, takeoverAllSessions: true }, actor) as Promise<FollowUpAuthReceipt>,
    disableAuth: (actor: AgentActor, installationId: string) =>
      frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "disable", installationId }, actor) as Promise<FollowUpAuthReceipt>,
    async close() {
      await followUp.close()
      await frontDesk.close()
      await schedules.close()
      await agents.close()
      await terminals.close()
      await catalog.close()
    },
  }
}

// ============================================================================
// 14 · P1 (Daemon): Unknown/classic disable is strictly idempotent (no authVersion bump),
// and a genuine authVersion bump mid-triage while another device stays authorized STILL delivers
// the Mac daily report once; revoking the last authorized device stops delivery!
// ============================================================================
test("R2 14-P1 daemon: idempotent disable does not bump authVersion and concurrent non-last device revocation never drops an authorized Mac daily report", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r2-14-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  let triageEntered!: () => void
  let releaseTriage!: () => void
  let pauseNextTriage = false

  const h = await openHarness(dir, {
    backend: makeBackend(() => ({ text: "Daily Risk Digest: 4 commits audited, 1 slow query in billing.ts" })),
    triageModel: () => async (input, signal) => {
      if (pauseNextTriage) {
        pauseNextTriage = false
        triageEntered()
        await new Promise<void>(resolve => {
          const onAbort = () => resolve()
          signal?.addEventListener("abort", onAbort, { once: true })
          releaseTriage = () => { signal?.removeEventListener("abort", onAbort); resolve() }
        })
        if (signal?.aborted) throw new Error("Aborted")
      }
      return { kind: "notify", summary: `${input.sourceTitle}: ${input.outputText}`, reason: "every_run" }
    },
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("DailyDigest", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id

  // 1. Authorize Mac (authVersion = 1). A classic device that never enabled SA calls disable -> unchanged, authVersion stays 1!
  const macOn = await h.enableAuth(userA, "inst-mac")
  assert.equal(macOn.authVersion, 1)
  assert.equal(macOn.activeDeviceCount, 1)

  const classicDisable = await h.disableAuth(userA, "inst-classic-never-enabled")
  assert.equal(classicDisable.status, "unchanged")
  assert.equal(classicDisable.authVersion, 1, "Unknown installationId disable must NOT bump authVersion")
  assert.equal(classicDisable.authorized, true)
  assert.equal(classicDisable.activeDeviceCount, 1)
  assert.equal(classicDisable.summary.devices.some(d => d.installationId === "inst-classic-never-enabled"), false)

  // 2. Also authorize iPhone (activeDeviceCount = 2, authVersion = 2), create & subscribe Daily Risk Digest
  const iphoneOn = await h.enableAuth(userA, "inst-iphone")
  assert.equal(iphoneOn.authVersion, 2)
  assert.equal(iphoneOn.activeDeviceCount, 2)

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Daily Risk Digest",
      prompt: "Generate daily digest",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // 3. Trigger Run 1; pause inside triage; while in flight, iPhone disables itself (authVersion 2 -> 3, Mac STILL authorized!)
  pauseNextTriage = true
  const entered1 = new Promise<void>(resolve => { triageEntered = resolve })
  const run1 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await entered1

  const iphoneOff = await h.disableAuth(userA, "inst-iphone")
  assert.equal(iphoneOff.status, "applied")
  assert.equal(iphoneOff.authVersion, 3)
  assert.equal(iphoneOff.authorized, true, "Mac remains authorized")
  assert.equal(iphoneOff.activeDeviceCount, 1)

  // Release triage -> Daily Risk Digest MUST STILL deliver its full body ONCE!
  releaseTriage()
  const snap1 = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.provenance?.runId === run1.id),
  )
  const delivered1 = snap1.messages.filter(m => m.provenance?.runId === run1.id)
  assert.equal(delivered1.length, 1)
  assert.match(delivered1[0]!.text, /1 slow query in billing\.ts/)

  // 4. Contrast: Trigger Run 2; pause inside triage; now LAST authorized device (Mac) revokes -> NO message delivered!
  pauseNextTriage = true
  const entered2 = new Promise<void>(resolve => { triageEntered = resolve })
  const run2 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await entered2

  const macOff = await h.disableAuth(userA, "inst-mac")
  assert.equal(macOff.authorized, false)
  assert.equal(macOff.activeDeviceCount, 0)
  assert.equal(macOff.stoppedAllBackground, true)
  releaseTriage()
  await delay(100)
  await h.followUp.drainScheduleEvents()

  const snap2 = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap2.messages.filter(m => m.provenance?.runId === run2.id).length, 0, "Revoking the last device must stop delivery")
  assert.equal(snap2.messages.length, 1)
})

// ============================================================================
// 12 · P1: Daemon restarts after `claimed` and before Worker receipt ->
// native run becomes `interrupted`, SA history matches `interrupted`, main chat gets
// EXACTLY ONE interruption notice (even across two consecutive restarts and both init orders)!
// ============================================================================
for (const productionInitOrder of [true, false]) {
  test(`R2 12-P1: restart after claimed before Worker receipt reconciles SA history to interrupted and notifies once (productionInitOrder=${productionInitOrder})`, async t => {
    const dir = await mkdtemp(join(tmpdir(), `deskfleet-r2-12-${productionInitOrder ? "prod" : "reconcile"}-`))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const project = join(dir, "repo")
    await mkdir(project, { recursive: true })

    // Phase 1: Create schedule, enable SA & subscribe, then close cleanly.
    const h1 = await openHarness(dir, { productionInitOrder })
    const wsId = (await h1.catalog.native.createWorkspace("CrashRecovery", [{ path: project }])).id
    const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
    await h1.enableAuth(userA, "inst-mac")

    const task = await h1.operations.handle("scheduleCreate", {
      schedule: {
        title: "Nightly Build",
        prompt: "Run nightly build",
        workspaceId: wsId,
        enabled: true,
        target: { kind: "new", provider, context: "directory" },
        trigger: { kind: "manual" },
      },
    }, userA) as ScheduledTask
    await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
      workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
    }, userA)
    await h1.close()

    // Phase 2: Inject a crashed `claimed` run (NO sessionId, NO inputId = before Worker receipt!) into scheduled-tasks.json.
    const scheduleFile = join(dir, "scheduled-tasks.json")
    const saved = JSON.parse(await readFile(scheduleFile, "utf8")) as {
      tasks: Array<{ id: string; runs: Array<Record<string, unknown>> }>
      pendingEvents?: SchedulePrivateEvent[]
    }
    const crashedRunId = randomUUID()
    const crashedAt = new Date(Date.now() + 1_000).toISOString()
    const targetTask = saved.tasks.find(item => item.id === task.id)!
    targetTask.runs.unshift({
      id: crashedRunId,
      state: "claimed",
      scheduledFor: crashedAt,
      startedAt: crashedAt,
      createOperationId: randomUUID(),
      inputOperationId: randomUUID(),
      ownerUserId: userA.userId,
      scheduleVersion: 1,
    })
    await writeFile(scheduleFile, JSON.stringify(saved, null, 2))

    // Phase 3: First restart after crash -> native `interrupted`, SA history `interrupted`, main chat gets EXACTLY 1 notice!
    const h2 = await openHarness(dir, { productionInitOrder })
    try {
      const nativeTask = h2.schedules.snapshot().find(item => item.id === task.id)!
      const nativeRun = nativeTask.runs.find(r => r.id === crashedRunId)!
      assert.equal(nativeRun.state, "interrupted", "Native ScheduledTasks must mark crashed claimed run as interrupted")

      const snapAfterRestart1 = await eventually(
        () => h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
        s => s.messages.some(m => m.provenance?.runId === crashedRunId),
      )
      const notices1 = snapAfterRestart1.messages.filter(m => m.provenance?.runId === crashedRunId)
      assert.equal(notices1.length, 1, "Main chat must receive exactly one interruption notification")
      assert.match(notices1[0]!.text, /Nightly Build/i)
      assert.match(notices1[0]!.text, /interrupt/i)

      const saRuns1 = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
        workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
      }, userA) as FollowUpRunsPage
      const saRun1 = saRuns1.runs.find(r => r.runId === crashedRunId)!
      assert.equal(saRun1.status, "interrupted", "SA history must agree with native interrupted status")
      assert.equal(saRun1.delivered, true)
      assert.equal(h2.schedules.pendingPrivateEvents().length, 0)
    } finally {
      await h2.close()
    }

    // Phase 4: Consecutive SECOND restart -> ZERO duplicate notices, history stays interrupted!
    const h3 = await openHarness(dir, { productionInitOrder })
    try {
      await h3.followUp.drainScheduleEvents()
      await delay(80)
      const snapAfterRestart2 = await h3.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
      assert.equal(snapAfterRestart2.messages.filter(m => m.provenance?.runId === crashedRunId).length, 1, "Second restart must NOT duplicate interruption notice")
      const saRuns2 = await h3.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
        workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
      }, userA) as FollowUpRunsPage
      assert.equal(saRuns2.runs.find(r => r.runId === crashedRunId)?.status, "interrupted")
      assert.equal(h3.schedules.pendingPrivateEvents().length, 0)
    } finally {
      await h3.close()
    }
  })
}

// ============================================================================
// 11 · P1: Earlier `run_started` hits 503 and retries AFTER `run_finished` already
// delivered `completed` -> MUST NOT downgrade status, clear `delivered`, wipe summary/messageId,
// or duplicate delivery!
// ============================================================================
test("R2 11-P1: late run_started retrying after run_finished never downgrades delivered completed history or duplicates delivery", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r2-11-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  // Also directly verify monotonic run-state guard on MemoryFollowUpStore!
  const mem = new MemoryFollowUpStore()
  await mem.upsertRun({
    userId: "u1", workspaceId: "ws1", sourceKind: "schedule", sourceId: "s1", runKey: "run:r1",
    scheduleId: "s1", scheduleTitle: "Digest", runId: "r1", sessionId: "sess-1", turnId: "turn-1",
    startedAt: "2026-11-23T00:00:00Z", finishedAt: "2026-11-23T00:01:00Z",
    status: "completed", delivered: true, deliveredMessageId: "msg-1",
    summary: "Full completed digest body", evidenceAvailability: "available",
    evidenceRefs: { sessionId: "sess-1", turnId: "turn-1" },
    createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:01:00Z",
  })
  await mem.upsertRun({
    userId: "u1", workspaceId: "ws1", sourceKind: "schedule", sourceId: "s1", runKey: "run:r1",
    scheduleId: "s1", scheduleTitle: "Digest", runId: "r1",
    startedAt: "2026-11-23T00:00:00Z", status: "claimed", delivered: false,
    summary: 'Running scheduled task "Digest"', evidenceAvailability: "restricted",
    createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:02:00Z",
  })
  const memRecord = await mem.getRun("u1", "ws1", "schedule", "s1", "run:r1")
  assert.equal(memRecord?.status, "completed")
  assert.equal(memRecord?.delivered, true)
  assert.equal(memRecord?.deliveredMessageId, "msg-1")
  assert.equal(memRecord?.summary, "Full completed digest body")

  // End-to-end daemon test:
  // 1) Initial `run_started` (`claimed`) hits transient 503 on follow-up authorize.
  // 2) `authorize` recovers -> `run_finished` (`completed`) delivers full report once.
  // 3) Restart/replay stale `run_started` (`claimed`), late `run_started` (`running`), and duplicate `run_finished` (`completed`).
  let failFirstRunStartedAuth = true
  const h1 = await openHarness(dir, {
    productionInitOrder: true,
    backend: makeBackend(() => ({ text: "Morning Digest: 3 PRs merged, latency p99 120ms" })),
    followUpAuthorize: async actor => {
      if (actor.deviceId === "follow-up-delegation" && failFirstRunStartedAuth) {
        failFirstRunStartedAuth = false
        throw new HttpError(503, "Service Unavailable")
      }
      return actor
    },
  })
  const wsId = (await h1.catalog.native.createWorkspace("OutOfOrder", [{ path: project }])).id
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h1.enableAuth(userA, "inst-mac")
  const task = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "Morning Digest",
      prompt: "Summarize morning metrics",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  const run = await h1.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const snap1 = await eventually(async () => {
    await h1.followUp.drainScheduleEvents()
    return h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === run.id))

  const runsBeforeReplay = await h1.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  const completedRecord = runsBeforeReplay.runs.find(r => r.runId === run.id)!
  assert.equal(completedRecord.status, "completed")
  assert.equal(completedRecord.delivered, true)
  assert.ok(completedRecord.deliveredMessageId)
  assert.match(completedRecord.summary, /latency p99 120ms/)
  assert.equal(snap1.messages.filter(m => m.provenance?.runId === run.id).length, 1)
  await h1.close()

  // Inject late retried `run_started` (`claimed`), `run_started` (`running`), and duplicate `run_finished` into pendingEvents on disk!
  const scheduleFile = join(dir, "scheduled-tasks.json")
  const saved = JSON.parse(await readFile(scheduleFile, "utf8")) as { pendingEvents?: SchedulePrivateEvent[] }
  const lateBase = {
    scheduleId: task.id,
    scheduleTitle: task.title,
    scheduleVersion: 1,
    workspaceId: wsId,
    targetKind: "directory" as const,
    ownerUserId: userA.userId!,
    runId: run.id,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    createdAt: new Date().toISOString(),
  }
  saved.pendingEvents = [
    { ...lateBase, id: `late-claimed-${randomUUID()}`, kind: "run_started", runState: "claimed" },
    { ...lateBase, id: `late-running-${randomUUID()}`, kind: "run_started", runState: "running", sessionId: completedRecord.sessionId, inputId: completedRecord.inputId },
    { ...lateBase, id: `dup-finished-${randomUUID()}`, kind: "run_finished", runState: "completed", sessionId: completedRecord.sessionId, inputId: completedRecord.inputId, finishedAt: completedRecord.finishedAt },
  ]
  await writeFile(scheduleFile, JSON.stringify(saved, null, 2))

  // Reopen & drain -> stale events are cleanly acked WITHOUT downgrading state or duplicating delivery!
  const h2 = await openHarness(dir, { productionInitOrder: true })
  try {
    await h2.followUp.drainScheduleEvents()
    assert.equal(h2.schedules.pendingPrivateEvents().length, 0, "Stale/duplicate events must drain cleanly")

    const runsAfterReplay = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
      workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
    }, userA) as FollowUpRunsPage
    const recordAfter = runsAfterReplay.runs.find(r => r.runId === run.id)!
    assert.equal(recordAfter.status, "completed", "Late run_started must NEVER downgrade completed status")
    assert.equal(recordAfter.delivered, true, "Late run_started must NEVER clear delivered flag")
    assert.equal(recordAfter.deliveredMessageId, completedRecord.deliveredMessageId, "deliveredMessageId must be preserved")
    assert.equal(recordAfter.summary, completedRecord.summary, "Completed summary must be preserved")
    assert.deepEqual(recordAfter.evidenceRefs, completedRecord.evidenceRefs, "evidenceRefs must be preserved")

    const snap2 = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
    assert.equal(snap2.messages.filter(m => m.provenance?.runId === run.id).length, 1, "Zero duplicate deliveries allowed")
  } finally {
    await h2.close()
  }
})

// ============================================================================
// 13 · P1: Transient DB error (SQLITE_BUSY / database is locked) during journal read
// MUST NOT be misclassified as deleted or empty output and MUST NOT mark `delivered: true`;
// on recovery delivers the full report ONCE. Contrast with confirmed deleted session & genuine empty turn.
// ============================================================================
test("R2 13-P1: transient SQLITE_BUSY defers delivery without fabricating empty/deleted output and delivers full report once on recovery", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r2-13-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  // Unit check of error classifier
  assert.equal(classifyJournalReadError(Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" })), "transient")
  assert.equal(classifyJournalReadError(new Error("SQLITE_LOCKED: table is locked")), "transient")
  assert.equal(classifyJournalReadError(new Error("Agent Session was not found.")), "not_found")
  assert.equal(classifyJournalReadError(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })), "not_found")

  let replyMode: "full" | "empty" = "full"
  let holdFollowUpAuth: Promise<void> | undefined
  let releaseFollowUpAuth: (() => void) | undefined
  const pauseFollowUp = () => {
    holdFollowUpAuth = new Promise<void>(resolve => { releaseFollowUpAuth = resolve })
  }
  const resumeFollowUp = () => {
    const release = releaseFollowUpAuth
    holdFollowUpAuth = undefined
    releaseFollowUpAuth = undefined
    release?.()
  }

  const h = await openHarness(dir, {
    productionInitOrder: true,
    retryBaseMs: 60_000, // Keep retry manual so we can assert exact pre-recovery state deterministically!
    retryMaxMs: 60_000,
    followUpAuthorize: async actor => {
      if (actor.deviceId === "follow-up-delegation" && holdFollowUpAuth) {
        await holdFollowUpAuth
      }
      return actor
    },
    backend: makeBackend(() => replyMode === "full"
      ? { text: "Evening Summary: deployed v2.4.1 with zero regressions" }
      : { text: "" }),
  })
  t.after(async () => { resumeFollowUp(); await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("DbTransient", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Evening Summary",
      prompt: "Summarize evening release",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // Wrap journal.read & journal.history to inject SQLITE_BUSY for run1's session ONLY when fault is active!
  let busyOnRead = false
  let busyOnHistory = false
  let forceDeletedForSession: string | undefined
  const origRead = h.agents.journal.read.bind(h.agents.journal)
  const origHistory = h.agents.journal.history.bind(h.agents.journal)
  const origList = h.agents.journal.list.bind(h.agents.journal)
  h.agents.journal.read = async sessionId => {
    if (forceDeletedForSession && sessionId === forceDeletedForSession) {
      throw new Error("Agent Session was not found.")
    }
    if (busyOnRead) {
      throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" })
    }
    return origRead(sessionId)
  }
  h.agents.journal.list = async () => {
    const items = await origList()
    return forceDeletedForSession ? items.filter(s => s.id !== forceDeletedForSession) : items
  }
  h.agents.journal.history = async (sessionId, afterSeq, limit) => {
    if (busyOnHistory) {
      throw new Error("database is locked")
    }
    return origHistory(sessionId, afterSeq, limit)
  }

  // Case A: Hold follow-up drain gate while Run 1 finishes in Worker so real `run_finished` is queued in pendingEvents!
  pauseFollowUp()
  const run1 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(
    () => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => Boolean(list[0]?.runs.some(r => r.id === run1.id && r.state === "completed")),
  )
  await eventually(
    () => Promise.resolve(h.schedules.pendingPrivateEvents()),
    events => events.some(e => e.runId === run1.id && e.kind === "run_finished"),
  )

  // Attempt 1: journal.read throws SQLITE_BUSY
  busyOnRead = true
  resumeFollowUp()
  await h.followUp.drainScheduleEvents()
  assert.ok(h.schedules.pendingPrivateEvents().some(e => e.runId === run1.id && e.kind === "run_finished"), "run_finished must stay pending during SQLITE_BUSY on read")
  let snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0, "Must NOT deliver fake empty/deleted message during SQLITE_BUSY on read")
  let runs = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(runs.runs.find(r => r.runId === run1.id && r.delivered), undefined, "Must NOT mark run delivered during SQLITE_BUSY")
  assert.equal(runs.runs.find(r => r.runId === run1.id && r.evidenceAvailability === "deleted"), undefined, "Must NOT misclassify SQLITE_BUSY as deleted")

  // Attempt 2: journal.read succeeds, journal.history throws "database is locked"
  busyOnRead = false
  busyOnHistory = true
  await h.followUp.drainScheduleEvents()
  assert.ok(h.schedules.pendingPrivateEvents().some(e => e.runId === run1.id && e.kind === "run_finished"), "run_finished must stay pending during database-locked history read")
  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0, "Must NOT deliver fake empty output during database-locked history read")

  // Recovery: clear fault -> delivers COMPLETE report body ONCE!
  busyOnHistory = false
  h.followUp.notifyAuthorizeRecovered()
  snap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.provenance?.runId === run1.id),
  )
  await h.followUp.drainScheduleEvents()
  const msgs1 = snap.messages.filter(m => m.provenance?.runId === run1.id)
  assert.equal(msgs1.length, 1)
  assert.match(msgs1[0]!.text, /deployed v2\.4\.1 with zero regressions/)
  runs = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  const run1Record = runs.runs.find(r => r.runId === run1.id)!
  assert.equal(run1Record.status, "completed")
  assert.equal(run1Record.delivered, true)
  assert.equal(run1Record.evidenceAvailability, "available")
  assert.equal(h.schedules.pendingPrivateEvents().length, 0)

  // Case B (Contrast): Confirmed deleted session -> evidenceAvailability = "deleted" and clear deleted notice (NOT "no text output")!
  pauseFollowUp()
  const run2 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const completedList2 = await eventually(
    () => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => Boolean(list[0]?.runs.some(r => r.id === run2.id && r.state === "completed")),
  )
  await eventually(
    () => Promise.resolve(h.schedules.pendingPrivateEvents()),
    events => events.some(e => e.runId === run2.id && e.kind === "run_finished"),
  )
  forceDeletedForSession = completedList2[0]!.runs.find(r => r.id === run2.id)!.sessionId!
  resumeFollowUp()
  snap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.provenance?.runId === run2.id),
  )
  await h.followUp.drainScheduleEvents()
  const msg2 = snap.messages.find(m => m.provenance?.runId === run2.id)!
  assert.match(msg2.text, /session was deleted.*no longer available/i)
  assert.doesNotMatch(msg2.text, /no text output/i)
  runs = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(runs.runs.find(r => r.runId === run2.id)?.evidenceAvailability, "deleted")
  const persistedRun2 = await h.followUpStore.getRun(userA.userId!, wsId, "schedule", task.id, `run:${run2.id}`)
  assert.equal(persistedRun2?.evidenceAvailability, "deleted")
  forceDeletedForSession = undefined

  // Case C (Contrast): Genuinely empty assistant output -> evidenceAvailability = "available" and "no text output" notice!
  replyMode = "empty"
  const run3 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  snap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.provenance?.runId === run3.id),
  )
  await h.followUp.drainScheduleEvents()
  const msg3 = snap.messages.find(m => m.provenance?.runId === run3.id)!
  assert.match(msg3.text, /no text output/i)
  runs = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(runs.runs.find(r => r.runId === run3.id)?.evidenceAvailability, "available")
})

// ============================================================================
// 9 · P2: `exceptions_only` MUST stay quiet on clean/negated reports ("无风险",
// "无异常", "No risks", "0 errors") while delivering real anomalies, mixed contrast
// reports, and failed runs!
// ============================================================================
test("R2 9-P2: exceptions_only stays quiet on negated clean reports while delivering real anomalies, mixed contrast reports, and failures", async t => {
  // 1. Direct unit assertions on looksCleanNoRisk
  for (const clean of [
    "昨日提交已巡检，无风险，无异常，一切正常。",
    "巡检完成：昨日无新提交，风险：无，异常：无。",
    "未发现风险，没有异常，暂无问题。",
    "Daily patrol complete. No risks found, 0 errors, 0 warnings.",
    "No anomalies or regressions detected. All clear.",
    "問題なし、リスクなし",
  ]) {
    assert.equal(looksCleanNoRisk(clean), true, `Expected clean/quiet for: ${clean}`)
  }
  for (const anomalous of [
    "昨日无异常，今日出现回归：支付接口 500。",
    "No errors, but 1 regression warning in billing.ts",
    "发现 1 个高危风险：鉴权绕过",
    "Warning: disk usage at 95%",
    "3 tests failed in checkout module",
    "Error: connection refused to postgres",
  ]) {
    assert.equal(looksCleanNoRisk(anomalous), false, `Expected anomaly delivery for: ${anomalous}`)
  }

  // 2. End-to-end `exceptions_only` scheduled task runs
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r2-9-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const scriptedReplies: Array<{ text?: string; error?: string }> = [
    { text: "昨日提交已巡检，无风险，无异常，一切正常。" },
    { text: "Daily check finished: No risks, 0 errors, 0 warnings." },
    { text: "昨日无异常，今日出现 1 个回归：支付回调超时。" },
    { text: "发现 1 个异常风险：数据库连接池耗尽。" },
    { error: "Worker crashed with exit code 1 (despite 无风险 in log)" },
  ]
  let idx = 0

  const h = await openHarness(dir, {
    productionInitOrder: true,
    backend: makeBackend(() => scriptedReplies[idx++] ?? { text: "ok" }),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("PatrolNoise", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Risk Patrol",
      prompt: "Audit commits for risks",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "exceptions_only",
  }, userA)

  const runAndWaitHistory = async () => {
    const run = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
    await eventually(async () => {
      await h.followUp.drainScheduleEvents()
      const page = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
        workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
      }, userA) as FollowUpRunsPage
      return page.runs.find(r => r.runId === run.id && (r.status === "completed" || r.status === "failed" || r.status === "interrupted"))
    }, Boolean)
    return run
  }

  // Run 1 & Run 2: clean negated reports -> recorded in history (`delivered: false`), ZERO main chat messages!
  const cleanZh = await runAndWaitHistory()
  const cleanEn = await runAndWaitHistory()
  let snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0, "Clean negated Chinese & English reports must remain quiet under exceptions_only")

  // Run 3: mixed contrast report -> DELIVERED!
  const mixedRun = await runAndWaitHistory()
  // Run 4: real anomaly report -> DELIVERED!
  const realRiskRun = await runAndWaitHistory()
  // Run 5: failed run -> DELIVERED!
  const failedRun = await runAndWaitHistory()

  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 3, "Mixed contrast, real anomaly, and failed run must all be delivered")
  assert.ok(snap.messages.some(m => m.provenance?.runId === mixedRun.id && m.text.includes("支付回调超时")))
  assert.ok(snap.messages.some(m => m.provenance?.runId === realRiskRun.id && m.text.includes("数据库连接池耗尽")))
  assert.ok(snap.messages.some(m => m.provenance?.runId === failedRun.id))

  const history = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(history.runs.find(r => r.runId === cleanZh.id)?.delivered, false)
  assert.equal(history.runs.find(r => r.runId === cleanEn.id)?.delivered, false)
  assert.equal(history.runs.find(r => r.runId === mixedRun.id)?.delivered, true)
  assert.equal(history.runs.find(r => r.runId === realRiskRun.id)?.delivered, true)
  assert.equal(history.runs.find(r => r.runId === failedRun.id)?.delivered, true)
})
