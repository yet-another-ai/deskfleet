import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { AgentProviders } from "../providers/providers.ts"
import { AgentSessions } from "../agent/sessions.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import { TestAgentQuotas } from "../fixtures/agent-quotas.ts"
import { MachineOperations } from "../machine/operations.ts"
import { ProviderSetup } from "../providers/setup.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import { ScheduledTasks } from "../schedules/scheduled-tasks.ts"
import type { FollowUpAuthReceipt, FollowUpRunsPage } from "@deskfleet/protocol/super-agent-follow-up"
import { LocalFollowUpStore } from "./follow-up-store.ts"
import { SuperFollowUpService } from "./follow-up.ts"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import type { ScheduleCommandHost } from "./schedule.ts"
import { SuperAgentService, type SuperUserState } from "./service.ts"
import { LocalSuperStore } from "./store.ts"
import { looksCleanNoRisk, type TriageModel } from "./triage.ts"
import { superWorkspaces } from "./workspaces.ts"
import { TerminalSessions } from "../terminals/terminals.ts"

const userA: AgentActor = { kind: "user", userId: "user-a", deviceId: "login-a" }
const userClassic: AgentActor = { kind: "user", userId: "user-classic", deviceId: "login-classic" }

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    assert.ok(Date.now() < deadline, "Timed out waiting for expected state")
    await delay(15)
  }
}

interface ScriptedChunk {
  text: string
  phase?: "commentary" | "partial_answer" | "final_answer"
  purpose?: "ack" | "activity" | "milestone" | "final_answer"
  messageId?: string
}

interface ScriptedPlan {
  chunks?: ScriptedChunk[]
  text?: string
  waitFor?: () => Promise<void>
  onStarted?: () => void
}

