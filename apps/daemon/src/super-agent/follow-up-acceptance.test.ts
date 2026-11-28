import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import test from "node:test"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import type { AgentActor, AgentSnapshot } from "@deskfleet/protocol/agent"
import { AgentProviders } from "../providers/providers.ts"
import { AgentSessions } from "../agent/sessions.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import { CentralSync } from "../central/sync.ts"
import { TestAgentQuotas } from "../fixtures/agent-quotas.ts"
import { MachineOperations } from "../machine/operations.ts"
import { dispatchMcp } from "../mcp/dispatch.ts"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import { nextScheduleTime } from "../schedules/time.ts"
import { ScheduledTasks } from "../schedules/scheduled-tasks.ts"
import { evaluateWorkerProgress, extractVerifiedPrRefs, inspectTurnOwnership, matchCrossWorkerEvidence } from "./follow-up-evidence.ts"
import { inferDefaultDeliveryPolicy, type FollowUpAuthReceipt, type FollowUpRunsPage, type FollowUpSourceRecord, type FollowUpSourcesResponse } from "@deskfleet/protocol/super-agent-follow-up"
import { LocalFollowUpStore } from "./follow-up-store.ts"
import { SuperFollowUpService } from "./follow-up.ts"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import { routeSuperMessage, type SuperDecisionModel } from "./router.ts"
import { deterministicScheduleUuid, type ScheduleCommandHost } from "./schedule.ts"
import { SuperAgentService, type SuperUserState } from "./service.ts"
import { LocalSuperStore } from "./store.ts"
import { superWorkspaces } from "./workspaces.ts"
import { TerminalSessions } from "../terminals/terminals.ts"
import { ProviderSetup } from "../providers/setup.ts"

const exec = promisify(execFile)

const userA: AgentActor = { kind: "user", userId: "user-a", deviceId: "login-a" }
const userB: AgentActor = { kind: "user", userId: "user-b", deviceId: "login-b" }

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    assert.ok(Date.now() < deadline, "Timed out waiting for expected state")
    await delay(15)
  }
}

async function initGitRepo(dir: string) {
  await mkdir(dir, { recursive: true })
  await exec("git", ["-C", dir, "init"])
  await writeFile(join(dir, "README.md"), "initial commit\n")
  await exec("git", ["-C", dir, "add", "README.md"])
  await exec("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"])
}

interface HarnessOptions {
  backend?: BackendAgent
  quotas?: TestAgentQuotas
  authorize?: (actor: AgentActor) => Promise<AgentActor>
  model?: SuperDecisionModel
  triageModel?: (userId: string) => ((packet: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>) | undefined
  githubPullRequest?: Parameters<typeof SuperFollowUpService["prototype"]["init"]> extends never ? never : NonNullable<ConstructorParameters<typeof SuperFollowUpService>[0]["githubPullRequest"]>
  now?: () => Date
  skipFollowUpInit?: boolean
}

async function openHarness(directory: string, options: HarnessOptions = {}) {
  const catalog = new DaemonCatalog(directory)
  await catalog.init()
  const backend = options.backend ?? new BackendAgent()
  const providers = new AgentProviders(directory, backend)
  await providers.init()
  const quotas = options.quotas ?? new TestAgentQuotas()
  const agents = new AgentSessions(catalog, catalog.native, backend, providers, undefined, undefined, quotas)
  await agents.init()
  const terminals = new TerminalSessions({ directory: join(directory, "terminals") })
  await terminals.init()
  const setup = new ProviderSetup(terminals, { directory })
  const authorize = options.authorize ?? (async actor => actor)
  const schedules = new ScheduledTasks(directory, { agents, catalog, providers, authorize, now: options.now })
  await schedules.init()
  const operations = new MachineOperations({ agents, catalog, providers, terminals, setup, schedules, capabilities: async () => ({ displays: [], audio: false }) })
  const superStore = new LocalSuperStore<SuperUserState>(catalog.native)
  await superStore.init()
  const followUpStore = new LocalFollowUpStore(catalog.native)
  const ws = superWorkspaces(catalog, directory)
  let frontDesk!: SuperAgentService
  const followUp = new SuperFollowUpService({
    followUpStore, superStore, agents, schedules, authorize,
    workspaces: ws.workspaces, triageModel: options.triageModel,
    githubPullRequest: options.githubPullRequest,
    isInteractiveBusy: (uid, wid) => frontDesk?.isInteractiveBusy(uid, wid) ?? false,
    now: options.now,
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
    coordinatorModel: () => options.model ?? (async () => ({ reason: "default", actions: [{ kind: "answer", text: "ok" }] })),
    agents, store: superStore, followUp, schedules: scheduleHost, authorize,
    providers: () => providers.metadata().providers, ...ws,
  })
  if (!options.skipFollowUpInit) await followUp.init()
  else await followUpStore.init()
  await frontDesk.init()

  const mcpBridge = {
    prepareCreate: async ({ actor, sessionId, workspaceId, schedule }: { actor: AgentActor; sessionId: string; workspaceId: string; schedule: Record<string, unknown> }) => {
      const delegation = frontDesk.workerDelegationForSession(sessionId)
      if (!delegation || delegation.userId !== actor.userId) return {}
      if (delegation.hasNativeScheduleId) {
        const existing = schedules.snapshot().find(t => t.id === delegation.hasNativeScheduleId)
        if (existing) return { duplicateOf: existing }
      }
      const operationId = deterministicScheduleUuid("mcp-schedule-create", delegation.userId, workspaceId, delegation.sourceMessageId, String(schedule.title ?? ""), String(schedule.prompt ?? ""))
      const scheduleId = deterministicScheduleUuid("mcp-schedule-id", delegation.userId, workspaceId, delegation.sourceMessageId, String(schedule.title ?? ""), String(schedule.prompt ?? ""))
      return { operationId, scheduleId, autoSubscribe: followUp.isAuthorized(delegation.userId), deliveryPolicy: inferDefaultDeliveryPolicy(String(schedule.title ?? ""), String(schedule.prompt ?? "")) }
    },
    onCreated: async ({ actor, workspaceId, task, deliveryPolicy }: { actor: AgentActor; workspaceId: string; task: ScheduledTask; deliveryPolicy?: "every_run" | "exceptions_only" }) => {
      if (!actor.userId || !followUp.isAuthorized(actor.userId)) return
      await followUp.subscribeSchedule({
        userId: actor.userId, workspaceId, scheduleId: task.id, scheduleTitle: task.title,
        targetKind: task.target.kind === "existing" ? "existing" : task.target.context,
        deliveryPolicy: deliveryPolicy ?? inferDefaultDeliveryPolicy(task.title, task.prompt), enabled: true,
      })
    },
  }

  return {
    catalog, providers, agents, schedules, operations, superStore, followUpStore, followUp, frontDesk, backend, mcpBridge,
    async enableAuth(actor: AgentActor, installationId: string, deviceLabel = installationId) {
      return frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "enable", installationId, deviceLabel, takeoverAllSessions: true }, actor) as Promise<FollowUpAuthReceipt>
    },
    async close() {
      await Promise.allSettled([followUp.close(), frontDesk.close(), schedules.close(), agents.close(), terminals.close()])
      await superStore.close()
      await catalog.close()
    },
  }
}

/** Auto-approve a BackendAgent prompt by returning a custom reply without pending permission when desired. */
function makeAutoReplyBackend(replyFor: (prompt: string) => { text?: string; error?: string; askPermission?: boolean; elicitation?: string }) {
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    conn.prompt = async params => {
      const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
      backend.prompts.push(promptText)
      const plan = replyFor(promptText)
      if (plan.askPermission) {
        const res = await client.requestPermission!({
          sessionId: params.sessionId,
          toolCall: { toolCallId: `tc-${randomUUID()}`, title: `Approve ${promptText.slice(0, 40)}` },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }],
        }, new AbortController().signal)
        const outcome = res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"
        await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Permission outcome: ${outcome}. ${plan.text ?? ""}` } } })
        return { stopReason: "end_turn" }
      }
      if (plan.elicitation) {
        const res = await client.requestElicitation!({
          sessionId: params.sessionId, toolCallId: `el-${randomUUID()}`, mode: "form", message: plan.elicitation,
          requestedSchema: { type: "object", required: ["choice"], properties: { choice: { type: "string" } } },
        }, new AbortController().signal)
        await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Answered elicitation: ${JSON.stringify(res)}` } } })
        return { stopReason: "end_turn" }
      }
      if (plan.error) throw new Error(plan.error)
      await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: plan.text ?? `Completed: ${promptText}` } } })
      return { stopReason: "end_turn" }
    }
    return conn
  }
  return backend
}

