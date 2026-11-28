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
import type { SchedulePrivateEvent, ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import { ScheduledTasks } from "../schedules/scheduled-tasks.ts"
import type { FollowUpAuthReceipt, FollowUpRunRecord, FollowUpRunsPage } from "@deskfleet/protocol/super-agent-follow-up"
import { LocalFollowUpStore } from "./follow-up-store.ts"
import { SuperFollowUpService } from "./follow-up.ts"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import type { ScheduleCommandHost } from "./schedule.ts"
import { SuperAgentService, type SuperUserState } from "./service.ts"
import { LocalSuperStore } from "./store.ts"
import { boundSummaryText, looksCleanNoRisk, type TriageModel } from "./triage.ts"
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
  const authorize = async (actor: AgentActor) => actor
  const superStore = new LocalSuperStore<SuperUserState>(catalog.native)
  await superStore.init()
  const followUpStore = new LocalFollowUpStore(catalog.native)
  await followUpStore.init()
  const schedules = new ScheduledTasks(directory, {
    agents, catalog, providers, authorize,
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
    followUpStore, superStore, agents, schedules, authorize,
    workspaces: ws.workspaces,
    triageModel: options.triageModel,
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
    agents, store: superStore, followUp, schedules: scheduleHost, authorize,
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
// 19 · P1: 「仅异常」在告警前/后附加「昨日无异常」时不得漏报，纯正常报告仍静默
// ============================================================================
test("R3 19-P1: exceptions_only delivers alerts even when preceded or followed by 昨日无异常 while keeping purely clean reports quiet", async t => {
  // 1. Direct unit checks (standalone, prefixed clean, suffixed clean, novel alert, pure clean)
  assert.equal(looksCleanNoRisk("昨日无异常。"), true)
  assert.equal(looksCleanNoRisk("昨日提交已巡检，无风险，无异常，一切正常。"), true)
  assert.equal(looksCleanNoRisk("Daily check complete. No risks found, 0 errors, 0 warnings."), true)
  assert.equal(looksCleanNoRisk("今日支付接口连续超时，HTTP 503，需立即处理。"), false)
  assert.equal(looksCleanNoRisk("昨日无异常。今日支付接口连续超时，HTTP 503，需立即处理。"), false)
  assert.equal(looksCleanNoRisk("今日支付接口连续超时，HTTP 503，需立即处理。昨日无异常。"), false)
  assert.equal(looksCleanNoRisk("昨日无异常。今日订单队列积压 420 条，请确认是否扩容。"), false)

  // 2. End-to-end exceptions_only schedule runs
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r3-19-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const reports = [
    "昨日无异常。",
    "今日支付接口连续超时，HTTP 503，需立即处理。",
    "昨日无异常。今日支付接口连续超时，HTTP 503，需立即处理。",
    "今日支付接口连续超时，HTTP 503，需立即处理。昨日无异常。",
    "昨日无异常。今日订单队列积压 420 条，请确认是否扩容。",
  ]
  let idx = 0
  let modelInvocations = 0

  const h = await openHarness(dir, {
    backend: makeRichBackend(() => ({ text: reports[idx++] ?? "昨日无异常。" })),
    triageModel: () => async packet => {
      modelInvocations += 1
      return { kind: "deliver_result", summary: String(packet.outputText ?? ""), reason: "model verified alert" }
    },
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("AlertGate", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Payment Health Check",
      prompt: "Check payment API health",
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

  const rClean = await runAndWait()
  assert.equal(modelInvocations, 0, "Purely clean report should stay quiet without invoking triage model")
  let snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0, "Purely clean 昨日无异常 must remain quiet")

  const rStandalone = await runAndWait()
  const rPrefixed = await runAndWait()
  const rSuffixed = await runAndWait()
  const rNovel = await runAndWait()

  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(modelInvocations, 4, "Every alert/mixed report must bypass the clean short-circuit")
  assert.equal(snap.messages.length, 4, "Standalone, prefixed-normal, suffixed-normal, and novel alerts must all deliver")
  for (const run of [rStandalone, rPrefixed, rSuffixed]) {
    const msg = snap.messages.find(m => m.provenance?.runId === run.id)
    assert.ok(msg, `Expected main chat delivery for run ${run.id}`)
    assert.match(msg.text, /HTTP 503/)
  }
  const novelMsg = snap.messages.find(m => m.provenance?.runId === rNovel.id)
  assert.ok(novelMsg && novelMsg.text.includes("订单队列积压 420 条"))

  const history = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(history.runs.find(r => r.runId === rClean.id)?.delivered, false)
  for (const run of [rStandalone, rPrefixed, rSuffixed, rNovel]) {
    assert.equal(history.runs.find(r => r.runId === run.id)?.delivered, true)
  }
})

// ============================================================================
// 20 · P1: 「每次汇报」在长/短过程 commentary 后给出显式 final_answer 时，
// 主对话与历史必须完整送达正式终稿，不得被 4,000 字截断过程说明替代
// ============================================================================
test("R3 20-P1: every_run delivers complete explicit final_answer over long or short commentary and preserves conclusion on untagged long output", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r3-20-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const finalConclusion = "最终结论：发布须暂停，先修复支付回调。"
  const longCommentary = "过程核对日志：正在逐项检查接口延迟与回调链路。".repeat(215) // ~4,300+ chars
  assert.ok(longCommentary.length > 4_300)

  // Unit check of boundSummaryText preserving concluding text when untagged output > 4,000 chars
  const boundedUntagged = boundSummaryText(`${longCommentary}\n${finalConclusion}`, 4000)
  assert.ok(boundedUntagged.length <= 4000)
  assert.ok(boundedUntagged.includes(finalConclusion), "boundSummaryText must preserve concluding answer")
  assert.match(boundedUntagged, /truncated.*original execution session/i)

  const plans: ScriptedPlan[] = [
    // Run 1: 4,300+ chars explicit commentary + 19-char explicit final_answer
    {
      chunks: [
        { text: longCommentary, phase: "commentary", messageId: "m-comm-1" },
        { text: finalConclusion, phase: "final_answer", messageId: "m-final-1" },
      ],
    },
    // Run 2: 5-char explicit commentary + 19-char explicit final_answer
    {
      chunks: [
        { text: "核对完成。", phase: "commentary", messageId: "m-comm-2" },
        { text: finalConclusion, phase: "final_answer", messageId: "m-final-2" },
      ],
    },
    // Run 3: Untagged >4,300 chars prefix + concluding line (no phase tags)
    {
      chunks: [
        { text: `${longCommentary}\n${finalConclusion}` },
      ],
    },
  ]
  let planIdx = 0

  const h = await openHarness(dir, {
    backend: makeRichBackend(() => plans[planIdx++] ?? { text: finalConclusion }),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("FinalAnswer", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Release Readiness Digest",
      prompt: "Audit release readiness",
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
    await eventually(
      () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
      s => s.messages.some(m => m.provenance?.runId === run.id),
    )
    await h.followUp.drainScheduleEvents()
    return run
  }

  const rLongComm = await runAndWait()
  const rShortComm = await runAndWait()
  const rUntaggedLong = await runAndWait()

  const snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  const history = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage

  // Run 1: Long commentary + explicit final_answer -> delivers exact final conclusion cleanly, once!
  const msgs1 = snap.messages.filter(m => m.provenance?.runId === rLongComm.id)
  assert.equal(msgs1.length, 1)
  assert.equal(msgs1[0]!.text, finalConclusion)
  const hist1 = history.runs.find(r => r.runId === rLongComm.id)!
  assert.equal(hist1.delivered, true)
  assert.equal(hist1.summary, finalConclusion)

  // Run 2: Short commentary + explicit final_answer -> also delivers exact final conclusion without gluing commentary!
  const msgs2 = snap.messages.filter(m => m.provenance?.runId === rShortComm.id)
  assert.equal(msgs2.length, 1)
  assert.equal(msgs2[0]!.text, finalConclusion)
  const hist2 = history.runs.find(r => r.runId === rShortComm.id)!
  assert.equal(hist2.delivered, true)
  assert.equal(hist2.summary, finalConclusion)

  // Run 3: Untagged >4,300 chars -> main chat gets concise SA summary (no raw truncation paste!),
  // while expandable detail keeps the bounded execution log preserving the concluding answer!
  const msgs3 = snap.messages.filter(m => m.provenance?.runId === rUntaggedLong.id)
  assert.equal(msgs3.length, 1)
  assert.ok(msgs3[0]!.text.includes(finalConclusion), "Untagged long output summary must still preserve concluding answer")
  assert.ok(msgs3[0]!.text.length < 1000, "Main chat must receive concise SA summary rather than pasting 4,000 chars of raw logs")
  assert.doesNotMatch(msgs3[0]!.text, /\[output truncated/i, "Main chat SA summary must not use raw truncation marker")
  assert.ok(msgs3[0]!.provenance?.detail?.includes(finalConclusion), "Expandable detail preserves concluding answer")
  const hist3 = history.runs.find(r => r.runId === rUntaggedLong.id)!
  assert.equal(hist3.delivered, true)
  assert.equal(hist3.summary, msgs3[0]!.text)
  assert.ok(hist3.detail?.includes(finalConclusion), "Persisted run detail preserves concluding answer")
})

// ============================================================================
// 18 · P1: 分别关闭单条计划跟进、关闭最后一台已授权设备的 SA，原生任务在停用期间
// 正常结束；重新开启后不得补发旧日报，但新发起的运行正常跟进；持续有效时的崩溃仍补报
// ============================================================================
test("R3 18-P1: re-enabling after single-schedule pause or last-device revocation never replays reports finished while disabled, while new runs deliver normally", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r3-18-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  let runCounter = 0
  let startedSignal: (() => void) | undefined
  let releaseWorker: (() => void) | undefined
  let holdCurrentWorker = false
  const reportBodies = [
    "停用单条期间旧日报：不应补发 A",
    "重新开启单条后新日报：应送达 B",
    "关闭最后一台设备期间旧日报：不应补发 C",
    "重新授权设备后新日报：应送达 D",
  ]

  const h = await openHarness(dir, {
    backend: makeRichBackend(() => {
      const text = reportBodies[runCounter++] ?? "fallback"
      if (holdCurrentWorker) {
        holdCurrentWorker = false
        return {
          text,
          onStarted: () => startedSignal?.(),
          waitFor: () => new Promise<void>(resolve => { releaseWorker = resolve }),
        }
      }
      return { text }
    }),
  })
  t.after(async () => { releaseWorker?.(); await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("PauseWindow", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Daily Ops Digest",
      prompt: "Produce daily ops digest",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // --- Scenario A: Disable single schedule while run 1 is in-flight ---
  holdCurrentWorker = true
  const run1Started = new Promise<void>(resolve => { startedSignal = resolve })
  const run1 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await run1Started
  // Ensure SA recorded run 1 as non-terminal (`running`) before user pauses single schedule
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    const rec = await h.followUpStore.getRun(userA.userId!, wsId, "schedule", task.id, `run:${run1.id}`)
    return rec?.status === "running" || rec?.status === "claimed"
  }, Boolean)

  // Pause single schedule follow-up -> let native run 1 finish while paused!
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: false,
  }, userA)
  releaseWorker!()
  await eventually(
    () => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => Boolean(list[0]?.runs.some(r => r.id === run1.id && r.state === "completed")),
  )
  await h.followUp.drainScheduleEvents()
  let snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0, "Main chat must be 0 while schedule follow-up is paused")

  // Re-enable single schedule -> drain MUST NOT replay old report A!
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true,
  }, userA)
  await h.followUp.drainScheduleEvents()
  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0, "Re-enabling single schedule MUST NOT replay report finished while paused")
  let hist = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  const histRun1 = hist.runs.find(r => r.runId === run1.id)!
  assert.equal(histRun1.status, "completed", "History must calibrate paused-period run to native completed status")
  assert.equal(histRun1.delivered, false, "Paused-period run must remain delivered=false")
  assert.match(histRun1.summary, /paused; not pushed to main chat/i)

  // New run 2 after re-enabling -> delivers normally!
  const run2 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  snap = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === run2.id))
  assert.equal(snap.messages.length, 1)
  assert.match(snap.messages[0]!.text, /重新开启单条后新日报：应送达 B/)

  // --- Scenario B: Disable LAST authorized device while run 3 is in-flight ---
  holdCurrentWorker = true
  const run3Started = new Promise<void>(resolve => { startedSignal = resolve })
  const run3 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await run3Started
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    const rec = await h.followUpStore.getRun(userA.userId!, wsId, "schedule", task.id, `run:${run3.id}`)
    return rec?.status === "running" || rec?.status === "claimed"
  }, Boolean)

  // Revoke last authorized device -> let native run 3 finish while unauthorized!
  const off = await h.disableAuth(userA, "inst-mac")
  assert.equal(off.authorized, false)
  releaseWorker!()
  await eventually(
    () => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => Boolean(list[0]?.runs.some(r => r.id === run3.id && r.state === "completed")),
  )
  await h.followUp.drainScheduleEvents()
  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 1, "Main chat must stay at 1 while SA is unauthorized")

  // Re-authorize Mac -> drain MUST NOT replay old report C!
  const onAgain = await h.enableAuth(userA, "inst-mac")
  assert.equal(onAgain.authorized, true)
  await h.followUp.drainScheduleEvents()
  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 1, "Re-authorizing SA MUST NOT replay report finished while disabled")
  assert.equal(snap.messages.some(m => m.text.includes("不应补发 C")), false)
  hist = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  const histRun3 = hist.runs.find(r => r.runId === run3.id)!
  assert.equal(histRun3.status, "completed")
  assert.equal(histRun3.delivered, false)
  assert.match(histRun3.summary, /disabled; not pushed to main chat/i)

  // New run 4 after re-authorizing -> delivers normally!
  const run4 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  snap = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === run4.id))
  assert.equal(snap.messages.length, 2)
  assert.ok(snap.messages.some(m => m.provenance?.runId === run4.id && m.text.includes("重新授权设备后新日报：应送达 D")))
})

