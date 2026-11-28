import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { HttpError } from "@deskfleet/client/request-diagnostics"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { eventually, makeAcpToolBackend, openHarness, type FollowUpHarness } from "../fixtures/follow-up-harness.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import type { FollowUpRunsPage } from "@deskfleet/protocol/super-agent-follow-up"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"

const userA: AgentActor = { kind: "user", userId: "user-a", deviceId: "login-a" }

type Switch = "pause" | "revoke"

/** Poll without failing so a missing delivery surfaces as a precise count assertion instead of a timeout. */
async function settle<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ready(value) || Date.now() >= deadline) return value
    await delay(20)
  }
}

// ============================================================================
// 37 · P1: 日报在授权有效时已完成，因跟进服务临时 503 待补发。随后既暂停该计划的跟进、又撤销最后一台设备的
// 后台授权（任意顺序），积压在两项都关闭时被消费；按任意顺序恢复后，暂停前日报恰好补发一次，
// 两项关闭期间的运行保持静默，重启不重复。单项关闭为对照。手动执行与到点执行均覆盖。
// ============================================================================
async function runOverlapScenario(t: test.TestContext, name: string, off: Switch[], on: Switch[], trigger: "manual" | "due") {
  const dir = await mkdtemp(join(tmpdir(), `deskfleet-r7-37-${name}-`))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  // Native completion times come from the Worker journal (real time), so the clock stays real. A due plan is
  // created with the clock 31 minutes behind, which makes its first interval deadline already due.
  let offsetMs = trigger === "due" ? -31 * 60_000 : 0
  const now = () => new Date(Date.now() + offsetMs)
  const tick = () => delay(25)
  const report = `暂停前已完成的对账日报（${name}）：支付 1,024 笔全部对平。`
  let auth503 = false
  let runNum = 0
  const followUpAuthorize = async (actor: AgentActor) => {
    if (auth503 && actor.deviceId === "follow-up-delegation") throw new HttpError(503, "Central auth temporarily unavailable")
    return actor
  }
  const h1 = await openHarness(dir, {
    now,
    followUpAuthorize,
    backend: makeAcpToolBackend(() => ({ text: runNum++ === 0 ? report : `两项关闭期间第 ${runNum - 1} 次运行的日报：不得补发。` })),
  })
  active = h1
  const wsId = (await h1.catalog.native.createWorkspace(`Overlap${name}`, [{ path: project }])).id
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h1.enableAuth(userA, "inst-mac")
  const task = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "Reconciliation Daily", prompt: "Reconcile payments", workspaceId: wsId, enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: trigger === "due" ? { kind: "interval", minutes: 30 } : { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h1.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  const nativeRuns = (h: FollowUpHarness) => h.schedules.inspectTask(task.id)!.task.runs
  const snapshotOf = (h: FollowUpHarness) => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  const runsOf = (h: FollowUpHarness) => h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 50,
  }, userA) as Promise<FollowUpRunsPage>
  const setSwitch = async (h: FollowUpHarness, which: Switch, enabled: boolean) => {
    await tick()
    if (which === "pause") {
      await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
        workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled,
      }, userA)
    } else if (enabled) {
      await h.enableAuth(userA, "inst-mac")
    } else {
      await h.disableAuth(userA, "inst-mac")
    }
  }

  // 1. The report completes while authorization and subscription are both active; delivery is transiently blocked.
  auth503 = true
  let prePause: ScheduleRun
  if (trigger === "due") {
    offsetMs = 0
    h1.schedules.start()
    const runs = await eventually(() => Promise.resolve(nativeRuns(h1)), r => r.some(x => x.state === "completed"))
    prePause = runs.find(x => x.state === "completed")!
    assert.equal(h1.schedules.inspectTask(task.id)!.runMeta[prePause.id]?.manualRunByUserId, undefined, "due trigger, not Run now")
  } else {
    prePause = await h1.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
    await eventually(() => Promise.resolve(nativeRuns(h1)), r => r.some(x => x.id === prePause.id && x.state === "completed"))
  }
  await eventually(() => Promise.resolve(h1.schedules.pendingPrivateEvents()), e => e.some(x => x.runId === prePause.id && x.kind === "run_finished"))
  await h1.followUp.drainScheduleEvents()
  assert.equal((await runsOf(h1)).runs.length, 0, "SA history is still empty while delivery is blocked")
  assert.ok(h1.schedules.pendingPrivateEvents().length >= 2, "start and finish receipts stay queued")

  // 2. Turn off the requested switches (in order), then let the backlog drain while they are off.
  for (const which of off) await setSwitch(h1, which, false)
  auth503 = false
  await h1.followUp.drainScheduleEvents()
  assert.equal(h1.schedules.pendingPrivateEvents().length, 0, "backlog is consumed while follow-up is off")
  assert.equal((await snapshotOf(h1)).messages.length, 0)

  // 3. The plan runs again while follow-up is off: that report must stay quiet forever.
  await tick()
  const offRun = await h1.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(nativeRuns(h1)), r => r.some(x => x.id === offRun.id && x.state === "completed"))
  await h1.followUp.drainScheduleEvents()

  // 4. Restore in the requested order, then restart the host.
  for (const which of on) await setSwitch(h1, which, true)
  await settle(async () => {
    await h1.followUp.drainScheduleEvents()
    return snapshotOf(h1)
  }, s => s.messages.some(m => m.text.includes(report)))
  active = undefined
  await h1.close()

  const h2 = await openHarness(dir, { now, followUpAuthorize, backend: makeAcpToolBackend(() => ({ text: "unused" })) })
  active = h2
  await settle(async () => {
    await h2.followUp.drainScheduleEvents()
    return snapshotOf(h2)
  }, s => s.messages.some(m => m.text.includes(report)))
  await h2.followUp.drainScheduleEvents()
  await delay(50)
  const snap = await snapshotOf(h2)
  const history = await runsOf(h2)
  const observed = {
    reportMessages: snap.messages.filter(m => m.text.includes(report)).length,
    deliveredHistory: history.runs.filter(r => r.delivered).length,
    offPeriodLeaks: snap.messages.filter(m => m.text.includes("不得补发")).length,
  }
  t.diagnostic(`${name} off=${off.join(">")} on=${on.join(">")} trigger=${trigger}: ${JSON.stringify(observed)}`)
  assert.deepEqual(observed, { reportMessages: 1, deliveredHistory: 1, offPeriodLeaks: 0 },
    `pre-pause report delivered exactly once; off-period run quiet (off=${off.join(">")}, on=${on.join(">")}, ${trigger})`)
  const recovered = history.runs.find(r => r.runId === prePause.id)
  assert.equal(recovered?.delivered, true)
  assert.equal(recovered?.status, "completed")
  assert.equal(snap.messages.find(m => m.text.includes(report))?.provenance?.sessionId, prePause.sessionId ?? nativeRuns(h2).find(r => r.id === prePause.id)?.sessionId)
  assert.equal(history.runs.find(r => r.runId === offRun.id)?.delivered ?? false, false)
  assert.equal(h2.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)?.state.deferredPrePauseRuns, undefined, "receipt consumed")

  // Second restart: no duplicates.
  active = undefined
  await h2.close()
  const h3 = await openHarness(dir, { now, followUpAuthorize })
  active = h3
  await h3.followUp.drainScheduleEvents()
  await delay(50)
  assert.equal((await snapshotOf(h3)).messages.filter(m => m.text.includes(report)).length, 1)
  assert.equal((await runsOf(h3)).runs.filter(r => r.delivered).length, 1)
}

const cases: Array<[string, Switch[], Switch[], "manual" | "due"]> = [
  ["pause-only", ["pause"], ["pause"], "manual"],
  ["revoke-only", ["revoke"], ["revoke"], "manual"],
  ["pause-revoke_auth-first", ["pause", "revoke"], ["revoke", "pause"], "manual"],
  ["revoke-pause_auth-first", ["revoke", "pause"], ["revoke", "pause"], "manual"],
  ["pause-revoke_sub-first", ["pause", "revoke"], ["pause", "revoke"], "manual"],
  ["revoke-pause_sub-first", ["revoke", "pause"], ["pause", "revoke"], "manual"],
  ["due-pause-only", ["pause"], ["pause"], "due"],
  ["due-pause-revoke_auth-first", ["pause", "revoke"], ["revoke", "pause"], "due"],
  ["due-revoke-pause_sub-first", ["revoke", "pause"], ["pause", "revoke"], "due"],
]

for (const [name, off, on, trigger] of cases) {
  test(`R7 37-P1: ${name} (off ${off.join(" > ")}, restore ${on.join(" > ")}, ${trigger}) delivers the pre-pause report exactly once`, async t => {
    await runOverlapScenario(t, name, off, on, trigger)
  })
}