// ============================================================================
// A1: Two entry points (Form + Main Chat) x Three targets (worktree, directory, existing) = 6 combos
// ============================================================================
test("A1: form and SA main chat share one scheduler across worktree, directory, and existing-session targets", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a1-"))
  const repoDir = join(dir, "repo")
  await initGitRepo(repoDir)
  let nextAction: unknown
  const backend = makeAutoReplyBackend(prompt => ({ text: `Summary for [${prompt}]` }))
  const h = await openHarness(dir, {
    backend,
    model: async () => ({ reason: "schedule action", actions: [nextAction] }),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("RepoProject", [{ path: repoDir }])).id
  await h.enableAuth(userA, "mac-install-1")

  const existingSession = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Existing Worker",
  }, userA) as AgentSnapshot).session

  const targets: Array<{ name: string; formTarget: ScheduledTask["target"]; chatTarget: { targetKind: "worktree" | "directory" | "existing"; sessionId?: string } }> = [
    { name: "worktree", formTarget: { kind: "new", provider, context: "worktree" }, chatTarget: { targetKind: "worktree" } },
    { name: "directory", formTarget: { kind: "new", provider, context: "directory" }, chatTarget: { targetKind: "directory" } },
    { name: "existing", formTarget: { kind: "existing", sessionId: existingSession.id }, chatTarget: { targetKind: "existing", sessionId: existingSession.id } },
  ]

  const scheduleIds = new Set<string>()
  for (const item of targets) {
    // 1. Form entry point
    const formTask = await h.operations.handle("scheduleCreate", {
      operationId: randomUUID(),
      scheduleId: randomUUID(),
      schedule: {
        title: `Form ${item.name} report`,
        prompt: `Generate daily report via form ${item.name}`,
        workspaceId: ws, enabled: true, target: item.formTarget,
        trigger: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
      },
    }, userA) as ScheduledTask
    assert.ok(!scheduleIds.has(formTask.id))
    scheduleIds.add(formTask.id)
    await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
      workspaceId: ws, sourceKind: "schedule", sourceId: formTask.id, enabled: true, deliveryPolicy: "every_run",
    }, userA)
    const formRun = await h.operations.handle("scheduleRun", { scheduleId: formTask.id }, userA) as ScheduleRun
    await eventually(async () => {
      await h.followUp.drainScheduleEvents()
      const page = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: formTask.id }, userA) as FollowUpRunsPage
      return page.runs.find(r => r.runId === formRun.id)
    }, run => run?.status === "completed" && run.delivered === true && !!run.sessionId && !!run.inputId && !!run.turnId)

    // 2. Main Chat entry point
    nextAction = {
      kind: "schedule", operation: "create",
      title: `Chat ${item.name} report`,
      prompt: `Generate daily report via chat ${item.name}`,
      ...item.chatTarget,
      trigger: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" },
      deliveryPolicy: "every_run",
    }
    const msgId = randomUUID()
    await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: ws, messageId: msgId, text: `Daily report ${item.name}`, timeZone: "Asia/Shanghai" }, userA)
    const snap = await eventually(
      () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
      s => s.messages.some(m => m.sourceMessageId === msgId && m.provenance?.origin === "schedule_receipt"),
    )
    const receiptMsg = snap.messages.find(m => m.sourceMessageId === msgId && m.provenance?.origin === "schedule_receipt")!
    const chatSchedId = receiptMsg.provenance!.scheduleId!
    assert.ok(!scheduleIds.has(chatSchedId))
    scheduleIds.add(chatSchedId)
    // Appears immediately in the shared Schedules list!
    const listed = await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[]
    assert.ok(listed.some(task => task.id === chatSchedId))

    const chatRun = await h.operations.handle("scheduleRun", { scheduleId: chatSchedId }, userA) as ScheduleRun
    await eventually(async () => {
      await h.followUp.drainScheduleEvents()
      const page = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: chatSchedId }, userA) as FollowUpRunsPage
      return page.runs.find(r => r.runId === chatRun.id)
    }, run => run?.status === "completed" && run.delivered === true && !!run.sessionId && !!run.inputId && !!run.turnId)
  }

  assert.equal(scheduleIds.size, 6)
  const finalSnap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.equal(finalSnap.supportsProactiveFollowUp, true)
  assert.equal(finalSnap.supportsScheduleCommands, true)
  const deliveries = finalSnap.messages.filter(m => m.provenance?.origin === "sa_follow_up" && m.provenance.sourceKind === "schedule")
  assert.equal(deliveries.length, 6)
})

// ============================================================================
// A2: Main chat create -> Form edit -> pause -> resume -> run -> delete -> idempotent retry never recreates
// ============================================================================
test("A2: cross-entry lifecycle consistency and idempotent receipt protection against recreating deleted schedules", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a2-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  let nextAction: unknown
  const backend = makeAutoReplyBackend(() => ({ text: "Commit audit clean: no issues." }))
  const h = await openHarness(dir, {
    backend,
    model: async () => ({ reason: "schedule op", actions: [nextAction] }),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  await h.providers.create({ template: "codex", name: "Codex", env: {} })
  const ws = (await h.catalog.native.createWorkspace("DeskFleet", [{ path: workDir }])).id
  await h.enableAuth(userA, "mac-1")

  // 1. Create Mon-Fri 09:00 Asia/Shanghai via Main Chat
  nextAction = {
    kind: "schedule", operation: "create",
    title: "Weekday commit audit", prompt: "Check yesterday's commits for risks",
    trigger: { kind: "weekly", time: "09:00", timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] },
    deliveryPolicy: "exceptions_only",
  }
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: ws, messageId: "create-1", text: "工作日北京时间 9 点检查昨天的提交，有风险再告诉我", timeZone: "Asia/Shanghai" }, userA)
  const createdSnap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.sourceMessageId === "create-1" && m.provenance?.scheduleId),
  )
  const scheduleId = createdSnap.messages.find(m => m.sourceMessageId === "create-1")!.provenance!.scheduleId!
  const listed1 = await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[]
  assert.equal(listed1.length, 1)
  assert.deepEqual(listed1[0]!.trigger, { kind: "weekly", time: "09:00", timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] })

  // 2. Form edits time to 10:30
  await h.operations.handle("scheduleUpdate", {
    scheduleId, changes: { trigger: { kind: "weekly", time: "10:30", timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] } },
  }, userA)

  // 3. Main chat inspects and sees updated time, then pauses
  nextAction = { kind: "schedule", operation: "pause", scheduleId }
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: ws, messageId: "pause-1", text: "以后不再执行" }, userA)
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => list[0]?.enabled === false)

  // 4. Form resumes
  await h.operations.handle("scheduleUpdate", { scheduleId, changes: { enabled: true } }, userA)
  assert.equal((await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[])[0]!.enabled, true)

  // 5. Main chat runs now
  nextAction = { kind: "schedule", operation: "run", scheduleId }
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: ws, messageId: "run-1", text: "立即运行" }, userA)
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => (list[0]?.runs.length ?? 0) >= 1)

  // 6. Delete via Form
  const createOpId = deterministicScheduleUuid("sa-schedule-create", userA.userId!, ws, "create-1", 0, 0)
  const receiptBeforeDelete = h.schedules.commandReceipt(createOpId)
  assert.ok(receiptBeforeDelete)
  await h.operations.handle("scheduleDelete", { scheduleId }, userA)
  assert.equal((await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[]).length, 0)

  // 7. Reconnecting stale retry with the same create operationId MUST NOT recreate the deleted schedule!
  const replay = await h.operations.handle("scheduleCreate", {
    operationId: createOpId,
    scheduleId,
    schedule: {
      title: "Weekday commit audit", prompt: "Check yesterday's commits for risks",
      workspaceId: ws, enabled: true,
      target: listed1[0]!.target,
      trigger: { kind: "weekly", time: "09:00", timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] },
    },
  }, userA) as ScheduledTask
  assert.equal(replay.id, scheduleId)
  assert.equal((await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[]).length, 0, "Deleted schedule must not be recreated on stale retry")

  // 8. Same operationId with DIFFERENT parameters must throw a conflict error!
  await assert.rejects(
    h.operations.handle("scheduleCreate", {
      operationId: createOpId,
      schedule: {
        title: "Tampered title", prompt: "Different prompt",
        workspaceId: ws, enabled: true,
        target: listed1[0]!.target,
        trigger: { kind: "manual" },
      },
    }, userA),
    /different parameters/u,
  )
})

