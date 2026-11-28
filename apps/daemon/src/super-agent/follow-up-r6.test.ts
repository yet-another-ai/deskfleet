import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { HttpError } from "@deskfleet/client/request-diagnostics"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { eventually, makeAcpToolBackend, openHarness, type FollowUpHarness, type ScriptedPlan } from "../fixtures/follow-up-harness.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import type { FollowUpRunsPage } from "@deskfleet/protocol/super-agent-follow-up"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import { looksCleanNoRisk } from "./triage.ts"

const userA: AgentActor = { kind: "user", userId: "user-a", deviceId: "login-a" }
const userOff: AgentActor = { kind: "user", userId: "user-sa-off", deviceId: "login-off" }
const userClassic: AgentActor = { kind: "user", userId: "user-classic", deviceId: "login-classic" }

/** Poll without failing so a missing delivery surfaces as a precise count assertion instead of a timeout. */
async function settle<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ready(value) || Date.now() >= deadline) return value
    await delay(20)
  }
}

async function runToCompletion(h: FollowUpHarness, scheduleId: string): Promise<ScheduleRun> {
  const run = await h.operations.handle("scheduleRun", { scheduleId }, userA) as ScheduleRun
  await eventually(
    () => Promise.resolve(h.schedules.inspectTask(scheduleId)!.task.runs),
    runs => runs.some(r => r.id === run.id && r.state === "completed"),
  )
  return run
}

const snapshotOf = (h: FollowUpHarness, workspaceId: string, actor = userA) =>
  h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor) as Promise<SuperSnapshot>
const runsOf = (h: FollowUpHarness, workspaceId: string, scheduleId: string, actor = userA, limit = 200) =>
  h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId, sourceKind: "schedule", sourceId: scheduleId, limit,
  }, actor) as Promise<FollowUpRunsPage>

// ============================================================================
// 33 · P1: 暂停前已完成、因跟进服务 503 待补发的日报。暂停后同一计划再运行 49 / 50 / 75 次，
// 原生近期记录（50 条）已把原运行挤出时，恢复跟进并重启后仍须在主对话出现一次、历史记一次交付，
// 暂停期间的运行全部保持静默，二次重启不重复。
// ============================================================================
async function runPausedBackfillScenario(t: test.TestContext, pausedRuns: number) {
  const dir = await mkdtemp(join(tmpdir(), `deskfleet-r6-33-${pausedRuns}-`))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  const report = `暂停前已完成的库存报告（${pausedRuns}）：库存 1,204 件，与账面一致。`
  let auth503 = false
  let runNum = 0
  const h1 = await openHarness(dir, {
    backend: makeAcpToolBackend(() => ({ text: runNum++ === 0 ? report : `暂停期间第 ${runNum - 1} 次运行的日报：不得补发。` })),
    followUpAuthorize: async actor => {
      if (auth503 && actor.deviceId === "follow-up-delegation") throw new HttpError(503, "Central auth temporarily unavailable")
      return actor
    },
  })
  active = h1
  const wsId = (await h1.catalog.native.createWorkspace(`Backfill${pausedRuns}`, [{ path: project }])).id
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h1.enableAuth(userA, "inst-mac")
  const task = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "Inventory Daily", prompt: "Inventory report", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // Pre-pause run completes while follow-up delegation is transiently failing.
  auth503 = true
  const prePause = await runToCompletion(h1, task.id)
  await eventually(() => Promise.resolve(h1.schedules.pendingPrivateEvents()), e => e.some(x => x.runId === prePause.id && x.kind === "run_finished"))
  await h1.followUp.drainScheduleEvents()
  assert.equal((await runsOf(h1, wsId, task.id)).runs.length, 0)

  // Pause, recover auth, consume the backlog during the pause.
  await delay(20)
  const pausedAtIso = new Date().toISOString()
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: false,
  }, userA)
  auth503 = false
  await h1.followUp.drainScheduleEvents()
  assert.equal(h1.schedules.pendingPrivateEvents().length, 0)
  assert.equal((await snapshotOf(h1, wsId)).messages.length, 0)

  // The same plan runs N more times during the pause through the native "Run now" entry.
  for (let i = 0; i < pausedRuns; i += 1) await runToCompletion(h1, task.id)
  const nativeRuns = h1.schedules.inspectTask(task.id)!.task.runs
  const evicted = !nativeRuns.some(r => r.id === prePause.id)
  assert.equal(evicted, pausedRuns >= 50, `native recent history retains 50 runs (pausedRuns=${pausedRuns})`)
  // The original Worker still holds the report even after the native run was evicted.
  const prePauseSession = (await h1.agents.journal.list()).find(s => s.id === prePause.sessionId)
  assert.ok(prePauseSession || prePause.sessionId === undefined)

  // Resume while delegation is down again, then restart so recovery happens on the fresh host.
  auth503 = true
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true,
  }, userA)
  active = undefined
  await h1.close()
  auth503 = false
  const h2 = await openHarness(dir, { backend: makeAcpToolBackend(() => ({ text: "unused" })) })
  active = h2
  let snap = await settle(async () => {
    await h2.followUp.drainScheduleEvents()
    return snapshotOf(h2, wsId)
  }, s => s.messages.some(m => m.provenance?.runId === prePause.id))
  await h2.followUp.drainScheduleEvents()
  snap = await snapshotOf(h2, wsId)

  const reportMessages = snap.messages.filter(m => m.text.includes(report))
  assert.equal(reportMessages.length, 1, `pre-pause report must appear exactly once in SA main chat (pausedRuns=${pausedRuns}, evicted=${evicted})`)
  assert.equal(reportMessages[0]!.provenance?.runId, prePause.id)
  assert.equal(snap.messages.length, 1, "paused-period runs must not be delivered")
  assert.equal(snap.messages.some(m => m.text.includes("不得补发")), false)

  let history = await runsOf(h2, wsId, task.id)
  const recovered = history.runs.filter(r => r.runId === prePause.id)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0]!.delivered, true)
  assert.equal(recovered[0]!.status, "completed")
  assert.ok((recovered[0]!.finishedAt ?? "") < pausedAtIso, "history keeps the pre-pause completion time")
  assert.equal(history.runs.filter(r => r.delivered).length, 1, "history records exactly one delivery")
  const source = h2.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)!
  assert.equal(source.state.deferredPrePauseRuns, undefined, "deferred receipt is consumed after delivery")

  // A second restart must not duplicate the recovered report or the delivery record.
  active = undefined
  await h2.close()
  const h3 = await openHarness(dir)
  active = h3
  await h3.followUp.drainScheduleEvents()
  await delay(50)
  snap = await snapshotOf(h3, wsId)
  assert.equal(snap.messages.filter(m => m.text.includes(report)).length, 1)
  assert.equal(snap.messages.length, 1)
  history = await runsOf(h3, wsId, task.id)
  assert.equal(history.runs.filter(r => r.delivered).length, 1)
}

