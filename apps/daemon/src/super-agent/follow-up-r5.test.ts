import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
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

type ScriptedEvent =
  | { kind: "text"; text: string; phase?: "commentary" | "partial_answer" | "final_answer"; purpose?: "ack" | "activity" | "milestone" | "final_answer"; messageId?: string }
  | { kind: "tool"; title: string }

interface ScriptedPlan {
  events?: ScriptedEvent[]
  text?: string
}

function makeAcpToolBackend(planFor: (prompt: string) => ScriptedPlan) {
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
        const plan = planFor(promptText)
        if (plan.events) {
          for (const step of plan.events) {
            if (step.kind === "tool") {
              const toolCallId = `tc-${randomUUID()}`
              await client.onUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId,
                  title: step.title,
                  kind: "read",
                  status: "in_progress",
                },
              })
              await client.onUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId,
                  title: step.title,
                  status: "completed",
                },
              })
            } else {
              const deskfleetMeta: Record<string, unknown> = {}
              if (step.phase) deskfleetMeta.phase = step.phase
              if (step.purpose) deskfleetMeta.purpose = step.purpose
              if (step.messageId) deskfleetMeta.messageId = step.messageId
              await client.onUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: step.text },
                  ...(Object.keys(deskfleetMeta).length ? { _meta: { deskfleet: deskfleetMeta } } : {}),
                },
              })
            }
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
// 29 · P1: 任务在暂停前已完成，但授权服务 503 导致运行记录尚未建立；
// 暂停期间恢复授权并处理待重试回执（静默且队列清空），随后重新启用并重启宿主 ->
// 日报完整投递一次，历史正确记录为暂停前完成；暂停期间完成的任务保持静默。
// ============================================================================
test("R5 29-P1: pre-pause completed run with zero SA history due to 503 survives pause-time drain, re-enable, and daemon restart, delivering once with pre-pause finishedAt", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r5-29-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  let activeHarness: Awaited<ReturnType<typeof openHarness>> | undefined
  t.after(async () => {
    if (activeHarness) await activeHarness.close()
    await rm(dir, { recursive: true, force: true })
  })

  let auth503 = false
  let runNum = 0
  const replies = [
    "暂停前已完成且 503 延迟的日报：支付对账一致，0 差异。",
    "暂停期间运行并完成的旧日报：绝不应补发。",
  ]

  const h1 = await openHarness(dir, {
    backend: makeAcpToolBackend(() => ({ text: replies[runNum++] ?? "fallback" })),
    followUpAuthorize: async actor => {
      if (auth503 && actor.deviceId === "follow-up-delegation") {
        throw new HttpError(503, "Central auth temporarily unavailable")
      }
      return actor
    },
  })
  activeHarness = h1

  const wsId = (await h1.catalog.native.createWorkspace("PauseRetry503", [{ path: project }])).id
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h1.enableAuth(userA, "inst-mac")

  const task = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "Reconciliation Daily",
      prompt: "Reconcile payments",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // 1. Trigger 503 BEFORE run starts so SA cannot even create a `claimed`/`running` run row!
  auth503 = true
  const prePauseRun = await h1.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const listAfterRun1 = await eventually(
    () => h1.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => Boolean(list.find(x => x.id === task.id)?.runs.some(r => r.id === prePauseRun.id && r.state === "completed")),
  )
  const nativeFinishedAt = listAfterRun1.find(x => x.id === task.id)!.runs.find(r => r.id === prePauseRun.id)!.finishedAt!
  await eventually(
    () => Promise.resolve(h1.schedules.pendingPrivateEvents()),
    events => events.some(e => e.runId === prePauseRun.id && e.kind === "run_finished"),
  )
  await h1.followUp.drainScheduleEvents()

  // Verify exact pre-pause failure state: 0 SA run rows, 0 main chat messages, pending retries still queued!
  let runs = await h1.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(runs.runs.length, 0, "SA must have 0 run records while 503 blocked all initial events")
  assert.ok(h1.schedules.pendingPrivateEvents().length >= 2, "Pending start+finish receipts must still be queued")

  // 2. Pause schedule AFTER native completion, then recover auth and drain queue DURING PAUSE!
  await delay(50)
  const pausedAtIso = new Date().toISOString()
  assert.ok(pausedAtIso > nativeFinishedAt)
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: false,
  }, userA)

  auth503 = false
  await h1.followUp.drainScheduleEvents()

  // During pause: queue drained cleanly, main chat stays silent (0), history stays clean (0)
  assert.equal(h1.schedules.pendingPrivateEvents().length, 0, "Queue drains cleanly during pause")
  let snap = await h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0, "Main chat must stay silent during pause")
  runs = await h1.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(runs.runs.length, 0)

  // Control: Run 2 executes & completes DURING pause -> must stay silent even after re-enable!
  const duringPauseRun = await h1.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(
    () => h1.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => Boolean(list.find(x => x.id === task.id)?.runs.some(r => r.id === duringPauseRun.id && r.state === "completed")),
  )
  await delay(30)

  // 3. Re-enable schedule while auth transiently 503s (or close immediately) and RESTART daemon!
  // Keeping auth503=true across re-enable forces recovery to happen specifically after daemon restart!
  auth503 = true
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true,
  }, userA)
  activeHarness = undefined
  await h1.close()

  // Restart daemon with auth healthy -> pre-pause report MUST deliver ONCE with pre-pause finishedAt!
  auth503 = false
  const h2 = await openHarness(dir, {
    backend: makeAcpToolBackend(() => ({ text: "unused" })),
  })
  activeHarness = h2

  snap = await eventually(
    () => h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.provenance?.runId === prePauseRun.id),
  )
  await h2.followUp.drainScheduleEvents()

  assert.equal(snap.messages.length, 1, "Pre-pause report must deliver exactly once after restart; paused-period run must remain silent")
  assert.match(snap.messages[0]!.text, /暂停前已完成且 503 延迟的日报：支付对账一致，0 差异。/)
  assert.equal(snap.messages.some(m => m.text.includes("绝不应补发")), false)

  runs = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  const recovered = runs.runs.find(r => r.runId === prePauseRun.id)!
  assert.equal(recovered.status, "completed")
  assert.equal(recovered.delivered, true)
  assert.ok((recovered.finishedAt ?? "") < pausedAtIso, "Recovered run history must preserve pre-pause finishedAt")

  // Second restart -> zero duplicates!
  activeHarness = undefined
  await h2.close()
  const h3 = await openHarness(dir)
  activeHarness = h3
  await h3.followUp.drainScheduleEvents()
  const snapAfterRestart2 = await h3.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapAfterRestart2.messages.length, 1, "Second restart must not duplicate recovered pre-pause report")
})