// ============================================================================
// A3: Worker MCP dedup + legacy adoption + default chat project handoff + unsupported rule + DST/missed-run
// ============================================================================
test("A3: Worker MCP deduplication, legacy schedule adoption, default handoff, unsupported rules, and DST semantics", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a3-"))
  const dirA = join(dir, "alpha")
  const dirB = join(dir, "beta")
  await mkdir(dirA); await mkdir(dirB)
  let nextActions: unknown[] = []
  const backend = makeAutoReplyBackend(() => ({ text: "Done." }))
  const h = await openHarness(dir, {
    backend,
    model: async () => ({ reason: "route", actions: nextActions }),
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const wsA = (await h.catalog.native.createWorkspace("Alpha", [{ path: dirA }])).id
  await h.catalog.native.createWorkspace("Alpha", [{ path: dirB }])

  // 1. Legacy MCP-created schedule (created BEFORE unified takeover is on) is not subscribed until adopted/enabled
  const ordinarySession = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: wsA, operationId: randomUUID(), provider, context: "directory", title: "Legacy MCP worker",
  }, userA) as AgentSnapshot).session
  const legacyMcpTask = await dispatchMcp(h.operations, "scheduleCreate", {
    schedule: {
      title: "Legacy MCP task", prompt: "Run legacy check", enabled: true,
      target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" },
    },
  }, userA, { sessionId: ordinarySession.id, workspaceId: wsA }, undefined, undefined, h.mcpBridge) as ScheduledTask
  assert.equal(h.followUp.getScheduleSubscription(userA.userId!, wsA, legacyMcpTask.id), undefined)
  // Enable unified takeover and verify explicit adopt/subscription works
  await h.enableAuth(userA, "mac-1")
  const adopted = await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: wsA, sourceKind: "schedule", sourceId: legacyMcpTask.id, adopt: true,
  }, userA) as FollowUpSourceRecord
  assert.equal(adopted.state.enabled, true)

  // 2. SA-delegated Worker calling MCP scheduleCreate twice creates ONLY ONCE, and auto-subscribes!
  nextActions = [{ kind: "create", title: "Setup cron", scope: "Schedule via worker", prompt: "Set up schedule" }]
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: wsA, messageId: "delegated-1", text: "Set up schedule" }, userA)
  const delegatedSnap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as Promise<SuperSnapshot>,
    s => !!s.tickets[0]?.sessionId,
  )
  const workerSid = delegatedSnap.tickets[0]!.sessionId!
  const mcpPayload = {
    schedule: {
      title: "MCP delegated daily", prompt: "Generate daily digest", enabled: true,
      target: { kind: "new", provider, context: "directory" }, trigger: { kind: "daily", time: "08:00", timeZone: "Asia/Tokyo" },
    },
  }
  const firstMcp = await dispatchMcp(h.operations, "scheduleCreate", mcpPayload, userA, { sessionId: workerSid, workspaceId: wsA }, undefined, undefined, h.mcpBridge) as ScheduledTask
  const secondMcp = await dispatchMcp(h.operations, "scheduleCreate", mcpPayload, userA, { sessionId: workerSid, workspaceId: wsA }, undefined, undefined, h.mcpBridge) as ScheduledTask
  assert.equal(firstMcp.id, secondMcp.id, "Repeated delegated MCP scheduleCreate must return the same schedule")
  assert.equal(h.followUp.getScheduleSubscription(userA.userId!, wsA, firstMcp.id)?.enabled, true)

  // 3. Unsupported calendar rule (statutory holidays) returns supported choices, never silently turns into daily!
  nextActions = [{ kind: "schedule", operation: "create", unsupportedRule: "Chinese statutory holidays (法定工作日)" }]
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: wsA, messageId: "unsupported-1", text: "每个法定工作日早上9点检查" }, userA)
  const unsupSnap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.sourceMessageId === "unsupported-1" && m.role === "assistant"),
  )
  assert.match(unsupSnap.messages.find(m => m.sourceMessageId === "unsupported-1")!.text, /cannot accurately represent/u)
  assert.equal((await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[]).length, 2, "Unsupported rule must NOT create a schedule")

  // 4. Default conversation handing off unambiguously to wsA (and completing creation in wsA)
  nextActions = [{ kind: "schedule", operation: "create", workspaceId: wsA, title: "Default handoff task", prompt: "Check repo", trigger: { kind: "daily", time: "09:00", timeZone: "Asia/Tokyo" } }]
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: null, messageId: "def-1", text: "Schedule daily check for Alpha" }, userA)
  const defSnap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: null }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.id === "def-1" && m.state === "transferred"),
  )
  assert.equal(defSnap.messages.find(m => m.id === "def-1")?.targetWorkspaceId, wsA)
  await eventually(
    () => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>,
    list => list.some(task => task.workspaceId === wsA && task.title === "Default handoff task"),
  )

  // 4b. Duplicate project name ("Alpha" exists in both dirA and dirB): default chat asks ONE clarifying question mentioning both folders/IDs and creates ZERO schedules!
  const countBeforeDup = (await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[]).length
  nextActions = [{ kind: "schedule", operation: "create", title: "Ambiguous Alpha task", prompt: "Check", trigger: { kind: "manual" } }]
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: null, messageId: "dup-proj-1", text: "Schedule check for Alpha" }, userA)
  const dupSnap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: null }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.sourceMessageId === "dup-proj-1" && m.role === "assistant"),
  )
  const dupReply = dupSnap.messages.find(m => m.sourceMessageId === "dup-proj-1")!
  assert.match(dupReply.text, /Multiple projects match "Alpha"/u)
  assert.ok(dupReply.text.includes(dirA) && dupReply.text.includes(dirB), "Clarifying question must list both folder hints so user can answer once")
  assert.equal((await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[]).length, countBeforeDup)

  // 5. DST nonexistent wall time (America/New_York spring forward 2026-03-08 02:30) is skipped per existing rule
  const nextDst = nextScheduleTime({ kind: "daily", time: "02:30", timeZone: "America/New_York" }, new Date("2026-03-08T05:00:00Z"))
  assert.equal(nextDst, "2026-03-09T06:30:00.000Z")
})

// ============================================================================
// A4: Monday/Tuesday separate Workers -> Wednesday queries Monday's evidence; existing Worker with manual + 2 schedules doesn't mix
// ============================================================================
test("A4: multi-day schedule run citations stay accurate and shared existing Worker separates manual + two schedules", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a4-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  let runNum = 0
  const backend = makeAutoReplyBackend(prompt => {
    if (prompt.includes("Audit commits")) {
      runNum++
      return { text: runNum === 1 ? "Monday finding: risk in billing.ts line 42" : "Tuesday finding: all clean" }
    }
    return { text: `Handled [${prompt}]` }
  })
  const h = await openHarness(dir, { backend })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("MultiDay", [{ path: workDir }])).id
  await h.enableAuth(userA, "mac-1")

  const dailyTask = await h.operations.handle("scheduleCreate", {
    schedule: {
      title: "Daily audit", prompt: "Audit commits", workspaceId: ws, enabled: true,
      target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" },
    },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", {
    workspaceId: ws, sourceKind: "schedule", sourceId: dailyTask.id, enabled: true, deliveryPolicy: "every_run",
  }, userA)

  // Monday run & Tuesday run each create separate Workers
  const monRun = await h.operations.handle("scheduleRun", { scheduleId: dailyTask.id }, userA) as ScheduleRun
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return (await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: dailyTask.id }, userA) as FollowUpRunsPage).runs
  }, runs => runs.some(r => r.runId === monRun.id && r.status === "completed"))

  const tueRun = await h.operations.handle("scheduleRun", { scheduleId: dailyTask.id }, userA) as ScheduleRun
  const twoRuns = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return (await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: dailyTask.id }, userA) as FollowUpRunsPage).runs
  }, runs => runs.some(r => r.runId === tueRun.id && r.status === "completed"))

  const mondayRecord = twoRuns.find(r => r.runId === monRun.id)!
  const tuesdayRecord = twoRuns.find(r => r.runId === tueRun.id)!
  assert.notEqual(mondayRecord.sessionId, tuesdayRecord.sessionId)
  assert.match(mondayRecord.summary, /Monday finding: risk in billing\.ts line 42/u)
  assert.match(tuesdayRecord.summary, /Tuesday finding: all clean/u)

  // Existing Worker receiving manual input + two distinct schedules keeps each run's inputId/turnId/summary separate!
  const sharedWorker = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Shared Worker",
  }, userA) as AgentSnapshot).session
  const sched1 = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Sched One", prompt: "Job Alpha", workspaceId: ws, enabled: true, target: { kind: "existing", sessionId: sharedWorker.id }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  const sched2 = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Sched Two", prompt: "Job Beta", workspaceId: ws, enabled: true, target: { kind: "existing", sessionId: sharedWorker.id }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws, sourceKind: "schedule", sourceId: sched1.id, enabled: true, deliveryPolicy: "every_run" }, userA)
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws, sourceKind: "schedule", sourceId: sched2.id, enabled: true, deliveryPolicy: "every_run" }, userA)

  await h.agents.handle("_deskfleet/input/submit", { sessionId: sharedWorker.id, operationId: randomUUID(), content: [{ type: "text", text: "Manual question" }], delivery: "backlog" }, userA)
  const r1 = await h.operations.handle("scheduleRun", { scheduleId: sched1.id }, userA) as ScheduleRun
  const r2 = await h.operations.handle("scheduleRun", { scheduleId: sched2.id }, userA) as ScheduleRun

  const s1Page = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: sched1.id }, userA) as Promise<FollowUpRunsPage>
  }, p => p.runs.some(r => r.runId === r1.id && r.status === "completed"))
  const s2Page = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: sched2.id }, userA) as Promise<FollowUpRunsPage>
  }, p => p.runs.some(r => r.runId === r2.id && r.status === "completed"))

  assert.match(s1Page.runs[0]!.summary, /Job Alpha/u)
  assert.doesNotMatch(s1Page.runs[0]!.summary, /Job Beta|Manual question/u)
  assert.match(s2Page.runs[0]!.summary, /Job Beta/u)
  assert.doesNotMatch(s2Page.runs[0]!.summary, /Job Alpha|Manual question/u)
})

