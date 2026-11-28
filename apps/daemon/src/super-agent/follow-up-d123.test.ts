import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { CatalogWorkspace } from "@deskfleet/protocol/catalog"
import { TestAgentQuotas } from "../fixtures/agent-quotas.ts"
import { eventually, makeAcpToolBackend, openHarness, type FollowUpHarness } from "../fixtures/follow-up-harness.ts"
import { MachineRuntime } from "../machine/runtime.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import type { FollowUpAuthReceipt, FollowUpRunsPage } from "@deskfleet/protocol/super-agent-follow-up"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import type { SuperDecisionModel } from "./router.ts"
import { createCoordinatorTriageModel, extractTriageFromCoordinatorDecision, triageFollowUpEvent } from "./triage.ts"

const userA: AgentActor = { kind: "user", userId: "user-d123-a", deviceId: "dev-d123-a" }

async function sendMainChat(h: FollowUpHarness, workspaceId: string, actor: AgentActor, text: string): Promise<{ reply: string; snapshot: SuperSnapshot }> {
  const messageId = randomUUID()
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId, messageId, text, timeZone: "Asia/Shanghai" }, actor)
  const snapshot = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.id === messageId && m.state !== "routing"),
  )
  const userMsg = snapshot.messages.find(m => m.id === messageId)!
  assert.equal(userMsg.state, "answered", `Expected answered for "${text}", got ${userMsg.state}: ${userMsg.reason}`)
  const reply = snapshot.messages.filter(m => m.sourceMessageId === messageId && m.role === "assistant").map(m => m.text).join("\n")
  return { reply, snapshot }
}

// ============================================================================
// D1a: Master switch turned OFF mid-flight while journal.read is suspended
// ============================================================================
test("D1a: turning off master switch mid-flight during journal read preserves pre-pause receipt before ack, stays quiet while off, and delivers once on re-enable even after >50 off-period runs", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-d1a-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let runCounter = 0
  const backend = makeAcpToolBackend(() => {
    runCounter += 1
    if (runCounter === 1) return { text: "暂停前完整日报正文：订单与对账全部核对完毕（Run #1）。" }
    return { text: `关闭期间运行产物 #${runCounter}（不得补发）` }
  })

  const h = await openHarness(dir, { backend })
  active = h
  const wsId = (await h.catalog.native.createWorkspace("D1aProject", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac-d1a", { takeoverAllSessions: true })

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "每日财务日报",
      prompt: "生成每日财务日报",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)
  }, src => !!src?.state.enabled)

  // Intercept journal.history ONLY once the completed turn event is present (invoked by readTurnAssistantOutput
  // inside processSchedulePrivateEvent, never during session startup configuration reads).
  let enteredJournalRead!: () => void
  const inJournalRead = new Promise<void>(resolve => { enteredJournalRead = resolve })
  let releaseJournalRead!: () => void
  const gateJournalRead = new Promise<void>(resolve => { releaseJournalRead = resolve })
  let holdArmed = false
  let heldOnce = false
  const origHistory = h.agents.journal.history.bind(h.agents.journal)
  h.agents.journal.history = async (...args) => {
    const page = await origHistory(...args)
    if (holdArmed && !heldOnce && page.some(ev => ev.kind === "turn" && (ev.payload as { state?: string }).state === "completed")) {
      heldOnce = true
      enteredJournalRead()
      await gateJournalRead
    }
    return page
  }

  // Trigger Run #1 at T1; let native execution finish while follow-up consumer pauses mid-flight inside transcript read.
  await delay(15)
  holdArmed = true
  const run1 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(h.schedules.inspectTask(task.id)!.task.runs), runs => runs.some(r => r.id === run1.id && r.state === "completed"))
  await inJournalRead

  // At T2 > T1, turn OFF the master switch while journal.history is still suspended!
  await delay(20)
  const stopReceipt = await h.setTakeover(userA, false)
  assert.equal(stopReceipt.summary.takeoverAllSessions, false)

  // Release journal.history and wait for drain to finish & ack cleanly.
  releaseJournalRead()
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.schedules.pendingPrivateEvents().length
  }, count => count === 0)

  // While OFF: 0 proactive reminders, queue is clean, AND deferredPrePauseRuns durably holds Run #1!
  const snapWhileOff = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapWhileOff.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, 0, "0 reminders while switch is off")
  const subWhileOff = h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)
  assert.deepEqual(
    subWhileOff?.state.deferredPrePauseRuns?.map(item => item.runId),
    [run1.id],
    "pre-pause receipt MUST be persisted before queue ack",
  )

  // Execute 52 more runs while OFF so Run #1 rolls completely out of the native scheduler's 50-run cap!
  for (let i = 0; i < 52; i += 1) {
    const offRun = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
    await eventually(() => Promise.resolve(h.schedules.inspectTask(task.id)!.task.runs), runs => runs.some(r => r.id === offRun.id && r.state === "completed"))
  }
  await h.followUp.drainScheduleEvents()
  assert.equal(h.schedules.inspectTask(task.id)!.task.runs.some(r => r.id === run1.id), false, "Run #1 rolled out of native 50-run history")
  assert.equal(
    (await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot)
      .messages.filter(m => m.provenance?.origin === "sa_follow_up").length,
    0,
    "0 reminders across all 52 off-period runs",
  )
  assert.deepEqual(
    h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)?.state.deferredPrePauseRuns?.map(item => item.runId),
    [run1.id],
    "off-period runs MUST NOT enter deferredPrePauseRuns",
  )

  // Re-enable master switch at T4 -> Run #1 delivers ONCE, 0 off-period runs leak!
  await delay(20)
  await h.setTakeover(userA, true, "inst-mac-d1a")
  const snapAfterReenable = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.provenance?.runId === run1.id))

  const deliveredMsgs = snapAfterReenable.messages.filter(m => m.provenance?.origin === "sa_follow_up")
  assert.equal(deliveredMsgs.length, 1, "exactly one pre-pause report delivered after re-enable")
  assert.match(deliveredMsgs[0]!.text, /暂停前完整日报正文/)
  assert.ok(!deliveredMsgs[0]!.text.includes("关闭期间运行产物"))
  assert.equal(h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)?.state.deferredPrePauseRuns, undefined, "deferred receipt cleared once delivered")

  // Restart daemon -> still exactly 1 delivery, zero duplicates!
  active = undefined
  await h.close()
  const h2 = await openHarness(dir, { backend })
  active = h2
  await h2.followUp.drainScheduleEvents()
  await delay(40)
  const snapAfterRestart = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapAfterRestart.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, 1, "restart does not duplicate deferred delivery")
})

