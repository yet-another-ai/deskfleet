import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { AgentActor } from "@deskfleet/protocol/agent"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import { eventually, makeAcpToolBackend, openHarness, type ScriptedPlan } from "../fixtures/follow-up-harness.ts"
import { triageFollowUpEvent } from "./triage.ts"

const userA: AgentActor = { kind: "user", userId: "user-redesign-a", deviceId: "mac-redesign-a" }

const LONG_UPDATE_REPORT_RUN_1 = [
  "截至 11 月 26 日，DeskFleet 在 GitHub 上的最新正式版仍是 **v0.23.0**。公开 `main` 已到 `054b8f62`，比正式版多 8 个提交。**建议在本地 `personal/0.23` 上先合机器级会话终端修复，再适配 Markdown 预览，整并 `main` 暂缓。** [正式版](https://github.com/yet-another-ai/deskfleet/releases/tag/v0.23.0)",
  "",
  "`personal/0.23` 已以官方 v0.23.0 为基线，叠加了 11 个 SA 补丁。原 `super-agent` 工作树有 112 个未提交路径，预演合入正式版有 **53 个冲突路径**，合入 `main` 有 **62 个**。`personal/0.23` 整并 `main` 也有 **18 个冲突**。尚未执行任何合入操作。",
  "",
  "| 改动 | 对 SA 的建议 |",
  "| --- | --- |",
  "| 机器级会话终端修复 (#683) | 优先合入 |",
  "| Markdown 预览 | 后续适配 |",
  "| 整并 main | 暂缓，冲突过多 |",
].join("\n")

const LONG_UPDATE_REPORT_RUN_2 = [
  "截至 11 月 27 日，DeskFleet 在 GitHub 上已发布 **v0.24.0** 正式版，包含新的 MCP 权限修复与会话回放优化。**建议安排窗口将 `personal/0.23` 升级到 `v0.24.0` 基线。**",
  "",
  "本次仅完成发布说明与 diff 扫描，尚未创建升级分支，也未运行真机构建。",
  "",
  "| 模块 | 变化 |",
  "| --- | --- |",
  "| daemon | MCP 权限修复 |",
  "| ui | 会话回放优化 |",
].join("\n")