// ============================================================================
// 30 · P1: Worker 未标记消息用途，仅发开场白后调用工具并结束回合 ->
// 不推送该开场白、不记为已交付；工具后有结论只取结论；纯文本直答与显式终稿均正常交付。
// ============================================================================
test("R5 30-P1: untagged opening text before a tool call never delivers as report body, while post-tool text, pure text, and explicit final_answer deliver cleanly", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r5-30-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const plans: ScriptedPlan[] = [
    // 1. Untagged opening -> tool call -> turn ends (NO post-tool conclusion!)
    {
      events: [
        { kind: "text", text: "我先查一下支付日志，稍后给你结论。" },
        { kind: "tool", title: "Inspect payment logs" },
      ],
    },
    // 2. Untagged opening -> tool call -> untagged conclusion
    {
      events: [
        { kind: "text", text: "我先查一下支付日志，稍后给你结论。" },
        { kind: "tool", title: "Inspect payment logs" },
        { kind: "text", text: "查完了，支付回调均已成功。" },
      ],
    },
    // 3. Pure untagged text with no tool call (compatibility path)
    {
      events: [
        { kind: "text", text: "查完了，支付回调均已成功。" },
      ],
    },
    // 4. Untagged opening -> tool call -> explicit final_answer
    {
      events: [
        { kind: "text", text: "我先查一下支付日志，稍后给你结论。" },
        { kind: "tool", title: "Inspect payment logs" },
        { kind: "text", text: "最终结论：支付回调全部正常，无需处理。", phase: "final_answer", messageId: "final-1" },
      ],
    },
  ]
  let idx = 0

  const h = await openHarness(dir, {
    backend: makeAcpToolBackend(() => plans[idx++] ?? { text: "fallback" }),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("UntaggedToolBoundary", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Payment Log Check",
      prompt: "Check payment callback logs",
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

  const rPreToolOnly = await runAndWait()
  const rOpeningPlusPostTool = await runAndWait()
  const rPureText = await runAndWait()
  const rExplicitFinal = await runAndWait()

  const snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  const hist = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage

  // 1. Pre-tool untagged opening ONLY -> NEVER push that opening text as report body and NEVER mark delivered=true!
  const m1 = snap.messages.find(m => m.provenance?.runId === rPreToolOnly.id)!
  assert.ok(m1 && m1.provenance?.sessionId, "Missing-conclusion notice must link back to original session")
  assert.doesNotMatch(m1.text, /我先查一下支付日志|稍后给你结论/, "Opening text before tool call must NOT be pushed as report")
  assert.match(m1.text, /no formal final conclusion.*open the original execution session/i)
  const h1Rec = hist.runs.find(r => r.runId === rPreToolOnly.id)!
  assert.equal(h1Rec.status, "completed")
  assert.equal(h1Rec.delivered, false, "Pre-tool-only run must NOT be marked delivered=true")
  assert.doesNotMatch(h1Rec.summary, /我先查一下支付日志|稍后给你结论/)

  // 2. Untagged opening -> tool -> untagged conclusion -> delivers ONLY the post-tool conclusion!
  const m2 = snap.messages.find(m => m.provenance?.runId === rOpeningPlusPostTool.id)!
  assert.equal(m2.text, "查完了，支付回调均已成功。")
  const h2Rec = hist.runs.find(r => r.runId === rOpeningPlusPostTool.id)!
  assert.equal(h2Rec.delivered, true)
  assert.equal(h2Rec.summary, "查完了，支付回调均已成功。")

  // 3. Pure untagged text -> delivers cleanly!
  const m3 = snap.messages.find(m => m.provenance?.runId === rPureText.id)!
  assert.equal(m3.text, "查完了，支付回调均已成功。")
  assert.equal(hist.runs.find(r => r.runId === rPureText.id)?.delivered, true)

  // 4. Explicit final_answer -> delivers exact explicit final_answer!
  const m4 = snap.messages.find(m => m.provenance?.runId === rExplicitFinal.id)!
  assert.equal(m4.text, "最终结论：支付回调全部正常，无需处理。")
  const h4Rec = hist.runs.find(r => r.runId === rExplicitFinal.id)!
  assert.equal(h4Rec.delivered, true)
  assert.equal(h4Rec.summary, "最终结论：支付回调全部正常，无需处理。")
})

// ============================================================================
// 31 · P1: 「仅异常」面对「支付 100 笔仅成功 2 笔，库存检查全部通过」不得被误判正常静默，
// 必须调用已配置的判断模型并推送明确指出支付异常的告警；明确正常报告仍静默。
// ============================================================================
test("R5 31-P1: exceptions_only invokes configured triage model on mixed quantitative anomaly '支付 100 笔仅成功 2 笔，库存检查全部通过' while keeping clean reports quiet", async t => {
  // 1. Direct unit checks
  assert.equal(looksCleanNoRisk("支付和库存全部通过，无异常。"), true)
  assert.equal(looksCleanNoRisk("支付接口 A、B、C 全部通过，无异常，无需处理。"), true)
  assert.equal(looksCleanNoRisk("支付 100 笔仅成功 2 笔，库存检查全部通过。"), false)
  assert.equal(looksCleanNoRisk("支付 100 笔成功 2 笔，库存检查全部通过。"), false)
  assert.equal(looksCleanNoRisk("支付请求连续失败，库存检查全部通过。"), false)
  assert.equal(looksCleanNoRisk("Payments: 2 of 100 succeeded, inventory checks all passed."), false)

  // 2. End-to-end with configured triage model + invocation log assertions
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r5-31-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const reports = [
    "支付和库存全部通过，无异常。",
    "支付 100 笔仅成功 2 笔，库存检查全部通过。",
    "支付请求连续失败，库存检查全部通过。",
  ]
  let idx = 0
  const modelCalls: Array<{ outputText: string; deliveryPolicy: string }> = []

  const h = await openHarness(dir, {
    backend: makeAcpToolBackend(() => ({ text: reports[idx++] ?? "支付和库存全部通过，无异常。" })),
    triageModel: () => async packet => {
      const outputText = String(packet.outputText ?? "")
      modelCalls.push({ outputText, deliveryPolicy: String(packet.deliveryPolicy ?? "") })
      if (outputText.includes("仅成功 2 笔")) {
        return {
          kind: "deliver_result",
          summary: "支付异常告警：支付 100 笔仅成功 2 笔（成功率严重偏低），库存检查正常。",
          reason: "Severe payment success-rate drop detected",
        }
      }
      return {
        kind: "deliver_result",
        summary: `支付异常告警：${outputText}`,
        reason: "Payment anomaly detected",
      }
    },
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("MetricAnomaly", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Payment & Inventory Patrol",
      prompt: "Check payment and inventory status",
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

  // Row 1: Clean report -> 0 model calls, 0 main chat messages, delivered=false
  const rClean = await runAndWait()
  assert.equal(modelCalls.length, 0, "Clearly clean report must stay quiet without invoking triage model")
  let snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 0)

  // Row 2: Quantitative payment anomaly + clean inventory -> MUST invoke triage model & push payment anomaly alert!
  const rMetricAnomaly = await runAndWait()
  assert.equal(modelCalls.length, 1, "Configured triage model MUST be invoked for quantitative mixed report")
  assert.equal(modelCalls[0]!.outputText, "支付 100 笔仅成功 2 笔，库存检查全部通过。")
  assert.equal(modelCalls[0]!.deliveryPolicy, "exceptions_only")
  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 1)
  const metricMsg = snap.messages.find(m => m.provenance?.runId === rMetricAnomaly.id)!
  assert.match(metricMsg.text, /支付异常/)
  assert.match(metricMsg.text, /100 笔仅成功 2 笔/)

  // Row 3: Explicit payment failure + clean inventory -> invokes triage model & pushes alert
  const rFailAnomaly = await runAndWait()
  assert.equal(modelCalls.length, 2)
  snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snap.messages.length, 2)
  assert.ok(snap.messages.some(m => m.provenance?.runId === rFailAnomaly.id && m.text.includes("支付请求连续失败")))

  const hist = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 20,
  }, userA) as FollowUpRunsPage
  assert.equal(hist.runs.find(r => r.runId === rClean.id)?.delivered, false)
  assert.equal(hist.runs.find(r => r.runId === rMetricAnomaly.id)?.delivered, true)
  assert.equal(hist.runs.find(r => r.runId === rFailAnomaly.id)?.delivered, true)
})