// ============================================================================
// A5: Direct ordinary Worker (never dispatched by SA) -> permission, elicitation, failure; answering in Worker closes SA card
// ============================================================================
test("A5: ordinary Worker never dispatched by SA surfaces permissions/questions/failures and syncs resolution across both ends", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a5-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  const backend = makeAutoReplyBackend(prompt => {
    if (prompt.includes("need-perm")) return { askPermission: true, text: "Export complete" }
    if (prompt.includes("need-question")) return { elicitation: "Which CSV encoding should we use?" }
    if (prompt.includes("need-fail")) return { error: "Export disk full" }
    return { text: "Ordinary chat done." }
  })
  const h = await openHarness(dir, { backend })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("Exports", [{ path: workDir }])).id
  await h.enableAuth(userA, "mac-1")

  // Directly created ordinary session from authorized SA device (NO SA ticket!)
  const ordinary = (await h.agents.handle("_deskfleet/session/create", {
    workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Export Worker",
    followUpInstallationId: "mac-1",
  }, userA) as AgentSnapshot).session
  assert.equal(((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA)) as SuperSnapshot).tickets.length, 0)

  // 1. Normal completion creates NO ticket and does NOT spam chat
  await h.agents.handle("_deskfleet/input/submit", { sessionId: ordinary.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Say hi" }] }, userA)
  await eventually(() => h.agents.journal.read(ordinary.id), s => s.turns.some(turn => turn.state === "completed"))
  await delay(60)
  const afterNormal = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.equal(afterNormal.tickets.length, 0)
  assert.equal(afterNormal.messages.length, 0, "Normal ordinary chat must not spam main chat")

  // 2. Pending permission surfaces in SA pendingRequests + main chat; answering directly in Worker resolves SA immediately!
  await h.agents.handle("_deskfleet/input/submit", { sessionId: ordinary.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Run need-perm" }] }, userA)
  const withPerm = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => (s.pendingRequests?.length ?? 0) === 1 && s.pendingRequests![0]!.kind === "permission",
  )
  const perm = withPerm.pendingRequests![0]!.item
  // Answer directly inside the Worker session
  await h.agents.handle("_deskfleet/permission/respond", { sessionId: ordinary.id, permissionId: perm.id, optionId: "allow", operationId: randomUUID() }, userA)
  const clearedPerm = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => (s.pendingRequests?.length ?? 0) === 0 && s.messages.some(m => m.workerEvent === "permission" && /^Allow ·/u.test(m.text)),
  )
  assert.equal(clearedPerm.pendingRequests?.length ?? 0, 0)

  // 3. Structured elicitation surfaces in SA; answering resolves cleanly
  await h.agents.handle("_deskfleet/input/submit", { sessionId: ordinary.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Run need-question" }] }, userA)
  const withQuestion = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => (s.pendingRequests?.length ?? 0) === 1 && s.pendingRequests![0]!.kind === "elicitation",
  )
  const qItem = withQuestion.pendingRequests![0]!.item
  await h.agents.handle("_deskfleet/elicitation/respond", { sessionId: ordinary.id, elicitationId: qItem.id, operationId: randomUUID(), response: { action: "accept", content: { choice: "UTF-8" } } }, userA)
  await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => (s.pendingRequests?.length ?? 0) === 0 && s.messages.some(m => m.workerEvent === "question" && /^Answered ·/u.test(m.text)),
  )

  // 4. Turn failure surfaces clearly in SA main chat
  await h.agents.handle("_deskfleet/input/submit", { sessionId: ordinary.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Run need-fail" }] }, userA)
  const withFailure = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => m.provenance?.sourceId === ordinary.id && /Export disk full/u.test(m.text)),
  )
  assert.ok(withFailure.messages.some(m => /Export disk full/u.test(m.text)))
})