function makeRichBackend(planFor: (prompt: string) => ScriptedPlan) {
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
        const plan = planFor(promptText)
        plan.onStarted?.()
        if (plan.waitFor) await plan.waitFor()
        if (plan.chunks) {
          for (const chunk of plan.chunks) {
            const deskfleetMeta: Record<string, unknown> = {}
            if (chunk.phase) deskfleetMeta.phase = chunk.phase
            if (chunk.purpose) deskfleetMeta.purpose = chunk.purpose
            if (chunk.messageId) deskfleetMeta.messageId = chunk.messageId
            await client.onUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: chunk.text },
                ...(Object.keys(deskfleetMeta).length ? { _meta: { deskfleet: deskfleetMeta } } : {}),
              },
            })
          }
        } else if (plan.text !== undefined && plan.text.length > 0) {
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

async function openHarness(directory: string, options: {
  backend?: BackendAgent
  triageModel?: (userId: string) => TriageModel | undefined
  followUpAuthorize?: (actor: AgentActor) => Promise<AgentActor>
  now?: () => Date
  retryBaseMs?: number
  retryMaxMs?: number
} = {}) {
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
  const scheduleAuth = async (actor: AgentActor) => actor
  const followUpAuth = options.followUpAuthorize ?? scheduleAuth
  const superStore = new LocalSuperStore<SuperUserState>(catalog.native)
  await superStore.init()
  const followUpStore = new LocalFollowUpStore(catalog.native)
  await followUpStore.init()
  const schedules = new ScheduledTasks(directory, {
    agents, catalog, providers, authorize: scheduleAuth, now: options.now,
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
  const operations = new MachineOperations({ agents, catalog, providers, terminals, setup, schedules, capabilities: async () => ({ displays: [], audio: false }) })
  const ws = superWorkspaces(catalog, directory)
  const followUp = new SuperFollowUpService({
    followUpStore, superStore, agents, schedules, authorize: followUpAuth,
    workspaces: ws.workspaces,
    triageModel: options.triageModel,
    now: options.now,
    retryBaseMs: options.retryBaseMs ?? 60_000,
    retryMaxMs: options.retryMaxMs ?? 60_000,
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
// 24 · P1:
// 1. 日报在暂停前已完成、因 SQLITE_BUSY 待投递 -> 暂停再重开 -> 恢复读取后收到完整日报 1 条，
//    SA 历史归为暂停前完成且 delivered=true；
// 2. 暂停期间完成的旧日报仍不补发；
// 3. 首次订阅前原生计划已有旧 interrupted 记录 -> 首次订阅后不误写入 SA 历史。
// ============================================================================
test("R4 24-P1: pre-pause completed run deferred by SQLITE_BUSY still delivers after pause/re-enable, while paused-period runs stay quiet and first-time subscribe ignores prior interruptions", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r4-24-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  let holdFollowUpAuth: Promise<void> | undefined
  let releaseFollowUpAuth: (() => void) | undefined
  const pauseGate = () => { holdFollowUpAuth = new Promise<void>(resolve => { releaseFollowUpAuth = resolve }) }
  const resumeGate = () => {
    const rel = releaseFollowUpAuth
    holdFollowUpAuth = undefined
    releaseFollowUpAuth = undefined
    rel?.()
  }

  let runIdx = 0
  let releasePausedWorker: (() => void) | undefined
  let pausedWorkerStarted: (() => void) | undefined
  const plans: ScriptedPlan[] = [
    { text: "暂停前已完成日报：全站可用率 99.98%，核心指标正常。" },
    {
      text: "暂停期间完成的旧日报：绝不应补发。",
      onStarted: () => pausedWorkerStarted?.(),
      waitFor: () => new Promise<void>(resolve => { releasePausedWorker = resolve }),
    },
  ]

  let activeHarness: Awaited<ReturnType<typeof openHarness>> | undefined
  t.after(async () => {
    resumeGate()
    releasePausedWorker?.()
    if (activeHarness) await activeHarness.close()
    await rm(dir, { recursive: true, force: true })
  })

  const h = await openHarness(dir, {
    backend: makeRichBackend(() => plans[runIdx++] ?? { text: "fallback" }),
    followUpAuthorize: async actor => {
      if (actor.deviceId === "follow-up-delegation" && holdFollowUpAuth) {
        await holdFollowUpAuth
      }
      return actor
    },
  })
  activeHarness = h

  const wsId = (await h.catalog.native.createWorkspace("PrePauseBusy", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id

  // --- Case D first: Pre-existing schedule has an old interrupted run BEFORE user ever enables SA ---
  const legacyTask = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Legacy Interrupted Task",
      prompt: "Run legacy check",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  activeHarness = undefined
  await h.close()

  const scheduleFile = join(dir, "scheduled-tasks.json")
  const saved = JSON.parse(await readFile(scheduleFile, "utf8")) as {
    tasks: Array<{ id: string; runs: Array<Record<string, unknown>> }>
  }
  const preSubRunId = randomUUID()
  const priorTs = new Date(Date.now() - 60_000).toISOString()
  saved.tasks.find(item => item.id === legacyTask.id)!.runs.unshift({
    id: preSubRunId,
    state: "interrupted",
    scheduledFor: priorTs,
    startedAt: priorTs,
    finishedAt: new Date(Date.now() - 55_000).toISOString(),
    error: "Daemon restarted before user ever enabled SA",
    createOperationId: randomUUID(),
    inputOperationId: randomUUID(),
    ownerUserId: userA.userId,
    scheduleVersion: 1,
  })
  await writeFile(scheduleFile, JSON.stringify(saved, null, 2))

  // Reopen with real wall clock aligned across AgentSessions, ScheduledTasks, and SuperFollowUpService
  const h2 = await openHarness(dir, {
    backend: makeRichBackend(() => plans[runIdx++] ?? { text: "fallback" }),
    followUpAuthorize: async actor => {
      if (actor.deviceId === "follow-up-delegation" && holdFollowUpAuth) {
        await holdFollowUpAuth
      }
      return actor
    },
  })
  activeHarness = h2

  // User enables SA and subscribes to legacyTask for the FIRST time -> old interrupted run must NOT appear in SA history or main chat!
  await h2.enableAuth(userA, "inst-mac")
  await h2.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: legacyTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)
  await h2.followUp.drainScheduleEvents()
  const legacyRuns = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: legacyTask.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(legacyRuns.runs.length, 0, "First-time subscription must NOT import pre-existing interrupted run into SA history")
  let snap = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0)

  // --- Case B: Pre-pause completed run deferred by SQLITE_BUSY, paused + re-enabled BEFORE DB recovery ---
  const task = await h2.operations.handle("scheduleCreate", {
    schedule: {
      title: "Morning Ops Digest",
      prompt: "Summarize ops metrics",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h2.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  let busyOnRead = false
  const origRead = h2.agents.journal.read.bind(h2.agents.journal)
  h2.agents.journal.read = async sessionId => {
    if (busyOnRead) {
      throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" })
    }
    return origRead(sessionId)
  }

  // Run 1 starts & finishes natively while subscribed & authorized; gate holds follow-up so we trigger SQLITE_BUSY deterministically.
  pauseGate()
  const prePauseRun = await h2.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const listAfterPrePause = await eventually(
    () => h2.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => Boolean(list.find(x => x.id === task.id)?.runs.some(r => r.id === prePauseRun.id && r.state === "completed")),
  )
  const nativePrePauseFinishedAt = listAfterPrePause.find(x => x.id === task.id)!.runs.find(r => r.id === prePauseRun.id)!.finishedAt!
  await eventually(
    () => Promise.resolve(h2.schedules.pendingPrivateEvents()),
    events => events.some(e => e.runId === prePauseRun.id && e.kind === "run_finished"),
  )

  // First drain attempt hits SQLITE_BUSY -> run_started recorded non-terminal, run_finished stays queued!
  busyOnRead = true
  resumeGate()
  await h2.followUp.drainScheduleEvents()
  assert.ok(h2.schedules.pendingPrivateEvents().some(e => e.runId === prePauseRun.id && e.kind === "run_finished"))

  // Wait >41ms AFTER native completion, then user pauses single schedule follow-up and re-enables BEFORE DB recovers!
  await delay(60)
  const pausedAtIso = new Date().toISOString()
  assert.ok(pausedAtIso > nativePrePauseFinishedAt, "Pause must occur strictly after native completion")
  await h2.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: false,
  }, userA)

  await delay(30)
  await h2.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true,
  }, userA)

  // DB recovers -> drain delivers the FULL pre-pause daily report ONCE, with pre-pause finishedAt!
  busyOnRead = false
  h2.followUp.notifyAuthorizeRecovered()
  snap = await eventually(
    () => h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.provenance?.runId === prePauseRun.id),
  )
  await h2.followUp.drainScheduleEvents()
  const prePauseMsgs = snap.messages.filter(m => m.provenance?.runId === prePauseRun.id)
  assert.equal(prePauseMsgs.length, 1, "Pre-pause completed report must deliver exactly once after DB recovery")
  assert.match(prePauseMsgs[0]!.text, /暂停前已完成日报：全站可用率 99\.98%/)
  assert.equal(h2.schedules.pendingPrivateEvents().length, 0)

  const runsAfterRecover = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  const prePauseHist = runsAfterRecover.runs.find(r => r.runId === prePauseRun.id)!
  assert.equal(prePauseHist.status, "completed")
  assert.equal(prePauseHist.delivered, true)
  assert.ok((prePauseHist.finishedAt ?? "") < pausedAtIso, "SA history finishedAt must remain earlier than pause timestamp")

  // --- Case C (Preserved 18-P1 rule): Run that ACTUALLY finishes DURING pause still must NOT be replayed on re-enable ---
  const startedPromise = new Promise<void>(resolve => { pausedWorkerStarted = resolve })
  const duringPauseRun = await h2.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await startedPromise
  await eventually(async () => {
    await h2.followUp.drainScheduleEvents()
    const rec = await h2.followUpStore.getRun(userA.userId!, wsId, "schedule", task.id, `run:${duringPauseRun.id}`)
    return rec?.status === "running" || rec?.status === "claimed"
  }, Boolean)

  // Pause schedule, wait briefly, let native run finish WHILE paused, then re-enable
  await h2.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: false,
  }, userA)
  await delay(25)
  releasePausedWorker!()
  await eventually(
    () => h2.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => Boolean(list.find(x => x.id === task.id)?.runs.some(r => r.id === duringPauseRun.id && r.state === "completed")),
  )
  await delay(25)
  await h2.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true,
  }, userA)
  await h2.followUp.drainScheduleEvents()

  snap = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 1, "Run completed DURING pause must NOT replay into main chat after re-enable")
  assert.equal(snap.messages.some(m => m.text.includes("绝不应补发")), false)
  const runsAfterPaused = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  const pausedHist = runsAfterPaused.runs.find(r => r.runId === duringPauseRun.id)!
  assert.equal(pausedHist.status, "completed")
  assert.equal(pausedHist.delivered, false)
  assert.match(pausedHist.summary, /paused; not pushed to main chat/i)
})