// ============================================================================
// D1b: Single-schedule paused mid-flight during triageModel + pause again during replay
// ============================================================================
test("D1b: pausing a schedule mid-flight during triage (and again during replay) preserves deferred receipt, stays quiet while paused, and delivers once on final resume", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-d1b-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let runSeq = 0
  const backend = makeAcpToolBackend(() => {
    runSeq += 1
    return runSeq === 1
      ? { text: "支付巡检发现异常：100 笔交易仅成功 2 笔（Run #1）。" }
      : { text: "暂停期间巡检异常：缓存超时（Run #2，不得补发）。" }
  })

  let triageCalls = 0
  let onTriageEntered: (() => void) | undefined
  let triageGate: Promise<void> | undefined
  let releaseTriage: (() => void) | undefined
  const armTriageGate = () => {
    let enteredResolve!: () => void
    const entered = new Promise<void>(resolve => { enteredResolve = resolve })
    onTriageEntered = enteredResolve
    triageGate = new Promise<void>(resolve => { releaseTriage = resolve })
    return { entered, release: () => releaseTriage?.() }
  }

  const h = await openHarness(dir, {
    backend,
    triageModel: () => async () => {
      triageCalls += 1
      if (triageGate) {
        const gate = triageGate
        triageGate = undefined
        onTriageEntered?.()
        await gate
      }
      return {
        kind: "deliver_result",
        summary: "【支付异常告警】100 笔交易仅成功 2 笔（Run #1）。",
        reason: "Payment anomaly confirmed by triage",
      }
    },
  })
  active = h
  const wsId = (await h.catalog.native.createWorkspace("D1bProject", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac-d1b", { takeoverAllSessions: true })

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "支付异常巡检",
      prompt: "检查支付成功率",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)
  }, src => !!src?.state.enabled && src.state.deliveryPolicy === "exceptions_only")

  // First pause: suspend inside triageModel on Run #1, then pause ONLY this schedule.
  await delay(15)
  const gate1 = armTriageGate()
  const run1 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await gate1.entered

  await delay(20)
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: false,
  }, userA)
  gate1.release()

  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.schedules.pendingPrivateEvents().length
  }, count => count === 0)
  assert.equal(
    (await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot)
      .messages.filter(m => m.provenance?.origin === "sa_follow_up").length,
    0,
    "0 messages pushed while schedule is paused",
  )
  assert.deepEqual(h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)?.state.deferredPrePauseRuns?.map(r => r.runId), [run1.id])

  // Run #2 finishes during paused window -> MUST stay quiet and NOT enter deferredPrePauseRuns!
  await delay(20)
  const run2 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(h.schedules.inspectTask(task.id)!.task.runs), runs => runs.some(r => r.id === run2.id && r.state === "completed"))
  await h.followUp.drainScheduleEvents()
  assert.deepEqual(h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)?.state.deferredPrePauseRuns?.map(r => r.runId), [run1.id])

  // Second pause DURING deferred replay: resume, hold triage again, pause again -> receipt MUST NOT be deleted!
  await delay(20)
  const gate2 = armTriageGate()
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true,
  }, userA)
  await gate2.entered
  await delay(20)
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: false,
  }, userA)
  gate2.release()
  await h.followUp.drainScheduleEvents()
  assert.deepEqual(
    h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id)?.state.deferredPrePauseRuns?.map(r => r.runId),
    [run1.id],
    "double-pause during deferred replay MUST keep Run #1 receipt intact",
  )
  assert.equal(
    (await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot)
      .messages.filter(m => m.provenance?.origin === "sa_follow_up").length,
    0,
  )

  // Final resume: Run #1 delivers ONCE, Run #2 stays quiet!
  await delay(20)
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, enabled: true,
  }, userA)
  const finalSnap = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.provenance?.runId === run1.id))

  const pushed = finalSnap.messages.filter(m => m.provenance?.origin === "sa_follow_up")
  assert.equal(pushed.length, 1, "exactly one delivery after final resume")
  assert.match(pushed[0]!.text, /支付异常告警/)
  assert.ok(!pushed[0]!.text.includes("Run #2"))
  assert.ok(triageCalls >= 3)
})