// ============================================================================
// 21 · P2: 同一计划已有 1,000+ 条较新记录时，向较早已完成运行送入迟到启动事件，
// 历史仍必须保持「已完成、已交付」，原摘要/证据引用/消息 ID 不得被改写
// ============================================================================
test("R3 21-P2: late run_started for an early completed run cannot downgrade history even after >1,000 newer records in SQLite", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r3-21-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const h1 = await openHarness(dir, {
    backend: makeRichBackend(() => ({ text: "最早的真实日报：支付链路稳定，核心指标正常。" })),
  })
  const wsId = (await h1.catalog.native.createWorkspace("DeepHistory", [{ path: project }])).id
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h1.enableAuth(userA, "inst-mac")

  const task = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "High-Frequency Health Check",
      prompt: "Check core metrics",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // 1. Run and deliver the earliest real report
  const earlyRun = await h1.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const snap1 = await eventually(async () => {
    await h1.followUp.drainScheduleEvents()
    return h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === earlyRun.id))
  await h1.followUp.drainScheduleEvents()
  const originalRecord = (await h1.followUpStore.getRun(userA.userId!, wsId, "schedule", task.id, `run:${earlyRun.id}`))!
  assert.equal(originalRecord.status, "completed")
  assert.equal(originalRecord.delivered, true)
  assert.ok(originalRecord.deliveredMessageId)
  assert.match(originalRecord.summary, /最早的真实日报/)
  assert.equal(snap1.messages.length, 1)

  // 2. Seed 1,005 newer run records for the exact same schedule directly into real SQLite!
  const baseMs = Date.parse(originalRecord.createdAt) + 10_000
  for (let i = 0; i < 1_005; i++) {
    const ts = new Date(baseMs + i * 1_000).toISOString()
    const newerRunId = `newer-${String(i).padStart(4, "0")}`
    const rec: FollowUpRunRecord = {
      id: randomUUID(),
      userId: userA.userId!,
      workspaceId: wsId,
      sourceKind: "schedule",
      sourceId: task.id,
      runKey: `run:${newerRunId}`,
      scheduleId: task.id,
      scheduleTitle: task.title,
      runId: newerRunId,
      startedAt: ts,
      finishedAt: ts,
      status: "completed",
      deliveryPolicy: "every_run",
      delivered: false,
      summary: `Newer synthetic run #${i}`,
      evidenceAvailability: "available",
      createdAt: ts,
      updatedAt: ts,
    }
    await h1.catalog.native.upsertSuperAgentFollowUpRun({
      id: rec.id,
      userId: rec.userId,
      workspaceId: rec.workspaceId,
      sourceKind: rec.sourceKind,
      sourceId: rec.sourceId,
      runKey: rec.runKey,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      recordJson: JSON.stringify(rec),
    })
  }
  await h1.close()

  // 3. Inject late retried `run_started` (`claimed` and `running`) for `earlyRun` into scheduled-tasks.json
  const scheduleFile = join(dir, "scheduled-tasks.json")
  const saved = JSON.parse(await readFile(scheduleFile, "utf8")) as { pendingEvents?: SchedulePrivateEvent[] }
  const lateBase = {
    scheduleId: task.id,
    scheduleTitle: task.title,
    scheduleVersion: 1,
    workspaceId: wsId,
    targetKind: "directory" as const,
    ownerUserId: userA.userId!,
    runId: earlyRun.id,
    scheduledFor: earlyRun.scheduledFor,
    startedAt: earlyRun.startedAt,
    createdAt: new Date(baseMs + 2_000_000).toISOString(),
  }
  saved.pendingEvents = [
    { ...lateBase, id: `deep-late-claimed-${randomUUID()}`, kind: "run_started", runState: "claimed" },
    { ...lateBase, id: `deep-late-running-${randomUUID()}`, kind: "run_started", runState: "running", sessionId: originalRecord.sessionId, inputId: originalRecord.inputId },
  ]
  await writeFile(scheduleFile, JSON.stringify(saved, null, 2))

  // 4. Reopen, drain late events, and verify via BOTH exact lookup AND paginated history down to the earliest page!
  const h2 = await openHarness(dir)
  t.after(async () => { await h2.close(); await rm(dir, { recursive: true, force: true }) })

  await h2.followUp.drainScheduleEvents()
  assert.equal(h2.schedules.pendingPrivateEvents().length, 0)

  const exactAfter = (await h2.followUpStore.getRun(userA.userId!, wsId, "schedule", task.id, `run:${earlyRun.id}`))!
  assert.equal(exactAfter.status, "completed", "Deep-history completed status must survive late claimed/running events")
  assert.equal(exactAfter.delivered, true, "Deep-history delivered flag must remain true")
  assert.equal(exactAfter.deliveredMessageId, originalRecord.deliveredMessageId)
  assert.equal(exactAfter.summary, originalRecord.summary)
  assert.deepEqual(exactAfter.evidenceRefs, originalRecord.evidenceRefs)

  // Paginate through followUpRuns all the way past 1,005 newer records to verify the earliest report on the final page!
  let cursor: { createdAt: string; id: string } | undefined
  let foundInPages: FollowUpRunRecord | undefined
  let totalSeen = 0
  for (;;) {
    const page = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
      workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 200,
      ...(cursor ? { cursor } : {}),
    }, userA) as FollowUpRunsPage
    totalSeen += page.runs.length
    const hit = page.runs.find(r => r.runId === earlyRun.id)
    if (hit) foundInPages = hit
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  assert.equal(totalSeen, 1_006)
  assert.ok(foundInPages, "Earliest run must be reachable via paginated history")
  assert.equal(foundInPages.status, "completed")
  assert.equal(foundInPages.delivered, true)
  assert.equal(foundInPages.deliveredMessageId, originalRecord.deliveredMessageId)
  assert.equal(foundInPages.summary, originalRecord.summary)
  assert.deepEqual(foundInPages.evidenceRefs, originalRecord.evidenceRefs)

  const snap2 = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap2.messages.length, 1)
})