// ============================================================================
// 25 · P1: Worker 仅发显式进度/开场/阶段成果就结束时，不得将其当作已交付的正式日报；
// 有显式 final_answer 的对照组正常交付并标为 delivered=true。
// ============================================================================
test("R4 25-P1: commentary-only, ack-only, and milestone-only runs never masquerade as delivered reports while explicit final_answer delivers normally", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r4-25-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const plans: ScriptedPlan[] = [
    // 1. Only commentary
    { chunks: [{ text: "我先检查支付日志，稍后给出结论。", phase: "commentary", messageId: "m-comm-only" }] },
    // 2. Only opening ack
    { chunks: [{ text: "收到，我先开始核对今日支付记录。", purpose: "ack", messageId: "m-ack-only" }] },
    // 3. Only intermediate milestone
    { chunks: [{ text: "阶段成果：已完成支付节点 A 与节点 B 核对。", purpose: "milestone", messageId: "m-mile-only" }] },
    // 4. Control: commentary + explicit final_answer
    {
      chunks: [
        { text: "我先检查支付日志，稍后给出结论。", phase: "commentary", messageId: "m-comm-ctrl" },
        { text: "最终结论：支付回调已恢复，P99 延迟 82ms。", phase: "final_answer", messageId: "m-final-ctrl" },
      ],
    },
  ]
  let idx = 0

  const h = await openHarness(dir, {
    backend: makeRichBackend(() => plans[idx++] ?? { text: "fallback" }),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("NoFinalGuard", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Payment Log Digest",
      prompt: "Inspect payment logs",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  const runAndWait = async () => {
    const run = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
    await eventually(async () => {
      await h.followUp.drainScheduleEvents()
      const page = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
        workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
      }, userA) as FollowUpRunsPage
      return page.runs.find(r => r.runId === run.id && r.status === "completed")
    }, Boolean)
    return run
  }

  const rCommOnly = await runAndWait()
  const rAckOnly = await runAndWait()
  const rMilestoneOnly = await runAndWait()
  const rFinalCtrl = await runAndWait()

  const snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  const hist = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage

  // 1. Commentary-only -> MUST NOT echo "稍后给出结论" as report body and MUST NOT mark delivered=true!
  const commMsg = snap.messages.find(m => m.provenance?.runId === rCommOnly.id)!
  assert.ok(commMsg && commMsg.provenance?.sessionId, "Notice must keep original session link")
  assert.doesNotMatch(commMsg.text, /稍后给出结论/, "Progress commentary must NEVER be used as the daily report body")
  assert.match(commMsg.text, /no formal final conclusion.*open the original execution session/i)
  const commHist = hist.runs.find(r => r.runId === rCommOnly.id)!
  assert.equal(commHist.status, "completed")
  assert.equal(commHist.delivered, false, "Commentary-only run must NOT be marked delivered=true")
  assert.doesNotMatch(commHist.summary, /稍后给出结论/)

  // 2. Ack-only -> MUST NOT echo opening ack as report body and MUST NOT mark delivered=true!
  const ackMsg = snap.messages.find(m => m.provenance?.runId === rAckOnly.id)!
  assert.ok(ackMsg && ackMsg.provenance?.sessionId)
  assert.doesNotMatch(ackMsg.text, /马上开始核对|我先开始核对/)
  assert.match(ackMsg.text, /opening acknowledgement.*no formal final conclusion/i)
  assert.equal(hist.runs.find(r => r.runId === rAckOnly.id)?.delivered, false)

  // 3. Milestone-only -> clearly labeled intermediate milestone without formal final conclusion, delivered=false!
  const mileMsg = snap.messages.find(m => m.provenance?.runId === rMilestoneOnly.id)!
  assert.ok(mileMsg && mileMsg.provenance?.sessionId)
  assert.match(mileMsg.text, /intermediate milestone.*no formal final conclusion/i)
  assert.ok(mileMsg.text.includes("阶段成果：已完成支付节点 A 与节点 B 核对。"))
  assert.equal(hist.runs.find(r => r.runId === rMilestoneOnly.id)?.delivered, false)

  // 4. Control with explicit final_answer -> delivers exact conclusion and marks delivered=true!
  const ctrlMsg = snap.messages.find(m => m.provenance?.runId === rFinalCtrl.id)!
  assert.equal(ctrlMsg.text, "最终结论：支付回调已恢复，P99 延迟 82ms。")
  const ctrlHist = hist.runs.find(r => r.runId === rFinalCtrl.id)!
  assert.equal(ctrlHist.delivered, true)
  assert.equal(ctrlHist.summary, "最终结论：支付回调已恢复，P99 延迟 82ms。")
})

