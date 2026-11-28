import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { HttpError } from "@deskfleet/client/request-diagnostics"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import { eventually, makeAcpToolBackend, openHarness, type FollowUpHarness } from "../fixtures/follow-up-harness.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import type {
  FollowUpAuthReceipt,
  FollowUpRunsPage,
  FollowUpSourcesResponse,
} from "@deskfleet/protocol/super-agent-follow-up"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import type { SuperDecisionModel } from "./router.ts"
import type { ScheduleRunEvidence } from "./schedule-evidence.ts"

const userA: AgentActor = { kind: "user", userId: "user-a", deviceId: "login-a" }
const userB: AgentActor = { kind: "user", userId: "user-b", deviceId: "login-b" }
const userC: AgentActor = { kind: "user", userId: "user-c", deviceId: "login-c" }
const userClassic: AgentActor = { kind: "user", userId: "user-classic", deviceId: "login-classic" }

async function sendMainChat(h: FollowUpHarness, workspaceId: string, actor: AgentActor, text: string): Promise<{ snapshot: SuperSnapshot; reply: string }> {
  const messageId = randomUUID()
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId, messageId, text }, actor)
  const snapshot = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.id === messageId && m.state !== "routing"),
  )
  const userMsg = snapshot.messages.find(m => m.id === messageId)
  assert.equal(userMsg?.state, "answered", `Expected answered for "${text}", got ${userMsg?.state}: ${userMsg?.reason}`)
  const reply = snapshot.messages.filter(m => m.role === "assistant" && m.sourceMessageId === messageId).map(m => m.text).join("\n")
  return { snapshot, reply }
}

/** Gated ACP backend that supports pausing a named prompt mid-turn while streaming live tool + commentary progress. */
function makeGatedAcpBackend(handler: (prompt: string, tools: {
  emitText: (text: string, meta?: { phase?: string; purpose?: string }) => Promise<void>
  emitTool: (toolCallId: string, title: string, status: "in_progress" | "completed") => Promise<void>
}) => Promise<void>) {
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
        await handler(promptText, {
          emitText: async (text, meta) => {
            await client.onUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
                ...(meta ? { _meta: { deskfleet: meta } } : {}),
              },
            })
          },
          emitTool: async (toolCallId, title, status) => {
            await client.onUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update",
                toolCallId,
                title,
                ...(status === "in_progress" ? { kind: "read" } : {}),
                status,
              },
            })
          },
        })
        return { stopReason: "end_turn" }
      },
    }
  }
  return backend
}