// ============================================================================
// 到点执行对照：经典用户与显式订阅用户的原生计划均按时完成，仅显式订阅者在 SA 主对话收到 1 条日报
// ============================================================================
test("R5 due-trigger control: classic user and explicitly subscribed user both complete on schedule while only subscribed user receives SA delivery", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r5-due-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  let clockMs = Date.parse("2026-11-24T01:00:00.000Z")
  const now = () => new Date(clockMs)

  const h = await openHarness(dir, {
    now,
    backend: makeAcpToolBackend(prompt => ({ text: `按时触发日报：${prompt}` })),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("DueControlR5", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")

  const classicTask = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Classic Due Task",
      prompt: "Classic check",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 30 },
    },
  }, userClassic) as ScheduledTask

  const subscribedTask = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Subscribed Due Task",
      prompt: "Subscribed check",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 30 },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: subscribedTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  clockMs += 31 * 60_000
  h.schedules.start()

  await eventually(
    () => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => {
      const c = list.find(item => item.id === classicTask.id)
      const s = list.find(item => item.id === subscribedTask.id)
      return Boolean(c?.runs.some(r => r.state === "completed") && s?.runs.some(r => r.state === "completed"))
    },
  )

  const saSnap = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.scheduleId === subscribedTask.id))
  assert.equal(saSnap.messages.length, 1)
  assert.match(saSnap.messages[0]!.text, /按时触发日报：Subscribed check/)
  assert.equal(h.followUpStore.getAuth(userClassic.userId!), undefined)
  assert.equal((await h.followUpStore.listRuns({ userId: userClassic.userId!, workspaceId: wsId })).runs.length, 0)
  assert.equal(h.superStore.get(userClassic.userId!), undefined)
})