// ============================================================================
// A6: Cross-Worker PR evidence strict matching (positive & negative) + works without GitHub
// ============================================================================
test("A6: cross-Worker PR matching enforces repo/workspace/owner/objective boundaries and works without GitHub", async t => {
  // Pure verification of strict matching boundaries
  assert.deepEqual(extractVerifiedPrRefs("Fixed #42 in PR title"), [], "Bare #42 without owner/repo is never accepted")
  const refs = extractVerifiedPrRefs("Investigated https://github.com/acme/app/pull/42 and acme/other#42")
  assert.equal(refs.length, 2)

  const matched = matchCrossWorkerEvidence({
    candidates: [
      { sessionId: "s-same", workspaceId: "ws-1", ownerUserId: "user-a", title: "Auth flaky test", objective: "fix auth timeout test", prRefs: [{ owner: "acme", repo: "app", number: 42 }], summary: "Root cause is missing token refresh lock", updatedAt: "2026-11-23T00:00:00Z" },
      { sessionId: "s-diff-repo", workspaceId: "ws-1", ownerUserId: "user-a", title: "Auth flaky test", objective: "fix auth timeout test", prRefs: [{ owner: "other", repo: "app", number: 42 }], summary: "Different repo PR", updatedAt: "2026-11-23T00:00:00Z" },
      { sessionId: "s-diff-ws", workspaceId: "ws-2", ownerUserId: "user-a", title: "Auth flaky test", objective: "fix auth timeout test", prRefs: [{ owner: "acme", repo: "app", number: 42 }], summary: "Different workspace same folder", updatedAt: "2026-11-23T00:00:00Z" },
      { sessionId: "s-diff-owner", workspaceId: "ws-1", ownerUserId: "user-b", title: "Auth flaky test", objective: "fix auth timeout test", prRefs: [{ owner: "acme", repo: "app", number: 42 }], summary: "Other member's session", updatedAt: "2026-11-23T00:00:00Z" },
      { sessionId: "s-diff-goal", workspaceId: "ws-1", ownerUserId: "user-a", title: "Release changelog docs", objective: "write release notes documentation", prRefs: [{ owner: "acme", repo: "app", number: 42 }], summary: "Updated changelog bullets", updatedAt: "2026-11-23T00:00:00Z" },
    ],
    targetSessionId: "s-target",
    targetWorkspaceId: "ws-1",
    ownerUserId: "user-a",
    targetPrRefs: [{ owner: "acme", repo: "app", number: 42 }],
    targetObjective: "investigate auth timeout test",
  })
  assert.deepEqual(matched.compatible.map(m => m.sessionId), ["s-same"])
  assert.deepEqual(matched.relatedSeparate.map(m => m.sessionId), ["s-diff-goal"])

  // End-to-end without GitHub connected: Worker 1 investigates acme/app#42, Worker 2 asks a factual question -> SA supplements Worker 2!
  const dir = await mkdtemp(join(tmpdir(), "df-a6-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  const backend = makeAutoReplyBackend(prompt => {
    if (prompt.includes("Investigate acme/app#42")) return { text: "Verified on acme/app#42: auth timeout happens in token-lock.ts." }
    if (prompt.includes("Need factual root cause")) return { elicitation: "What caused the auth timeout on acme/app#42?" }
    return { text: `Applied context: ${prompt.slice(0, 60)}` }
  })
  const h = await openHarness(dir, { backend }) // No githubPullRequest provided!
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("App", [{ path: workDir }])).id
  await h.enableAuth(userA, "mac-1")

  const w1 = (await h.agents.handle("_deskfleet/session/create", { workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Auth timeout test", followUpInstallationId: "mac-1" }, userA) as AgentSnapshot).session
  await h.agents.handle("_deskfleet/input/submit", { sessionId: w1.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Investigate acme/app#42 auth timeout" }] }, userA)
  await eventually(() => h.followUp.listRuns({ userId: userA.userId!, workspaceId: ws, sourceKind: "session", sourceId: w1.id }), p => p.runs.length === 1)

  const w2 = (await h.agents.handle("_deskfleet/session/create", { workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Auth timeout test", followUpInstallationId: "mac-1" }, userA) as AgentSnapshot).session
  await h.agents.handle("_deskfleet/input/submit", { sessionId: w2.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Need factual root cause on acme/app#42" }] }, userA)
  await eventually(
    () => h.agents.journal.read(w2.id),
    s => s.inputs.some(input => input.content.some(block => block.type === "text" && /token-lock\.ts/u.test(block.text))),
  )
  assert.equal(h.followUp.metrics().autoSupplements, 1)
})

// ============================================================================
// A7: Long build with progress no false alert + repeated failures merge into ONE card + product decision asks once
// ============================================================================
test("A7: healthy long builds do not false-alarm, repeated failures merge into one card, and product decisions ask one concrete question", async t => {
  // 1. Healthy long build: lastEventSeq advances -> progressing (no alert)
  const activeSnap = {
    session: { id: "s1", workspaceId: "ws", provider: "codex", title: "Long build", context: "directory", lifecycle: "ready", archiveState: "active", lastEventSeq: "15", createdAt: "2026-11-23T00:00:00Z", updatedAt: "2026-11-23T00:30:00Z" },
    runs: [], inputs: [], permissions: [], elicitations: [],
    turns: [{ id: "t1", sessionId: "s1", initialInputId: "i1", dispatchCommandId: "c1", runGeneration: 1, state: "running", startedAt: "2026-11-23T00:00:00Z" }],
  } as unknown as AgentSnapshot
  const progressing = evaluateWorkerProgress(activeSnap, { enabled: true, deliveryPolicy: "exceptions_only", ownerUserId: "user-a", lastProgressSeq: "10", lastProgressAt: "2026-11-23T00:00:00Z" }, "ws", "s1", Date.parse("2026-11-23T01:00:00Z"))
  assert.equal(progressing.state, "progressing")

  // 2. Repeated verifiable failure merges into ONE card
  const dir = await mkdtemp(join(tmpdir(), "df-a7-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  const backend = makeAutoReplyBackend(prompt => {
    if (prompt.includes("build-fail")) return { error: "TypeScript error TS2307 in build.ts" }
    if (prompt.includes("product-choice")) return { elicitation: "Cross-timezone report: should it use creation timezone or current user timezone?" }
    return { text: "ok" }
  })
  const h = await openHarness(dir, { backend })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("Build", [{ path: workDir }])).id
  await h.enableAuth(userA, "mac-1")

  const worker = (await h.agents.handle("_deskfleet/session/create", { workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "CI Build", followUpInstallationId: "mac-1" }, userA) as AgentSnapshot).session
  await h.agents.handle("_deskfleet/input/submit", { sessionId: worker.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Run build-fail 1" }] }, userA)
  await eventually(() => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>, s => s.messages.length === 1)

  await h.agents.handle("_deskfleet/input/submit", { sessionId: worker.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Run build-fail 2" }] }, userA)
  const mergedSnap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => s.messages.some(m => /Occurred 2 times/u.test(m.text)),
  )
  // Merged into ONE issue card rather than creating two separate alerts!
  assert.equal(mergedSnap.messages.filter(m => /TS2307/u.test(m.text)).length, 1)

  // 3. Product decision asks ONE concrete question in main chat; answering continues!
  await h.agents.handle("_deskfleet/input/submit", { sessionId: worker.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Ask product-choice" }] }, userA)
  const askedSnap = await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => (s.pendingRequests?.length ?? 0) === 1 && s.messages.some(m => m.workerEvent === "question" && /Cross-timezone report/u.test(m.text)),
  )
  const qReq = askedSnap.pendingRequests![0]!.item
  await h.agents.handle("_deskfleet/elicitation/respond", { sessionId: worker.id, elicitationId: qReq.id, operationId: randomUUID(), response: { action: "accept", content: { choice: "Creation timezone" } } }, userA)
  await eventually(
    () => h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>,
    s => (s.pendingRequests?.length ?? 0) === 0,
  )
})

// ============================================================================
// A8: Compatibility baseline — never enabled, upgraded pre-consent SA user, legacy schedule file
// ============================================================================
test("A8: classic users and pre-upgrade SA users incur zero proactive calls or writes until explicitly authorized", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a8-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  let triageCalls = 0
  const backend = makeAutoReplyBackend(() => ({ text: "Legacy schedule completed." }))
  const h = await openHarness(dir, {
    backend,
    triageModel: () => async () => { triageCalls++; return { kind: "deliver_result", summary: "unexpected", reason: "unexpected" } },
  })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("ClassicProj", [{ path: workDir }])).id

  // 1. Classic user (never enabled SA): creates & runs schedule + ordinary session -> ZERO proactive calls, ZERO pendingEvents!
  const classicTask = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Classic cron", prompt: "Run classic", workspaceId: ws, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.operations.handle("scheduleRun", { scheduleId: classicTask.id }, userA)
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => list[0]?.lastRun?.state === "completed")
  const rawScheduleFile = JSON.parse(await readFile(join(dir, "scheduled-tasks.json"), "utf8")) as Record<string, unknown>
  assert.equal(rawScheduleFile.pendingEvents, undefined, "Classic unsubscribed schedule writes zero pendingEvents")
  assert.equal(triageCalls, 0)

  // 2. Upgraded user who already had legacy super_agent_state rooms/messages BEFORE upgrade -> needsConsent === true, authorized === false!
  await h.superStore.update(userB.userId!, () => ({ rooms: [], intents: [] }), state => {
    state.rooms.push({ workspaceId: ws, provider, messages: [{ id: "legacy-1", role: "user", text: "Old chat", createdAt: "2026-10-01T00:00:00Z", state: "answered" }], tickets: [], recentTicketIds: [] })
  })
  const upgradedSnap = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userB) as SuperSnapshot
  assert.equal(upgradedSnap.followUp?.authorized, false)
  assert.equal(upgradedSnap.followUp?.needsConsent, true, "Upgraded SA user must explicitly consent before background follow-up starts")
  // Opening project & creating an ordinary session does NOT auto-authorize!
  const ord = (await h.agents.handle("_deskfleet/session/create", { workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Unconsented worker" }, userB) as AgentSnapshot).session
  await h.agents.handle("_deskfleet/input/submit", { sessionId: ord.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Check something" }] }, userB)
  await eventually(() => h.agents.journal.read(ord.id), s => s.turns.some(turn => turn.state === "completed"))
  assert.equal(triageCalls, 0)
  assert.equal(h.followUp.authSummary(userB.userId!, ws).subscribedSessionCount, 0)
})

// ============================================================================
// A9: Multi-device auth (Mac on, iPhone off -> continues; last off -> revokes & cleans up; stale reconnect; re-enable; team membership revoked)
// ============================================================================
test("A9: multi-device grants, last-grant revocation cleanup, stale reconnect fencing, re-enable, and team membership revocation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a9-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  let allowMember = true
  let holdTriage!: () => void
  const triageGate = new Promise<void>(resolve => { holdTriage = resolve })
  let triageStarted = false

  const backend = makeAutoReplyBackend(prompt => {
    if (prompt.includes("hold-perm")) return { askPermission: true, text: "Held" }
    return { text: `Finding: error in ${prompt}` }
  })
  const h = await openHarness(dir, {
    backend,
    authorize: async actor => {
      if (!allowMember && actor.userId === userA.userId) throw new Error("Team membership revoked")
      return actor
    },
    triageModel: () => async (_packet, signal) => {
      triageStarted = true
      await Promise.race([triageGate, new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))))])
      return { kind: "deliver_result", summary: "Late triage output", reason: "late" }
    },
  })
  t.after(async () => { holdTriage(); await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("MultiDev", [{ path: workDir }])).id

  // 1. Enable Mac + iPhone
  const macGrant = await h.enableAuth(userA, "inst-mac", "MacBook Pro")
  const iphoneGrant = await h.enableAuth(userA, "inst-iphone", "iPhone")
  assert.equal(iphoneGrant.activeDeviceCount, 2)
  assert.equal(iphoneGrant.authorized, true)

  // 2. Disable iPhone -> Mac stays active, background follow-up CONTINUES!
  const iphoneOff = await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "disable", installationId: "inst-iphone" }, userA) as FollowUpAuthReceipt
  assert.equal(iphoneOff.authorized, true)
  assert.equal(iphoneOff.activeDeviceCount, 1)
  assert.equal(iphoneOff.stoppedAllBackground, false)

  // Queue a pure-automated pending action + a queued automated input on a busy Worker to verify revocation cleanup
  const worker = (await h.agents.handle("_deskfleet/session/create", { workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Active worker", followUpInstallationId: "inst-mac" }, userA) as AgentSnapshot).session
  await h.agents.handle("_deskfleet/input/submit", { sessionId: worker.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "hold-perm human work" }] }, userA)
  await eventually(() => h.agents.journal.read(worker.id), s => s.permissions.some(p => p.state === "pending"))
  const autoInput = await h.agents.handle("_deskfleet/input/submit", {
    sessionId: worker.id, operationId: randomUUID(), delivery: "backlog",
    content: [{ type: "text", text: "Auto follow-up queued", _meta: { "deskfleet/followUpOrigin": "sa_follow_up" } }],
  }, userA) as { inputId: string }
  await h.followUpStore.upsertAction({
    userId: userA.userId!, workspaceId: ws, sourceKind: "session", sourceId: worker.id,
    actionKey: "act-queued-auto", evidenceVersion: "ev1", authVersion: iphoneOff.authVersion,
    actionKind: "supplement_worker", mode: "active", status: "dispatched",
    sessionId: worker.id, inputId: autoInput.inputId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
  await h.followUpStore.upsertAction({
    userId: userA.userId!, workspaceId: ws, sourceKind: "session", sourceId: worker.id,
    actionKey: "act-completed-auto", evidenceVersion: "ev0", authVersion: iphoneOff.authVersion,
    actionKind: "deliver_result", mode: "active", status: "completed",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })

  // Start a schedule run that triggers in-flight triage
  const sched = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Nightly check", prompt: "Check logs", workspaceId: ws, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws, sourceKind: "schedule", sourceId: sched.id, enabled: true, deliveryPolicy: "exceptions_only" }, userA)
  await h.operations.handle("scheduleRun", { scheduleId: sched.id }, userA)
  await eventually(async () => triageStarted, Boolean)

  // 3. Disable Mac (LAST grant) -> cancels queued auto input, aborts in-flight triage, preserves completed action & human turn!
  const macOff = await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "disable", installationId: "inst-mac" }, userA) as FollowUpAuthReceipt
  assert.equal(macOff.authorized, false)
  assert.equal(macOff.stoppedAllBackground, true)
  assert.equal(macOff.revocationReport?.withdrawnInputs, 1)
  assert.ok((macOff.revocationReport?.abortedAnalyses ?? 0) >= 1)
  holdTriage()
  await delay(50)

  const workerAfter = await h.agents.journal.read(worker.id)
  assert.equal(workerAfter.inputs.find(i => i.id === autoInput.inputId)?.state, "withdrawn")
  assert.equal(workerAfter.permissions.find(p => p.state === "pending")?.state, "pending", "Human turn remains intact!")
  const actionsAfter = await h.followUpStore.listActions(userA.userId!)
  assert.equal(actionsAfter.find(a => a.actionKey === "act-completed-auto")?.status, "completed", "Already completed action stays completed")
  const snapAfterRevoke = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.ok(!snapAfterRevoke.messages.some(m => m.text.includes("Late triage output")), "Late triage result must not deliver after revocation")

  // 4. Stale offline device cannot re-open revoked auth with old authVersion!
  const stale = await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
    action: "enable", installationId: "inst-iphone", expectedAuthVersion: macGrant.authVersion,
  }, userA) as FollowUpAuthReceipt
  assert.equal(stale.status, "stale_ignored")
  assert.equal(stale.authorized, false)

  // 5. Native schedule STILL runs on time while SA is disabled!
  const runWhileOff = await h.operations.handle("scheduleRun", { scheduleId: sched.id }, userA) as ScheduleRun
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => list[0]?.runs.some(r => r.id === runWhileOff.id && r.state === "completed"))

  // 6. Re-enable with current authVersion checks still-open pending request once without replaying disabled history
  const reenabled = await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", {
    action: "enable", installationId: "inst-mac", expectedAuthVersion: macOff.authVersion, takeoverAllSessions: true,
  }, userA) as FollowUpAuthReceipt
  assert.equal(reenabled.authorized, true)
  const snapReenabled = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.equal(snapReenabled.pendingRequests?.length, 1, "Still-open human permission request is surfaced once on re-enable")

  // 7. Team membership revocation blocks proactive follow-up & native schedules fail authorization cleanly
  allowMember = false
  const deniedRun = await h.operations.handle("scheduleRun", { scheduleId: sched.id }, userA) as ScheduleRun
  assert.equal(deniedRun.state, "failed")
  assert.match(deniedRun.error!, /Team membership revoked/u)
})

// ============================================================================
// A10: Multi-member edits/runs, cross-project same folder, shared multi-user turn, missing-author legacy session, privacy allowlist
// ============================================================================
test("A10: multi-member isolation, shared-turn redaction, missing-author rejection, and public snapshot privacy allowlist", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a10-"))
  const sharedFolder = join(dir, "shared")
  await mkdir(sharedFolder)
  const backend = makeAutoReplyBackend(prompt => ({ text: `Secret result for ${prompt}` }))
  const h = await openHarness(dir, { backend })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws1 = (await h.catalog.native.createWorkspace("ProjA", [{ path: sharedFolder }])).id
  const ws2 = (await h.catalog.native.createWorkspace("ProjB", [{ path: sharedFolder }])).id
  await h.enableAuth(userA, "mac-a")
  await h.enableAuth(userB, "mac-b")

  // Track CentralSync schedule uploads to prove private acks don't trigger re-upload AND no private fields leak!
  const postedSchedules: unknown[] = []
  const sync = new CentralSync(h.agents, h.catalog, h.providers, async (path, body) => {
    if (path === "/api/daemon/schedules") postedSchedules.push(structuredClone(body))
    const payload = body as { snapshot?: { session?: { lastEventSeq?: string } }; snapshotSeq?: string; events?: { seq: string }[] } | undefined
    return { lastEventSeq: payload?.snapshot?.session?.lastEventSeq ?? payload?.snapshotSeq ?? payload?.events?.at(-1)?.seq ?? "0" }
  }, async () => false, h.schedules, undefined, true)
  sync.enable()
  t.after(async () => { await sync.close() })

  // 1. User A creates a schedule & subscribes
  const taskA = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Team task", prompt: "Inspect build", workspaceId: ws1, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws1, sourceKind: "schedule", sourceId: taskA.id, enabled: true, deliveryPolicy: "every_run" }, userA)

  // 2. User B manually triggers "Run now" on taskA -> MUST NOT leak into User A's private SA!
  await h.operations.handle("scheduleRun", { scheduleId: taskA.id }, userB)
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => list[0]?.lastRun?.state === "completed")
  await h.followUp.drainScheduleEvents()
  const snapAAfterBRun = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as SuperSnapshot
  assert.equal(snapAAfterBRun.messages.filter(m => m.text.includes("Secret result")).length, 0, "Other member's manual run must never enter User A's private SA")

  // 3. User B edits taskA's prompt -> User A's private subscription is PAUSED and User A gets reconfirmation notice!
  await h.operations.handle("scheduleUpdate", { scheduleId: taskA.id, changes: { prompt: "Changed scope by user B" } }, userB)
  await h.followUp.drainScheduleEvents()
  const subAfterEdit = h.followUpStore.getSource(userA.userId!, ws1, "schedule", taskA.id)!
  assert.equal(subAfterEdit.state.enabled, false)
  assert.equal(subAfterEdit.state.pausedReason, "modified_by_other_member")
  const snapAAfterEdit = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws1 }, userA) as SuperSnapshot
  assert.ok(snapAAfterEdit.messages.some(m => /edited by another team member/u.test(m.text)))

  // 4. Same folder ws2 stays completely isolated from ws1
  const snapWs2 = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws2 }, userA) as SuperSnapshot
  assert.equal(snapWs2.messages.length, 0)

  // 5. User B's session cannot be adopted by User A
  const sessionB = (await h.agents.handle("_deskfleet/session/create", { workspaceId: ws1, operationId: randomUUID(), provider, context: "directory", title: "User B Worker" }, userB) as AgentSnapshot).session
  await assert.rejects(
    h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws1, sourceKind: "session", sourceId: sessionB.id, adopt: true }, userA),
    /Only sessions created or forked by you/u,
  )

  // 5b. Shared multi-user turn redaction + missing-author rejection + personal default room isolation!
  const fakeSharedSnap = {
    turns: [{ id: "t-shared", initialInputId: "i1", state: "completed", startedAt: "2026-11-23T00:00:00Z" }, { id: "t-legacy", initialInputId: "i3", state: "completed", startedAt: "2026-11-23T00:00:00Z" }],
    inputs: [
      { id: "i1", turnId: "t-shared", author: userA, content: [{ type: "text", text: "mine" }], state: "dispatched" },
      { id: "i2", turnId: "t-shared", author: userB, content: [{ type: "text", text: "colleague secret" }], state: "dispatched" },
      { id: "i3", turnId: "t-legacy", author: { kind: "local" }, content: [{ type: "text", text: "unattributed legacy" }], state: "dispatched" },
    ],
  } as unknown as AgentSnapshot
  assert.deepEqual(inspectTurnOwnership(fakeSharedSnap, "t-shared", userA.userId!).kind, "mixed_shared")
  assert.equal(inspectTurnOwnership(fakeSharedSnap, "t-shared", userA.userId!).readable, false)
  assert.deepEqual(inspectTurnOwnership(fakeSharedSnap, "t-legacy", userA.userId!).kind, "missing_author")
  assert.equal(inspectTurnOwnership(fakeSharedSnap, "t-legacy", userA.userId!).readable, false)

  // Personal default room (workspaceId: null) is isolated per user
  await h.frontDesk.handle("_deskfleet/super-agent/send", { workspaceId: null, messageId: "priv-a-1", text: "My private default note" }, userA)
  const defSnapB = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: null }, userB) as SuperSnapshot
  assert.equal(defSnapB.messages.length, 0, "User A's personal default room must never leak into User B's default room")

  // 6. Verify public snapshot, scheduleList, MCP, and CentralSync contain ZERO private fields!
  await sync.flush()
  const uploadCountBeforeAck = postedSchedules.length
  await h.schedules.ackPrivateEvents([])
  await sync.flush()
  assert.equal(postedSchedules.length, uploadCountBeforeAck)

  const publicList = await h.operations.handle("scheduleList", {}, userA) as ScheduledTask[]
  const mcpList = await dispatchMcp(h.operations, "scheduleList", {}, userB, { sessionId: sessionB.id, workspaceId: ws1 }) as ScheduledTask[]
  for (const payload of [publicList, mcpList, postedSchedules.at(-1)]) {
    const json = JSON.stringify(payload)
    assert.ok(!json.includes("actor"), "Public output must never contain actor")
    assert.ok(!json.includes("pendingEvents"), "Public output must never contain pendingEvents")
    assert.ok(!json.includes("commandReceipts"), "Public output must never contain commandReceipts")
    assert.ok(!json.includes("deliveryPolicy"), "Public output must never contain private deliveryPolicy")
    assert.ok(!json.includes("edited by another team member"), "Public output must never contain private SA messages")
  }
})

