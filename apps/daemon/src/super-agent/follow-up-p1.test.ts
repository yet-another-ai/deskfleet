import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { CentralRequestError, HttpError } from "@deskfleet/client/request-diagnostics"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import { AgentProviders } from "../providers/providers.ts"
import { AgentSessions } from "../agent/sessions.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import { TestAgentQuotas } from "../fixtures/agent-quotas.ts"
import { MachineOperations } from "../machine/operations.ts"
import { ProviderSetup } from "../providers/setup.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import { ScheduledTasks } from "../schedules/scheduled-tasks.ts"
import { classifyAuthorizeError } from "./follow-up-evidence.ts"
import type { FollowUpAuthReceipt, FollowUpRunsPage } from "@deskfleet/protocol/super-agent-follow-up"
import { LocalFollowUpStore } from "./follow-up-store.ts"
import { SuperFollowUpService } from "./follow-up.ts"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import type { ScheduleCommandHost } from "./schedule.ts"
import { SuperAgentService, type SuperUserState } from "./service.ts"
import { LocalSuperStore } from "./store.ts"
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

function makeBackend(replyFor: (prompt: string) => { chunks?: string[]; text?: string; error?: string; askPermission?: boolean }) {
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    return {
      ...conn,
      initialization: {
        ...conn.initialization,
        agentCapabilities: {
          ...conn.initialization.agentCapabilities,
          sessionCapabilities: { resume: {}, fork: {} },
        },
      },
      forkSession: async () => ({ sessionId: `fork-${randomUUID()}`, configOptions: [] }),
      prompt: async params => {
        const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
        const plan = replyFor(promptText)
        if (plan.error) throw new Error(plan.error)
        if (plan.askPermission) {
          const res = await client.requestPermission!({
            sessionId: params.sessionId,
            toolCall: { toolCallId: `tc-${randomUUID()}`, title: `Approve ${promptText.slice(0, 40)}` },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }],
          }, new AbortController().signal)
          const outcome = res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"
          await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Permission outcome: ${outcome}` } } })
          return { stopReason: "end_turn" }
        }
        if (plan.chunks) {
          for (const chunk of plan.chunks) {
            await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } } })
          }
        } else if (plan.text !== undefined) {
          if (plan.text.length > 0) {
            await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: plan.text } } })
          }
        }
        return { stopReason: "end_turn" }
      },
    }
  }
  return backend
}

async function openHarness(directory: string, options: {
  backend?: BackendAgent
  scheduleAuthorize?: (actor: AgentActor) => Promise<AgentActor>
  followUpAuthorize?: (actor: AgentActor) => Promise<AgentActor>
  retryBaseMs?: number
  retryMaxMs?: number
  historyPageSize?: number
  historyMaxPages?: number
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
  const scheduleAuth = options.scheduleAuthorize ?? (async actor => actor)
  const followUpAuth = options.followUpAuthorize ?? scheduleAuth
  const schedules = new ScheduledTasks(directory, { agents, catalog, providers, authorize: scheduleAuth })
  await schedules.init()
  const operations = new MachineOperations({ agents, catalog, providers, terminals, setup, schedules, capabilities: async () => ({ displays: [], audio: false }) })
  const superStore = new LocalSuperStore<SuperUserState>(catalog.native)
  await superStore.init()
  const followUpStore = new LocalFollowUpStore(catalog.native)
  const ws = superWorkspaces(catalog, directory)
  let frontDesk!: SuperAgentService
  const followUp = new SuperFollowUpService({
    followUpStore, superStore, agents, schedules, authorize: followUpAuth,
    workspaces: ws.workspaces,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
    historyPageSize: options.historyPageSize,
    historyMaxPages: options.historyMaxPages,
  })
  const scheduleHost: ScheduleCommandHost = {
    handleSchedule: (method, params, actor) => operations.handle(method, params, actor),
    listSchedules: () => schedules.snapshot(),
    subscribeSchedule: params => followUp.subscribeSchedule(params).then(() => {}),
    isFollowUpAuthorized: uid => followUp.isAuthorized(uid),
    getScheduleSubscription: (uid, wid, sid) => followUp.getScheduleSubscription(uid, wid, sid),
    listScheduleRuns: async (uid, wid, sid, limit) => (await followUp.listRuns({ userId: uid, workspaceId: wid, sourceKind: "schedule", sourceId: sid, limit })).runs,
  }
  frontDesk = new SuperAgentService({
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
// P1 · 原 1: Transient authorization outage (503/network) retains pendingEvents & delivers once on recovery;
//           explicit revocation (401/403/membership revoked) stays silent and does NOT retry.
// ============================================================================
test("P1-1: transient 503/network auth outage preserves pending schedule events and delivers once on recovery while explicit 403 revocation stays silent", async t => {
  assert.equal(classifyAuthorizeError(new HttpError(503, "User delegation is no longer authorized (503)")), "transient")
  assert.equal(classifyAuthorizeError(new HttpError(403, "User delegation is no longer authorized (403)")), "revoked")
  assert.equal(classifyAuthorizeError(new HttpError(401, "Unauthorized")), "revoked")
  assert.equal(classifyAuthorizeError(new CentralRequestError("fetch failed", {
    method: "POST", route: "/api/daemon/authorize-delegation", elapsedMs: 50, causes: [], kind: "network", transport: "node_fetch", phase: "fetch",
  })), "transient")
  assert.equal(classifyAuthorizeError(new Error("Team membership revoked")), "revoked")

  const dir = await mkdtemp(join(tmpdir(), "df-p1-1-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)

  let authMode: "ok" | "503" | "network" | "403" = "ok"
  const backend = makeBackend(prompt => ({ text: `Daily Digest Body: ${prompt}` }))
  const h = await openHarness(dir, {
    backend,
    // Schedule itself runs and completes while follow-up delegation verification experiences a transient 503!
    scheduleAuthorize: async actor => actor,
    followUpAuthorize: async actor => {
      if (authMode === "503") throw new HttpError(503, "User delegation is no longer authorized (503)")
      if (authMode === "network") {
        throw new CentralRequestError("network down", {
          method: "POST", route: "/api/daemon/authorize-delegation", elapsedMs: 10, causes: [], kind: "network", transport: "node_fetch", phase: "fetch",
        })
      }
      if (authMode === "403") throw new HttpError(403, "User delegation is no longer authorized (403)")
      return actor
    },
    retryBaseMs: 60_000, // Keep manual control first, then verify automatic retry separately
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("DailyRepo", [{ path: workDir }])).id
  await h.enableAuth(userA, "inst-mac")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Morning Digest", prompt: "Summarize commits", workspaceId: ws, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: ws, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // 1. Outage hits right as the completed run is consumed -> MUST retain pendingEvents, NOT permanently ack!
  authMode = "503"
  const run1 = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => Boolean(list[0]?.runs.some(r => r.id === run1.id && r.state === "completed")))
  await h.followUp.drainScheduleEvents()

  assert.ok(h.schedules.pendingPrivateEvents().some(e => e.runId === run1.id && e.kind === "run_finished"), "run_finished must stay unacked during HTTP 503 outage")
  const snapDuring503 = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.equal(snapDuring503.messages.length, 0, "No premature message during 503 outage")

  // 2. Central recovers -> notifyAuthorizeRecovered delivers the EXACT completed run ONCE and transitions run history to completed!
  authMode = "ok"
  h.followUp.notifyAuthorizeRecovered()
  const snapAfterRecover = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.text.includes("Daily Digest Body: Summarize commits")),
  )
  assert.equal(snapAfterRecover.messages.length, 1, "Recovered run must deliver exactly once")
  await eventually(async () => h.schedules.pendingPrivateEvents().length, n => n === 0)
  const runsAfterRecover = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: task.id }, userA) as FollowUpRunsPage
  assert.equal(runsAfterRecover.runs.find(r => r.runId === run1.id)?.status, "completed")

  // Extra drain produces zero duplicates
  await h.followUp.drainScheduleEvents()
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot).messages.length, 1)

  // 3. Explicit 403 revocation -> stays completely silent, acks event (no infinite retry), does NOT deliver even if auth later flips back!
  authMode = "403"
  const runRevoked = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => Boolean(list[0]?.runs.some(r => r.id === runRevoked.id && r.state === "completed")))
  await h.followUp.drainScheduleEvents()
  assert.equal(h.schedules.pendingPrivateEvents().length, 0, "Explicitly revoked event must be acked and not retry forever")
  authMode = "ok"
  await h.followUp.drainScheduleEvents()
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot).messages.length, 1, "Explicitly revoked run must remain silent in SA main chat")
})

test("P1-1b: transient network outage automatically retries via bounded backoff timer and delivers once", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-p1-1b-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)

  let failing = false
  let failedAttempts = 0
  const backend = makeBackend(() => ({ text: "Recovered via backoff retry" }))
  const h = await openHarness(dir, {
    backend,
    scheduleAuthorize: async actor => actor,
    followUpAuthorize: async actor => {
      if (failing && failedAttempts < 2) {
        failedAttempts += 1
        throw new Error("ECONNRESET temporary network outage")
      }
      return actor
    },
    retryBaseMs: 30,
    retryMaxMs: 60,
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("RetryRepo", [{ path: workDir }])).id
  await h.enableAuth(userA, "inst-mac")
  const task = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Backoff Digest", prompt: "Check", workspaceId: ws, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: ws, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  failing = true
  await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA)
  const snap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.text.includes("Recovered via backoff retry")),
  )
  assert.equal(failedAttempts, 2, "Must have retried automatically after 2 transient network failures")
  assert.equal(snap.messages.length, 1)
  await eventually(async () => h.schedules.pendingPrivateEvents().length, n => n === 0)
})

// ============================================================================
// P1 · 原 2: Long reused existing session (>1,000 old events) preserves full report body & links;
//           ordinary Worker >1,000 events + >250 chunks preserves full output;
//           partial/incomplete read is distinguished from genuinely empty output!
// ============================================================================
test("P1-2: reused existing session with >1,050 prior events delivers full report text and distinguishes partial read from empty output", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-p1-2-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)

  const backend = makeBackend(prompt => {
    if (prompt.includes("EMPTY_OUTPUT")) return { text: "" }
    if (prompt.includes("MULTI_CHUNK_ORDINARY")) {
      return { chunks: Array.from({ length: 260 }, (_, idx) => idx === 259 ? "FINAL_ORDINARY_REPORT_TOKEN" : "x") }
    }
    if (prompt.includes("DAILY_LONG_SESSION")) return { text: "LONG_SESSION_DAILY_REPORT: 3 commits reviewed, 0 blockers." }
    return { text: `ok:${prompt}` }
  })
  const h = await openHarness(dir, { backend })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("LongHistory", [{ path: workDir }])).id
  await h.enableAuth(userA, "inst-mac")

  // 1. Existing session with >1,050 pre-existing journal events (exceeding AGENT_HISTORY_MAX_EVENTS = 1000!)
  const longSession = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Long Reused Session",
  }, userA) as AgentSnapshot).session
  const seedSnap = await h.agents.journal.read(longSession.id)
  const fillerEvents = Array.from({ length: 1_050 }, (_, idx) => h.agents.journal.event(longSession.id, "acp", {
    sessionId: "old-provider-session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `old-chunk-${idx}` } },
  }))
  await h.agents.journal.commit(seedSnap, { events: fillerEvents })
  const seeded = await h.agents.journal.read(longSession.id)
  assert.ok(BigInt(seeded.session.lastEventSeq) > 1_050n, "Session must contain >1,050 prior events")

  // Schedule targeting this long existing session
  const longTask = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Long Session Digest", prompt: "DAILY_LONG_SESSION", workspaceId: ws, enabled: true, target: { kind: "existing", sessionId: longSession.id }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: ws, sourceKind: "schedule", sourceId: longTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  const longRun = await h.operations.handle("scheduleRun", { scheduleId: longTask.id }, userA) as ScheduleRun
  const snapLong = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === longRun.id))

  const delivered = snapLong.messages.find(m => m.provenance?.runId === longRun.id)!
  assert.match(delivered.text, /LONG_SESSION_DAILY_REPORT: 3 commits reviewed, 0 blockers\./u, "Full report text past event #1,050 must be delivered")
  assert.ok(!delivered.text.includes("Run completed with no text output"), "Must NOT drop body into empty fallback")
  assert.equal(delivered.provenance?.sessionId, longSession.id)
  assert.ok(delivered.provenance?.turnId, "Must link to this run's turnId")
  assert.equal(delivered.provenance?.evidenceAvailability, "available")

  // 2. Genuinely empty turn still reports complete/available empty text accurately
  const emptyTask = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Silent Script", prompt: "EMPTY_OUTPUT", workspaceId: ws, enabled: true, target: { kind: "existing", sessionId: longSession.id }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: ws, sourceKind: "schedule", sourceId: emptyTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)
  const emptyRun = await h.operations.handle("scheduleRun", { scheduleId: emptyTask.id }, userA) as ScheduleRun
  const snapEmpty = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === emptyRun.id))
  const emptyMsg = snapEmpty.messages.find(m => m.provenance?.runId === emptyRun.id)!
  assert.match(emptyMsg.text, /Run completed with no text output/u)
  assert.equal(emptyMsg.provenance?.evidenceAvailability, "available")

  // 3. Ordinary Worker with >1,050 prior events AND >250 chunks in a single turn captures full text & advances cursor cleanly!
  const ordLong = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Long Ordinary Worker",
    followUpInstallationId: "inst-mac",
  }, userA) as AgentSnapshot).session
  const ordSeed = await h.agents.journal.read(ordLong.id)
  await h.agents.journal.commit(ordSeed, {
    events: Array.from({ length: 1_050 }, (_, idx) => h.agents.journal.event(ordLong.id, "acp", {
      sessionId: "old-ord",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `old-${idx}` } },
    })),
  })
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: ordLong.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "MULTI_CHUNK_ORDINARY" }],
  }, userA)
  const ordRuns = await eventually(
    () => h.followUp.listRuns({ userId: userA.userId!, workspaceId: ws, sourceKind: "session", sourceId: ordLong.id }),
    page => page.runs.some(r => r.summary.includes("FINAL_ORDINARY_REPORT_TOKEN")),
  )
  assert.equal(ordRuns.runs[0]!.evidenceAvailability, "available")

  // 4. Incomplete read (page budget hit before terminal event) -> marks evidenceAvailability="partial" & surfaces clearly even under exceptions_only!
  const dirPartial = await mkdtemp(join(tmpdir(), "df-p1-2-partial-"))
  const workDirPartial = join(dirPartial, "work")
  await mkdir(workDirPartial)
  const hp = await openHarness(dirPartial, {
    backend: makeBackend(() => ({ chunks: ["part-1 ", "part-2 ", "part-3 ", "part-4 ", "part-5 "] })),
    historyPageSize: 2,
    historyMaxPages: 1, // Forces incomplete transcript read before turn terminal event!
  })
  t.after(async () => { await hp.close(); await rm(dirPartial, { recursive: true, force: true }) })
  const pProv = (await hp.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const pWs = (await hp.catalog.native.createWorkspace("PartialRepo", [{ path: workDirPartial }])).id
  await hp.enableAuth(userA, "inst-mac")
  const pTask = await hp.operations.handle("scheduleCreate", {
    schedule: { title: "Huge Output Patrol", prompt: "Generate huge output", workspaceId: pWs, enabled: true, target: { kind: "new", provider: pProv, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await hp.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: pWs, sourceKind: "schedule", sourceId: pTask.id, enabled: true, deliveryPolicy: "exceptions_only",
  }, userA)
  const pRun = await hp.operations.handle("scheduleRun", { scheduleId: pTask.id }, userA) as ScheduleRun
  const pSnap = await eventually(async () => {
    await hp.followUp.drainScheduleEvents()
    return hp.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: pWs }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === pRun.id))
  const pMsg = pSnap.messages.find(m => m.provenance?.runId === pRun.id)!
  assert.equal(pMsg.provenance?.evidenceAvailability, "partial", "Truncated/budget-limited read must be labeled partial")
  assert.ok(!pMsg.text.includes("Run completed with no text output"), "Partial read must never be reported as empty output")
  assert.match(pMsg.text, /could not be read completely|Partial output captured/u)
})

// ============================================================================
// P1 · 原 3 + Cross-device P1 · 原 4 daemon verification:
//   - Classic device (or old client / unauthorized installation) creating or forking a Worker MUST NOT auto-enroll
//   - Authorized SA device creating or forking a Worker DOES auto-enroll
//   - Explicit adoption works from current cursor
//   - Swapping Mac <-> iPhone authorization swaps auto-enrollment accurately
//   - Two workspaces sharing the same folder stay isolated
//   - Closing one device while another stays authorized continues follow-up; revoking last stops SA while native schedules still run!
// ============================================================================
test("P1-3 & P1-4 daemon: host-verified device origin prevents classic Worker auto-enrollment, supports swap/adopt/same-dir isolation, and verifies partial vs last-grant revocation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-p1-3-"))
  const sharedDir = join(dir, "shared-repo")
  await mkdir(sharedDir)

  const backend = makeBackend(prompt => {
    if (prompt.includes("BOOM")) return { error: `Fatal failure in ${prompt}` }
    return { text: `Done: ${prompt}` }
  })
  const h = await openHarness(dir, { backend })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws1 = (await h.catalog.native.createWorkspace("ProjectOne", [{ path: sharedDir }])).id
  const ws2 = (await h.catalog.native.createWorkspace("ProjectTwo", [{ path: sharedDir }])).id

  // Authorize ONLY Mac ("inst-mac") WITHOUT enabling unified takeover yet!
  await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
    action: "enable", installationId: "inst-mac", deviceLabel: "inst-mac",
  }, userA)

  // 1. Before unified takeover is explicitly enabled, ordinary Workers MUST NOT auto-enroll or push to SA!
  const preTakeoverWorker = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: ws1, operationId: randomUUID(), provider, context: "directory", title: "Pre-takeover Worker",
  }, userA) as AgentSnapshot).session
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: preTakeoverWorker.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "BOOM pre-takeover failure" }],
  }, userA)
  await eventually(() => h.agents.journal.read(preTakeoverWorker.id), s => s.turns.some(turn => turn.state === "failed" || turn.state === "interrupted"))
  await delay(60)
  assert.equal(h.followUpStore.getSource(userA.userId!, ws1, "session", preTakeoverWorker.id), undefined, "Before takeover is enabled, Worker MUST NOT auto-enroll")
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as SuperSnapshot).messages.length, 0, "Pre-takeover Worker failure MUST NOT enter SA main chat")

  // 2. Explicitly turning ON unified takeover adopts preTakeoverWorker from current cursor WITHOUT replaying historical failure; NEW failure DOES return to SA!
  await h.enableAuth(userA, "inst-mac")
  await delay(40)
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as SuperSnapshot).messages.length, 0, "Enabling takeover must NOT replay pre-takeover history")
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: preTakeoverWorker.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "BOOM after adoption" }],
  }, userA)
  await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.text.includes("BOOM after adoption")),
  )

  // 3. New & forked ordinary Workers in ws1 BOTH auto-enroll in ws1 ONLY (NOT ws2 sharing sharedDir!)
  const macWorker = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: ws1, operationId: randomUUID(), provider, context: "directory", title: "Mac SA Worker",
  }, userA) as AgentSnapshot).session
  await eventually(() => Promise.resolve(h.followUpStore.getSource(userA.userId!, ws1, "session", macWorker.id)), s => s?.state.enabled === true)
  const macFork = (await h.agents.handle("_deskfleet/session/fork", {
    sessionId: macWorker.id, operationId: randomUUID(), context: "directory", title: "Mac SA Fork",
  }, userA) as AgentSnapshot).session
  await eventually(() => Promise.resolve(h.followUpStore.getSource(userA.userId!, ws1, "session", macFork.id)), s => s?.state.enabled === true)
  assert.equal(h.followUpStore.getSource(userA.userId!, ws2, "session", macWorker.id), undefined, "Same-directory sibling workspace must stay isolated")
  assert.equal(h.followUpStore.getSource(userA.userId!, ws2, "session", macFork.id), undefined, "Forked Worker must also stay isolated from sibling workspace")
  await h.agents.handle("_deskfleet/input/submit", {
    sessionId: macWorker.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "BOOM mac worker" }],
  }, userA)
  await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.text.includes("BOOM mac worker")),
  )
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws2 }, userA) as SuperSnapshot).messages.length, 0)

  // 4. Cross-device Case A: Enable iPhone too, then DISABLE Mac -> iPhone remains authorized so schedule + new ordinary Worker STILL return to SA!
  await h.enableAuth(userA, "inst-iphone")
  const macOff = await h.disableAuth(userA, "inst-mac")
  assert.equal(macOff.authorized, true)
  assert.equal(macOff.activeDeviceCount, 1)
  assert.equal(macOff.stoppedAllBackground, false)

  const afterSwapIphoneWorker = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: ws1, operationId: randomUUID(), provider, context: "directory", title: "Post-enable iPhone Worker",
  }, userA) as AgentSnapshot).session
  await eventually(() => Promise.resolve(h.followUpStore.getSource(userA.userId!, ws1, "session", afterSwapIphoneWorker.id)), s => s?.state.enabled === true)

  // Schedule still reports to SA while iPhone remains authorized
  const sched = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Cross-Device Digest", prompt: "Report status", workspaceId: ws1, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: ws1, sourceKind: "schedule", sourceId: sched.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)
  const runWhileOneAuth = await h.operations.handle("scheduleRun", { scheduleId: sched.id }, userA) as ScheduleRun
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.runId === runWhileOneAuth.id))

  // 6. Cross-device Case B: Disable LAST grant (iPhone) -> SA stops new deliveries, native schedule STILL executes on time!
  const lastOff = await h.disableAuth(userA, "inst-iphone")
  assert.equal(lastOff.authorized, false)
  assert.equal(lastOff.activeDeviceCount, 0)
  assert.equal(lastOff.stoppedAllBackground, true)
  const msgCountBeforeLastOffRun = (await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as SuperSnapshot).messages.length

  const runAfterLastOff = await h.operations.handle("scheduleRun", { scheduleId: sched.id }, userA) as ScheduleRun
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => Boolean(list[0]?.runs.some(r => r.id === runAfterLastOff.id && r.state === "completed")))
  await h.followUp.drainScheduleEvents()
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as SuperSnapshot).messages.length, msgCountBeforeLastOffRun, "After last grant revoked, native schedule runs on time without sending new SA messages")
})