// ============================================================================
// 26 · P2: 无后台协调模型时，「仅异常」应对带检查对象/服务名/指标的明确正常报告
// （如「支付接口 A、B、C 全部通过，无异常，无需处理。」）保持静默；含真实异常时仍须告警。
// ============================================================================
test("R4 26-P2: exceptions_only without a triage model keeps clean reports naming checked services quiet while delivering real anomalies", async t => {
  // 1. Direct unit checks covering clean reports with services/items/metrics vs anomalies/mixed/actionable
  for (const clean of [
    "全部通过，无异常。",
    "支付接口 A、B、C 全部通过，无异常，无需处理。",
    "订单服务、支付服务、结算服务全部通过，无异常，无风险。",
    "核心 API、支付服务运行正常，无异常，无需处理。",
    "Payment API A, B, C all checks passed, no errors, no action needed.",
    "昨日无异常。支付接口 A、B、C 全部通过，无异常，无需处理。",
  ]) {
    assert.equal(looksCleanNoRisk(clean), true, `Expected quiet clean report: ${clean}`)
  }
  for (const alert of [
    "支付接口 C 连续超时，需立即处理。",
    "支付接口 A、B 全部通过，无异常，但支付接口 C 连续超时，需立即处理。",
    "支付接口 A、B 全部通过，无异常。支付接口 C 连续超时，需立即处理。",
    "支付接口 A、B 全部通过，支付接口 C 返回 429。",
    "支付接口 A、B、C 无异常，请确认是否切换流量。",
    "昨日无异常。今日支付接口连续超时，HTTP 503，需立即处理。",
    "昨日无异常。今日订单队列积压 420 条，请确认是否扩容。",
    "支付接口 A、B、C 已巡检完成。", // Ambiguous: no clean verdict
  ]) {
    assert.equal(looksCleanNoRisk(alert), false, `Expected alert/non-quiet report: ${alert}`)
  }

  // 2. End-to-end production-style harness WITHOUT triageModel (triageModel: undefined)
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r4-26-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const reports = [
    "全部通过，无异常。",
    "支付接口 A、B、C 全部通过，无异常，无需处理。",
    "Payment API A, B, C all checks passed, no errors, no action needed.",
    "支付接口 C 连续超时，需立即处理。",
    "支付接口 A、B 全部通过，无异常，但支付接口 C 连续超时，需立即处理。",
  ]
  let idx = 0

  const h = await openHarness(dir, {
    backend: makeRichBackend(() => ({ text: reports[idx++] ?? "全部通过，无异常。" })),
    // Intentionally NO triageModel to match production MachineRuntime configuration!
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("NoModelPatrol", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Payment API Patrol",
      prompt: "Check Payment APIs A, B, C",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "exceptions_only",
  }, userA)

  const runAndWait = async () => {
    const run = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
    await eventually(async () => {
      await h.followUp.drainScheduleEvents()
      const page = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
        workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
      }, userA) as FollowUpRunsPage
      return page.runs.find(r => r.runId === run.id && r.status === "completed")
    }, Boolean)
    return run
  }

  const r1 = await runAndWait()
  const r2 = await runAndWait()
  const r3 = await runAndWait()
  let snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0, "All three clean reports (including named services A, B, C) must stay quiet without a model")

  const r4 = await runAndWait()
  const r5 = await runAndWait()
  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 2, "Both real anomalies must deliver to main chat")
  assert.ok(snap.messages.some(m => m.provenance?.runId === r4.id && m.text.includes("支付接口 C 连续超时")))
  assert.ok(snap.messages.some(m => m.provenance?.runId === r5.id && m.text.includes("支付接口 C 连续超时")))

  const hist = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(hist.runs.find(r => r.runId === r1.id)?.delivered, false)
  assert.equal(hist.runs.find(r => r.runId === r2.id)?.delivered, false)
  assert.equal(hist.runs.find(r => r.runId === r3.id)?.delivered, false)
  assert.equal(hist.runs.find(r => r.runId === r4.id)?.delivered, true)
  assert.equal(hist.runs.find(r => r.runId === r5.id)?.delivered, true)
})