test("R6 33-P1: deferred pre-pause report survives 49 paused runs (native run still retained)", async t => {
  await runPausedBackfillScenario(t, 49)
})

test("R6 33-P1: deferred pre-pause report survives 50 paused runs (native run evicted from recent history)", async t => {
  await runPausedBackfillScenario(t, 50)
})

test("R6 33-P1: deferred pre-pause report survives 75 paused runs (well past the native retention limit)", async t => {
  await runPausedBackfillScenario(t, 75)
})

// ============================================================================
// 35 · P1: 「仅异常」面对 `Backups did not run. Inventory: all checks passed.`，同一行与分行均须通知；
// 已配置判断模型时两种格式各调用一次；纯正常报告保持静默且不调用模型。
// ============================================================================
const BACKUP_SAME_LINE = "Backups did not run. Inventory: all checks passed."
const BACKUP_TWO_LINES = "Backups did not run.\nInventory: all checks passed."
const INVENTORY_CLEAN = "Inventory: all checks passed."

test("R6 35-P1 (unit): English sentence boundaries are judged independently and same-line equals multi-line", () => {
  assert.equal(looksCleanNoRisk(INVENTORY_CLEAN), true)
  assert.equal(looksCleanNoRisk(BACKUP_SAME_LINE), false)
  assert.equal(looksCleanNoRisk(BACKUP_TWO_LINES), false)
  // Equivalence: joining sentences on one line must never change the verdict.
  for (const sentences of [
    ["Backups did not run.", "Inventory: all checks passed."],
    ["Nightly export was not executed.", "All checks passed."],
    ["Payments: 2 of 100 succeeded.", "Inventory: all checks passed."],
    ["Sync never ran.", "No errors found."],
    ["Inventory: all checks passed.", "No errors found."],
    ["Daily check completed.", "All checks passed."],
    ["Coverage 99.5% on api.v2.", "All checks passed."],
  ]) {
    assert.equal(looksCleanNoRisk(sentences.join(" ")), looksCleanNoRisk(sentences.join("\n")), sentences.join(" | "))
  }
  // Clean controls stay clean; decimals and identifiers keep their dots.
  assert.equal(looksCleanNoRisk("Inventory: all checks passed. No errors found."), true)
  assert.equal(looksCleanNoRisk("Daily check completed. All checks passed."), true)
  assert.equal(looksCleanNoRisk("支付和库存全部通过，无异常。"), true)
  assert.equal(looksCleanNoRisk("Backups did not run"), false)
  assert.equal(looksCleanNoRisk("备份未执行。库存检查全部通过。"), false)
})