test("Redesign 1: SA summarizes long reports without pasting full text/tables, layers detail separately, links 事项 to same run, and isolates multiple runs of the same schedule", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-redesign-1-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  const plans: ScriptedPlan[] = [
    { text: LONG_UPDATE_REPORT_RUN_1 },
    { text: LONG_UPDATE_REPORT_RUN_2 },
  ]
  let planIdx = 0
  const modelPackets: Record<string, unknown>[] = []

  const h = await openHarness(dir, {
    backend: makeAcpToolBackend(() => plans[planIdx++] ?? { text: "Fallback" }),
    triageModel: () => async packet => {
      modelPackets.push(packet)
      const out = String(packet.outputText ?? "")
      if (out.includes("054b8f62")) {
        return {
          kind: "deliver_result",
          summary: "结论：官方正式版仍为 v0.23.0（main 多 8 个提交，整并有 18 处冲突），建议先合终端修复、暂缓整并 main。\n未完成：尚未执行任何合入。\n需要你操作：请确认是否先合入终端修复。",
          reason: "Summarized Run 1 update check",
          // Intentionally return the SAME generic issueKey across both runs to verify distinct schedule runs NEVER overwrite each other!
          issueKey: "deskfleet-update-check",
        }
      }
      return {
        kind: "deliver_result",
        summary: "结论：上游已发布 v0.24.0（含 MCP 权限修复与会话回放优化），建议规划升级。\n未完成：尚未创建升级分支或验证构建。\n需要你操作：请决定何时启动升级。",
        reason: "Summarized Run 2 update check",
        issueKey: "deskfleet-update-check",
      }
    },
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("DeskFleetSA", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "mac-redesign")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "检查 deskfleet 更新",
      prompt: "检查 DeskFleet 上游更新并给建议",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  const run1 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const snap1 = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === run1.id))

  const run2 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const snap2 = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === run2.id))

  assert.equal(modelPackets.length, 2, "Coordinator triage model must summarize both every_run runs")

  const followUpMsgs = snap2.messages.filter(m => m.provenance?.origin === "sa_follow_up")
  assert.equal(followUpMsgs.length, 2, "Exactly 1 SA summary message per run (no duplicate raw reports, no overwriting across runs)")

  const msg1 = followUpMsgs.find(m => m.provenance?.runId === run1.id)!
  const msg2 = followUpMsgs.find(m => m.provenance?.runId === run2.id)!
  assert.ok(msg1 && msg2)
  assert.notEqual(msg1.id, msg2.id)
  assert.notEqual(msg1.sessionId, msg2.sessionId)

  // Summary vs detail layering: collapsed body is concise SA summary (no markdown table), expanded detail keeps raw output!
  assert.match(msg1.text, /v0\.23\.0/u)
  assert.match(msg1.text, /未完成/u)
  assert.match(msg1.text, /需要你操作/u)
  assert.doesNotMatch(msg1.text, /\| --- \|/u, "Collapsed SA summary must not paste raw markdown tables")
  assert.ok(msg1.provenance?.detail?.includes("| 改动 | 对 SA 的建议 |"), "Expanded execution detail keeps run 1 raw details")
  assert.equal(msg1.provenance?.provider, provider)
  assert.equal(msg1.provenance?.runStatus, "completed")

  assert.match(msg2.text, /v0\.24\.0/u)
  assert.ok(!msg2.text.includes("054b8f62"), "Run 2 summary must not mix Run 1 facts")
  assert.ok(msg2.provenance?.detail?.includes("MCP 权限修复"), "Expanded detail for Run 2 has Run 2 content")
  assert.ok(!msg2.provenance?.detail?.includes("18 个冲突"), "Expanded detail for Run 2 must not contain Run 1 content")

  // Project 事项 (snapshot.followUpRuns) contains BOTH runs, each pointing to the exact same message & execution session!
  const runs = snap2.followUpRuns ?? []
  const rec1 = runs.find(r => r.runId === run1.id)!
  const rec2 = runs.find(r => r.runId === run2.id)!
  assert.ok(rec1 && rec2, "Both distinct runs must be present in snapshot.followUpRuns for 事项")
  assert.equal(rec1.deliveredMessageId, msg1.id)
  assert.equal(rec1.sessionId, msg1.sessionId)
  assert.equal(rec1.detail, msg1.provenance?.detail)
  assert.equal(rec2.deliveredMessageId, msg2.id)
  assert.equal(rec2.sessionId, msg2.sessionId)
  assert.equal(rec2.detail, msg2.provenance?.detail)
  assert.equal(snap1.followUpRuns?.some(r => r.runId === run1.id), true)
})