// ============================================================================
// 1. Phase 1 Core E2E:
//    2 existing schedules -> 1-click "接管全部定时任务" -> create 1 from SA + 1 from original form
//    -> all 4 execute on original settings -> query ONLY in SA main chat for running progress &
//    exact-run substantive conclusions -> verify proactive delivery counts -> stop follow-up
//    -> verify all 4 still execute on schedule with 0 new SA deliveries!
//    Also verifies upgrade/open-chat/other-user non-auto-takeover and exact-run isolation on shared sessions.
// ============================================================================
test("Phase 1 E2E: global schedule takeover covers 2 existing + SA-created + form-created schedules, answers live progress & exact-run evidence in main chat, and leaves native schedules intact when stopped", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-phase1-e2e-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  // Start clock 31m behind real time so 30m interval schedules become due immediately when we advance offsetMs.
  let offsetMs = -90 * 60_000
  const now = () => new Date(Date.now() + offsetMs)

  let s2RunSeq = 0
  let s3RunSeq = 0
  let existingRunSeq = 0
  let s3StartedResolve!: () => void
  const s3Started = new Promise<void>(resolve => { s3StartedResolve = resolve })
  let releaseS3Resolve!: () => void
  const releaseS3 = new Promise<void>(resolve => { releaseS3Resolve = resolve })

  const backend = makeGatedAcpBackend(async (prompt, tools) => {
    if (prompt.includes("DAILY_RECON")) {
      await tools.emitText("今日对账无变化，全部 128 笔订单已平账。", { phase: "final_answer", purpose: "final_answer" })
      return
    }
    if (prompt.includes("PAYMENT_INVENTORY")) {
      s2RunSeq += 1
      if (s2RunSeq === 1) {
        await tools.emitText("支付和库存全部通过，无异常。", { phase: "final_answer", purpose: "final_answer" })
      } else {
        await tools.emitText("支付 100 笔仅成功 2 笔，库存检查全部通过。", { phase: "final_answer", purpose: "final_answer" })
      }
      return
    }
    if (prompt.includes("BUILD_REGRESSION")) {
      s3RunSeq += 1
      if (s3RunSeq === 1) {
        await tools.emitText("正在扫描构建与单测日志，稍后汇总结果。", { phase: "commentary", purpose: "activity" })
        await tools.emitTool("tc-scan-1", "扫描单元测试日志", "in_progress")
        s3StartedResolve()
        await releaseS3
        await tools.emitTool("tc-scan-1", "扫描单元测试日志", "completed")
        // Intentionally end Run 1 WITHOUT a final conclusion to test progress-only distinction!
        return
      }
      await tools.emitTool("tc-scan-2", "扫描单元测试日志", "in_progress")
      await tools.emitTool("tc-scan-2", "扫描单元测试日志", "completed")
      await tools.emitText("回归测试完成：全部 42 项用例通过，无失败。", { phase: "final_answer", purpose: "final_answer" })
      return
    }
    if (prompt.includes("DEPS_DAILY")) {
      await tools.emitText("依赖安全日报：未发现高危 CVE，有 2 个次要补丁待安排升级。", { phase: "final_answer", purpose: "final_answer" })
      return
    }
    if (prompt.includes("SHARED_SESSION_CHECK")) {
      existingRunSeq += 1
      if (existingRunSeq === 1) {
        await tools.emitText("第一轮缓存体检结论：Redis 命中率 99.2%，无积压。", { phase: "final_answer", purpose: "final_answer" })
      } else {
        await tools.emitText("第二轮缓存体检结论：热点 key 淘汰突增 4 倍，需扩容。", { phase: "final_answer", purpose: "final_answer" })
      }
      return
    }
    await tools.emitText("已完成检查，无异常。", { phase: "final_answer", purpose: "final_answer" })
  })

  const triageCalls: Record<string, unknown>[] = []
  const triageModel = () => async (packet: Record<string, unknown>) => {
    triageCalls.push(packet)
    const text = String(packet.outputText ?? "")
    if (text.includes("仅成功 2 笔")) {
      return {
        kind: "deliver_result",
        summary: "支付异常告警：支付 100 笔仅成功 2 笔（成功率 2%），库存检查全部通过，需立即排查支付通道。",
        reason: "Payment success rate dropped severely despite clean inventory check",
      }
    }
    return { kind: "record_quietly", summary: text, reason: "Normal" }
  }

  // Deterministic coordinator model exercising real routeSuperMessage + read-only scheduleRuns evidence + schedule actions.
  const model: SuperDecisionModel = async packet => {
    const message = String(packet.message ?? "")
    const schedules = (packet.schedules ?? []) as Array<{
      id: string; title: string; activeRun?: { runId: string; state: string }; lastRun?: { runId: string; state: string }
    }>
    const evidence = (packet.evidence ?? []) as Array<{ request: { kind: string; scheduleId?: string; runId?: string }; result: string }>

    if (message.includes("接管全部定时任务")) {
      return { reason: "Take over all owned schedules", actions: [{ kind: "schedule", operation: "adopt_all" }] }
    }
    if (message.includes("停止全部定时任务跟进")) {
      return { reason: "Stop SA follow-up on all schedules", actions: [{ kind: "schedule", operation: "stop_all_follow_up" }] }
    }
    if (message.includes("新建定时任务：构建回归巡检")) {
      return {
        reason: "Create Build Regression schedule from SA main chat",
        actions: [{
          kind: "schedule",
          operation: "create",
          title: "构建回归巡检",
          prompt: "BUILD_REGRESSION 检查构建与单测日志",
          targetKind: "directory",
          trigger: { kind: "interval", minutes: 30 },
          deliveryPolicy: "every_run",
        }],
      }
    }
    if (message.includes("哪条还在跑")) {
      const running = schedules.filter(s => !!s.activeRun)
      if (!evidence.length && running.length) {
        return {
          reason: "Read live execution evidence for running schedule(s)",
          actions: running.map(s => ({
            kind: "evidence",
            request: { kind: "scheduleRuns", scheduleId: s.id, runId: s.activeRun!.runId, limit: 1 },
          })),
        }
      }
      const lines = evidence.map(ev => {
        const parsed = JSON.parse(ev.result) as { title: string; runs: ScheduleRunEvidence[] }
        const r = parsed.runs[0]!
        return `「${parsed.title}」仍在运行（运行 ${r.runId}，状态 ${r.evidenceStatus}，尚无最终结论）：当前进度：${r.progress}`
      })
      return {
        reason: "Report running schedules with live progress",
        actions: [{ kind: "answer", text: lines.length ? `目前仍在运行的计划：\n${lines.join("\n")}` : "当前没有正在运行的计划任务。" }],
      }
    }
    const inspectMatch = /^查询指定运行:([^:]+):(.+)$/u.exec(message.trim())
    if (inspectMatch) {
      const [, schedTitle, targetRunId] = inspectMatch
      const sched = schedules.find(s => s.title === schedTitle)!
      if (!evidence.length) {
        return {
          reason: "Inspect exact run evidence",
          actions: [{ kind: "evidence", request: { kind: "scheduleRuns", scheduleId: sched.id, runId: targetRunId, limit: 1 } }],
        }
      }
      const parsed = JSON.parse(evidence[0]!.result) as { title: string; runs: ScheduleRunEvidence[] }
      const r = parsed.runs[0]
      if (!r) {
        return { reason: "Run not found", actions: [{ kind: "answer", text: `未找到「${parsed.title}」的运行 ${targetRunId}。` }] }
      }
      if (r.evidenceStatus === "concluded") {
        return {
          reason: "Answer with exact run conclusion",
          actions: [{
            kind: "answer",
            text: `「${parsed.title}」运行 ${r.runId} 已得出结论（来源：${r.summarySource}，主动推送：${r.deliveredToMainChat ? "是" : "否"}）：${r.conclusion}`,
          }],
        }
      }
      if (r.evidenceStatus === "progress_only_no_conclusion") {
        return {
          reason: "Distinguish progress-only from conclusion",
          actions: [{
            kind: "answer",
            text: `「${parsed.title}」运行 ${r.runId} 已结束，但仅有过程进度、尚无最终结论：${r.progress}`,
          }],
        }
      }
      return {
        reason: "Report run status",
        actions: [{ kind: "answer", text: `「${parsed.title}」运行 ${r.runId} 状态为 ${r.evidenceStatus}：${r.error ?? r.progress ?? ""}` }],
      }
    }
    return { reason: "Default", actions: [{ kind: "answer", text: "ok" }] }
  }

  const h = await openHarness(dir, { backend, model, triageModel, now })
  active = h
  const wsId = (await h.catalog.native.createWorkspace("Phase1Project", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id

  // Step 1: Pre-existing 2 schedules owned by userA + 1 owned by userB + 1 ordinary session.
  const s1 = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "每日对账日报", prompt: "DAILY_RECON 生成每日对账日报", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 30 },
    },
  }, userA) as ScheduledTask
  const s2 = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "支付与库存巡检", prompt: "PAYMENT_INVENTORY 巡检支付与库存，仅异常汇报", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 30 },
    },
  }, userA) as ScheduledTask
  const sOther = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "他人归属巡检", prompt: "OTHER_OWNER", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userB) as ScheduledTask

  // Give S2 an explicit prior preference (paused) so we prove takeover preserves existing deliveryPolicy!
  await h.followUp.subscribeSchedule({
    userId: userA.userId!, workspaceId: wsId, scheduleId: s2.id,
    scheduleTitle: s2.title, targetKind: "directory", deliveryPolicy: "exceptions_only", enabled: false,
  })
  // Create an ordinary session owned by userA — Phase 1 must NOT auto-enroll ordinary sessions under schedule takeover.
  const ordinarySession = await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), title: "Ordinary Worker", provider, context: "directory",
  }, userA) as AgentSnapshot

  // Step 2: Opening chat + enabling device background auth alone (without unified takeover) MUST NOT auto-takeover!
  const beforeSnap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(beforeSnap.followUp?.adoptAllSchedules, false)
  const authReceipt = await h.enableAuth(userA, "inst-mac", { takeoverAllSessions: false })
  assert.equal(authReceipt.authorized, true)
  assert.equal(authReceipt.summary.takeoverAllSessions, false, "enabling device auth alone must NOT auto-takeover")
  assert.equal(authReceipt.summary.adoptAllSchedules, false, "enabling device auth alone must NOT auto-takeover schedules")
  assert.equal(h.followUp.getScheduleSubscription(userA.userId!, wsId, s1.id), undefined)
  assert.equal(h.followUp.getScheduleSubscription(userA.userId!, wsId, s2.id)?.enabled, false)

  // Also test another user enabling takeover does NOT affect userA.
  await h.enableAuth(userB, "inst-b", { takeoverAllSessions: false })
  await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "configure", adoptAllSchedules: true }, userB)
  assert.equal(h.followUp.hasAdoptAllSchedules(userA.userId!), false, "other user takeover must never affect userA")
  assert.equal(h.followUp.getScheduleSubscription(userB.userId!, wsId, s1.id), undefined, "userB cannot adopt userA's schedule")

  // Step 3: ONE single unified takeover choice (covers existing owned schedules + ordinary sessions, preserving deliveryPolicy).
  const takeoverReceipt = await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
    action: "configure", adoptAllSchedules: true,
  }, userA) as FollowUpAuthReceipt
  assert.equal(takeoverReceipt.summary.adoptAllSchedules, true)
  assert.equal(takeoverReceipt.summary.takeoverAllSessions, true)
  assert.equal(takeoverReceipt.summary.subscribedScheduleCount, 2, "both existing owned schedules active after one click")
  assert.equal(h.followUp.getScheduleSubscription(userA.userId!, wsId, s1.id)?.deliveryPolicy, "every_run")
  assert.equal(h.followUp.getScheduleSubscription(userA.userId!, wsId, s2.id)?.deliveryPolicy, "exceptions_only", "existing deliveryPolicy preserved")
  assert.equal(h.followUp.getScheduleSubscription(userA.userId!, wsId, sOther.id), undefined, "other user's schedule not taken over")
  assert.equal(h.followUpStore.getSource(userA.userId!, wsId, "session", ordinarySession.session.id)?.state.enabled, true, "ordinary session included in unified takeover")

  // Verify SA main chat adopt_all is wired to the exact same persistence logic (idempotent).
  const adoptChat = await sendMainChat(h, wsId, userA, "帮我接管全部定时任务")
  assert.match(adoptChat.reply, /all your scheduled tasks/i)
  assert.equal(h.followUp.authSummary(userA.userId!).adoptAllSchedules, true)

  // Step 4: Create S3 from SA main chat AND S4 from original form RPC (ZERO per-schedule subscription calls!).
  const createS3Chat = await sendMainChat(h, wsId, userA, "新建定时任务：构建回归巡检")
  assert.match(createS3Chat.reply, /Created scheduled task \*\*构建回归巡检\*\*/)
  const s3 = h.schedules.snapshot().find(task => task.title === "构建回归巡检")!
  assert.ok(s3, "S3 created in native scheduler")

  const s4 = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "依赖安全日报", prompt: "DEPS_DAILY 生成依赖安全日报", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 30 },
    },
  }, userA) as ScheduledTask
  // Wait for durable schedule_created event to drain and materialize S4 automatically.
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.followUpStore.getSource(userA.userId!, wsId, "schedule", s4.id)
  }, src => !!src?.state.enabled && !src.state.pausedReason)
  assert.equal(h.followUp.authSummary(userA.userId!, wsId).subscribedScheduleCount, 4, "all 4 schedules actively followed without per-schedule subscribing")

  // Step 5: Advance clock so all 4 schedules trigger on schedule via native tick()!
  offsetMs = -59 * 60_000
  const tickPromise = h.schedules.tick()
  // Wait for S1, S2 (Run 1), and S4 to complete, while S3 stays actively running on its gate!
  await s3Started
  await eventually(
    () => Promise.resolve(h.schedules.snapshot()),
    list =>
      list.find(x => x.id === s1.id)?.runs.some(r => r.state === "completed") === true
      && list.find(x => x.id === s2.id)?.runs.some(r => r.state === "completed") === true
      && list.find(x => x.id === s4.id)?.runs.some(r => r.state === "completed") === true
      && list.find(x => x.id === s3.id)?.runs.some(r => r.state === "running") === true,
  )
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    const snap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
    const runs = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, limit: 50 }, userA) as FollowUpRunsPage
    return { snap, runs }
  }, ({ snap, runs }) =>
    snap.messages.some(m => m.provenance?.scheduleId === s1.id && m.text.includes("今日对账无变化"))
    && snap.messages.some(m => m.provenance?.scheduleId === s4.id && m.text.includes("依赖安全日报"))
    && runs.runs.some(r => r.scheduleId === s2.id && r.status === "completed"))

  // Step 6A: Query ONLY in SA main chat while S3 is STILL RUNNING -> "哪条还在跑？"
  const runningQuery = await sendMainChat(h, wsId, userA, "哪条还在跑？")
  t.diagnostic(`Main chat [哪条还在跑？]: ${runningQuery.reply}`)
  assert.match(runningQuery.reply, /构建回归巡检/)
  assert.match(runningQuery.reply, /in_progress/)
  assert.match(runningQuery.reply, /尚无最终结论/)
  assert.match(runningQuery.reply, /扫描单元测试日志/)

  // Release S3 Run 1 (which ends with progress only and NO final conclusion).
  releaseS3Resolve()
  await tickPromise
  await eventually(
    () => Promise.resolve(h.schedules.inspectTask(s3.id)!.task.runs),
    runs => runs.some(r => r.state === "completed"),
  )
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "schedule", sourceId: s3.id, limit: 10 }, userA) as Promise<FollowUpRunsPage>
  }, page => page.runs.some(r => r.status === "completed"))

  const s3Run1 = h.schedules.inspectTask(s3.id)!.task.runs[0]!
  const s3History1 = (await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "schedule", sourceId: s3.id, limit: 10 }, userA) as FollowUpRunsPage).runs.find(r => r.runId === s3Run1.id)!
  assert.equal(s3History1.delivered, false, "progress-only run must NOT be marked delivered=true")

  // Query S3 Run 1 in main chat -> explicitly distinguishes progress-only from final conclusion!
  const s3ProgressOnlyQuery = await sendMainChat(h, wsId, userA, `查询指定运行:构建回归巡检:${s3Run1.id}`)
  t.diagnostic(`Main chat [S3 progress-only]: ${s3ProgressOnlyQuery.reply}`)
  assert.match(s3ProgressOnlyQuery.reply, /仅有过程进度、尚无最终结论/)
  assert.match(s3ProgressOnlyQuery.reply, /扫描单元测试日志/)

  // Trigger S2 Run 2 (mixed payment anomaly under exceptions_only -> MUST alert and call triageModel!).
  const s2Run1 = h.schedules.inspectTask(s2.id)!.task.runs[0]!
  const s2Run2 = await h.operations.handle("scheduleRun", { scheduleId: s2.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(h.schedules.inspectTask(s2.id)!.task.runs), runs => runs.some(r => r.id === s2Run2.id && r.state === "completed"))
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.provenance?.scheduleId === s2.id && m.provenance?.runId === s2Run2.id))

  // Step 6B: Query S2 Run 1 (clean quiet run) AND S2 Run 2 (mixed anomaly) separately — NEVER substitute another run!
  const s2CleanQuery = await sendMainChat(h, wsId, userA, `查询指定运行:支付与库存巡检:${s2Run1.id}`)
  t.diagnostic(`Main chat [S2 Run1 clean quiet]: ${s2CleanQuery.reply}`)
  assert.match(s2CleanQuery.reply, /主动推送：否/)
  assert.match(s2CleanQuery.reply, /支付和库存全部通过，无异常/)
  assert.ok(!s2CleanQuery.reply.includes("仅成功 2 笔"), "Run 1 query must never return Run 2's conclusion")

  const s2AnomalyQuery = await sendMainChat(h, wsId, userA, `查询指定运行:支付与库存巡检:${s2Run2.id}`)
  t.diagnostic(`Main chat [S2 Run2 anomaly]: ${s2AnomalyQuery.reply}`)
  assert.match(s2AnomalyQuery.reply, /主动推送：是/)
  assert.match(s2AnomalyQuery.reply, /支付异常告警|仅成功 2 笔/)
  assert.ok(triageCalls.length >= 1, "triage model was invoked for mixed anomaly")

  // Step 6C: Exact-run evidence on a shared "existing" session WITHOUT persisted SA summary (2 runs on 1 session!).
  const sharedSess = await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), title: "Shared Cache Check Session", provider, context: "directory",
  }, userA) as AgentSnapshot
  const sShared = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "缓存共享会话巡检", prompt: "SHARED_SESSION_CHECK", workspaceId: wsId, enabled: true,
      target: { kind: "existing", sessionId: sharedSess.session.id },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  // Explicitly opt out SA follow-up on sShared so it has ZERO persisted FollowUpRunRecord summaries!
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: sShared.id, enabled: false,
  }, userA)
  const sharedRun1 = await h.operations.handle("scheduleRun", { scheduleId: sShared.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(h.schedules.inspectTask(sShared.id)!.task.runs), runs => runs.some(r => r.id === sharedRun1.id && r.state === "completed"))
  const sharedRun2 = await h.operations.handle("scheduleRun", { scheduleId: sShared.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(h.schedules.inspectTask(sShared.id)!.task.runs), runs => runs.some(r => r.id === sharedRun2.id && r.state === "completed"))
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "schedule", sourceId: sShared.id, limit: 10 }, userA) as FollowUpRunsPage).runs.length, 0)

  const sharedQ1 = await sendMainChat(h, wsId, userA, `查询指定运行:缓存共享会话巡检:${sharedRun1.id}`)
  const sharedQ2 = await sendMainChat(h, wsId, userA, `查询指定运行:缓存共享会话巡检:${sharedRun2.id}`)
  t.diagnostic(`Main chat [Shared Run1 without summary]: ${sharedQ1.reply}`)
  t.diagnostic(`Main chat [Shared Run2 without summary]: ${sharedQ2.reply}`)
  assert.match(sharedQ1.reply, /来源：run_turn_evidence/)
  assert.match(sharedQ1.reply, /Redis 命中率 99\.2%/)
  assert.ok(!sharedQ1.reply.includes("热点 key 淘汰"), "Run 1 MUST NOT pull Run 2's conclusion from the same session")
  assert.match(sharedQ2.reply, /来源：run_turn_evidence/)
  assert.match(sharedQ2.reply, /热点 key 淘汰突增 4 倍/)
  assert.ok(!sharedQ2.reply.includes("99.2%"), "Run 2 MUST NOT pull Run 1's conclusion from the same session")

  // Cross-user permission guard: userB's schedule run MUST NOT leak its turn content to userA!
  const otherRun = await h.operations.handle("scheduleRun", { scheduleId: sOther.id }, userB) as ScheduleRun
  await eventually(() => Promise.resolve(h.schedules.inspectTask(sOther.id)!.task.runs), runs => runs.some(r => r.id === otherRun.id && r.state === "completed"))
  const restrictedQ = await sendMainChat(h, wsId, userA, `查询指定运行:他人归属巡检:${otherRun.id}`)
  t.diagnostic(`Main chat [Other owner restricted]: ${restrictedQ.reply}`)
  assert.match(restrictedQ.reply, /restricted/)
  assert.ok(!restrictedQ.reply.includes("已完成检查，无异常"), "must not leak another user's turn output")

  // Step 7: Verify exact proactive delivery counts across all 4 taken-over schedules!
  const snapBeforeStop = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  const proactiveBySchedule = (sid: string) => snapBeforeStop.messages.filter(m => m.provenance?.origin === "sa_follow_up" && m.provenance.scheduleId === sid)
  const countsBeforeStop = {
    s1DailyNoChange: proactiveBySchedule(s1.id).length,
    s2ExceptionsTotal: proactiveBySchedule(s2.id).length,
    s2Run1CleanPushed: proactiveBySchedule(s2.id).filter(m => m.provenance?.runId === s2Run1.id).length,
    s2Run2AnomalyPushed: proactiveBySchedule(s2.id).filter(m => m.provenance?.runId === s2Run2.id).length,
    s3NoticeOnly: proactiveBySchedule(s3.id).length,
    s4FormCreated: proactiveBySchedule(s4.id).length,
  }
  t.diagnostic(`Proactive counts before stop: ${JSON.stringify(countsBeforeStop)}`)
  assert.deepEqual(countsBeforeStop, {
    s1DailyNoChange: 1,
    s2ExceptionsTotal: 1,
    s2Run1CleanPushed: 0,
    s2Run2AnomalyPushed: 1,
    s3NoticeOnly: 1, // notice explaining no formal final conclusion (run.delivered === false)
    s4FormCreated: 1,
  })
  const totalFollowUpMsgsBeforeStop = snapBeforeStop.messages.filter(m => m.provenance?.origin === "sa_follow_up").length
  const totalFollowUpRunsBeforeStop = (await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, limit: 50 }, userA) as FollowUpRunsPage).runs.length

  // Step 8: Stop SA follow-up -> native schedules keep exact enabled/trigger/target/nextRunAt and ALL 4 still run on time!
  const beforeConfig = [s1.id, s2.id, s3.id, s4.id].map(id => {
    const task = h.schedules.inspectTask(id)!.task
    return { id, enabled: task.enabled, trigger: task.trigger, target: task.target, nextRunAt: task.nextRunAt, runCount: task.runs.length }
  })
  const stopChat = await sendMainChat(h, wsId, userA, "停止全部定时任务跟进")
  t.diagnostic(`Main chat [stop_all_follow_up]: ${stopChat.reply}`)
  assert.equal(h.followUp.authSummary(userA.userId!).adoptAllSchedules, false)

  for (const prev of beforeConfig) {
    const after = h.schedules.inspectTask(prev.id)!.task
    assert.equal(after.enabled, prev.enabled, "stopping SA follow-up must NOT disable native schedule")
    assert.deepEqual(after.trigger, prev.trigger, "stopping SA follow-up must NOT alter trigger")
    assert.deepEqual(after.target, prev.target, "stopping SA follow-up must NOT alter target")
    assert.equal(after.nextRunAt, prev.nextRunAt, "stopping SA follow-up must NOT alter nextRunAt")
  }

  // Advance clock by 31 minutes and trigger due tick -> ALL 4 native schedules execute and complete!
  offsetMs = -28 * 60_000
  await h.schedules.tick()
  await eventually(
    () => Promise.resolve([s1.id, s2.id, s3.id, s4.id].map((id, i) => ({
      count: h.schedules.inspectTask(id)!.task.runs.filter(r => r.state === "completed").length,
      prevCount: beforeConfig[i]!.runCount,
    }))),
    rows => rows.every(r => r.count >= r.prevCount + 1),
  )
  await h.followUp.drainScheduleEvents()
  await delay(50)

  const snapAfterStop = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  const runsAfterStop = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, limit: 50 }, userA) as FollowUpRunsPage
  assert.equal(snapAfterStop.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, totalFollowUpMsgsBeforeStop, "0 new SA proactive pushes after stop")
  assert.equal(runsAfterStop.runs.length, totalFollowUpRunsBeforeStop, "0 new SA follow-up run rows after stop")
})

