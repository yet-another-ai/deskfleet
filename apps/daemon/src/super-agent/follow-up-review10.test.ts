import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import { eventually, makeAcpToolBackend, openHarness, type FollowUpHarness } from "../fixtures/follow-up-harness.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import type { FollowUpAuthReceipt, FollowUpRunsPage } from "@deskfleet/protocol/super-agent-follow-up"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import { routeSuperMessage, type SuperDecisionModel } from "./router.ts"

const userA: AgentActor = { kind: "user", userId: "user-rev10-a", deviceId: "dev-rev10-a" }
const userB: AgentActor = { kind: "user", userId: "user-rev10-b", deviceId: "dev-rev10-b" }

async function sendMainChat(
  h: FollowUpHarness,
  workspaceId: string,
  actor: AgentActor,
  text: string,
  timeZone?: string,
): Promise<{ reply: string; snapshot: SuperSnapshot }> {
  const messageId = randomUUID()
  await h.frontDesk.handle("_deskfleet/super-agent/send", {
    workspaceId,
    messageId,
    text,
    ...(timeZone !== undefined ? { timeZone } : {}),
  }, actor)
  const snapshot = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor) as Promise<SuperSnapshot>,
    snap => {
      const m = snap.messages.find(x => x.id === messageId)
      return !!m && m.state !== "routing"
    },
  )
  const userMsg = snapshot.messages.find(m => m.id === messageId)
  assert.equal(userMsg?.state, "answered", `Expected answered, got ${userMsg?.state}: ${userMsg?.reason}`)
  const reply = snapshot.messages.filter(m => m.role === "assistant" && m.sourceMessageId === messageId).map(m => m.text).join("\n")
  return { reply, snapshot }
}

function makePermissionBackend(handler: (prompt: string, tools: {
  requestPermission: (title: string) => Promise<string>
  emitFinal: (text: string) => Promise<void>
  holdUntil?: Promise<void>
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
          requestPermission: async title => {
            const toolCallId = `tc-${randomUUID()}`
            const resp = await client.requestPermission!({
              sessionId: params.sessionId,
              toolCall: { toolCallId, title, kind: "execute", status: "pending" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Reject", kind: "reject_once" },
              ],
            }, new AbortController().signal)
            return resp.outcome.outcome === "selected" ? resp.outcome.optionId : "cancelled"
          },
          emitFinal: async text => {
            await client.onUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
                _meta: { deskfleet: { phase: "final_answer", purpose: "final_answer" } },
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

function initGitRepo(dir: string) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" })
}

// ============================================================================
// P1-1: Existing-session approval card never swallows final report or failure
// ============================================================================
test("P1-1: approval receipt never swallows final scheduled report in existing session or post-approval ordinary Worker failure", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p1-1-"))
  const projDir = join(dir, "proj")
  await mkdir(projDir, { recursive: true })
  await writeFile(join(projDir, "README.md"), "# P1-1\n")

  const backend = makePermissionBackend(async (prompt, { requestPermission, emitFinal }) => {
    if (prompt.includes("SCHEDULE_APPROVAL_REPORT")) {
      const choice = await requestPermission("Run database health check")
      assert.equal(choice, "allow")
      await emitFinal("全部 128 个节点健康检查通过，0 异常。")
      return
    }
    if (prompt.includes("WORKER_APPROVAL_THEN_FAIL")) {
      const choice = await requestPermission("Apply config patch")
      assert.equal(choice, "allow")
      throw new Error("Patch checksum mismatch after approval")
    }
    await emitFinal("Done.")
  })

  const h = await openHarness(dir, { backend })
  t.after(async () => {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })

  const wsId = (await h.catalog.native.createWorkspace("ProdOps", [{ path: projDir }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.enableAuth(userA, "mac-p1-1", { takeoverAllSessions: true })

  // 1) Existing-session scheduled task with every_run policy: approval -> final report
  const existingSess = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), provider, context: "directory", title: "Shared Ops Session",
  }, userA) as AgentSnapshot).session
  await eventually(
    async () => h.followUpStore.getSource(userA.userId!, wsId, "session", existingSess.id),
    src => !!src?.state.enabled,
  )

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "每日健康检查日报",
      prompt: "SCHEDULE_APPROVAL_REPORT",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "existing", sessionId: existingSess.id },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await eventually(
    async () => h.followUpStore.getSource(userA.userId!, wsId, "schedule", task.id),
    src => !!src?.state.enabled && src.state.deliveryPolicy === "every_run",
  )

  const run = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  const snapPending = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    snap => (snap.pendingRequests ?? []).some(r => r.kind === "permission" && r.item.sessionId === existingSess.id)
      && snap.messages.some(m => m.workerEvent === "permission" && m.sessionId === existingSess.id),
  )
  const perm = snapPending.pendingRequests!.find(r => r.kind === "permission" && r.item.sessionId === existingSess.id)!
  await h.agents.handle("_deskfleet/permission/respond", {
    sessionId: existingSess.id, permissionId: perm.item.id, operationId: randomUUID(), optionId: "allow",
  }, userA)

  await eventually(
    async () => h.schedules.inspectTask(task.id)!.task.runs,
    runs => runs.some(r => r.id === run.id && r.state === "completed"),
  )
  await h.followUp.drainScheduleEvents()

  const snapAfterSched = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.role === "assistant" && m.provenance?.runId === run.id && m.text.includes("全部 128 个节点健康检查通过")),
  )
  const approvalCards = snapAfterSched.messages.filter(m => m.workerEvent === "permission" && m.sessionId === existingSess.id)
  const finalReports = snapAfterSched.messages.filter(m => m.role === "assistant" && m.provenance?.runId === run.id)
  assert.equal(approvalCards.length, 1, "Approval card must stay preserved")
  assert.match(approvalCards[0]!.text, /^Allow · Run database health check/u)
  assert.equal(finalReports.length, 1, "Final schedule report must arrive as its own message (not swallowed by approval card)")
  assert.notEqual(finalReports[0]!.id, approvalCards[0]!.id)
  assert.match(finalReports[0]!.text, /全部 128 个节点健康检查通过/u)

  const runsPage = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "schedule", sourceId: task.id, limit: 10 }, userA) as FollowUpRunsPage
  const runRec = runsPage.runs.find(r => r.runId === run.id)!
  assert.equal(runRec.delivered, true)
  assert.equal(runRec.deliveredMessageId, finalReports[0]!.id)

  // Re-draining must still keep final report deduplicated at 1
  await h.followUp.drainScheduleEvents()
  const snapAfterRedrain = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapAfterRedrain.messages.filter(m => m.role === "assistant" && m.provenance?.runId === run.id).length, 1)

  // 2) Ordinary Worker: approval -> subsequent failure on same turn MUST NOT be swallowed
  const ordSess = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), provider, context: "directory", title: "Ordinary Patch Worker",
  }, userA) as AgentSnapshot).session
  await eventually(
    async () => h.followUpStore.getSource(userA.userId!, wsId, "session", ordSess.id),
    src => !!src?.state.enabled,
  )

  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: ordSess.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "WORKER_APPROVAL_THEN_FAIL" }],
  }, userA)
  const snapOrdPending = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    snap => (snap.pendingRequests ?? []).some(r => r.kind === "permission" && r.item.sessionId === ordSess.id)
      && snap.messages.some(m => m.workerEvent === "permission" && m.sessionId === ordSess.id),
  )
  const ordPerm = snapOrdPending.pendingRequests!.find(r => r.kind === "permission" && r.item.sessionId === ordSess.id)!
  await h.agents.handle("_deskfleet/permission/respond", {
    sessionId: ordSess.id, permissionId: ordPerm.item.id, operationId: randomUUID(), optionId: "allow",
  }, userA)

  const snapAfterOrdFail = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.role === "assistant" && m.sessionId === ordSess.id && m.text.includes("Patch checksum mismatch after approval")),
  )
  const ordApproval = snapAfterOrdFail.messages.filter(m => m.workerEvent === "permission" && m.sessionId === ordSess.id)
  const ordFailures = snapAfterOrdFail.messages.filter(m => m.role === "assistant" && m.sessionId === ordSess.id)
  assert.equal(ordApproval.length, 1)
  assert.match(ordApproval[0]!.text, /^Allow · Apply config patch/u)
  assert.equal(ordFailures.length, 1, "Post-approval ordinary Worker failure must not be swallowed by approval card")
  assert.notEqual(ordFailures[0]!.id, ordApproval[0]!.id)
})