async function runExceptionsOnlyScenario(t: test.TestContext, withModel: boolean) {
  const dir = await mkdtemp(join(tmpdir(), `deskfleet-r6-35-${withModel ? "model" : "nomodel"}-`))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  const reports = [INVENTORY_CLEAN, BACKUP_SAME_LINE, BACKUP_TWO_LINES]
  let idx = 0
  const modelCalls: string[] = []
  const h = await openHarness(dir, {
    backend: makeAcpToolBackend(() => ({ text: reports[idx++] ?? INVENTORY_CLEAN })),
    ...(withModel ? {
      triageModel: () => async (packet: Record<string, unknown>) => {
        const outputText = String(packet.outputText ?? "")
        modelCalls.push(outputText)
        return /did not run/u.test(outputText)
          ? { kind: "deliver_result", summary: `Backup alert: backups did not run. (${outputText.replace(/\n/gu, " ")})`, reason: "Backup job missed" }
          : { kind: "record_quietly", summary: outputText, reason: "clean" }
      },
    } : {}),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })
  const wsId = (await h.catalog.native.createWorkspace(`Backups${withModel ? "Model" : "NoModel"}`, [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")
  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Backup & Inventory Patrol", prompt: "Check backups and inventory", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "exceptions_only",
  }, userA)
  const runAndSettle = async () => {
    const run = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
    await eventually(async () => {
      await h.followUp.drainScheduleEvents()
      return (await runsOf(h, wsId, task.id)).runs.find(r => r.runId === run.id && r.status === "completed")
    }, Boolean)
    return run
  }
  const observed: Array<{ report: string; modelCalls: number; newMessages: number }> = []
  const runs: ScheduleRun[] = []
  for (const report of reports) {
    const callsBefore = modelCalls.length
    const msgsBefore = (await snapshotOf(h, wsId)).messages.length
    runs.push(await runAndSettle())
    observed.push({
      report,
      modelCalls: modelCalls.length - callsBefore,
      newMessages: (await snapshotOf(h, wsId)).messages.length - msgsBefore,
    })
  }
  t.diagnostic(`exceptions_only ${withModel ? "with" : "without"} model: ${JSON.stringify(observed)}`)
  assert.deepEqual(observed.map(o => o.newMessages), [0, 1, 1], "clean stays quiet; same-line and two-line backup failures both notify")
  if (withModel) {
    assert.deepEqual(observed.map(o => o.modelCalls), [0, 1, 1], "configured model is consulted once for each backup-failure format, never for the clean report")
    assert.equal(modelCalls[0], BACKUP_SAME_LINE)
    assert.equal(modelCalls[1], BACKUP_TWO_LINES)
  } else {
    assert.deepEqual(observed.map(o => o.modelCalls), [0, 0, 0])
  }
  const snap = await snapshotOf(h, wsId)
  for (const run of runs.slice(1)) {
    const msg = snap.messages.find(m => m.provenance?.runId === run.id)
    assert.ok(msg, "backup failure must reach main chat")
    assert.match(msg.text, /did not run/iu)
  }
  const history = await runsOf(h, wsId, task.id)
  assert.equal(history.runs.find(r => r.runId === runs[0]!.id)?.delivered, false)
  assert.equal(history.runs.find(r => r.runId === runs[1]!.id)?.delivered, true)
  assert.equal(history.runs.find(r => r.runId === runs[2]!.id)?.delivered, true)
}

test("R6 35-P1: exceptions_only with configured triage model notifies for same-line and two-line backup failure", async t => {
  await runExceptionsOnlyScenario(t, true)
})

test("R6 35-P1: exceptions_only without a model notifies for same-line and two-line backup failure", async t => {
  await runExceptionsOnlyScenario(t, false)
})

// ============================================================================
// 34 · P2: 没有最终文本的定时任务，主对话保留「没有文本输出」提示，历史不得记为已交付；有终稿的对照记为已交付。
// ============================================================================
test("R6 34-P2: runs without final text keep the no-text notice but are not recorded as delivered reports", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r6-34-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  const plans: ScriptedPlan[] = [
    { events: [{ kind: "tool", title: "Probe API endpoints" }] },
    { events: [{ kind: "text", text: "我先巡检接口，稍后汇报。" }, { kind: "tool", title: "Probe API endpoints" }] },
    { events: [] },
    { events: [{ kind: "tool", title: "Probe API endpoints" }, { kind: "text", text: "接口巡检报告：12 个接口全部 200。", phase: "final_answer", messageId: "final-34" }] },
  ]
  let idx = 0
  const h = await openHarness(dir, { backend: makeAcpToolBackend(() => plans[idx++] ?? { text: "fallback" }) })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })
  const wsId = (await h.catalog.native.createWorkspace("NoTextOutput", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac")
  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "提交书面接口巡检报告", prompt: "Probe APIs and write a report", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)
  const runIds: string[] = []
  for (let i = 0; i < plans.length; i += 1) {
    const run = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
    await eventually(async () => {
      await h.followUp.drainScheduleEvents()
      return (await runsOf(h, wsId, task.id)).runs.find(r => r.runId === run.id && r.status === "completed")
    }, Boolean)
    runIds.push(run.id)
  }
  const [toolsOnly, openingThenTool, emptyTurn, withFinal] = runIds as [string, string, string, string]
  const snap = await snapshotOf(h, wsId)
  const history = await runsOf(h, wsId, task.id)
  const msg = (id: string) => snap.messages.find(m => m.provenance?.runId === id)!
  const rec = (id: string) => history.runs.find(r => r.runId === id)!

  for (const id of [toolsOnly, emptyTurn]) {
    assert.match(msg(id).text, /no text output/iu, "main chat keeps the explicit no-text notice")
    assert.ok(msg(id).provenance?.sessionId, "notice links to the original session")
    assert.equal(rec(id).status, "completed")
    assert.equal(rec(id).delivered, false, "history must not record a delivered report when no text was produced")
  }
  assert.match(msg(openingThenTool).text, /no formal final conclusion/iu)
  assert.equal(rec(openingThenTool).delivered, false)
  assert.equal(msg(withFinal).text, "接口巡检报告：12 个接口全部 200。")
  assert.equal(rec(withFinal).delivered, true)
  const metrics = h.followUp.metrics()
  assert.equal(metrics.deliveredRuns, 1, "only the run with a final report counts as delivered")
})