// ============================================================================
// 2. Classic user control: never enabled SA -> native schedules complete on schedule,
//    SA main chat = 0 and follow-up history = 0 even while another user enabled global takeover.
// ============================================================================
test("Phase 1 control: classic user who never enabled SA completes schedules on time with 0 SA messages and 0 follow-up history", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-phase1-classic-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let offsetMs = -31 * 60_000
  const now = () => new Date(Date.now() + offsetMs)
  const h = await openHarness(dir, {
    now,
    backend: makeAcpToolBackend(() => ({ text: "经典模式巡检完成：一切正常。" })),
  })
  active = h
  const wsId = (await h.catalog.native.createWorkspace("ClassicProject", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id

  // Another user in the same daemon enables SA + global takeover.
  await h.enableAuth(userA, "inst-a")
  await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "configure", adoptAllSchedules: true }, userA)

  // Classic user creates 2 native schedules and never touches SA.
  const c1 = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "经典每日巡检", prompt: "Check logs", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 30 },
    },
  }, userClassic) as ScheduledTask
  const c2 = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "经典构建备份", prompt: "Verify backup", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "interval", minutes: 30 },
    },
  }, userClassic) as ScheduledTask

  offsetMs = 0
  await h.schedules.tick()
  await eventually(
    () => Promise.resolve([c1.id, c2.id].map(id => h.schedules.inspectTask(id)!.task.runs)),
    all => all.every(runs => runs.some(r => r.state === "completed")),
  )
  await h.followUp.drainScheduleEvents()
  await delay(50)

  const classicSnap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userClassic) as SuperSnapshot
  const classicRuns = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, limit: 20 }, userClassic) as FollowUpRunsPage
  const userASnap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(classicSnap.messages.length, 0, "classic user receives 0 SA messages")
  assert.equal(classicRuns.runs.length, 0, "classic user has 0 follow-up history rows")
  assert.equal(userASnap.messages.length, 0, "userA receives 0 cross-user messages from classic user's schedules")
})