// ============================================================================
// P1-2: Directory & worktree schedules surface live pending approvals in SA
// ============================================================================
test("P1-2: working directory and new worktree scheduled tasks surface live pending approvals in project SA and deliver final report once after approval", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p1-2-"))
  const repoA = join(dir, "repo-a")
  const repoB = join(dir, "repo-b")
  await mkdir(repoA, { recursive: true })
  await mkdir(repoB, { recursive: true })
  await writeFile(join(repoA, "README.md"), "# Repo A\n")
  await writeFile(join(repoB, "README.md"), "# Repo B\n")
  initGitRepo(repoA)

  const backend = makePermissionBackend(async (prompt, { requestPermission, emitFinal }) => {
    if (prompt.includes("DIR_SCHEDULE_APPROVAL")) {
      const choice = await requestPermission("Execute release check in directory")
      assert.equal(choice, "allow")
      await emitFinal("工作目录发布检查日报：所有校验通过。")
      return
    }
    if (prompt.includes("WT_SCHEDULE_APPROVAL")) {
      const choice = await requestPermission("Execute release check in worktree")
      assert.equal(choice, "allow")
      await emitFinal("新 worktree 发布检查日报：隔离构建全部通过。")
      return
    }
    await emitFinal("OK")
  })

  const h = await openHarness(dir, { backend })
  t.after(async () => {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })

  const wsA = (await h.catalog.native.createWorkspace("ProjectA", [{ path: repoA }])).id
  const wsB = (await h.catalog.native.createWorkspace("ProjectB", [{ path: repoB }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.enableAuth(userA, "mac-p1-2", { takeoverAllSessions: true })

  for (const mode of [
    { context: "directory" as const, title: "工作目录发布日报", prompt: "DIR_SCHEDULE_APPROVAL", permTitle: "Execute release check in directory", expectedReport: "工作目录发布检查日报：所有校验通过。" },
    { context: "worktree" as const, title: "Worktree发布日报", prompt: "WT_SCHEDULE_APPROVAL", permTitle: "Execute release check in worktree", expectedReport: "新 worktree 发布检查日报：隔离构建全部通过。" },
  ]) {
    const task = await h.operations.handle("scheduleCreate", {
      schedule: {
        title: mode.title,
        prompt: mode.prompt,
        workspaceId: wsA,
        enabled: true,
        target: { kind: "new", provider, context: mode.context },
        trigger: { kind: "manual" },
      },
    }, userA) as ScheduledTask

    const run = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun

    // While paused waiting for manual approval, Project A SA MUST show BOTH pendingRequests and main-chat notice!
    const snapWaiting = await eventually(
      () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as Promise<SuperSnapshot>,
      snap => (snap.pendingRequests ?? []).some(r => r.kind === "permission" && r.sourceKind === "schedule" && r.sourceId === task.id)
        && snap.messages.some(m => m.workerEvent === "permission" && m.provenance?.scheduleId === task.id),
    )
    const pending = snapWaiting.pendingRequests!.find(r => r.kind === "permission" && r.sourceId === task.id)!
    assert.equal(pending.sourceTitle, mode.title)
    const notice = snapWaiting.messages.find(m => m.workerEvent === "permission" && m.provenance?.scheduleId === task.id)!
    assert.match(notice.text, new RegExp(mode.permTitle))

    // Unrelated Project B must remain completely clean!
    const snapB = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, userA) as SuperSnapshot
    assert.equal(snapB.messages.length, 0)
    assert.equal(snapB.pendingRequests?.length ?? 0, 0)

    // Approve the pending permission -> card resolves, pending tray clears, and final report delivers ONCE!
    await h.agents.handle("_deskfleet/permission/respond", {
      sessionId: pending.item.sessionId,
      permissionId: pending.item.id,
      operationId: randomUUID(),
      optionId: "allow",
    }, userA)

    await eventually(
      async () => h.schedules.inspectTask(task.id)!.task.runs,
      runs => runs.some(r => r.id === run.id && r.state === "completed"),
    )
    await h.followUp.drainScheduleEvents()

    const snapDone = await eventually(
      () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as Promise<SuperSnapshot>,
      snap => snap.messages.some(m => m.role === "assistant" && m.provenance?.runId === run.id && m.text.includes(mode.expectedReport))
        && !(snap.pendingRequests ?? []).some(r => r.sourceId === task.id),
    )
    await delay(60)
    const snapStable = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
    const permMsgs = snapStable.messages.filter(m => m.workerEvent === "permission" && m.provenance?.scheduleId === task.id)
    const reportMsgs = snapStable.messages.filter(m => m.role === "assistant" && m.provenance?.runId === run.id)
    assert.equal(permMsgs.length, 1, `${mode.context}: permission card appears once`)
    assert.match(permMsgs[0]!.text, new RegExp(`^Allow · ${mode.permTitle}`))
    assert.equal(reportMsgs.length, 1, `${mode.context}: final report delivered exactly once`)
    assert.match(reportMsgs[0]!.text, new RegExp(mode.expectedReport))
  }
})

// ============================================================================
// P1-3: Explicit per-schedule opt-out on creation survives takeover & restart
// ============================================================================
test("P1-3: schedule created with explicit opt-out (followUpEnabled: false) persists opt-out across master takeover, reload, and first run", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p1-3-"))
  const projDir = join(dir, "proj")
  await mkdir(projDir, { recursive: true })
  await writeFile(join(projDir, "README.md"), "# P1-3\n")

  const makeModel = (): SuperDecisionModel => async packet => {
    const msg = String((packet as { message?: string }).message ?? "")
    if (msg.includes("不用 SA 跟进")) {
      return {
        reason: "Explicitly opt out of SA follow-up on creation",
        actions: [{
          kind: "schedule",
          operation: "create",
          title: "静默备份日报",
          prompt: "OPT_OUT_REPORT",
          targetKind: "directory",
          trigger: { kind: "manual" },
          deliveryPolicy: "every_run",
          followUpEnabled: false,
        }],
      }
    }
    return {
      reason: "Default unspecified follow-up on creation",
      actions: [{
        kind: "schedule",
        operation: "create",
        title: "默认跟进日报",
        prompt: "DEFAULT_FOLLOW_REPORT",
        targetKind: "directory",
        trigger: { kind: "manual" },
        deliveryPolicy: "every_run",
      }],
    }
  }

  const makeBackend = () => makeAcpToolBackend(prompt => ({
    events: [{
      kind: "text",
      text: prompt.includes("OPT_OUT_REPORT") ? "静默备份正文：不得进入 SA 主对话。" : "默认跟进正文：应当推送至 SA 主对话。",
      phase: "final_answer",
      purpose: "final_answer",
    }],
  }))

  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  const h1 = await openHarness(dir, { backend: makeBackend(), model: makeModel() })
  active = h1
  const wsId = (await h1.catalog.native.createWorkspace("OptOutProj", [{ path: projDir }])).id
  const provider = (await h1.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h1.frontDesk.handle("_deskfleet/super-agent/settings", { workspaceId: wsId, provider }, userA)
  await h1.enableAuth(userA, "mac-p1-3", { takeoverAllSessions: true })

  // Create schedule #1 with explicit opt-out and schedule #2 with unspecified followUpEnabled
  const optOutCreate = await sendMainChat(h1, wsId, userA, "创建一个静默备份日报，不用 SA 跟进")
  assert.match(optOutCreate.reply, /SA follow-up: Not enabled/u)
  const defaultCreate = await sendMainChat(h1, wsId, userA, "创建一个默认跟进日报")
  assert.match(defaultCreate.reply, /SA follow-up: Active/u)

  const tasks = h1.schedules.snapshot()
  const optOutTask = tasks.find(x => x.title === "静默备份日报")!
  const defaultTask = tasks.find(x => x.title === "默认跟进日报")!
  assert.ok(optOutTask && defaultTask)

  await h1.followUp.drainScheduleEvents()
  await h1.followUp.syncWorkspaceTakeover(userA.userId!, wsId)
  const optOutSrc1 = h1.followUpStore.getSource(userA.userId!, wsId, "schedule", optOutTask.id)
  assert.equal(optOutSrc1?.state.enabled, false)
  assert.equal(optOutSrc1?.state.optedOut, true)
  assert.equal(h1.followUp.getScheduleSubscription(userA.userId!, wsId, optOutTask.id)?.enabled, false)
  assert.equal(h1.followUp.getScheduleSubscription(userA.userId!, wsId, defaultTask.id)?.enabled, true)

  // Reload / restart host on the same SQLite database — auto-takeover scan on startup MUST NOT re-enroll optOutTask!
  await h1.close()
  const h2 = await openHarness(dir, { backend: makeBackend(), model: makeModel() })
  active = h2
  await h2.followUp.syncWorkspaceTakeover(userA.userId!, wsId)
  const optOutSrc2 = h2.followUpStore.getSource(userA.userId!, wsId, "schedule", optOutTask.id)
  assert.equal(optOutSrc2?.state.enabled, false, "Opt-out must persist after reload")
  assert.equal(optOutSrc2?.state.optedOut, true, "optedOut flag must remain true after reload")
  assert.equal(h2.followUp.getScheduleSubscription(userA.userId!, wsId, optOutTask.id)?.enabled, false)

  // Run opt-out schedule's first run -> native run completes, ZERO SA main-chat deliveries & ZERO follow-up runs!
  const optOutRun = await h2.operations.handle("scheduleRun", { scheduleId: optOutTask.id }, userA) as ScheduleRun
  await eventually(
    async () => h2.schedules.inspectTask(optOutTask.id)!.task.runs,
    runs => runs.some(r => r.id === optOutRun.id && r.state === "completed"),
  )
  await h2.followUp.drainScheduleEvents()
  await delay(80)

  const snapAfterOptOut = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapAfterOptOut.messages.filter(m => m.provenance?.origin === "sa_follow_up" && m.provenance?.scheduleId === optOutTask.id).length, 0)
  assert.ok(!snapAfterOptOut.messages.some(m => m.text.includes("不得进入 SA 主对话")))
  const optOutRuns = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "schedule", sourceId: optOutTask.id, limit: 10 }, userA) as FollowUpRunsPage
  assert.equal(optOutRuns.runs.length, 0)

  // Control: unspecified schedule's first run DOES deliver cleanly!
  const defaultRun = await h2.operations.handle("scheduleRun", { scheduleId: defaultTask.id }, userA) as ScheduleRun
  await eventually(
    async () => h2.schedules.inspectTask(defaultTask.id)!.task.runs,
    runs => runs.some(r => r.id === defaultRun.id && r.state === "completed"),
  )
  await h2.followUp.drainScheduleEvents()
  const snapAfterDefault = await eventually(
    () => h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.provenance?.runId === defaultRun.id && m.text.includes("默认跟进正文")),
  )
  assert.equal(snapAfterDefault.messages.filter(m => m.provenance?.runId === defaultRun.id).length, 1)
})