// ============================================================================
// D2a: Silent stalled ordinary Worker periodic recheck with controllable clock
// ============================================================================
test("D2a: silently stalled ordinary Worker triggers quiet first recheck, alerts once on sustained stall, and never duplicates across retries or restart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-d2a-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let nowMs = Date.parse("2026-11-25T10:00:00.000Z")
  const now = () => new Date(nowMs)

  let releaseStuckPrompt!: () => void
  const stuckPromptGate = new Promise<void>(resolve => { releaseStuckPrompt = resolve })
  let promptStartedResolve!: () => void
  const promptStarted = new Promise<void>(resolve => { promptStartedResolve = resolve })

  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        promptStartedResolve()
        await stuckPromptGate
        await client.onUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Worker finally finished." } },
        })
        return { stopReason: "end_turn" }
      },
    }
  }

  const h = await openHarness(dir, { now, backend, stallThresholdMs: 10 * 60_000, stallCheckIntervalMs: 0 })
  active = h
  const wsId = (await h.catalog.native.createWorkspace("D2aProject", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac-d2a", { takeoverAllSessions: true })

  // Create an ordinary session and start a turn that hangs silently without emitting any further events.
  const session = await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), title: "Silent Build Worker", provider, context: "directory",
  }, userA) as AgentSnapshot
  await eventually(
    () => Promise.resolve(h.followUpStore.getSource(userA.userId!, wsId, "session", session.session.id)),
    src => !!src?.state.enabled,
  )

  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: session.session.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "Run long silent verification" }],
  }, userA)
  await promptStarted
  // Ensure the turn-start control event has been processed so lastProgressSeq matches the silent turn state.
  await eventually(async () => {
    const snap = await h.agents.journal.read(session.session.id)
    const src = h.followUpStore.getSource(userA.userId!, wsId, "session", session.session.id)
    return { seq: snap.session.lastEventSeq, progressSeq: src?.state.lastProgressSeq, hasTurn: snap.turns.some(turn => turn.state === "running") }
  }, state => state.hasTurn && state.seq === state.progressSeq)

  // +5 min (< 10 min threshold): 0 alerts, not even quiet recheck yet.
  nowMs += 5 * 60_000
  await h.followUp.checkStalledSessions()
  assert.equal(h.followUpStore.getSource(userA.userId!, wsId, "session", session.session.id)?.state.lastErrorKey, undefined)
  assert.equal(
    (await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot)
      .messages.filter(m => m.provenance?.origin === "sa_follow_up").length,
    0,
  )

  // +11 min (first threshold crossing): QUIET recheck ONLY -> 0 alerts in SA main chat!
  nowMs += 6 * 60_000
  await h.followUp.checkStalledSessions()
  const afterRecheck = h.followUpStore.getSource(userA.userId!, wsId, "session", session.session.id)
  assert.equal(afterRecheck?.state.lastErrorKey, `stall:${wsId}:${session.session.id}`)
  assert.equal(afterRecheck?.state.lastErrorCount, 1)
  assert.equal(
    (await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot)
      .messages.filter(m => m.provenance?.origin === "sa_follow_up").length,
    0,
    "first stall threshold crossing must stay quiet (recheck only)",
  )

  // +11 min again (sustained zero progress across two consecutive checks): ONE actionable alert!
  nowMs += 11 * 60_000
  await h.followUp.checkStalledSessions()
  const snapAfterStall = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  const stallMsgs = snapAfterStall.messages.filter(m => m.provenance?.origin === "sa_follow_up")
  assert.equal(stallMsgs.length, 1, "sustained stall surfaces exactly 1 alert in SA main chat")
  assert.match(stallMsgs[0]!.text, /Silent Build Worker.*stalled/i)
  assert.equal(stallMsgs[0]!.provenance?.sourceId, session.session.id)
  assert.equal(stallMsgs[0]!.provenance?.issueKey, `stall:${wsId}:${session.session.id}`)
  const storedStallMsg = h.superStore.get(userA.userId!)?.rooms.find(r => r.workspaceId === wsId)?.messages.find(m => m.id === stallMsgs[0]!.id)
  assert.ok((storedStallMsg?.options?.length ?? 0) >= 2, "stall alert stores concrete action options")

  const runsPage = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "session", sourceId: session.session.id }, userA) as FollowUpRunsPage
  assert.equal(runsPage.runs.length, 1)
  assert.equal(runsPage.runs[0]!.status, "attention")
  assert.equal(runsPage.runs[0]!.delivered, true)

  // +15 min later, run checkStalledSessions() twice more -> STILL 1 alert (0 duplicates)!
  const dupBefore = h.followUp.metrics().duplicateSuppressed
  nowMs += 15 * 60_000
  await h.followUp.checkStalledSessions()
  nowMs += 15 * 60_000
  await h.followUp.checkStalledSessions()
  assert.equal(
    (await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot)
      .messages.filter(m => m.provenance?.origin === "sa_follow_up").length,
    1,
    "repeated checks on the same stalled turn MUST NOT duplicate alerts",
  )
  assert.ok(h.followUp.metrics().duplicateSuppressed >= dupBefore + 2)

  // Unblock Worker cleanly so turn finishes and stall state clears.
  releaseStuckPrompt()
  await eventually(async () => (await h.agents.journal.read(session.session.id)).turns.at(-1)?.state, st => st === "completed")
  await eventually(
    () => Promise.resolve(h.followUpStore.getSource(userA.userId!, wsId, "session", session.session.id)),
    src => src?.state.lastErrorKey === undefined,
  )
})