// ============================================================================
// 3. SA create WITHOUT background auth -> clearly separates "已创建" vs "等待授权跟进",
//    and granting auth later auto-attaches to the original schedule WITHOUT global takeover,
//    WITHOUT recreating, and WITHOUT per-schedule subscribing.
// ============================================================================
test("Phase 1 auth flow: SA-created schedule without background auth clearly distinguishes Created vs Waiting for authorization and auto-attaches once authorized", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-phase1-noauth-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let runSeq = 0
  const model: SuperDecisionModel = async () => ({
    reason: "Create schedule directly in SA chat without requiring global takeover",
    actions: [{
      kind: "schedule",
      operation: "create",
      title: "每日上线前健康检查",
      prompt: "检查线上网关与数据库健康状态并生成日报",
      targetKind: "directory",
      trigger: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
      deliveryPolicy: "every_run",
    }],
  })
  const h = await openHarness(dir, {
    model,
    backend: makeAcpToolBackend(() => ({
      text: ++runSeq === 1 ? "授权前第 1 次健康检查：不得补发。" : "授权后第 2 次健康检查：网关与数据库全部正常。",
    })),
  })
  active = h
  const wsId = (await h.catalog.native.createWorkspace("ReleaseProject", [{ path: project }])).id
  await h.providers.create({ template: "codex", name: "Codex", env: {} })

  // Pre-condition: userC has NEITHER background auth NOR global schedule takeover.
  assert.equal(h.followUp.isAuthorized(userC.userId!), false)
  assert.equal(h.followUp.hasAdoptAllSchedules(userC.userId!), false)

  // Create schedule via SA main chat while missing background authorization.
  const { reply } = await sendMainChat(h, wsId, userC, "帮我每天上午 9 点做一次上线前健康检查")
  t.diagnostic(`Main chat [SA create without auth]: ${reply}`)
  assert.match(reply, /Created.*已创建/u, "explicitly states schedule is Created")
  assert.match(reply, /Waiting for background authorization.*等待授权跟进/u, "explicitly states SA follow-up is waiting for authorization")
  assert.match(reply, /background follow-up authorization/i, "explains what permission is needed")
  assert.match(reply, /automatically follow/i, "promises automatic attach once authorized")

  const created = h.schedules.snapshot().find(task => task.title === "每日上线前健康检查")!
  assert.ok(created, "native schedule created immediately")
  assert.equal(created.enabled, true)
  const sourcesBefore = await h.frontDesk.handle("_deskfleet/super-agent/followUpSources", { workspaceId: wsId }, userC) as FollowUpSourcesResponse
  assert.equal(sourcesBefore.auth.authorized, false)
  assert.equal(sourcesBefore.auth.adoptAllSchedules, false)
  assert.equal(sourcesBefore.auth.pendingAuthScheduleCount, 1)
  assert.equal(sourcesBefore.sources.find(s => s.sourceId === created.id)?.state.pausedReason, "awaiting_authorization")

  // Run #1 before authorization: native schedule executes fine, SA MUST stay completely silent (no auth bypass!).
  const run1 = await h.operations.handle("scheduleRun", { scheduleId: created.id }, userC) as ScheduleRun
  await eventually(() => Promise.resolve(h.schedules.inspectTask(created.id)!.task.runs), runs => runs.some(r => r.id === run1.id && r.state === "completed"))
  await h.followUp.drainScheduleEvents()
  await delay(40)
  const snapBeforeAuth = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userC) as SuperSnapshot
  assert.equal(snapBeforeAuth.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, 0, "no follow-up delivery before auth")

  // Restart daemon BEFORE granting authorization to prove staged awaiting_authorization survives restart!
  active = undefined
  await h.close()
  const h2 = await openHarness(dir, {
    model,
    backend: makeAcpToolBackend(() => ({ text: "授权后第 2 次健康检查：网关与数据库全部正常。" })),
  })
  active = h2

  // Granting bare device auth without unified takeover keeps takeover OFF; turning ON unified takeover attaches the staged schedule!
  await delay(25)
  const bareAuthReceipt = await h2.enableAuth(userC, "inst-mac-c", { takeoverAllSessions: false })
  assert.equal(bareAuthReceipt.authorized, true)
  assert.equal(bareAuthReceipt.summary.takeoverAllSessions, false, "granting bare device auth does NOT force unified takeover")
  const enabledReceipt = await h2.enableAuth(userC, "inst-mac-c", { takeoverAllSessions: true })
  assert.equal(enabledReceipt.authorized, true)
  assert.equal(enabledReceipt.summary.takeoverAllSessions, true)
  assert.equal(enabledReceipt.summary.pendingAuthScheduleCount, 0)
  assert.equal(enabledReceipt.summary.subscribedScheduleCount, 1, "original schedule auto-attached after restart!")
  const subAfterAuth = h2.followUp.getScheduleSubscription(userC.userId!, wsId, created.id)
  assert.equal(subAfterAuth?.enabled, true)
  assert.equal(subAfterAuth?.deliveryPolicy, "every_run")

  // Verify pre-auth Run #1 is NOT replayed, and Run #2 delivers cleanly once!
  await h2.followUp.drainScheduleEvents()
  const run2 = await h2.operations.handle("scheduleRun", { scheduleId: created.id }, userC) as ScheduleRun
  await eventually(() => Promise.resolve(h2.schedules.inspectTask(created.id)!.task.runs), runs => runs.some(r => r.id === run2.id && r.state === "completed"))
  const snapAfterAuth = await eventually(async () => {
    await h2.followUp.drainScheduleEvents()
    return h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userC) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.provenance?.origin === "sa_follow_up" && m.provenance.runId === run2.id))

  const followUpMsgs = snapAfterAuth.messages.filter(m => m.provenance?.origin === "sa_follow_up")
  assert.equal(followUpMsgs.length, 1, "only post-auth Run #2 delivered")
  assert.match(followUpMsgs[0]!.text, /授权后第 2 次健康检查/)
  assert.ok(!snapAfterAuth.messages.some(m => m.text.includes("不得补发")), "pre-auth run must never replay")
})