// ============================================================================
// P2-1: Shared-directory session reassigned A -> B routes failures only to B
// ============================================================================
test("P2-1: reassigning a shared-directory session from project A to project B migrates follow-up and sends subsequent failures only to B", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p2-1-"))
  const sharedDir = join(dir, "shared-repo")
  await mkdir(sharedDir, { recursive: true })
  await writeFile(join(sharedDir, "README.md"), "# Shared\n")

  const backend = makePermissionBackend(async (prompt, { emitFinal }) => {
    if (prompt.includes("FAIL_AFTER_MOVE")) {
      throw new Error("Build broke after reassignment to Project B")
    }
    await emitFinal("Initial work done.")
  })

  const h = await openHarness(dir, { backend })
  t.after(async () => {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })

  const wsA = (await h.catalog.native.createWorkspace("ProjectA", [{ path: sharedDir }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.enableAuth(userA, "mac-p2-1", { takeoverAllSessions: true })

  // Create unassigned "New Conversation" session in sharedDir -> uniquely matches Project A initially
  const sess = (await h.agents.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider, context: "directory", cwd: sharedDir, title: "Shared Dir History Session",
  }, userA) as AgentSnapshot).session
  assert.equal(sess.workspaceId, undefined)
  await eventually(
    async () => h.followUpStore.getSource(userA.userId!, wsA, "session", sess.id),
    src => !!src?.state.enabled,
  )

  // Now create Project B sharing the exact same directory, then explicitly assign the session to Project B
  const wsB = (await h.catalog.native.createWorkspace("ProjectB", [{ path: sharedDir }])).id
  await h.frontDesk.handle("_deskfleet/super-agent/history", {
    view: "groups",
    assign: { workspaceId: wsB, sessionIds: [sess.id] },
  }, userA)

  // Trigger a new failure on the session -> ONLY Project B should receive the failure notice!
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: sess.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "FAIL_AFTER_MOVE" }],
  }, userA)

  const snapB = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, userA) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.sessionId === sess.id && m.text.includes("Build broke after reassignment to Project B")),
  )
  await delay(80)
  const snapA = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
  assert.equal(snapB.messages.filter(m => m.sessionId === sess.id).length, 1, "Project B must receive the failure alert")
  assert.equal(snapA.messages.filter(m => m.sessionId === sess.id).length, 0, "Project A must receive 0 alerts after reassignment")

  const oldSrcA = h.followUpStore.getSource(userA.userId!, wsA, "session", sess.id)
  const newSrcB = h.followUpStore.getSource(userA.userId!, wsB, "session", sess.id)
  assert.equal(oldSrcA?.state.enabled, false)
  assert.equal(oldSrcA?.state.pausedReason, "ownership_changed")
  assert.equal(newSrcB?.state.enabled, true)
})