// ============================================================================
// D2b: Healthy long-running Worker (zero false alarms) + switch OFF + live timer
// ============================================================================
test("D2b: progressing long-running Worker never false-alarms, switch OFF stays silent, and periodic timer runs automatically", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-d2b-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let nowMs = Date.parse("2026-11-25T13:00:00.000Z")
  const now = () => new Date(nowMs)
  const emitBySession = new Map<string, (text: string) => Promise<void>>()
  const releaseBySession = new Map<string, () => void>()
  const startedResolves = new Map<string, () => void>()

  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        const key = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
        emitBySession.set(key, async text => {
          await client.onUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          })
        })
        let done!: () => void
        const wait = new Promise<void>(resolve => { done = resolve })
        releaseBySession.set(key, done)
        startedResolves.get(key)?.()
        await wait
        return { stopReason: "end_turn" }
      },
    }
  }

  // Enable a fast periodic timer (25ms) to verify the background sweep fires on its own without manual checkStalledSessions()!
  const h = await openHarness(dir, { now, backend, stallThresholdMs: 10 * 60_000, stallCheckIntervalMs: 25 })
  active = h
  const wsId = (await h.catalog.native.createWorkspace("D2bProject", [{ path: project }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  await h.enableAuth(userA, "inst-mac-d2b", { takeoverAllSessions: true })

  // 1. Healthy long-running Worker emitting periodic ACP chunks every 8 min over 32 min -> 0 false stall alerts!
  const healthyStarted = new Promise<void>(resolve => { startedResolves.set("LONG_HEALTHY", resolve) })
  const healthy = await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), title: "Healthy Long Build", provider, context: "directory",
  }, userA) as AgentSnapshot
  await eventually(() => Promise.resolve(h.followUpStore.getSource(userA.userId!, wsId, "session", healthy.session.id)), src => !!src?.state.enabled)
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: healthy.session.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "LONG_HEALTHY" }],
  }, userA)
  await healthyStarted
  await delay(60)

  for (let step = 1; step <= 4; step += 1) {
    nowMs += 8 * 60_000
    await emitBySession.get("LONG_HEALTHY")!(`Compiling module ${step}/4...`)
    await delay(60)
  }
  const snapHealthy = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapHealthy.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, 0, "healthy progressing Worker must have 0 stall alerts")

  // 2. Turn OFF master switch -> silently stalled Worker gets 0 alerts even after +30 min!
  const offStarted = new Promise<void>(resolve => { startedResolves.set("OFF_STALLED", resolve) })
  const offSess = await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), title: "Off Stalled Worker", provider, context: "directory",
  }, userA) as AgentSnapshot
  await eventually(() => Promise.resolve(h.followUpStore.getSource(userA.userId!, wsId, "session", offSess.session.id)), src => !!src?.state.enabled)
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: offSess.session.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "OFF_STALLED" }],
  }, userA)
  await offStarted
  await h.setTakeover(userA, false)
  nowMs += 30 * 60_000
  await delay(80)
  await h.followUp.checkStalledSessions()
  assert.equal(
    (await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot)
      .messages.filter(m => m.provenance?.origin === "sa_follow_up").length,
    0,
    "master switch OFF must never produce stall alerts",
  )

  // 3. Re-enable and verify the automatic background timer fires on its own (without calling checkStalledSessions() manually)!
  await h.setTakeover(userA, true, "inst-mac-d2b")
  await delay(60)
  nowMs += 11 * 60_000
  await eventually(
    () => Promise.resolve(h.followUpStore.getSource(userA.userId!, wsId, "session", offSess.session.id)),
    src => src?.state.lastErrorKey === `stall:${wsId}:${offSess.session.id}` && src.state.lastErrorCount === 1,
  )
  nowMs += 11 * 60_000
  const autoAlertSnap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.provenance?.sourceId === offSess.session.id && m.provenance?.issueKey === `stall:${wsId}:${offSess.session.id}`),
  )
  assert.equal(autoAlertSnap.messages.filter(m => m.provenance?.sourceId === offSess.session.id).length, 1)

  releaseBySession.get("LONG_HEALTHY")?.()
  releaseBySession.get("OFF_STALLED")?.()
})