test("Redesign 2: deterministic fallback & low-quality model guard never output status labels, raw truncation, or raw tables", async () => {
  // 1. Model lazily returns bare status label "completed" -> rejected, replaced by structured SA summary!
  const bareLabelDecision = await triageFollowUpEvent({
    userId: "u1", workspaceId: "ws-1", sourceKind: "schedule", sourceId: "sched-1",
    sourceTitle: "检查 deskfleet 更新", runKey: "run:1", status: "completed",
    deliveryPolicy: "every_run", ruleMode: "active", outputText: LONG_UPDATE_REPORT_RUN_1,
  }, {
    model: async () => ({ kind: "deliver_result", summary: "completed", reason: "done" }),
  })
  assert.equal(bareLabelDecision.kind, "deliver_result")
  assert.notEqual(bareLabelDecision.summary.trim().toLowerCase(), "completed")
  assert.match(bareLabelDecision.summary, /结论/u)
  assert.match(bareLabelDecision.summary, /需要你操作/u)
  assert.doesNotMatch(bareLabelDecision.summary, /\| --- \|/u)
  assert.ok(bareLabelDecision.detail?.includes("| 改动 | 对 SA 的建议 |"))

  // 2. Model lazily pastes the full raw report verbatim (including markdown table) -> rejected & distilled!
  const verbatimPasteDecision = await triageFollowUpEvent({
    userId: "u1", workspaceId: "ws-1", sourceKind: "schedule", sourceId: "sched-1",
    sourceTitle: "检查 deskfleet 更新", runKey: "run:2", status: "completed",
    deliveryPolicy: "every_run", ruleMode: "active", outputText: LONG_UPDATE_REPORT_RUN_1,
  }, {
    model: async () => ({ kind: "deliver_result", summary: LONG_UPDATE_REPORT_RUN_1, reason: "pasted" }),
  })
  assert.doesNotMatch(verbatimPasteDecision.summary, /\| --- \|/u)
  assert.ok(verbatimPasteDecision.summary.length < LONG_UPDATE_REPORT_RUN_1.length)
  assert.ok(verbatimPasteDecision.detail?.includes("18 个冲突"))

  // 3. Buggy model tries to silence or mark a FAILED run as clean -> hard invariant forces deliver_result & failure summary!
  const failedDecision = await triageFollowUpEvent({
    userId: "u1", workspaceId: "ws-1", sourceKind: "schedule", sourceId: "sched-1",
    sourceTitle: "Nightly Deploy Check", runKey: "run:fail-1", status: "failed",
    deliveryPolicy: "exceptions_only", ruleMode: "active",
    outputText: "Step 1 checked config OK.", error: "SSH connection timed out while verifying prod host",
  }, {
    model: async () => ({ kind: "record_quietly", summary: "All checks passed, no errors found.", reason: "hallucinated" }),
  })
  assert.equal(failedDecision.kind, "deliver_result", "Failed run MUST NEVER become record_quietly")
  assert.match(failedDecision.summary, /did not complete \(failed\)/u)
  assert.match(failedDecision.summary, /SSH connection timed out/u)
  assert.match(failedDecision.summary, /Step 1 checked config OK/u)
  assert.ok(failedDecision.detail?.includes("SSH connection timed out"))

  // 4. Incomplete / commentary-only / milestone-only runs NEVER report as confirmed success
  const incompleteDecision = await triageFollowUpEvent({
    userId: "u1", workspaceId: "ws-1", sourceKind: "schedule", sourceId: "sched-1",
    sourceTitle: "Audit Logs", runKey: "run:inc-1", status: "completed",
    deliveryPolicy: "every_run", ruleMode: "active",
    outputText: "Partial line 1\n".repeat(40), evidenceIncomplete: true,
  })
  assert.equal(incompleteDecision.kind, "deliver_result")
  assert.equal(incompleteDecision.reportDelivered, false)
  assert.match(incompleteDecision.summary, /unconfirmed|could not be read completely/iu)
  assert.ok(incompleteDecision.summary.length < 600, "Incomplete summary stays concise while raw excerpt stays in detail")
  assert.ok(incompleteDecision.detail?.includes("Partial line 1"))
})