// ============================================================================
// 到点执行对照：推进测试时钟让原生调度器按时触发同一类工作目录计划；
// 经典用户与显式订阅用户的原生计划均完成，只有显式订阅者在 SA 主对话与历史收到 1 条日报。
// ============================================================================
test("R4 due-trigger control: advancing test clock fires both classic and subscribed workdir schedules, delivering SA report only to the subscribed user", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r4-due-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  let clockMs = Date.parse("2026-11-23T10:00:00.000Z")
  const now = () => new Date(clockMs)

  const h = await openHarness(dir, {
    now,
    backend: makeRichBackend(prompt => ({ text: `到点日报正文：${prompt}` })),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("DueControl", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id

  // Only userA authorizes SA; userClassic NEVER authorizes or subscribes!
  await h.enableAuth(userA, "inst-mac")

  // Both users create an identical 1-hour interval workdir schedule
  const classicTask = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Classic Scheduled Digest",
      prompt: "Classic scheduled prompt",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 60 },
    },
  }, userClassic) as ScheduledTask

  const subscribedTask = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Subscribed Scheduled Digest",
      prompt: "Subscribed scheduled prompt",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 60 },
    },
  }, userA) as ScheduledTask

  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: subscribedTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // Advance clock past due time (+61 minutes) and start native scheduler -> automatic due trigger!
  clockMs += 61 * 60_000
  h.schedules.start()

  await eventually(
    () => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => {
      const c = list.find(item => item.id === classicTask.id)
      const s = list.find(item => item.id === subscribedTask.id)
      return Boolean(c?.runs.some(r => r.state === "completed") && s?.runs.some(r => r.state === "completed"))
    },
  )

  // Subscribed user receives EXACTLY 1 SA main chat report + 1 SA history record
  const saSnap = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.scheduleId === subscribedTask.id))
  assert.equal(saSnap.messages.length, 1)
  assert.match(saSnap.messages[0]!.text, /到点日报正文：Subscribed scheduled prompt/)

  const saHist = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: subscribedTask.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(saHist.runs.length, 1)
  assert.equal(saHist.runs[0]!.status, "completed")
  assert.equal(saHist.runs[0]!.delivered, true)

  // Classic user has 0 SA main chat messages and 0 SA history records (and never initialized SA state!)
  assert.equal(h.followUpStore.getAuth(userClassic.userId!), undefined)
  const classicHist = await h.followUpStore.listRuns({ userId: userClassic.userId!, workspaceId: wsId })
  assert.equal(classicHist.runs.length, 0)
  const classicRoom = h.superStore.get(userClassic.userId!)
  assert.equal(classicRoom, undefined, "Classic user must receive zero SA writes or main-chat messages")
})