// ============================================================================
// P2-2: Resuming a single ordinary session skips paused-period failures
// ============================================================================
test("P2-2: resuming a single paused ordinary session advances cursor past paused-period failures while delivering post-resume failures", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p2-2-"))
  const projDir = join(dir, "proj")
  await mkdir(projDir, { recursive: true })

  const backend = makePermissionBackend(async (prompt, { emitFinal }) => {
    if (prompt.includes("PAUSED_FAIL")) throw new Error("Paused-period transient outage")
    if (prompt.includes("POST_RESUME_FAIL")) throw new Error("Post-resume real build failure")
    await emitFinal("All clean.")
  })

  const h = await openHarness(dir, { backend })
  t.after(async () => {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })

  const wsId = (await h.catalog.native.createWorkspace("ResumeProj", [{ path: projDir }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.enableAuth(userA, "mac-p2-2", { takeoverAllSessions: true })

  const sess = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), provider, context: "directory", title: "Single Pause Worker",
  }, userA) as AgentSnapshot).session
  await eventually(
    async () => h.followUpStore.getSource(userA.userId!, wsId, "session", sess.id),
    src => !!src?.state.enabled,
  )

  // Pause ONLY this single ordinary session
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "session", sourceId: sess.id, enabled: false,
  }, userA)

  // Trigger a failure while paused
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: sess.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "PAUSED_FAIL" }],
  }, userA)
  await eventually(
    () => h.agents.journal.read(sess.id),
    snap => snap.turns.some(turn => turn.state === "failed" || turn.state === "interrupted"),
  )
  await delay(60)
  const snapPaused = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapPaused.messages.length, 0, "0 alerts while single session is paused")

  // Resume ONLY this single ordinary session -> cursor must advance past the paused-period failure
  const resumed = await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsId, sourceKind: "session", sourceId: sess.id, enabled: true,
  }, userA) as { state: { cursorSeq?: string } }
  const afterPauseSnap = await h.agents.journal.read(sess.id)
  assert.equal(resumed.state.cursorSeq, afterPauseSnap.session.lastEventSeq)

  // Run a clean turn after resume -> paused-period failure MUST NOT replay!
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: sess.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "CLEAN_TURN" }],
  }, userA)
  await eventually(
    () => h.agents.journal.read(sess.id),
    snap => snap.turns.length >= 2 && snap.turns.at(-1)?.state === "completed",
  )
  await delay(80)
  const snapAfterClean = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapAfterClean.messages.length, 0, "Paused-period failure must NOT replay on next turn after resume")

  // Trigger a brand-new failure AFTER resume -> MUST deliver cleanly!
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: sess.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "POST_RESUME_FAIL" }],
  }, userA)
  const snapAfterNewFail = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.text.includes("Post-resume real build failure")),
  )
  assert.equal(snapAfterNewFail.messages.length, 1)
  assert.ok(!snapAfterNewFail.messages.some(m => m.text.includes("Paused-period transient outage")))
})