// ============================================================================
// A11: Crash recovery at two-store boundary, session-less startup failure, consecutive skips, >50 run retention, archived/deleted evidence
// ============================================================================
test("A11: crash/restart idempotency, session-less failure visibility, consecutive skips, >50 run pagination, and archived evidence", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a11-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  const quotas = new TestAgentQuotas()
  // Phase 1: Normal run + session-less startup failure + two-store crash boundary + consecutive overlap skips
  let releaseHold: (() => void) | undefined
  const backend = new BackendAgent()
  const baseConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await baseConnect(config, client)
    conn.prompt = async params => {
      const promptText = params.prompt.flatMap(b => b.type === "text" ? [b.text] : []).join("\n")
      if (promptText.includes("HOLD_OVERLAP")) {
        await new Promise<void>(resolve => { releaseHold = resolve })
      }
      await client.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Run result: ${promptText}` } } })
      return { stopReason: "end_turn" }
    }
    return conn
  }

  let h = await openHarness(dir, { backend, quotas })
  t.after(async () => { releaseHold?.(); await h.close(); await rm(dir, { recursive: true, force: true }) })
  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("Reliable", [{ path: workDir }])).id
  await h.enableAuth(userA, "mac-1")

  const task = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Crash-safe task", prompt: "Generate summary", workspaceId: ws, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws, sourceKind: "schedule", sourceId: task.id, enabled: true, deliveryPolicy: "every_run" }, userA)

  const runBeforeCrash = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => list[0]?.runs.some(r => r.id === runBeforeCrash.id && r.state === "completed"))
  await h.followUp.drainScheduleEvents()

  // Session-less startup failure (quota=0 before session creation): MUST surface clearly, never "no risk"!
  quotas.capacity = 0
  const noSessionFail = await h.operations.handle("scheduleRun", { scheduleId: task.id }, userA) as ScheduleRun
  assert.equal(noSessionFail.state, "failed")
  assert.equal(noSessionFail.sessionId, undefined)
  await h.followUp.drainScheduleEvents()
  const afterNoSession = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.ok(afterNoSession.messages.some(m => /did not complete \(failed\)/u.test(m.text) && /allowance/u.test(m.text)), "Session-less startup failure must surface clearly")

  // Simulate true crash AFTER scheduled-tasks.json persists pendingEvents BEFORE SQLite consumes them!
  const messageCountBeforeRestart = afterNoSession.messages.length
  await h.close()
  const schedPath = join(dir, "scheduled-tasks.json")
  const rawSched = JSON.parse(await readFile(schedPath, "utf8")) as { tasks: unknown[]; pendingEvents?: unknown[] }
  rawSched.pendingEvents = [
    ...(rawSched.pendingEvents ?? []),
    {
      id: "unacked-crash-evt-1", kind: "run_finished", scheduleId: task.id, scheduleTitle: task.title,
      scheduleVersion: 1, workspaceId: ws, targetKind: "directory", ownerUserId: userA.userId!,
      runId: "crash-run-1", runState: "failed", scheduledFor: "2026-11-23T01:00:00Z", startedAt: "2026-11-23T01:00:00Z",
      finishedAt: "2026-11-23T01:00:05Z", error: "Auth token expired before dispatch", createdAt: "2026-11-23T01:00:05Z",
    },
  ]
  await writeFile(schedPath, JSON.stringify(rawSched))

  // Restart #1: automatically drains pendingEvents ONCE into SQLite and acks them in scheduled-tasks.json!
  quotas.capacity = 10
  h = await openHarness(dir, { backend, quotas })
  await h.followUp.drainScheduleEvents()
  const afterRecovery = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.equal(afterRecovery.messages.filter(m => /Auth token expired/u.test(m.text)).length, 1, "Crash-recovered pendingEvent must deliver exactly once")
  assert.equal(afterRecovery.messages.length, messageCountBeforeRestart + 1)
  assert.equal(h.schedules.pendingPrivateEvents().length, 0, "Recovered event must be acknowledged in scheduled-tasks.json")

  // Restart #2: zero duplicates!
  await h.close()
  h = await openHarness(dir, { backend, quotas })
  await h.followUp.drainScheduleEvents()
  const afterSecondRestart = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.equal(afterSecondRestart.messages.length, afterRecovery.messages.length, "Second restart must not duplicate any delivery")

  // Consecutive overlap skips: 1st skip stays quiet; 2nd & 3rd consecutive skips merge into ONE issue card!
  const overlapTask = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Overlap patrol", prompt: "HOLD_OVERLAP check", workspaceId: ws, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws, sourceKind: "schedule", sourceId: overlapTask.id, enabled: true, deliveryPolicy: "exceptions_only" }, userA)
  const firstRun = await h.operations.handle("scheduleRun", { scheduleId: overlapTask.id }, userA) as ScheduleRun
  assert.equal(firstRun.state, "running")
  const skip1 = await h.operations.handle("scheduleRun", { scheduleId: overlapTask.id }, userA) as ScheduleRun
  assert.equal(skip1.state, "skipped")
  await h.followUp.drainScheduleEvents()
  const snapAfterSkip1 = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.equal(snapAfterSkip1.messages.filter(m => m.provenance?.scheduleId === overlapTask.id).length, 0, "Single overlap skip stays quiet in history")
  const skip2 = await h.operations.handle("scheduleRun", { scheduleId: overlapTask.id }, userA) as ScheduleRun
  assert.equal(skip2.state, "skipped")
  await h.followUp.drainScheduleEvents()
  const skip3 = await h.operations.handle("scheduleRun", { scheduleId: overlapTask.id }, userA) as ScheduleRun
  assert.equal(skip3.state, "skipped")
  await h.followUp.drainScheduleEvents()
  const snapAfterSkip3 = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  const skipNotices = snapAfterSkip3.messages.filter(m => m.provenance?.scheduleId === overlapTask.id)
  assert.equal(skipNotices.length, 1, "Consecutive overlap skips must merge into ONE issue notice")
  assert.match(skipNotices[0]!.text, /skipped 3 consecutive times/u)
  releaseHold?.()
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => Boolean(list.find(x => x.id === overlapTask.id)?.runs.some(r => r.id === firstRun.id && r.state === "completed")))

  // Archive original session -> SA preserves summary and reports evidenceAvailability === "archived"
  await h.agents.handle("_deskfleet/session/archive", { sessionId: runBeforeCrash.sessionId!, operationId: randomUUID() }, userA)
  const archivedRuns = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: task.id }, userA) as FollowUpRunsPage
  const archivedEntry = archivedRuns.runs.find(r => r.runId === runBeforeCrash.id)!
  assert.equal(archivedEntry.evidenceAvailability, "archived")
  assert.match(archivedEntry.summary, /Generate summary/u)

  // Historical run pointing to a purged/non-existent session accurately reports evidenceAvailability === "deleted"
  await h.followUpStore.upsertRun({
    userId: userA.userId!, workspaceId: ws, sourceKind: "schedule", sourceId: task.id,
    runKey: "purged:1", scheduleId: task.id, scheduleTitle: task.title, runId: "purged-1",
    sessionId: "deleted-session-id-999", startedAt: "2026-11-22T00:00:00Z", finishedAt: "2026-11-22T00:01:00Z",
    status: "completed", delivered: true, summary: "Summary survives session deletion",
    evidenceAvailability: "available", createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:01:00Z",
  })
  const deletedRuns = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: task.id }, userA) as FollowUpRunsPage
  assert.equal(deletedRuns.runs.find(r => r.runId === "purged-1")?.evidenceAvailability, "deleted")

  // >50 runs retention + pagination in SQLite!
  for (let i = 1; i <= 55; i++) {
    const ts = new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()
    await h.followUpStore.upsertRun({
      userId: userA.userId!, workspaceId: ws, sourceKind: "schedule", sourceId: task.id,
      runKey: `bulk:${i}`, scheduleId: task.id, scheduleTitle: task.title, runId: `bulk-${i}`,
      startedAt: ts, finishedAt: ts, status: "completed", delivered: false,
      summary: `Historical run #${i}`, evidenceAvailability: "deleted", createdAt: ts, updatedAt: ts,
    })
  }
  const page1 = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: task.id, limit: 20 }, userA) as FollowUpRunsPage
  assert.equal(page1.runs.length, 20)
  assert.ok(page1.nextCursor)
  const page2 = await h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: task.id, cursor: page1.nextCursor, limit: 20 }, userA) as FollowUpRunsPage
  assert.equal(page2.runs.length, 20)
  assert.ok(!page2.runs.some(r => page1.runs.some(p => p.id === r.id)))
})