test("Redesign 3: existing ticket association avoids duplicate tickets, while follow-up OFF and exceptions_only clean runs send zero extra messages", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-redesign-3-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })

  let runCounter = 0
  let failNext = false
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        if (failNext) {
          failNext = false
          throw new Error("Build verification failed with exit code 1")
        }
        runCounter += 1
        const text = runCounter === 1
          ? "支付接口 A、B 全部通过，无异常，无需处理。"
          : runCounter === 2
            ? "定时复检完成：目标工单接口恢复正常，暂无需操作。"
            : "关闭跟进期间运行：绝不应发送主对话消息。"
        await client.onUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
            _meta: { deskfleet: { phase: "final_answer", purpose: "final_answer" } },
          },
        })
        return { stopReason: "end_turn" }
      },
    }
  }

  let modelCalls = 0
  const h = await openHarness(dir, {
    backend,
    triageModel: () => async packet => {
      modelCalls += 1
      return {
        kind: "deliver_result",
        summary: `结论：${String(packet.outputText ?? "").trim()}（暂无需操作）`,
        reason: "summarized",
      }
    },
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const wsId = (await h.catalog.native.createWorkspace("PolicyCheck", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "mac-policy")

  // 1. exceptions_only clean run -> 0 main-chat messages, 0 model calls, STILL recorded in snapshot.followUpRuns!
  const quietTask = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "健康巡检", prompt: "检查接口状态", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: quietTask.id, enabled: true, deliveryPolicy: "exceptions_only",
  }, userA)
  const quietRun = await h.operations.handle("scheduleRun", { scheduleId: quietTask.id }, userA) as ScheduleRun
  const snapQuiet = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => (s.followUpRuns ?? []).some(r => r.runId === quietRun.id && r.status === "completed"))
  assert.equal(modelCalls, 0, "Clean exceptions_only run makes 0 model calls")
  assert.equal(snapQuiet.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, 0, "Clean exceptions_only run posts 0 chat messages")
  assert.equal(snapQuiet.followUpRuns?.find(r => r.runId === quietRun.id)?.delivered, false)

  // 2. Schedule targeting an EXISTING SA ticket's Worker session -> reuses existing ticketId without creating a duplicate ticket!
  const ticketSession = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), provider, context: "directory", title: "Ticket Worker",
  }, userA) as { session: { id: string } }).session
  await h.superStore.update(userA.userId!, () => ({ rooms: [], intents: [] }), state => {
    state.rooms.push({
      workspaceId: wsId,
      provider,
      messages: [],
      tickets: [{
        id: "ticket-existing-1",
        title: "支付接口恢复跟踪",
        scope: "跟踪支付接口恢复状态",
        summary: "持续跟踪中",
        provider,
        sessionId: ticketSession.id,
        updatedAt: new Date().toISOString(),
      }],
      recentTicketIds: ["ticket-existing-1"],
    })
  })
  const boundTask = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "工单定时复检", prompt: "复检支付接口", workspaceId: wsId, enabled: true,
      target: { kind: "existing", sessionId: ticketSession.id }, trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: boundTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)
  const boundRun = await h.operations.handle("scheduleRun", { scheduleId: boundTask.id }, userA) as ScheduleRun
  const snapBound = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === boundRun.id))
  assert.equal(snapBound.tickets.length, 1, "Must reuse existing ticket rather than duplicating")
  const boundMsg = snapBound.messages.find(m => m.provenance?.runId === boundRun.id)!
  const boundRec = snapBound.followUpRuns?.find(r => r.runId === boundRun.id)!
  assert.equal(boundMsg.ticketId, "ticket-existing-1")
  assert.equal(boundRec.ticketId, "ticket-existing-1")
  assert.equal(boundRec.deliveredMessageId, boundMsg.id)
  assert.equal(boundRec.sessionId, ticketSession.id)

  // 3. Failed/interrupted run under exceptions_only -> MUST deliver failure feedback and NEVER mark completed!
  failNext = true
  const failRun = await h.operations.handle("scheduleRun", { scheduleId: quietTask.id }, userA) as ScheduleRun
  const snapFail = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === failRun.id))
  const failRec = snapFail.followUpRuns?.find(r => r.runId === failRun.id)!
  assert.ok(failRec.status === "failed" || failRec.status === "interrupted", `Expected failed/interrupted, got ${failRec.status}`)
  assert.equal(failRec.delivered, true)
  const failMsg = snapFail.messages.find(m => m.provenance?.runId === failRun.id)!
  assert.match(failMsg.text, /did not complete|failed|interrupted|未完成|失败|中断/iu)
  assert.equal(failRec.deliveredMessageId, failMsg.id)

  // 4. Turn OFF follow-up (`takeoverAllSessions: false`) -> 0 new messages and 0 new model calls!
  const msgsBeforeOff = snapFail.messages.length
  const callsBeforeOff = modelCalls
  await h.setTakeover(userA, false)
  const offRun = await h.operations.handle("scheduleRun", { scheduleId: boundTask.id }, userA) as ScheduleRun
  await eventually(
    () => Promise.resolve(h.schedules.inspectTask(boundTask.id)!.task.runs),
    runs => runs.some(r => r.id === offRun.id && r.state === "completed"),
  )
  await h.followUp.drainScheduleEvents()
  const snapOff = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapOff.messages.length, msgsBeforeOff, "Follow-up OFF must produce 0 extra messages")
  assert.equal(modelCalls, callsBeforeOff, "Follow-up OFF must make 0 model calls")
})