// ============================================================================
// 4. Build 33 lost-report path re-verification:
//    - Global schedule takeover + pause + revoke_all + double-revoke cutoff invariance + restore + restart
//    - Progress-only output MUST NEVER serve as final delivery through the same recovery path
// ============================================================================
test("Phase 1 build-33 re-verify: global takeover pause + revoke_all (with double revoke) recovers pre-pause report once, never bypasses auth, and never delivers progress-only as final", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-phase1-b33-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let auth503 = false
  let reportRunSeq = 0
  const formalReport = "暂停撤权前已完成的资金对账日报：1,200 笔全部平账。"
  const followUpAuthorize = async (actor: AgentActor) => {
    if (auth503 && actor.deviceId === "follow-up-delegation") throw new HttpError(503, "Central auth temporarily unavailable")
    return actor
  }
  const backend = makeAcpToolBackend(prompt => {
    if (prompt.includes("PROGRESS_ONLY_TASK")) {
      return {
        events: [
          { kind: "text", text: "我先查一下对账明细，稍后给你结论。" },
          { kind: "tool", title: "查询对账明细" },
        ],
      }
    }
    reportRunSeq += 1
    return {
      text: reportRunSeq === 1 ? formalReport : `撤权停用期间第 ${reportRunSeq - 1} 次运行的日报：不得补发。`,
    }
  })

  const h1 = await openHarness(dir, { followUpAuthorize, backend })
  active = h1
  const wsId = (await h1.catalog.native.createWorkspace("Build33Project", [{ path: project }])).id
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id

  await h1.enableAuth(userA, "inst-mac")
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "configure", adoptAllSchedules: true }, userA)

  const formalTask = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "资金对账日报", prompt: "FORMAL_REPORT", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  const progressTask = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "进度测试日报", prompt: "PROGRESS_ONLY_TASK", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h1.followUp.drainScheduleEvents()

  // 1. Both complete while auth & global takeover are active, but 503 blocks follow-up delivery.
  auth503 = true
  const preFormal = await h1.operations.handle("scheduleRun", { scheduleId: formalTask.id }, userA) as ScheduleRun
  const preProgress = await h1.operations.handle("scheduleRun", { scheduleId: progressTask.id }, userA) as ScheduleRun
  await eventually(
    () => Promise.resolve([h1.schedules.inspectTask(formalTask.id)!.task.runs, h1.schedules.inspectTask(progressTask.id)!.task.runs]),
    ([r1, r2]) => r1.some(x => x.id === preFormal.id && x.state === "completed") && r2.some(x => x.id === preProgress.id && x.state === "completed"),
  )
  await h1.followUp.drainScheduleEvents()
  assert.equal((await h1.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, limit: 20 }, userA) as FollowUpRunsPage).runs.length, 0)

  // 2. Overlap: stop global schedule takeover + revoke_all + run off-period report + second revoke_all (cutoff must NOT shift!).
  await delay(25)
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "configure", adoptAllSchedules: false }, userA)
  await delay(25)
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "revoke_all", installationId: "inst-mac" }, userA)
  auth503 = false
  await h1.followUp.drainScheduleEvents()
  assert.equal(h1.schedules.pendingPrivateEvents().length, 0, "queue consumed while off")

  // Off-period run + second revoke_all while still unauthorized.
  await delay(25)
  const offRun = await h1.operations.handle("scheduleRun", { scheduleId: formalTask.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(h1.schedules.inspectTask(formalTask.id)!.task.runs), runs => runs.some(x => x.id === offRun.id && x.state === "completed"))
  await delay(25)
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "revoke_all", installationId: "inst-mac" }, userA)
  await h1.followUp.drainScheduleEvents()

  // Re-enable takeover BEFORE restoring device auth -> MUST NOT bypass auth!
  await delay(25)
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "configure", adoptAllSchedules: true }, userA)
  await h1.followUp.drainScheduleEvents()
  const snapWhileRevoked = await h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapWhileRevoked.messages.length, 0, "MUST NOT bypass auth while device authorization is revoked")

  // 3. Restore device auth and restart daemon!
  await delay(25)
  await h1.enableAuth(userA, "inst-mac")
  await eventually(async () => {
    await h1.followUp.drainScheduleEvents()
    return h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.text.includes(formalReport)))

  active = undefined
  await h1.close()

  const h2 = await openHarness(dir, { followUpAuthorize, backend })
  active = h2
  await h2.followUp.drainScheduleEvents()
  await delay(50)

  const snapAfterRestart = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  const formalRuns = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "schedule", sourceId: formalTask.id, limit: 20 }, userA) as FollowUpRunsPage
  const progressRuns = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "schedule", sourceId: progressTask.id, limit: 20 }, userA) as FollowUpRunsPage

  assert.equal(snapAfterRestart.messages.filter(m => m.text.includes(formalReport)).length, 1, "formal pre-pause report delivered exactly once")
  assert.equal(formalRuns.runs.filter(r => r.delivered).length, 1, "formal pre-pause report recorded delivered once")
  assert.equal(snapAfterRestart.messages.filter(m => m.text.includes("不得补发")).length, 0, "off-period run never leaks even after double revoke_all")
  assert.equal(snapAfterRestart.messages.some(m => m.text.includes("我先查一下对账明细")), false, "progress-only message MUST NEVER be delivered as report body")
  assert.equal(progressRuns.runs.find(r => r.runId === preProgress.id)?.delivered, false, "progress-only run MUST have delivered=false")
})