// ============================================================================
// P2-3: Missing client timeZone falls back to execution host timeZone (not UTC)
// ============================================================================
test("P2-3: missing client timeZone falls back to execution machine timeZone while preserving explicit client and trigger timeZones", async t => {
  const prevTz = process.env.TZ
  process.env.TZ = "Asia/Shanghai"
  t.after(() => {
    if (prevTz === undefined) delete process.env.TZ
    else process.env.TZ = prevTz
  })
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Shanghai")

  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p2-3-"))
  const projDir = join(dir, "proj")
  await mkdir(projDir, { recursive: true })

  let seenPacketTz: unknown
  const model: SuperDecisionModel = async packet => {
    seenPacketTz = (packet as { clientTimeZone?: string }).clientTimeZone
    const msg = String((packet as { message?: string }).message ?? "")
    if (msg.includes("显式伦敦")) {
      return {
        reason: "Explicit trigger timezone",
        actions: [{
          kind: "schedule", operation: "create", title: "伦敦定时", prompt: "Check",
          targetKind: "directory", trigger: { kind: "daily", time: "09:00", timeZone: "Europe/London" },
        }],
      }
    }
    return {
      reason: "Omit trigger timezone to test fallback",
      actions: [{
        kind: "schedule", operation: "create",
        title: msg.includes("纽约客户端") ? "纽约客户端定时" : "默认宿主时区定时",
        prompt: "Check",
        targetKind: "directory",
        trigger: { kind: "daily", time: "09:00" } as never,
      }],
    }
  }

  // 1) Direct router check: missing clientTimeZone -> host timezone (Asia/Shanghai), NOT UTC!
  const routedHost = await routeSuperMessage({
    workspaceId: "ws-1",
    text: "每天早上 9 点检查",
    recent: [],
    tickets: [],
    workspaces: [{ id: "ws-1", name: "Proj" }],
  }, { model })
  assert.equal(seenPacketTz, "Asia/Shanghai")
  assert.equal(routedHost.actions[0]?.kind, "schedule")
  assert.deepEqual((routedHost.actions[0] as { trigger?: unknown }).trigger, { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" })

  // 2) End-to-end persistence via SuperAgentService:
  //    (a) client omits timeZone -> stored as 09:00 Asia/Shanghai
  //    (b) client sends America/New_York -> stored as 09:00 America/New_York
  //    (c) explicit trigger Europe/London overrides client America/New_York
  const h = await openHarness(dir, { model })
  t.after(async () => {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })
  const wsId = (await h.catalog.native.createWorkspace("TzProj", [{ path: projDir }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.frontDesk.handle("_deskfleet/super-agent/settings", { workspaceId: wsId, provider }, userA)

  await sendMainChat(h, wsId, userA, "每天早上 9 点巡检（客户端未传时区）")
  await sendMainChat(h, wsId, userA, "每天早上 9 点巡检（纽约客户端）", "America/New_York")
  await sendMainChat(h, wsId, userA, "每天早上 9 点显式伦敦巡检", "America/New_York")

  const saved = h.schedules.snapshot()
  const hostTask = saved.find(x => x.title === "默认宿主时区定时")!
  const clientTask = saved.find(x => x.title === "纽约客户端定时")!
  const explicitTask = saved.find(x => x.title === "伦敦定时")!
  assert.deepEqual(hostTask.trigger, { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" })
  assert.deepEqual(clientTask.trigger, { kind: "daily", time: "09:00", timeZone: "America/New_York" })
  assert.deepEqual(explicitTask.trigger, { kind: "daily", time: "09:00", timeZone: "Europe/London" })
})

// ============================================================================
// P2-4: Main-chat schedule update persists target changes & runs on new target
// ============================================================================
test("P2-4: main-chat schedule update persists target changes (existing -> directory -> worktree), clears obsolete sessionId, and executes next run on new target", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p2-4-"))
  const repoDir = join(dir, "repo")
  await mkdir(repoDir, { recursive: true })
  await writeFile(join(repoDir, "README.md"), "# Target Update Repo\n")
  initGitRepo(repoDir)

  let targetScheduleId = ""
  const model: SuperDecisionModel = async packet => {
    const msg = String((packet as { message?: string }).message ?? "")
    if (msg.includes("改成工作目录")) {
      return {
        reason: "Switch existing-session schedule to working directory",
        actions: [{ kind: "schedule", operation: "update", scheduleId: targetScheduleId, targetKind: "directory" }],
      }
    }
    return {
      reason: "Switch schedule to new worktree",
      actions: [{ kind: "schedule", operation: "update", scheduleId: targetScheduleId, targetKind: "worktree" }],
    }
  }

  const backend = makeAcpToolBackend(() => ({
    events: [{ kind: "text", text: "Target switch run OK.", phase: "final_answer", purpose: "final_answer" }],
  }))
  const h = await openHarness(dir, { backend, model })
  t.after(async () => {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })

  const wsId = (await h.catalog.native.createWorkspace("TargetProj", [{ path: repoDir }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.frontDesk.handle("_deskfleet/super-agent/settings", { workspaceId: wsId, provider }, userA)

  const legacySess = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), provider, context: "directory", title: "Legacy Existing Session",
  }, userA) as AgentSnapshot).session

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "目标切换巡检",
      prompt: "Run target check",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "existing", sessionId: legacySess.id },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  targetScheduleId = task.id
  assert.deepEqual(task.target, { kind: "existing", sessionId: legacySess.id })

  // 1) Switch existing -> directory via main chat
  const dirReply = await sendMainChat(h, wsId, userA, "把这条计划从已有会话改成工作目录运行")
  assert.match(dirReply.reply, /working directory/u)
  const afterDir = h.schedules.inspectTask(task.id)!.task
  assert.equal(afterDir.target.kind, "new")
  assert.equal(afterDir.target.context, "directory")
  assert.equal(afterDir.target.provider, provider)
  assert.equal("sessionId" in afterDir.target, false, "Obsolete sessionId must be cleared")

  const dirRun = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(
    async () => h.schedules.inspectTask(task.id)!.task.runs,
    runs => runs.some(r => r.id === dirRun.id && r.state === "completed"),
  )
  const completedDirRun = h.schedules.inspectTask(task.id)!.task.runs.find(r => r.id === dirRun.id)!
  assert.ok(completedDirRun.sessionId && completedDirRun.sessionId !== legacySess.id, "Next run must NOT reuse old existing session")
  const dirSessionSnap = await h.agents.journal.read(completedDirRun.sessionId!)
  assert.equal(dirSessionSnap.session.context, "directory")

  // 2) Switch directory -> worktree via main chat
  const wtReply = await sendMainChat(h, wsId, userA, "再把这条计划改成新 worktree 运行")
  assert.match(wtReply.reply, /new worktree/u)
  const afterWt = h.schedules.inspectTask(task.id)!.task
  assert.equal(afterWt.target.kind, "new")
  assert.equal(afterWt.target.context, "worktree")
  assert.equal("sessionId" in afterWt.target, false)

  const wtRun = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(
    async () => h.schedules.inspectTask(task.id)!.task.runs,
    runs => runs.some(r => r.id === wtRun.id && r.state === "completed"),
  )
  const completedWtRun = h.schedules.inspectTask(task.id)!.task.runs.find(r => r.id === wtRun.id)!
  assert.ok(completedWtRun.sessionId && completedWtRun.sessionId !== legacySess.id && completedWtRun.sessionId !== completedDirRun.sessionId)
  const wtSessionSnap = await h.agents.journal.read(completedWtRun.sessionId!)
  assert.equal(wtSessionSnap.session.context, "worktree")
})

// ============================================================================
// P2-5: Exact runId lookup works beyond 50 recent runs & enforces ownership
// ============================================================================
test("P2-5: exact runId lookup finds run #1 after 55 runs via both inspect and readScheduleRuns while enforcing ownership", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p2-5-"))
  const projDir = join(dir, "proj")
  await mkdir(projDir, { recursive: true })

  let targetScheduleId = ""
  const model: SuperDecisionModel = async packet => {
    const p = packet as { message?: string; evidence?: { request: { kind: string }; result: string }[] }
    if (String(p.message ?? "").includes("证据读取")) {
      if (!p.evidence?.length) {
        return {
          reason: "Read exact run #1 via scheduleRuns evidence",
          actions: [{ kind: "evidence", request: { kind: "scheduleRuns", scheduleId: targetScheduleId, runId: "run-001" } }],
        }
      }
      return {
        reason: "Answer from exact scheduleRuns evidence",
        actions: [{ kind: "answer", text: `Evidence: ${p.evidence[0]!.result}` }],
      }
    }
    return {
      reason: "Inspect exact run #1",
      actions: [{ kind: "schedule", operation: "inspect", scheduleId: targetScheduleId, runId: "run-001" }],
    }
  }

  const h = await openHarness(dir, { model })
  t.after(async () => {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })

  const wsId = (await h.catalog.native.createWorkspace("DeepRunProj", [{ path: projDir }])).id
  const wsOther = (await h.catalog.native.createWorkspace("OtherProj", [{ path: dir }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.frontDesk.handle("_deskfleet/super-agent/settings", { workspaceId: wsId, provider }, userA)
  await h.frontDesk.handle("_deskfleet/super-agent/settings", { workspaceId: wsId, provider }, userB)

  const task = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "高频巡检任务",
      prompt: "Check metrics",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  targetScheduleId = task.id

  // Persist 55 completed runs in real SQLite so run-001 sits strictly outside the latest 50!
  for (let i = 1; i <= 55; i += 1) {
    const id = `run-${String(i).padStart(3, "0")}`
    const ts = new Date(Date.UTC(2026, 10, 1, 0, i, 0)).toISOString()
    await h.followUpStore.upsertRun({
      userId: userA.userId!,
      workspaceId: wsId,
      sourceKind: "schedule",
      sourceId: task.id,
      runKey: `run:${id}`,
      scheduleId: task.id,
      scheduleTitle: task.title,
      runId: id,
      startedAt: ts,
      finishedAt: ts,
      status: "completed",
      deliveryPolicy: "every_run",
      delivered: true,
      summary: i === 1 ? "第 1 次报告正文：发现旧账单差异 42 元。" : `第 ${i} 次报告：一切正常。`,
      evidenceAvailability: "available",
      createdAt: ts,
      updatedAt: ts,
    })
  }

  // 1) Inspect by exact runId via schedule action
  const inspectRes = await sendMainChat(h, wsId, userA, "查询精确运行 run-001")
  assert.match(inspectRes.reply, /run-001/u)
  assert.match(inspectRes.reply, /第 1 次报告正文：发现旧账单差异 42 元。/u)

  // 2) Evidence readScheduleRuns by exact runId
  const evidenceRes = await sendMainChat(h, wsId, userA, "用证据读取 run-001")
  assert.match(evidenceRes.reply, /第 1 次报告正文：发现旧账单差异 42 元。/u)

  // 3) Ownership isolation: User B or another workspace MUST NOT read User A's run-001
  assert.equal(await h.followUp.getScheduleRun(userB.userId!, wsId, task.id, "run-001"), undefined)
  assert.equal(await h.followUp.getScheduleRun(userA.userId!, wsOther, task.id, "run-001"), undefined)
  const userBInspect = await sendMainChat(h, wsId, userB, "查询精确运行 run-001")
  assert.ok(!userBInspect.reply.includes("发现旧账单差异 42 元"), "User B must not see User A's persisted private run")
  assert.match(userBInspect.reply, /was not found/u)
})

// ============================================================================
// P2-6: Revoking last device authorization paginates beyond 200 actions
// ============================================================================
test("P2-6: revoking last device authorization paginates beyond 200 newer actions to withdraw older queued automated input and cancel all pending actions", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p2-6-"))
  const projDir = join(dir, "proj")
  await mkdir(projDir, { recursive: true })

  let releaseBlockingTurn!: () => void
  const blockingTurn = new Promise<void>(resolve => { releaseBlockingTurn = resolve })
  let startedBlocking!: () => void
  const blockingStarted = new Promise<void>(resolve => { startedBlocking = resolve })

  const backend = makePermissionBackend(async (prompt, { emitFinal }) => {
    if (prompt.includes("HOLD_BUSY_TURN")) {
      startedBlocking()
      await blockingTurn
      await emitFinal("Busy turn done.")
      return
    }
    await emitFinal("Queued input should never run.")
  })

  const h = await openHarness(dir, { backend })
  t.after(async () => {
    releaseBlockingTurn()
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })

  const wsId = (await h.catalog.native.createWorkspace("RevokePageProj", [{ path: projDir }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.enableAuth(userA, "mac-last", { takeoverAllSessions: true })

  const sess = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), provider, context: "directory", title: "Busy Worker",
  }, userA) as AgentSnapshot).session

  // Start a blocking human turn, then queue an automated backlog input behind it (state === "pending")
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: sess.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "HOLD_BUSY_TURN" }],
  }, userA)
  await blockingStarted

  const queuedActionId = randomUUID()
  const queuedReceipt = await h.agents.handle("_deskfleet/input/submit", {
    sessionId: sess.id, operationId: randomUUID(), delivery: "backlog",
    content: [{
      type: "text",
      text: "Automated supplement queued before 200+ newer actions",
      _meta: { "deskfleet/followUpOrigin": "sa_follow_up", "deskfleet/followUpActionId": queuedActionId },
    }],
  }, userA) as { inputId: string }

  // Record the OLD dispatched action far behind 230 newer completed actions + 210 pending actions
  await h.followUpStore.upsertAction({
    id: queuedActionId,
    userId: userA.userId!,
    workspaceId: wsId,
    sourceKind: "session",
    sourceId: sess.id,
    actionKey: "old-dispatched-beyond-200",
    evidenceVersion: "v1",
    authVersion: 1,
    actionKind: "supplement_worker",
    mode: "active",
    status: "dispatched",
    sessionId: sess.id,
    inputId: queuedReceipt.inputId,
    reason: "Queued automated supplement",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  })

  for (let i = 0; i < 230; i += 1) {
    const ts = new Date(Date.UTC(2026, 10, 10, 0, 0, i)).toISOString()
    await h.followUpStore.upsertAction({
      userId: userA.userId!,
      workspaceId: wsId,
      sourceKind: "session",
      sourceId: sess.id,
      actionKey: `newer-completed-${i}`,
      evidenceVersion: `vc-${i}`,
      authVersion: 1,
      actionKind: "deliver_result",
      mode: "active",
      status: "completed",
      reason: "Completed action pushing old dispatched past top 200",
      createdAt: ts,
      updatedAt: ts,
    })
  }
  for (let i = 0; i < 210; i += 1) {
    const ts = new Date(Date.UTC(2026, 10, 11, 0, 0, i)).toISOString()
    await h.followUpStore.upsertAction({
      userId: userA.userId!,
      workspaceId: wsId,
      sourceKind: "session",
      sourceId: sess.id,
      actionKey: `pending-paginated-${i}`,
      evidenceVersion: `vp-${i}`,
      authVersion: 1,
      actionKind: "supplement_worker",
      mode: "active",
      status: "pending",
      reason: "Pending action spanning >1 page of 200",
      createdAt: ts,
      updatedAt: ts,
    })
  }

  // Revoke the last authorized device -> MUST paginate and withdraw the old queued input + cancel all 210 pending actions!
  const receipt = await h.disableAuth(userA, "mac-last") as FollowUpAuthReceipt
  assert.equal(receipt.authorized, false)
  assert.equal(receipt.revocationReport?.withdrawnInputs, 1, "Old queued input beyond 200 newer actions MUST be withdrawn")
  assert.equal(receipt.revocationReport?.cancelledPendingActions, 210, "All 210 pending actions across pages MUST be cancelled")

  const snapAfterRevoke = await h.agents.journal.read(sess.id)
  const queuedInput = snapAfterRevoke.inputs.find(i => i.id === queuedReceipt.inputId)
  assert.equal(queuedInput?.state, "withdrawn")
  assert.equal((await h.followUpStore.listActions(userA.userId!, "pending", 50)).length, 0)
  assert.equal((await h.followUpStore.listActions(userA.userId!, "dispatched", 50)).length, 0)

  releaseBlockingTurn()
})