// ============================================================================
// D3a: Production MachineRuntime host path wires background triageModel
// ============================================================================
test("D3a: production MachineRuntime construction path wires triageModel for exceptions_only, distinguishes model triage vs rule fallback, and skips calls when clean or off", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-d3-runtime-"))
  const working = join(dir, "working")
  await mkdir(working, { recursive: true })
  // Create an isolated dummy binary that reports version 0.0.0 so createCoordinatorRuntime falls cleanly
  // onto its built-in ACP coordinator transport (`acpCoordinatorModel` -> `agentProvider.prompt`) without
  // touching any real host CLI or external network.
  const dummyCodexBin = join(dir, "dummy-codex")
  await writeFile(dummyCodexBin, "#!/bin/sh\necho '0.0.0'\n", "utf8")
  await chmod(dummyCodexBin, 0o755)

  const workerOutputs = [
    "延迟中位数 12 毫秒，目标上限 50 毫秒。",
    "延迟中位数 180 毫秒，超出 50 毫秒上限。",
    "延迟中位数 95 毫秒，目标上限 50 毫秒。",
    "支付接口 A、B、C 全部通过，无异常，无需处理。",
    "延迟中位数 260 毫秒，超出 50 毫秒上限（关闭开关期间）。",
  ]
  let workerRunIndex = 0
  let failCoordinatorModel = false
  const triagePackets: Record<string, unknown>[] = []

  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    if (client.inferenceOnly) {
      // Production coordinator runtime (`acpCoordinatorModel`) calls connect() with `inferenceOnly`.
      return {
        ...conn,
        prompt: async params => {
          const textPayload = params.prompt.map(block => block.type === "text" ? block.text : "").filter(Boolean).at(-1) ?? "{}"
          const parsed = JSON.parse(textPayload) as { mode?: string; triage?: Record<string, unknown> }
          triagePackets.push(parsed.triage ?? parsed)
          if (failCoordinatorModel) {
            throw new Error("Simulated coordinator model outage")
          }
          const outText = String(parsed.triage?.outputText ?? "")
          const decisionPayload = outText.includes("12 毫秒")
            ? { kind: "record_quietly", summary: "延迟中位数 12ms 处于 50ms 目标上限内，无异常。", reason: "Coordinator model verified metric within SLA" }
            : { kind: "deliver_result", summary: "【延迟超标告警】延迟中位数 180 毫秒，已超出 50 毫秒目标上限。", reason: "Coordinator model detected SLA latency breach" }
          // Return standard `superDecisionSchema` envelope (exact schema used by Claude/Codex/DSH/ACP transports).
          const envelope = {
            reason: "Background follow-up triage evaluation",
            actions: [{ kind: "answer", text: JSON.stringify(decisionPayload) }],
          }
          await client.onUpdate({
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(envelope) } },
          })
          return { stopReason: "end_turn" }
        },
      }
    }
    // Ordinary Worker execution prompt
    return {
      ...conn,
      prompt: async params => {
        const text = workerOutputs[workerRunIndex++] ?? "默认巡检正常。"
        await client.onUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        })
        return { stopReason: "end_turn" }
      },
    }
  }

  const runtime = new MachineRuntime(dir, {
    agentQuotas: new TestAgentQuotas(),
    agentProvider: backend,
    peers: { create: async () => { throw new Error("Unexpected peer creation") }, close: async () => {} },
    capabilities: async () => ({ displays: [], audio: false }),
  })
  t.after(async () => {
    try { await runtime.close() } finally { await rm(dir, { recursive: true, force: true }) }
  })
  await runtime.init()
  runtime.current.central.authorizeDelegation = async value => value

  const configured = await runtime.current.providers.create({
    template: "codex", name: "Isolated Coordinator Fixture", binaryPath: dummyCodexBin, env: {},
  })
  const workspace = await runtime.current.operations.handle("workspaceCreate", {
    name: "LatencyProject", directories: [{ path: working }],
  }, userA) as CatalogWorkspace

  // Enable unified takeover via production frontDesk RPC.
  const enableReceipt = await runtime.current.frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
    action: "enable", installationId: "inst-d3", deviceLabel: "mac-d3", takeoverAllSessions: true,
  }, userA) as FollowUpAuthReceipt
  assert.equal(enableReceipt.summary.takeoverAllSessions, true)

  // Create an `exceptions_only` schedule (inferred from "延迟巡检").
  const task = await runtime.current.operations.handle("scheduleCreate", {
    schedule: {
      title: "网关延迟巡检",
      prompt: "检查网关延迟是否超过 50 毫秒上限",
      workspaceId: workspace.id,
      enabled: true,
      target: { kind: "new", provider: configured.id, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await eventually(async () => {
    await runtime.current.followUp.drainScheduleEvents()
    return runtime.current.followUp.getScheduleSubscription(userA.userId!, workspace.id, task.id)
  }, sub => !!sub?.enabled && sub.deliveryPolicy === "exceptions_only")

  // Run 1: "延迟中位数 12 毫秒，目标上限 50 毫秒。" -> wired production triageModel invoked & returns record_quietly (0 main-chat messages!).
  const r1 = await runtime.current.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(async () => {
    await runtime.current.followUp.drainScheduleEvents()
    return (await runtime.current.followUp.listRuns({ userId: userA.userId!, workspaceId: workspace.id, sourceKind: "schedule", sourceId: task.id, limit: 10 })).runs
  }, runs => runs.some(r => r.runId === r1.id && r.status === "completed"))
  assert.equal(triagePackets.length, 1, "production MachineRuntime MUST invoke wired triageModel for quantitative exceptions_only report")
  assert.match(String(triagePackets[0]!.outputText ?? ""), /12 毫秒/)
  const snap1 = await runtime.current.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspace.id }, userA) as SuperSnapshot
  assert.equal(snap1.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, 0, "model verdict record_quietly keeps chat silent")
  const runRec1 = (await runtime.current.followUp.listRuns({ userId: userA.userId!, workspaceId: workspace.id, sourceKind: "schedule", sourceId: task.id, limit: 10 })).runs.find(r => r.runId === r1.id)!
  assert.equal(runRec1.delivered, false)
  assert.match(runRec1.summary, /12ms 处于 50ms 目标上限内/)

  // Run 2: "延迟中位数 180 毫秒，超出 50 毫秒上限。" -> wired model invoked & returns deliver_result (1 main-chat alert!).
  const r2 = await runtime.current.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const snap2 = await eventually(async () => {
    await runtime.current.followUp.drainScheduleEvents()
    return runtime.current.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspace.id }, userA) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.provenance?.runId === r2.id))
  assert.equal(triagePackets.length, 2, "wired triageModel invoked for Run 2")
  const pushed2 = snap2.messages.filter(m => m.provenance?.origin === "sa_follow_up")
  assert.equal(pushed2.length, 1)
  assert.match(pushed2[0]!.text, /延迟超标告警.*180 毫秒/)

  // Run 3: Model fails/unavailable -> rule fallback conservatively delivers ambiguous quantitative report (never drops!).
  failCoordinatorModel = true
  const r3 = await runtime.current.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const snap3 = await eventually(async () => {
    await runtime.current.followUp.drainScheduleEvents()
    return runtime.current.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspace.id }, userA) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.provenance?.runId === r3.id))
  assert.equal(triagePackets.length, 3, "model attempt occurred before falling back to deterministic rule")
  const pushed3 = snap3.messages.filter(m => m.provenance?.origin === "sa_follow_up")
  assert.equal(pushed3.length, 2, "deterministic fail-closed fallback surfaces Run 3 when model throws")
  assert.match(pushed3[1]!.text, /延迟中位数 95 毫秒/)
  assert.ok(!pushed3[1]!.text.includes("延迟超标告警"), "fallback uses raw deterministic report rather than model summary")

  // Run 4: Provably clean report ("支付接口 A、B、C 全部通过，无异常，无需处理。") -> quiet WITHOUT calling model!
  failCoordinatorModel = false
  const r4 = await runtime.current.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(async () => {
    await runtime.current.followUp.drainScheduleEvents()
    return (await runtime.current.followUp.listRuns({ userId: userA.userId!, workspaceId: workspace.id, sourceKind: "schedule", sourceId: task.id, limit: 10 })).runs
  }, runs => runs.some(r => r.runId === r4.id && r.status === "completed"))
  assert.equal(triagePackets.length, 3, "explicit clean report stays quiet via deterministic rule with 0 extra model calls")
  const snap4 = await runtime.current.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspace.id }, userA) as SuperSnapshot
  assert.equal(snap4.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, 2)

  // Run 5: Master switch OFF -> 0 model calls and 0 alerts!
  await runtime.current.frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
    action: "configure", takeoverAllSessions: false,
  }, userA)
  const r5 = await runtime.current.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(() => Promise.resolve(runtime.current.schedules.inspectTask(task.id)!.task.runs), runs => runs.some(r => r.id === r5.id && r.state === "completed"))
  await runtime.current.followUp.drainScheduleEvents()
  assert.equal(triagePackets.length, 3, "master switch OFF must make 0 model calls")
  const snap5 = await runtime.current.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspace.id }, userA) as SuperSnapshot
  assert.equal(snap5.messages.filter(m => m.provenance?.origin === "sa_follow_up").length, 2)
})