// ============================================================================
// 5. Persistence across daemon restart + direct schedule inspect/list evidence:
//    Enabling adoptAllSchedules survives daemon restart and auto-enrolls a brand-new
//    schedule created from the native form after restart; direct schedule inspect(runId)
//    returns substantive run conclusions instead of bare session links.
// ============================================================================
test("Phase 1 persistence & direct inspect: adoptAllSchedules survives restart for post-restart form schedules and direct inspect(runId) returns substantive evidence", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-phase1-persist-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  const model: SuperDecisionModel = async packet => {
    const message = String(packet.message ?? "")
    const schedules = (packet.schedules ?? []) as Array<{ id: string; title: string; lastRun?: { runId: string } }>
    const match = /^DIRECT_INSPECT:([^:]+):(.+)$/u.exec(message.trim())
    if (match) {
      const sched = schedules.find(s => s.title === match[1])!
      return {
        reason: "Direct schedule inspect for specific run",
        actions: [{ kind: "schedule", operation: "inspect", scheduleId: sched.id, runId: match[2] }],
      }
    }
    return { reason: "Default", actions: [{ kind: "answer", text: "ok" }] }
  }
  const backend = makeAcpToolBackend(() => ({
    events: [{ kind: "text", text: "重启后新建表单计划的首次巡检结论：数据库延迟 12ms，无异常。", phase: "final_answer", purpose: "final_answer" }],
  }))

  const h1 = await openHarness(dir, { model, backend })
  active = h1
  const wsId = (await h1.catalog.native.createWorkspace("PersistProject", [{ path: project }])).id
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h1.enableAuth(userA, "inst-mac")
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "configure", adoptAllSchedules: true }, userA)
  assert.equal(h1.followUp.authSummary(userA.userId!).adoptAllSchedules, true)

  // Restart daemon!
  active = undefined
  await h1.close()

  const h2 = await openHarness(dir, { model, backend })
  active = h2
  assert.equal(h2.followUp.authSummary(userA.userId!).adoptAllSchedules, true, "adoptAllSchedules persisted in SQLite across restart")

  // Create a brand-new schedule via original form RPC AFTER restart (no followUpUpdateSource call!).
  const postRestartForm = await h2.operations.handle("scheduleCreate", {
    schedule: {
      title: "重启后表单日报", prompt: "生成重启后数据库健康日报", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask

  // Trigger immediately — even without waiting for schedule_created drain first!
  const run = await h2.operations.handle("scheduleRun", { scheduleId: postRestartForm.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(h2.schedules.inspectTask(postRestartForm.id)!.task.runs), runs => runs.some(r => r.id === run.id && r.state === "completed"))
  const snap = await eventually(async () => {
    await h2.followUp.drainScheduleEvents()
    return h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.origin === "sa_follow_up" && m.provenance.scheduleId === postRestartForm.id))
  assert.equal(snap.messages.filter(m => m.provenance?.scheduleId === postRestartForm.id).length, 1)

  // Direct `schedule inspect` with specific runId returns substantive conclusion!
  const inspected = await sendMainChat(h2, wsId, userA, `DIRECT_INSPECT:重启后表单日报:${run.id}`)
  t.diagnostic(`Main chat [DIRECT_INSPECT]: ${inspected.reply}`)
  assert.match(inspected.reply, /数据库延迟 12ms/)
  assert.ok(inspected.reply.includes(run.id))
})