// ============================================================================
// 到点执行对照：关闭 SA 的用户原生计划按时执行，SA 主对话与历史各新增 0 条；显式订阅用户各新增 1 条。
// ============================================================================
test("R6 due-trigger control: SA turned off keeps native schedule running with 0 SA messages/history; explicit subscriber gets exactly 1", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-r6-due-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let clockMs = Date.parse("2026-11-24T01:00:00.000Z")
  const h = await openHarness(dir, {
    now: () => new Date(clockMs),
    backend: makeAcpToolBackend(prompt => ({ text: `按时触发日报：${prompt}` })),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })
  const wsId = (await h.catalog.native.createWorkspace("DueControlR6", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const create = (title: string, actor: AgentActor) => h.operations.handle("scheduleCreate", {
    schedule: {
      title, prompt: `${title} check`, workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" }, trigger: { kind: "interval", minutes: 30 },
    },
  }, actor) as Promise<ScheduledTask>

  // User who had SA on and subscribed, then turned SA off on their only device.
  await h.enableAuth(userOff, "inst-off")
  const offTask = await create("SA Off Due Task", userOff)
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: offTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userOff)
  await h.disableAuth(userOff, "inst-off")
  const offMessagesBefore = (await snapshotOf(h, wsId, userOff)).messages.length
  const offHistoryBefore = (await runsOf(h, wsId, offTask.id, userOff)).runs.length
  // Classic user who never enabled SA.
  const classicTask = await create("Classic Due Task", userClassic)
  // Explicit subscriber control.
  await h.enableAuth(userA, "inst-mac")
  const subTask = await create("Subscribed Due Task", userA)
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: subTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)
  const subMessagesBefore = (await snapshotOf(h, wsId)).messages.length

  clockMs += 31 * 60_000
  h.schedules.start()
  await eventually(
    () => Promise.resolve([offTask, classicTask, subTask].map(task => h.schedules.inspectTask(task.id)!.task.runs)),
    all => all.every(runs => runs.some(r => r.state === "completed")),
  )
  const snapA = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return snapshotOf(h, wsId)
  }, s => s.messages.some(m => m.provenance?.scheduleId === subTask.id))
  await h.followUp.drainScheduleEvents()
  await delay(50)

  assert.equal(snapA.messages.length - subMessagesBefore, 1, "explicit subscriber receives exactly one delivery")
  assert.equal((await runsOf(h, wsId, subTask.id)).runs.filter(r => r.status === "completed").length, 1)
  assert.equal((await snapshotOf(h, wsId, userOff)).messages.length - offMessagesBefore, 0, "SA off: 0 new main-chat messages")
  assert.equal((await runsOf(h, wsId, offTask.id, userOff)).runs.length - offHistoryBefore, 0, "SA off: 0 new history rows")
  assert.equal(h.followUpStore.getAuth(userClassic.userId!), undefined)
  assert.equal((await h.followUpStore.listRuns({ userId: userClassic.userId!, workspaceId: wsId })).runs.length, 0)
  assert.equal(h.superStore.get(userClassic.userId!), undefined)
})