// ============================================================================
// P2-7: Polling Project A never reads Project B's snapshots or command history
// ============================================================================
test("P2-7: polling project A main chat never reads project B session snapshots or command history while keeping project A reminders intact", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-rev10-p2-7-"))
  const dirA = join(dir, "proj-a")
  const dirB = join(dir, "proj-b")
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })

  const backend = makePermissionBackend(async (prompt, { emitFinal }) => {
    if (prompt.includes("FAIL_IN_A")) throw new Error("Project A Worker failed cleanly")
    await emitFinal("OK")
  })

  const h = await openHarness(dir, { backend })
  t.after(async () => {
    await h.close()
    await rm(dir, { recursive: true, force: true })
  })

  const wsA = (await h.catalog.native.createWorkspace("ProjectA", [{ path: dirA }])).id
  const wsB = (await h.catalog.native.createWorkspace("ProjectB", [{ path: dirB }])).id
  const provider = (await h.providers.create({ template: "codex", name: "Scripted", env: {} })).id
  await h.enableAuth(userA, "mac-p2-7", { takeoverAllSessions: true })

  const sessA = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsA, operationId: randomUUID(), provider, context: "directory", title: "Alpha Worker",
  }, userA) as AgentSnapshot).session
  const sessBIds = new Set<string>()
  for (let i = 1; i <= 4; i += 1) {
    const s = (await h.agents.handle("_deskfleet/session/create", {
      workspaceId: wsB, operationId: randomUUID(), provider, context: "directory", title: `Beta Worker ${i}`,
    }, userA) as AgentSnapshot).session
    sessBIds.add(s.id)
  }
  await eventually(
    async () => {
      if (!h.followUpStore.getSource(userA.userId!, wsA, "session", sessA.id)?.state.enabled) return false
      for (const id of sessBIds) {
        if (!h.followUpStore.getSource(userA.userId!, wsB, "session", id)?.state.enabled) return false
      }
      return true
    },
    Boolean,
  )
  await h.followUp.waitForTakeoverSync()
  await delay(50)

  // Instrument journal.read and journal.commands AFTER initial creation events have settled
  const readCounts = new Map<string, number>()
  const commandCounts = new Map<string, number>()
  const origRead = h.agents.journal.read.bind(h.agents.journal)
  const origCommands = h.agents.journal.commands.bind(h.agents.journal)
  h.agents.journal.read = async id => {
    readCounts.set(id, (readCounts.get(id) ?? 0) + 1)
    return origRead(id)
  }
  h.agents.journal.commands = async id => {
    commandCounts.set(id, (commandCounts.get(id) ?? 0) + 1)
    return origCommands(id)
  }

  // Poll Project A's main chat twice!
  await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA)
  await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA)

  let bReads = 0
  let bCmdReads = 0
  for (const id of sessBIds) {
    bReads += readCounts.get(id) ?? 0
    bCmdReads += commandCounts.get(id) ?? 0
  }
  assert.equal(bReads, 0, "Polling Project A must NEVER read Project B session snapshots")
  assert.equal(bCmdReads, 0, "Polling Project A must NEVER read Project B command history")

  // Also test when Project B has an unsubscribed session (e.g., created while takeover was temporarily off)
  await h.setTakeover(userA, false)
  const unsubB = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsB, operationId: randomUUID(), provider, context: "directory", title: "Beta Unsubscribed",
  }, userA) as AgentSnapshot).session
  await delay(50)
  // Turn takeover flag on directly in store without reconciling B, then poll ONLY Project A!
  await h.followUpStore.updateAuth(userA.userId!, state => { state.takeoverAllSessions = true })
  readCounts.clear()
  commandCounts.clear()
  await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA)
  assert.equal(readCounts.get(unsubB.id) ?? 0, 0, "Polling Project A must NEVER read even an unsubscribed Project B session snapshot")
  assert.equal(commandCounts.get(unsubB.id) ?? 0, 0, "Polling Project A must NEVER read even an unsubscribed Project B session's command history")

  // Restore original journal methods and verify Project A's normal reminders remain 100% intact
  h.agents.journal.read = origRead
  h.agents.journal.commands = origCommands
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: sessA.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "FAIL_IN_A" }],
  }, userA)
  const snapA = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.sessionId === sessA.id && m.text.includes("Project A Worker failed cleanly")),
  )
  assert.equal(snapA.messages.filter(m => m.sessionId === sessA.id).length, 1)
})