// ============================================================================
// D3b: createCoordinatorTriageModel edge cases (no provider / fenced JSON / malformed)
// ============================================================================
test("D3b: createCoordinatorTriageModel cleanly falls back when unconfigured or malformed, and unwraps fenced coordinator envelopes", async () => {
  const unconfigured = createCoordinatorTriageModel({
    superStore: { get: () => undefined },
    providers: () => [],
    defaultCoordinator: "codex",
    coordinatorModel: () => async () => { throw new Error("should not be called") },
  })
  assert.equal(unconfigured("u1"), undefined)

  // Unwrapping markdown-fenced JSON inside coordinator answer action
  const fenced = extractTriageFromCoordinatorDecision({
    reason: "triage",
    actions: [{ kind: "answer", text: "```json\n{\"kind\":\"record_quietly\",\"summary\":\"All within bounds\",\"reason\":\"ok\"}\n```" }],
  }) as { kind?: string; summary?: string }
  assert.equal(fenced?.kind, "record_quietly")
  assert.equal(fenced?.summary, "All within bounds")

  // Malformed coordinator text falls back deterministically in triageFollowUpEvent
  const resolver = createCoordinatorTriageModel({
    superStore: { get: () => undefined },
    providers: () => [{ id: "p1", name: "Codex", template: "codex" }],
    defaultCoordinator: "codex",
    coordinatorModel: () => async () => ({ reason: "bad", actions: [{ kind: "answer", text: "not valid json" }] }),
  })
  const decision = await triageFollowUpEvent({
    userId: "u1", workspaceId: "ws-1", sourceKind: "schedule", sourceId: "s-1", sourceTitle: "Latency",
    runKey: "run:1", status: "completed", deliveryPolicy: "exceptions_only", ruleMode: "active",
    outputText: "延迟中位数 140ms，超出 50ms 目标。",
  }, { model: resolver("u1") })
  assert.equal(decision.kind, "deliver_result", "malformed model output falls back conservatively to deterministic alert")
})

