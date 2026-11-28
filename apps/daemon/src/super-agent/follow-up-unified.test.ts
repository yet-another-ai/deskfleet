import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import { eventually, openHarness, type FollowUpHarness } from "../fixtures/follow-up-harness.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import type { FollowUpAuthReceipt, FollowUpRunsPage, FollowUpSourcesResponse } from "@deskfleet/protocol/super-agent-follow-up"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import type { SuperDecisionModel } from "./router.ts"

const userA: AgentActor = { kind: "user", userId: "user-a", deviceId: "login-a" }

interface ReplyPlan {
  text?: string
  error?: string
  askPermission?: boolean
  permissionTitle?: string
}

function makeScriptedBackend(planFor: (prompt: string) => ReplyPlan) {
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    conn.prompt = async params => {
      const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
      backend.prompts.push(promptText)
      const plan = planFor(promptText)
      if (plan.askPermission) {
        const res = await client.requestPermission!({
          sessionId: params.sessionId,
          toolCall: { toolCallId: `tc-${randomUUID()}`, title: plan.permissionTitle ?? `Approve ${promptText.slice(0, 40)}` },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Reject", kind: "reject_once" },
          ],
        }, new AbortController().signal)
        const outcome = res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"
        await client.onUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Permission outcome: ${outcome}. ${plan.text ?? ""}` },
          },
        })
        return { stopReason: "end_turn" }
      }
      if (plan.error) throw new Error(plan.error)
      await client.onUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: plan.text ?? "Done." },
        },
      })
      return { stopReason: "end_turn" }
    }
    return conn
  }
  return backend
}

async function sendMainChat(h: FollowUpHarness, workspaceId: string, actor: AgentActor, text: string): Promise<SuperSnapshot> {
  const messageId = randomUUID()
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId, messageId, text }, actor)
  return eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.id === messageId && m.state !== "routing"),
  )
}

// ============================================================================
// 1. Core E2E:
//    No-SA dir -> "New Conversation" session -> turn ON master switch ->
//    verify NO SA auto-created -> create project SA -> trigger new approval
//    on old session -> verify ONLY matching project SA notifies ONCE, with
//    zero manual session picking and zero history replay.
// ============================================================================
test("Unified E2E Core: New Conversation session in no-SA dir is auto-taken-over once project SA is created and notifies matching SA once on new approval", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-unified-core-"))
  const dirA = join(dir, "project-alpha")
  const dirB = join(dir, "project-beta")
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })

  const backend = makeScriptedBackend(prompt => {
    if (prompt.includes("HIST_FAIL")) return { error: "Historical pre-takeover failure" }
    if (prompt.includes("NEW_APPROVAL")) return { askPermission: true, permissionTitle: "Run production migration", text: "Migration completed" }
    return { text: "Historical ordinary completion" }
  })
  const h = await openHarness(dir, { backend })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id

  // Existing SA for Project Beta ONLY (Project Alpha intentionally has NO SA yet!)
  const wsB = (await h.catalog.handle({
    method: "workspaceCreate",
    params: { name: "Beta", directories: [{ path: dirB }] },
  }) as { id: string }).id

  // Create an old ordinary session in dirA via "New Conversation" (workspaceId omitted, cwd = dirA)
  const oldNoSa = (await h.agents.handle("_deskfleet/session/create", {
    operationId: randomUUID(),
    provider,
    context: "directory",
    cwd: dirA,
    title: "Alpha Legacy New Chat",
  }, userA) as AgentSnapshot).session
  assert.equal(oldNoSa.workspaceId, undefined)

  // Produce historical events (including a failure) BEFORE master switch is enabled
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: oldNoSa.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "HIST_FAIL" }],
  }, userA)
  await eventually(() => h.agents.journal.read(oldNoSa.id), snap => snap.turns.some(turn => turn.state === "failed" || turn.state === "interrupted"))

  // Turn ON unified switch ("让super agent 接管所有会话")
  const enabled = await h.setTakeover(userA, true, "inst-mac")
  assert.equal(enabled.authorized, true)
  assert.equal(enabled.summary.takeoverAllSessions, true)

  // Project Alpha has NO SA -> must NOT auto-create a workspace/SA, and Beta must get 0 messages!
  const catalogBefore = await h.catalog.snapshot()
  assert.equal(catalogBefore.workspaces.length, 1)
  assert.equal(catalogBefore.workspaces[0]!.id, wsB)
  const betaSnapBefore = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, userA) as SuperSnapshot
  assert.equal(betaSnapBefore.messages.length, 0)

  // Now create Project Alpha SA (matching dirA) — NO re-confirmation, NO manual session selection!
  const wsA = (await h.catalog.handle({
    method: "workspaceCreate",
    params: { name: "Alpha", directories: [{ path: dirA }] },
  }) as { id: string }).id
  await h.followUp.waitForTakeoverSync()

  // Historical pre-takeover failure MUST NOT be replayed into Alpha SA main chat!
  await delay(80)
  const alphaBeforeApproval = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
  assert.equal(alphaBeforeApproval.messages.length, 0)
  assert.equal(alphaBeforeApproval.pendingRequests?.length ?? 0, 0)

  // Trigger a NEW permission approval in the old "New Conversation" session!
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: oldNoSa.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "NEW_APPROVAL" }],
  }, userA)

  const alphaAfter = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as Promise<SuperSnapshot>,
    snap => snap.messages.some(m => m.workerEvent === "permission" && m.sessionId === oldNoSa.id)
      && (snap.pendingRequests ?? []).some(r => r.kind === "permission" && r.item.sessionId === oldNoSa.id),
  )

  // Wait briefly to confirm NO duplicate notifications appear
  await delay(100)
  const alphaStable = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
  const permMsgs = alphaStable.messages.filter(m => m.workerEvent === "permission" && m.sessionId === oldNoSa.id)
  const permPending = (alphaStable.pendingRequests ?? []).filter(r => r.kind === "permission" && r.item.sessionId === oldNoSa.id)
  assert.equal(permMsgs.length, 1, "Alpha SA must receive the permission notice exactly once")
  assert.equal(permPending.length, 1, "Alpha SA must show the pending request exactly once")
  assert.match(permMsgs[0]!.text, /Run production migration/u)

  // Beta SA MUST stay completely untouched!
  const betaAfter = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, userA) as SuperSnapshot
  assert.equal(betaAfter.messages.length, 0)
  assert.equal(betaAfter.pendingRequests?.length ?? 0, 0)

  // Resolving the permission in the original session syncs back to Alpha SA cleanly
  const reqId = alphaAfter.pendingRequests![0]!.item.id
  await h.agents.handle("_deskfleet/permission/respond", {
    sessionId: oldNoSa.id, permissionId: reqId, operationId: randomUUID(), optionId: "allow",
  }, userA)
  await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as Promise<SuperSnapshot>,
    snap => (snap.pendingRequests?.length ?? 0) === 0 && snap.messages.some(m => m.workerEvent === "permission" && m.sessionId === oldNoSa.id && /^Allow ·/u.test(m.text)),
  )
})

// ============================================================================
// 2. Upgrade Default OFF, Legacy Mac Grant / Legacy Subscriptions Never Bypass,
//    Failed Auth Never Displays ON, Existing History & Tickets Preserved.
// ============================================================================
test("Unified Upgrade & Auth Guard: defaults OFF on upgraded Mac with existing grants/subscriptions, blocks legacy bypass, preserves history/tickets/preferences, and rejects failed auth", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-unified-upgrade-"))
  const repoDir = join(dir, "repo")
  await mkdir(repoDir, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  let allowAuth = true
  const backend = makeScriptedBackend(prompt => {
    if (prompt.includes("LEGACY_PERM")) return { askPermission: true, permissionTitle: "Legacy deploy", text: "ok" }
    if (prompt.includes("NORMAL_RUN")) return { text: "All checks passed with zero issues." }
    if (prompt.includes("ALERT_RUN")) return { text: "ALERT: payment gateway returned HTTP 503 for 42 requests." }
    return { text: "ALERT: disk usage critical at 98%" }
  })

  // --- Phase 1: Seed legacy pre-upgrade state (Mac already authorized + legacy adoptAllSchedules + legacy sources + history + SA ticket) ---
  const h1 = await openHarness(dir, { backend })
  active = h1
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const wsId = (await h1.catalog.handle({
    method: "workspaceCreate",
    params: { name: "Payments", directories: [{ path: repoDir }] },
  }) as { id: string }).id

  const legacySched = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "Legacy Payment Monitor",
      prompt: "NORMAL_RUN",
      workspaceId: wsId,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask

  const legacySess = (await h1.agents.handle("_deskfleet/session/create", {
    workspaceId: wsId, operationId: randomUUID(), provider, context: "directory", title: "Legacy Ordinary Worker",
  }, userA) as AgentSnapshot).session

  // Seed legacy auth WITHOUT takeoverAllSessions (exact pre-upgrade shape on an already-authorized Mac!)
  await h1.followUpStore.updateAuth(userA.userId!, state => {
    state.authVersion = 4
    state.globalDisabled = false
    state.adoptAllSchedules = true
    state.grants["inst-mac"] = {
      installationId: "inst-mac",
      deviceLabel: "MacBook Pro",
      platform: "darwin",
      enabled: true,
      authVersion: 4,
      updatedAt: "2026-11-20T00:00:00.000Z",
    }
    delete state.takeoverAllSessions
  })
  // Seed legacy enabled sources (schedule with exceptions_only preference + ordinary session)
  await h1.followUpStore.updateSource(userA.userId!, wsId, "schedule", legacySched.id, () => ({
    enabled: true,
    deliveryPolicy: "exceptions_only",
    ownerUserId: userA.userId!,
    scheduleTitle: legacySched.title,
    targetKind: "directory",
    subscribedAt: "2026-11-20T00:00:00.000Z",
    firstSubscribedAt: "2026-11-20T00:00:00.000Z",
  }), () => {})
  await h1.followUpStore.updateSource(userA.userId!, wsId, "session", legacySess.id, () => ({
    enabled: true,
    deliveryPolicy: "exceptions_only",
    cursorSeq: legacySess.lastEventSeq,
    ownerUserId: userA.userId!,
    scheduleTitle: legacySess.title,
  }), () => {})
  // Seed historical run record and existing SA room ticket
  await h1.followUpStore.upsertRun({
    userId: userA.userId!, workspaceId: wsId, sourceKind: "schedule", sourceId: legacySched.id,
    runKey: "run:historical-1", scheduleId: legacySched.id, scheduleTitle: legacySched.title,
    runId: "historical-1", startedAt: "2026-11-20T01:00:00.000Z", finishedAt: "2026-11-20T01:01:00.000Z",
    status: "completed", deliveryPolicy: "exceptions_only", delivered: true,
    summary: "Historical run summary preserved across upgrade", evidenceAvailability: "available",
    createdAt: "2026-11-20T01:00:00.000Z", updatedAt: "2026-11-20T01:01:00.000Z",
  })
  await h1.superStore.update(userA.userId!, () => ({ rooms: [], intents: [] }), state => {
    state.rooms.push({
      workspaceId: wsId,
      provider,
      tickets: [{ id: "existing-ticket-1", title: "Existing Ticket", scope: "Keep intact", summary: "Preserved ticket summary", provider, updatedAt: "2026-11-20T00:00:00.000Z" }],
      messages: [{ id: "existing-msg-1", role: "assistant", text: "Existing SA history", createdAt: "2026-11-20T00:00:00.000Z", ticketId: "existing-ticket-1" }],
      recentTicketIds: ["existing-ticket-1"],
    })
  })
  await h1.close()
  active = undefined

  // --- Phase 2: Restart after upgrade ---
  const h2 = await openHarness(dir, {
    backend,
    followUpAuthorize: async actor => {
      if (!allowAuth) throw new Error("403 Delegation authorization rejected")
      return actor
    },
  })
  active = h2

  // 1. Default OFF even though inst-mac has an active grant and legacy sources exist!
  const status = await h2.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "status" }, userA) as FollowUpAuthReceipt
  assert.equal(status.authorized, true)
  assert.equal(status.summary.takeoverAllSessions, false)

  // 2. Enabling another device WITHOUT takeoverAllSessions: true MUST NOT infer full takeover!
  const secondDevice = await h2.frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
    action: "enable", installationId: "inst-iphone", deviceLabel: "iPhone",
  }, userA) as FollowUpAuthReceipt
  assert.equal(secondDevice.summary.takeoverAllSessions, false)

  // 3. Legacy schedule run (even abnormal!) & legacy session permission MUST NOT trigger proactive reminders!
  await h2.operations.handle("scheduleUpdate", {
    scheduleId: legacySched.id, changes: { prompt: "ALERT_RUN" },
  }, userA)
  const bypassedRun = await h2.operations.handle("scheduleRun", { scheduleId: legacySched.id }, userA) as ScheduleRun
  await eventually(
    async () => h2.schedules.snapshot().find(s => s.id === legacySched.id)!.runs.find(r => r.id === bypassedRun.id),
    r => r?.state === "completed",
  )
  await h2.agents.handle("_deskfleet/input/submit", {
    sessionId: legacySess.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "LEGACY_PERM" }],
  }, userA)
  await eventually(() => h2.agents.journal.read(legacySess.id), snap => snap.permissions.some(p => p.state === "pending"))
  await h2.followUp.drainScheduleEvents()
  await delay(100)

  const snapWhileOff = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapWhileOff.messages.length, 1, "Legacy subscriptions MUST NOT bypass OFF state")
  assert.equal(snapWhileOff.messages[0]!.id, "existing-msg-1")
  assert.equal(snapWhileOff.tickets.length, 1, "Existing SA ticket must be preserved")
  assert.equal(snapWhileOff.pendingRequests?.length ?? 0, 0)

  // Historical run record preserved!
  const runsPage = await h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", {
    workspaceId: wsId, sourceKind: "schedule", sourceId: legacySched.id,
  }, userA) as FollowUpRunsPage
  assert.ok(runsPage.runs.some(r => r.runId === "historical-1"), "Historical run records must be preserved")

  // 4. Failed authorization (stale version OR rejected authorize) MUST NOT display takeover ON!
  const staleReceipt = await h2.frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
    action: "enable", installationId: "inst-mac", expectedAuthVersion: 1, takeoverAllSessions: true,
  }, userA) as FollowUpAuthReceipt
  assert.equal(staleReceipt.status, "stale_ignored")
  assert.equal(staleReceipt.summary.takeoverAllSessions, false)

  allowAuth = false
  await assert.rejects(
    () => h2.setTakeover(userA, true, "inst-mac"),
    /403 Delegation authorization rejected/u,
  )
  allowAuth = true
  const afterReject = await h2.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "status" }, userA) as FollowUpAuthReceipt
  assert.equal(afterReject.summary.takeoverAllSessions, false)

  // 5. Resolve legacy pending permission, then explicitly enable unified takeover:
  //    existing deliveryPolicy ("exceptions_only") MUST be preserved and pre-takeover runs NOT replayed!
  const legacyPermId = (await h2.agents.journal.read(legacySess.id)).permissions[0]!.id
  await h2.agents.handle("_deskfleet/permission/respond", {
    sessionId: legacySess.id, permissionId: legacyPermId, operationId: randomUUID(), optionId: "allow",
  }, userA)
  await eventually(() => h2.agents.journal.read(legacySess.id), snap => snap.turns.every(t => t.state === "completed"))

  const turnedOn = await h2.setTakeover(userA, true, "inst-mac")
  assert.equal(turnedOn.summary.takeoverAllSessions, true)
  const sub = h2.followUp.getScheduleSubscription(userA.userId!, wsId, legacySched.id)
  assert.equal(sub?.enabled, true)
  assert.equal(sub?.deliveryPolicy, "exceptions_only", "Existing reporting preference must be preserved")

  // Normal run stays quiet under preserved exceptions_only
  await h2.operations.handle("scheduleUpdate", { scheduleId: legacySched.id, changes: { prompt: "NORMAL_RUN" } }, userA)
  const normalRun = await h2.operations.handle("scheduleRun", { scheduleId: legacySched.id }, userA) as ScheduleRun
  await eventually(async () => {
    await h2.followUp.drainScheduleEvents()
    return h2.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: wsId, sourceKind: "schedule", sourceId: legacySched.id }, userA) as Promise<FollowUpRunsPage>
  }, p => p.runs.some(r => r.runId === normalRun.id && r.status === "completed"))
  const snapAfterNormal = await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as SuperSnapshot
  assert.equal(snapAfterNormal.messages.length, 1, "Normal run under preserved exceptions_only must stay quiet")

  // Abnormal run notifies ONCE!
  await h2.operations.handle("scheduleUpdate", { scheduleId: legacySched.id, changes: { prompt: "ALERT_RUN" } }, userA)
  const alertRun = await h2.operations.handle("scheduleRun", { scheduleId: legacySched.id }, userA) as ScheduleRun
  const snapAfterAlert = await eventually(async () => {
    await h2.followUp.drainScheduleEvents()
    return h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsId }, userA) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.provenance?.runId === alertRun.id))
  assert.equal(snapAfterAlert.messages.filter(m => m.provenance?.runId === alertRun.id).length, 1)
})

// ============================================================================
// 3. Cross-Project Attribution + Form & SA Schedules + Ambiguous Dir +
//    Zero Duplicate Alerts Across SA Tickets, Schedule Runs, and Ordinary Sessions.
// ============================================================================
test("Unified Routing & Deduplication: routes old/new sessions and form/SA schedules to matching project SAs, skips ambiguous dirs, and never duplicates SA tickets or schedule turns", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-unified-dedup-"))
  const dirA = join(dir, "proj-a")
  const dirB = join(dir, "proj-b")
  const dirShared = join(dir, "proj-shared")
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })
  await mkdir(dirShared, { recursive: true })

  const backend = makeScriptedBackend(prompt => {
    if (prompt.includes("TICKET_PERM")) return { askPermission: true, permissionTitle: "Ticket tool approval", text: "Ticket done" }
    if (prompt.includes("LOOSE_A_PERM")) return { askPermission: true, permissionTitle: "Alpha loose approval", text: "done" }
    if (prompt.includes("LOOSE_B_PERM")) return { askPermission: true, permissionTitle: "Beta loose approval", text: "done" }
    if (prompt.includes("AMBIG_PERM")) return { askPermission: true, permissionTitle: "Shared dir approval", text: "done" }
    if (prompt.includes("EXISTING_SCHED")) return { text: "Existing-session daily summary: 12 builds green." }
    if (prompt.includes("FORM_SCHED_B")) return { text: "Beta daily report: all services healthy." }
    if (prompt.includes("SA_SCHED_A")) return { text: "Alpha SA schedule report: 3 PRs merged." }
    return { text: "All good." }
  })

  const model: SuperDecisionModel = async input => {
    if (String(input.message ?? "").includes("CREATE_SA_SCHED")) {
      return {
        reason: "create schedule",
        actions: [{
          kind: "schedule",
          operation: "create",
          title: "Alpha SA Daily Report",
          prompt: "SA_SCHED_A",
          targetKind: "directory",
          trigger: { kind: "manual" },
          deliveryPolicy: "every_run",
        }],
      }
    }
    return {
      reason: "dispatch ticket",
      actions: [{
        kind: "create",
        title: "SA Managed Ticket",
        scope: "Handle ticket work",
        prompt: "TICKET_PERM",
      }],
    }
  }

  const h = await openHarness(dir, { backend, model })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const wsA = (await h.catalog.handle({ method: "workspaceCreate", params: { name: "Alpha", directories: [{ path: dirA }] } }) as { id: string }).id
  const wsB = (await h.catalog.handle({ method: "workspaceCreate", params: { name: "Beta", directories: [{ path: dirB }] } }) as { id: string }).id
  const wsShared1 = (await h.catalog.handle({ method: "workspaceCreate", params: { name: "Shared 1", directories: [{ path: dirShared }] } }) as { id: string }).id
  const wsShared2 = (await h.catalog.handle({ method: "workspaceCreate", params: { name: "Shared 2", directories: [{ path: dirShared }] } }) as { id: string }).id

  // Existing ordinary session in Alpha + existing-session schedule targeting it
  const sessA = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsA, operationId: randomUUID(), provider, context: "directory", title: "Alpha Shared Worker",
  }, userA) as AgentSnapshot).session
  const schedExistingA = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Alpha Existing Session Daily Report",
      prompt: "EXISTING_SCHED",
      workspaceId: wsA,
      enabled: true,
      target: { kind: "existing", sessionId: sessA.id },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask

  // Existing loose "New Conversation" session in dirB AND in ambiguous dirShared
  const looseB = (await h.agents.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider, context: "directory", cwd: dirB, title: "Beta Old New Chat",
  }, userA) as AgentSnapshot).session
  const looseAmbig = (await h.agents.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider, context: "directory", cwd: dirShared, title: "Ambiguous New Chat",
  }, userA) as AgentSnapshot).session

  // Turn ON master switch
  await h.setTakeover(userA, true, "inst-mac")

  // Verify ambiguous shared-directory session was NOT guessed into either workspace!
  const sharedSources1 = await h.frontDesk.handle("_deskfleet/super-agent/followUpSources", { workspaceId: wsShared1 }, userA) as FollowUpSourcesResponse
  const sharedSources2 = await h.frontDesk.handle("_deskfleet/super-agent/followUpSources", { workspaceId: wsShared2 }, userA) as FollowUpSourcesResponse
  assert.equal(sharedSources1.sources.some(s => s.sourceId === looseAmbig.id), false)
  assert.equal(sharedSources2.sources.some(s => s.sourceId === looseAmbig.id), false)

  // 1. Create a NEW "New Conversation" session in dirA, a NEW form schedule in wsB, and a NEW SA schedule in wsA
  const newLooseA = (await h.agents.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider, context: "directory", cwd: dirA, title: "Alpha Future New Chat",
  }, userA) as AgentSnapshot).session
  const formSchedB = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Beta Form Daily Report",
      prompt: "FORM_SCHED_B",
      workspaceId: wsB,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await sendMainChat(h, wsA, userA, "CREATE_SA_SCHED")
  const saSchedA = h.schedules.snapshot().find(s => s.title === "Alpha SA Daily Report")!
  assert.ok(saSchedA)

  // 2. Run ALL three schedules (existing-session on subscribed sessA, new form schedule in wsB, new SA schedule in wsA)
  const rExisting = await h.operations.handle("scheduleRun", { scheduleId: schedExistingA.id }, userA) as ScheduleRun
  const rFormB = await h.operations.handle("scheduleRun", { scheduleId: formSchedB.id }, userA) as ScheduleRun
  const rSaA = await h.operations.handle("scheduleRun", { scheduleId: saSchedA.id }, userA) as ScheduleRun

  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    const snapA = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
    const snapB = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, userA) as SuperSnapshot
    return snapA.messages.some(m => m.provenance?.runId === rExisting.id)
      && snapA.messages.some(m => m.provenance?.runId === rSaA.id)
      && snapB.messages.some(m => m.provenance?.runId === rFormB.id)
  }, Boolean)
  await delay(100)

  // Check zero duplicate delivery on existing-session schedule (sessA is BOTH an ordinary session AND schedule target!)
  const snapAAfterScheds = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
  const existingRunMatches = snapAAfterScheds.messages.filter(m => m.sessionId === sessA.id && /Existing-session daily summary/u.test(m.text))
  assert.equal(existingRunMatches.length, 1, "Existing-session schedule turn MUST notify once, never duplicated by ordinary session follow-up")
  const saSchedMatches = snapAAfterScheds.messages.filter(m => m.provenance?.runId === rSaA.id)
  assert.equal(saSchedMatches.length, 1)
  // Beta schedule did NOT leak into Alpha, Alpha schedules did NOT leak into Beta
  assert.equal(snapAAfterScheds.messages.some(m => m.provenance?.scheduleId === formSchedB.id), false)
  const snapBAfterScheds = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, userA) as SuperSnapshot
  assert.equal(snapBAfterScheds.messages.filter(m => m.provenance?.runId === rFormB.id).length, 1)
  assert.equal(snapBAfterScheds.messages.some(m => m.provenance?.scheduleId === saSchedA.id || m.provenance?.scheduleId === schedExistingA.id), false)

  // 3. SA Ticket Worker requesting permission MUST notify ONCE (NOT duplicated by ordinary session follow-up!)
  await sendMainChat(h, wsA, userA, "Dispatch a ticket that asks permission")
  const snapWithTicketPerm = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as Promise<SuperSnapshot>,
    snap => (snap.pendingRequests ?? []).some(r => r.kind === "permission" && r.item.request.toolCall.title === "Ticket tool approval"),
  )
  await delay(100)
  const ticketSessId = snapWithTicketPerm.tickets.find(tk => tk.title === "SA Managed Ticket")!.sessionId!
  const snapTicketStable = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
  assert.equal(
    (snapTicketStable.pendingRequests ?? []).filter(r => r.item.sessionId === ticketSessId).length,
    1,
    "SA ticket permission must appear once in pendingRequests",
  )
  assert.equal(
    snapTicketStable.messages.filter(m => m.sessionId === ticketSessId && m.workerEvent === "permission").length,
    1,
    "SA ticket permission must appear once in main chat",
  )
  // Verify ticket session was NOT enrolled as a separate ordinary follow-up source
  assert.equal(
    h.followUpStore.listSources(userA.userId!).some(s => s.sourceKind === "session" && s.sourceId === ticketSessId),
    false,
  )

  // 4. New loose session in dirA notifies ONLY Alpha; old loose session in dirB notifies ONLY Beta; ambiguous dir notifies NEITHER
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: newLooseA.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "LOOSE_A_PERM" }],
  }, userA)
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: looseB.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "LOOSE_B_PERM" }],
  }, userA)
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: looseAmbig.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "AMBIG_PERM" }],
  }, userA)

  await eventually(
    async () => {
      const a = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
      const b = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, userA) as SuperSnapshot
      return a.messages.some(m => m.sessionId === newLooseA.id && m.workerEvent === "permission")
        && b.messages.some(m => m.sessionId === looseB.id && m.workerEvent === "permission")
    },
    Boolean,
  )
  await delay(80)
  const finalA = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as SuperSnapshot
  const finalB = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, userA) as SuperSnapshot
  const finalS1 = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsShared1 }, userA) as SuperSnapshot
  const finalS2 = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsShared2 }, userA) as SuperSnapshot
  assert.equal(finalA.messages.filter(m => m.sessionId === newLooseA.id && m.workerEvent === "permission").length, 1)
  assert.equal(finalA.messages.some(m => m.sessionId === looseB.id), false)
  assert.equal(finalB.messages.filter(m => m.sessionId === looseB.id && m.workerEvent === "permission").length, 1)
  assert.equal(finalB.messages.some(m => m.sessionId === newLooseA.id), false)
  assert.equal(finalS1.messages.length, 0)
  assert.equal(finalS2.messages.length, 0)
})

// ============================================================================
// 4. OFF -> Create SA While OFF -> OFF-Period Events -> Re-ON (No Replay) ->
//    Daemon Restart Persistence.
// ============================================================================
test("Unified Lifecycle: OFF stops all projects without closing sessions/schedules, creating SA while OFF does not take over, re-ON skips OFF-period events, and restart preserves active takeover", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-unified-lifecycle-"))
  const dirA = join(dir, "proj-a")
  const dirC = join(dir, "proj-c")
  await mkdir(dirA, { recursive: true })
  await mkdir(dirC, { recursive: true })
  let active: FollowUpHarness | undefined
  t.after(async () => {
    if (active) await active.close()
    await rm(dir, { recursive: true, force: true })
  })

  const backend = makeScriptedBackend(prompt => {
    if (prompt.includes("OFF_FAIL")) return { error: "Failure during OFF window" }
    if (prompt.includes("POST_RESTART_PERM")) return { askPermission: true, permissionTitle: "Post-restart deploy", text: "ok" }
    if (prompt.includes("OFF_SCHED_RUN")) return { text: "Daily report from OFF period" }
    if (prompt.includes("AFTER_RESTART_RUN")) return { text: "Daily report after restart" }
    return { text: "Done." }
  })

  const h1 = await openHarness(dir, { backend })
  active = h1
  const provider = (await h1.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const wsA = (await h1.catalog.handle({ method: "workspaceCreate", params: { name: "Alpha", directories: [{ path: dirA }] } }) as { id: string }).id

  const sessA = (await h1.agents.handle("_deskfleet/session/create", {
    workspaceId: wsA, operationId: randomUUID(), provider, context: "directory", title: "Alpha Worker",
  }, userA) as AgentSnapshot).session
  const schedA = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "Alpha Daily Report",
      prompt: "OFF_SCHED_RUN",
      workspaceId: wsA,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask

  // Turn ON, then turn OFF!
  await h1.setTakeover(userA, true, "inst-mac")
  const turnedOff = await h1.setTakeover(userA, false)
  assert.equal(turnedOff.summary.takeoverAllSessions, false)

  // Existing session stays open/active and native schedule stays enabled!
  assert.equal((await h1.agents.journal.read(sessA.id)).session.archiveState, "active")
  assert.equal(h1.schedules.snapshot().find(s => s.id === schedA.id)?.enabled, true)

  // While OFF: create loose session in dirC, then create Project C SA -> MUST NOT take over while OFF!
  const looseC = (await h1.agents.handle("_deskfleet/session/create", {
    operationId: randomUUID(), provider, context: "directory", cwd: dirC, title: "Gamma Loose Chat",
  }, userA) as AgentSnapshot).session
  const wsC = (await h1.catalog.handle({ method: "workspaceCreate", params: { name: "Gamma", directories: [{ path: dirC }] } }) as { id: string }).id
  await h1.followUp.waitForTakeoverSync()
  const schedC = await h1.operations.handle("scheduleCreate", {
    schedule: {
      title: "Gamma Daily Report",
      prompt: "AFTER_RESTART_RUN",
      workspaceId: wsC,
      enabled: true,
      target: { kind: "new", provider, context: "directory" },
      trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  assert.equal(h1.followUpStore.listSources(userA.userId!, wsC).length, 0, "Creating SA while switch is OFF must not take over")

  // While OFF: run schedA (native schedule STILL runs!) and fail a turn in sessA + looseC
  const offRun = await h1.operations.handle("scheduleRun", { scheduleId: schedA.id }, userA) as ScheduleRun
  await eventually(
    async () => h1.schedules.snapshot().find(s => s.id === schedA.id)!.runs.find(r => r.id === offRun.id),
    r => r?.state === "completed",
  )
  await h1.agents.handle("_deskfleet/input/submit", {
    sessionId: sessA.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "OFF_FAIL" }],
  }, userA)
  await h1.agents.handle("_deskfleet/input/submit", {
    sessionId: looseC.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "OFF_FAIL" }],
  }, userA)
  await eventually(() => h1.agents.journal.read(sessA.id), snap => snap.turns.some(t => t.state === "failed" || t.state === "interrupted"))
  await eventually(() => h1.agents.journal.read(looseC.id), snap => snap.turns.some(t => t.state === "failed" || t.state === "interrupted"))
  await h1.followUp.drainScheduleEvents()
  await delay(80)

  assert.equal(((await h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA)) as SuperSnapshot).messages.length, 0)
  assert.equal(((await h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsC }, userA)) as SuperSnapshot).messages.length, 0)

  // Turn ON again -> MUST NOT replay OFF-period schedule run or session failures!
  const reEnabled = await h1.setTakeover(userA, true, "inst-mac")
  assert.equal(reEnabled.summary.takeoverAllSessions, true)
  await h1.followUp.drainScheduleEvents()
  await delay(100)
  assert.equal(((await h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA)) as SuperSnapshot).messages.length, 0, "OFF-period Alpha events must not replay")
  assert.equal(((await h1.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsC }, userA)) as SuperSnapshot).messages.length, 0, "OFF-period Gamma events must not replay")

  // Restart daemon -> takeoverAllSessions persists, still zero replays, and new events deliver once!
  await h1.close()
  active = undefined
  const h2 = await openHarness(dir, { backend })
  active = h2
  const postRestartStatus = await h2.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "status" }, userA) as FollowUpAuthReceipt
  assert.equal(postRestartStatus.summary.takeoverAllSessions, true)
  await delay(80)
  assert.equal(((await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsC }, userA)) as SuperSnapshot).messages.length, 0)

  // Trigger NEW approval on Gamma loose session + NEW run on Gamma schedule after restart
  await h2.agents.handle("_deskfleet/input/submit", {
    sessionId: looseC.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "POST_RESTART_PERM" }],
  }, userA)
  const postRestartRun = await h2.operations.handle("scheduleRun", { scheduleId: schedC.id }, userA) as ScheduleRun

  const snapCAfter = await eventually(async () => {
    await h2.followUp.drainScheduleEvents()
    return h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsC }, userA) as Promise<SuperSnapshot>
  }, snap => snap.messages.some(m => m.sessionId === looseC.id && m.workerEvent === "permission")
    && snap.messages.some(m => m.provenance?.runId === postRestartRun.id))

  assert.equal(snapCAfter.messages.filter(m => m.sessionId === looseC.id && m.workerEvent === "permission").length, 1)
  assert.equal(snapCAfter.messages.filter(m => m.provenance?.runId === postRestartRun.id).length, 1)
  // Alpha stayed untouched!
  assert.equal(((await h2.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA)) as SuperSnapshot).messages.length, 0)
})