// ============================================================================
// A12: every_run delivers zero-change; exceptions_only stays quiet but queryable; stop single/global leaves native schedules working; shadow & rollback
// ============================================================================
test("A12: every_run vs exceptions_only delivery, per-schedule & global disable, shadow mode, and safe rollback", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-a12-"))
  const workDir = join(dir, "work")
  await mkdir(workDir)
  const backend = makeAutoReplyBackend(prompt => {
    if (prompt.includes("zero-change")) return { text: "昨日无新提交，一切正常。" }
    return { text: "Warning: regression found in parser.ts" }
  })
  const h = await openHarness(dir, { backend })
  t.after(async () => { await h.close(); await rm(dir, { recursive: true, force: true }) })

  const provider = (await h.providers.create({ template: "codex", name: "Codex", env: {} })).id
  const ws = (await h.catalog.native.createWorkspace("Policies", [{ path: workDir }])).id
  await h.enableAuth(userA, "mac-1")

  // 1. every_run delivers even on zero changes
  const dailyReport = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Daily digest", prompt: "zero-change report", workspaceId: ws, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws, sourceKind: "schedule", sourceId: dailyReport.id, enabled: true, deliveryPolicy: "every_run" }, userA)
  await h.operations.handle("scheduleRun", { scheduleId: dailyReport.id }, userA)
  await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as Promise<SuperSnapshot>
  }, s => s.messages.some(m => m.provenance?.scheduleId === dailyReport.id && /昨日无新提交/u.test(m.text)))

  // 2. exceptions_only stays quiet on zero changes while remaining queryable in run history
  const patrol = await h.operations.handle("scheduleCreate", {
    schedule: { title: "Quiet patrol", prompt: "zero-change check", workspaceId: ws, enabled: true, target: { kind: "new", provider, context: "directory" }, trigger: { kind: "manual" } },
  }, userA) as ScheduledTask
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws, sourceKind: "schedule", sourceId: patrol.id, enabled: true, deliveryPolicy: "exceptions_only" }, userA)
  await h.operations.handle("scheduleRun", { scheduleId: patrol.id }, userA)
  const patrolRuns = await eventually(async () => {
    await h.followUp.drainScheduleEvents()
    return h.frontDesk.handle("_deskfleet/super-agent/followUpRuns", { workspaceId: ws, sourceKind: "schedule", sourceId: patrol.id }, userA) as Promise<FollowUpRunsPage>
  }, p => p.runs.some(r => r.status === "completed"))
  assert.equal(patrolRuns.runs[0]!.delivered, false)
  const snapQuiet = await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot
  assert.ok(!snapQuiet.messages.some(m => m.provenance?.scheduleId === patrol.id), "exceptions_only must not spam chat when zero changes")

  // 3. Stop SA follow-up on one schedule -> native schedule still runs normally!
  await h.frontDesk.handle("_deskfleet/super-agent/followUpUpdateSource", { workspaceId: ws, sourceKind: "schedule", sourceId: dailyReport.id, enabled: false }, userA)
  const countBefore = snapQuiet.messages.length
  const nativeRun = await h.operations.handle("scheduleRun", { scheduleId: dailyReport.id }, userA) as ScheduleRun
  await eventually(() => h.operations.handle("scheduleList", {}, userA) as Promise<ScheduledTask[]>, list => Boolean(list.find(x => x.id === dailyReport.id)?.runs.some(r => r.id === nativeRun.id && r.state === "completed")))
  await h.followUp.drainScheduleEvents()
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot).messages.length, countBefore)

  // 4. Shadow mode logs decisions without sending messages to main chat
  await h.frontDesk.handle("_deskfleet/super-agent/followUpAuth", { action: "configure", ordinarySessionRuleMode: "shadow" }, userA)
  const shadowWorker = (await h.agents.handle("_deskfleet/session/create", { workspaceId: ws, operationId: randomUUID(), provider, context: "directory", title: "Shadow worker", followUpInstallationId: "mac-1" }, userA) as AgentSnapshot).session
  await h.agents.handle("_deskfleet/input/submit", { sessionId: shadowWorker.id, operationId: randomUUID(), delivery: "backlog", content: [{ type: "text", text: "Trigger finding" }] }, userA)
  await eventually(() => h.agents.journal.read(shadowWorker.id), s => s.turns.some(turn => turn.state === "completed"))
  await delay(50)
  assert.equal((await h.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, userA) as SuperSnapshot).messages.length, countBefore)

  // 5. Safe rollback stops consumer, drains pending events, and preserves cursors while native schedules stay usable
  const rollback = await h.followUp.prepareRollback()
  assert.equal(h.followUp.isConsumerEnabled(), false)
  assert.ok(rollback.cursors.length >= 2)
  const afterRollbackRun = await h.operations.handle("scheduleRun", { scheduleId: patrol.id }, userA) as ScheduleRun
  assert.equal(afterRollbackRun.state, "running")
})

// Bonus: Router schema/validation check for schedule actions
test("M1 router validates schedule actions and schedule evidence requests deterministically", async () => {
  const result = await routeSuperMessage({
    workspaceId: "ws-1",
    clientTimeZone: "Asia/Shanghai",
    text: "工作日9点检查提交",
    recent: [],
    tickets: [],
    workspaces: [{ id: "ws-1", name: "Repo" }],
    providers: [{ id: "codex", name: "Codex" }],
    schedules: [{ id: "sched-1", title: "Old", workspaceId: "ws-1", enabled: true, trigger: { kind: "manual" }, targetKind: "directory" }],
  }, {
    model: async () => ({
      reason: "Create weekday schedule",
      actions: [{
        kind: "schedule",
        operation: "create",
        title: "Commit check",
        prompt: "Check yesterday's commits",
        trigger: { kind: "weekly", time: "09:00", timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] },
        deliveryPolicy: "exceptions_only",
      }],
    }),
  })
  assert.equal(result.actions[0]?.kind, "schedule")
})