// ============================================================================
// D5a: Daemon main-chat copy uses verbatim "自动跟进会话与定时任务" everywhere
// ============================================================================
test("D5a: adopt_all, stop_all_follow_up, and missing-auth guidance consistently use verbatim '自动跟进会话与定时任务'", async t => {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-d5a-copy-"))
  const project = join(dir, "repo")
  await mkdir(project, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let nextAction: Record<string, unknown> = { kind: "schedule", operation: "adopt_all" }
  const model: SuperDecisionModel = async () => ({ reason: "test copy", actions: [nextAction] })
  const h = await openHarness(dir, { model })
  active = h
  const wsId = (await h.catalog.native.createWorkspace("CopyProject", [{ path: project }])).id
  await h.providers.create({ template: "codex", name: "Codex", env: {} })

  // 1. adopt_all before auth
  nextAction = { kind: "schedule", operation: "adopt_all" }
  const adoptPending = await sendMainChat(h, wsId, userA, "接管全部")
  assert.ok(adoptPending.reply.includes("自动跟进会话与定时任务"), "adopt_all pending auth uses verbatim switch name")
  assert.ok(!adoptPending.reply.includes("Settings → Super Agent → Enable background follow-up"), "no stale Enable background follow-up guidance")

  // 2. create schedule before auth
  nextAction = {
    kind: "schedule", operation: "create", title: "巡检文案验证", prompt: "检查服务状态",
    targetKind: "directory", trigger: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" }, deliveryPolicy: "every_run",
  }
  const createNoAuth = await sendMainChat(h, wsId, userA, "每天 9 点巡检")
  assert.ok(createNoAuth.reply.includes("自动跟进会话与定时任务"), "missing-auth create guidance uses verbatim switch name")
  assert.ok(!createNoAuth.reply.includes("Settings → Super Agent → Enable background follow-up"))

  // 3. adopt single schedule before auth
  const createdTask = h.schedules.snapshot()[0]!
  nextAction = { kind: "schedule", operation: "adopt", scheduleId: createdTask.id }
  const adoptOneNoAuth = await sendMainChat(h, wsId, userA, "跟进这条计划")
  assert.ok(adoptOneNoAuth.reply.includes("自动跟进会话与定时任务"), "missing-auth adopt guidance uses verbatim switch name")

  // 4. adopt_all after auth & stop_all_follow_up
  await h.enableAuth(userA, "inst-copy", { takeoverAllSessions: true })
  nextAction = { kind: "schedule", operation: "adopt_all" }
  const adoptActive = await sendMainChat(h, wsId, userA, "开启全量接管")
  assert.ok(adoptActive.reply.includes("自动跟进会话与定时任务"))
  assert.match(adoptActive.reply, /ordinary project sessions/i)

  nextAction = { kind: "schedule", operation: "stop_all_follow_up" }
  const stopAll = await sendMainChat(h, wsId, userA, "停止全部跟进")
  assert.ok(stopAll.reply.includes("自动跟进会话与定时任务"))
  assert.match(stopAll.reply, /ordinary sessions/i)
})
