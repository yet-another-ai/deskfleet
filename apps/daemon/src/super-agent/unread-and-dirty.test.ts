import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { isSaSummaryUnread, type SuperFeedbackPush, type SuperMachineSummary, type SuperWorkspaceSummary } from "@deskfleet/protocol/super-agent"
import { BackendAgent } from "../../../../scripts/fixtures/backend-agent.ts"
import { AgentSessions } from "../agent/sessions.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import { AgentProviders } from "../providers/providers.ts"
import { TestAgentQuotas } from "../fixtures/agent-quotas.ts"
import { eventually, makeAcpToolBackend, openHarness } from "../fixtures/follow-up-harness.ts"
import { SuperAgentService, type SuperUserState } from "./service.ts"
import { LocalSuperStore } from "./store.ts"
import { superWorkspaces } from "./workspaces.ts"
import { AgentChannel } from "../agent/channel.ts"
import type { SuperRouteResult } from "./router.ts"

const alice: AgentActor = { kind: "user", userId: "alice", deviceId: "dev-1" }

async function openServiceEnv(options: {
  backend?: BackendAgent
  model?: () => Promise<SuperRouteResult>
  stopUnconfirmedMs?: number
  onCoordinatorOptions?: () => void
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "deskfleet-sa-unread-"))
  const projectDir = join(dir, "project-a")
  await mkdir(projectDir, { recursive: true })
  const catalog = new DaemonCatalog(dir)
  await catalog.init()
  const ws = await catalog.native.createWorkspace("Project A", [{ path: projectDir }])
  const backend = options.backend ?? new BackendAgent()
  const providers = new AgentProviders(dir, backend)
  await providers.init()
  const primaryProvider = await providers.create({ template: "codex", name: "Codex", env: {} })
  const agents = new AgentSessions(catalog, catalog.native, backend, providers, undefined, undefined, new TestAgentQuotas())
  await agents.init()
  const store = new LocalSuperStore<SuperUserState>(catalog.native)
  await store.init()
  const helpers = superWorkspaces(catalog, dir)
  const makeService = () => new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "machine-1" }),
    defaultCoordinator: primaryProvider.id,
    coordinatorOptions: async () => {
      options.onCoordinatorOptions?.()
      return { models: [], defaultReasoningEfforts: [] }
    },
    coordinatorModel: () => options.model ?? (async () => ({ reason: "direct", actions: [{ kind: "answer", text: "Direct SA reply." }] })),
    agents,
    store,
    authorize: async actor => actor,
    providers: () => [primaryProvider],
    stopUnconfirmedMs: options.stopUnconfirmedMs,
    ...helpers,
  })
  const service = makeService()
  await service.init()
  return {
    dir,
    workspaceId: ws.id,
    catalog,
    agents,
    store,
    service,
    makeService,
    async close() {
      await service.close()
      await agents.close()
      await catalog.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test("summary & markRead: lightweight read-only RPC tracks SA visible replies, deduplicates delegated Worker results, and never mutates Worker lastReadSeq", async () => {
  let coordinatorOptionsCalls = 0
  let nextRoute: SuperRouteResult = { reason: "direct", actions: [{ kind: "answer", text: "Direct answer 1" }] }
  const env = await openServiceEnv({
    backend: makeAcpToolBackend(() => ({ text: "Worker completed task." })),
    model: async () => nextRoute,
    onCoordinatorOptions: () => { coordinatorOptionsCalls++ },
  })
  try {
    // Send direct SA reply
    await env.service.handle("_deskfleet/super-agent/send", { workspaceId: env.workspaceId, messageId: "m-direct", text: "Status?" }, alice)
    const afterDirect = await eventually(
      () => env.service.handle("_deskfleet/super-agent/snapshot", { workspaceId: env.workspaceId }, alice),
      snap => snap.messages.some(m => m.role === "assistant" && m.text === "Direct answer 1"),
    )
    assert.ok(afterDirect.messages.find(m => m.role === "assistant")?.visibleSeq)

    // Summary must be lightweight: zero coordinatorOptions calls and zero journal.history calls
    coordinatorOptionsCalls = 0
    let historyCalls = 0
    const origHistory = env.agents.journal.history.bind(env.agents.journal)
    env.agents.journal.history = async (...args) => { historyCalls++; return origHistory(...args) }

    const summary1 = await env.service.handle("_deskfleet/super-agent/summary", {}, alice)
    assert.equal(coordinatorOptionsCalls, 0, "summary must not invoke coordinatorOptions")
    assert.equal(historyCalls, 0, "summary must not read Worker journal history")
    const ws1 = summary1.workspaces.find(w => w.workspaceId === env.workspaceId)!
    assert.ok(ws1.latestVisible, "direct reply must produce latestVisible marker")
    assert.equal(isSaSummaryUnread(ws1.latestVisible, ws1.lastRead), true)

    // Dispatch to a Worker so a delegated result is delivered into SA
    nextRoute = {
      reason: "delegate",
      actions: [{ kind: "create", title: "Run task", scope: "Run task", prompt: "Do work" }],
    }
    await env.service.handle("_deskfleet/super-agent/send", { workspaceId: env.workspaceId, messageId: "m-work", text: "Do work" }, alice)
    const afterWork = await eventually(
      () => env.service.handle("_deskfleet/super-agent/snapshot", { workspaceId: env.workspaceId }, alice),
      snap => snap.messages.some(m => m.role === "worker" && m.workerEvent === "result"),
    )
    const workerSessionId = afterWork.tickets[0]!.sessionId!
    const workerSnap = await env.agents.journal.read(workerSessionId)
    assert.ok(workerSnap.session.lastCompletedSeq)
    assert.equal(workerSnap.session.lastReadSeq ?? "0", "0", "Worker session starts unread")

    const summary2 = await env.service.handle("_deskfleet/super-agent/summary", {}, alice)
    const ws2 = summary2.workspaces.find(w => w.workspaceId === env.workspaceId)!
    assert.equal(ws2.delegatedCompletedSeqs[workerSessionId], workerSnap.session.lastCompletedSeq, "summary carries exact delegated Worker completion seq")
    assert.equal(afterWork.delegatedCompletedSeqs?.[workerSessionId], workerSnap.session.lastCompletedSeq)

    // Mark SA visible marker read -> clears SA unread WITHOUT touching Worker lastReadSeq!
    const marked = await env.service.handle("_deskfleet/super-agent/markRead", {
      workspaceId: env.workspaceId,
      key: ws2.latestVisible!.key,
      order: ws2.latestVisible!.order,
      messageId: ws2.latestVisible!.messageId,
    }, alice)
    assert.equal(isSaSummaryUnread(marked.latestVisible, marked.lastRead), false)
    const workerAfterMark = await env.agents.journal.read(workerSessionId)
    assert.equal(workerAfterMark.session.lastReadSeq ?? "0", "0", "SA markRead must never modify Worker lastReadSeq")

    // Verify AgentChannel exposes summary and markRead RPCs cleanly
    const sentFrames: Record<string, unknown>[] = []
    const channel = new AgentChannel(
      {
        journal: env.agents.journal,
        handle: env.agents.handle.bind(env.agents),
        onEvent: env.agents.onEvent.bind(env.agents),
        superAgent: env.service.handle.bind(env.service),
        superAgentFeedback: env.service.subscribeFeedback.bind(env.service),
      },
      alice,
      async data => { sentFrames.push(JSON.parse(Buffer.from(data).toString("utf8"))) },
      error => { throw error },
    )
    channel.receive(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`))
    await eventually(async () => sentFrames.some(f => f.id === 1), Boolean)
    channel.receive(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "_deskfleet/super-agent/summary", params: {} })}\n`))
    await eventually(async () => sentFrames.some(f => f.id === 2), Boolean)
    const summaryFrame = sentFrames.find(f => f.id === 2) as { result?: SuperMachineSummary }
    assert.ok(summaryFrame.result?.workspaces.some(w => w.workspaceId === env.workspaceId))
    channel.receive(Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "_deskfleet/super-agent/markRead",
      params: { workspaceId: env.workspaceId, key: ws2.latestVisible!.key, order: ws2.latestVisible!.order, messageId: ws2.latestVisible!.messageId },
    })}\n`))
    await eventually(async () => sentFrames.some(f => f.id === 3), Boolean)
    const markFrame = sentFrames.find(f => f.id === 3) as { result?: SuperWorkspaceSummary }
    assert.equal(markFrame.result?.workspaceId, env.workspaceId)
    channel.close()
  } finally {
    await env.close()
  }
})

test("snapshot_dirty emits after state settles on routing failure, dispatch failure, stop confirmation, stop timeout, queue tail settle, and background follow-up report", async () => {
  // Part 1: Routing failure, dispatch failure, stop confirmation, stop timeout, and queue tail completion
  let routeBehavior: "fail" | "dispatch_fail" | "slow_worker" = "fail"
  let failDispatchSubmit = false
  let releaseCancel: (() => void) | undefined
  let releaseHungCancel: (() => void) | undefined
  let hangCancel = false
  const backend = new BackendAgent()
  const origConnect = backend.connect.bind(backend)
  backend.connect = async (config, client) => {
    const conn = await origConnect(config, client)
    return {
      ...conn,
      prompt: async params => {
        if (routeBehavior === "slow_worker") {
          await new Promise<void>(resolve => {
            releaseCancel = resolve
          })
          return { stopReason: "cancelled" }
        }
        return conn.prompt(params)
      },
      cancel: async params => {
        if (hangCancel) {
          await new Promise<void>(resolve => { releaseHungCancel = resolve })
        }
        releaseCancel?.()
        return conn.cancel(params)
      },
    }
  }

  const env = await openServiceEnv({
    backend,
    stopUnconfirmedMs: 40,
    model: async () => {
      if (routeBehavior === "fail") throw new Error("Coordinator outage")
      if (routeBehavior === "dispatch_fail") {
        return { reason: "dispatch", actions: [{ kind: "create", title: "Dispatch fail task", scope: "Dispatch fail", prompt: "Run failing dispatch" }] }
      }
      return { reason: "dispatch", actions: [{ kind: "create", title: "Slow task", scope: "Slow task", prompt: "Wait" }] }
    },
  })

  try {
    const origHandle = env.agents.handle.bind(env.agents)
    env.agents.handle = (async (method: Parameters<typeof origHandle>[0], params: Parameters<typeof origHandle>[1], actor: Parameters<typeof origHandle>[2]) => {
      if (failDispatchSubmit && method === "_deskfleet/session/create") {
        throw new Error("Worker provisioning rejected")
      }
      return origHandle(method, params, actor)
    }) as typeof env.agents.handle

    const pushes: SuperFeedbackPush[] = []
    const sub = await env.service.subscribeFeedback({ workspaceId: env.workspaceId, afterCursor: 0 }, alice, push => pushes.push(push))

    // 1. Routing failure -> snapshot_dirty emitted AFTER message.state === "failed"
    pushes.length = 0
    await env.service.handle("_deskfleet/super-agent/send", { workspaceId: env.workspaceId, messageId: "m-route-fail", text: "Fail route" }, alice)
    await eventually(async () => {
      const hasDirty = pushes.some(p => p.event.type === "snapshot_dirty" && p.event.sourceMessageId === "m-route-fail")
      if (!hasDirty) return false
      const snap = await env.service.handle("_deskfleet/super-agent/snapshot", { workspaceId: env.workspaceId }, alice)
      const msg = snap.messages.find(m => m.id === "m-route-fail")
      return msg?.state === "failed" && msg.reason === "Coordinator outage"
    }, Boolean)
    const summaryAfterFail = await env.service.handle("_deskfleet/super-agent/summary", {}, alice)
    const wsAfterFail = summaryAfterFail.workspaces.find(w => w.workspaceId === env.workspaceId)!
    assert.equal(wsAfterFail.latestVisible?.messageId, "m-route-fail", "actionable routing failure produces SA unread marker")

    // 2. Dispatch failure -> snapshot_dirty emitted AFTER checkpoint commits failed/blocked state
    routeBehavior = "dispatch_fail"
    failDispatchSubmit = true
    pushes.length = 0
    await env.service.handle("_deskfleet/super-agent/send", { workspaceId: env.workspaceId, messageId: "m-dispatch-fail", text: "Fail dispatch" }, alice)
    await eventually(async () => {
      const dirtyCount = pushes.filter(p => p.event.type === "snapshot_dirty" && p.event.sourceMessageId === "m-dispatch-fail").length
      if (dirtyCount < 2) return false
      const snap = await env.service.handle("_deskfleet/super-agent/snapshot", { workspaceId: env.workspaceId }, alice)
      const msg = snap.messages.find(m => m.id === "m-dispatch-fail")
      const ticket = snap.tickets.find(t => t.title === "Dispatch fail task")
      return msg?.state === "failed" && ticket?.status === "blocked"
    }, Boolean)
    failDispatchSubmit = false

    // 3. Slow worker for stop timeout + stop confirmation
    routeBehavior = "slow_worker"
    pushes.length = 0
    await env.service.handle("_deskfleet/super-agent/send", { workspaceId: env.workspaceId, messageId: "m-slow", text: "Start slow" }, alice)
    await eventually(
      () => env.service.handle("_deskfleet/super-agent/snapshot", { workspaceId: env.workspaceId }, alice),
      snap => snap.tickets.some(t => t.title === "Slow task" && t.status === "working" && !!t.sessionId),
    )

    // 4. Stop timeout (stopUnconfirmedMs = 40ms) -> emits snapshot_dirty when visibleStopState becomes "unconfirmed"
    hangCancel = true
    pushes.length = 0
    await env.service.handle("_deskfleet/super-agent/stop", { workspaceId: env.workspaceId, messageId: "m-slow", revision: 0 }, alice)
    const dirtyBeforeTimeout = pushes.filter(p => p.event.type === "snapshot_dirty").length
    assert.ok(dirtyBeforeTimeout >= 1, "stop request emits initial snapshot_dirty")
    await eventually(async () => {
      const dirtyNow = pushes.filter(p => p.event.type === "snapshot_dirty").length
      if (dirtyNow <= dirtyBeforeTimeout) return false
      const snap = await env.service.handle("_deskfleet/super-agent/snapshot", { workspaceId: env.workspaceId }, alice)
      return snap.messages.some(m => m.sourceMessageId === "m-slow" && m.stopState === "unconfirmed")
    }, Boolean, 2_000)

    // 5. Stop confirmation -> settle cancelled turn & verify user stop does NOT create SA unread
    hangCancel = false
    const latestSummaryBeforeCancel = (await env.service.handle("_deskfleet/super-agent/summary", {}, alice))
      .workspaces.find(w => w.workspaceId === env.workspaceId)!.latestVisible
    pushes.length = 0
    releaseHungCancel?.()
    releaseCancel?.()
    await eventually(async () => {
      if (!pushes.some(p => p.event.type === "snapshot_dirty")) return false
      const snap = await env.service.handle("_deskfleet/super-agent/snapshot", { workspaceId: env.workspaceId }, alice)
      return snap.messages.some(m => m.role === "worker" && m.workerEvent === "result" && m.stopState === "stopped")
    }, Boolean)
    const latestSummaryAfterCancel = (await env.service.handle("_deskfleet/super-agent/summary", {}, alice))
      .workspaces.find(w => w.workspaceId === env.workspaceId)!.latestVisible
    assert.deepEqual(latestSummaryAfterCancel, latestSummaryBeforeCancel, "user-stopped turn must NOT produce SA unread")

    sub.unsubscribe()

    // 6. Queue tail completion -> when a ticket remains "queued" after its terminal event is already projected,
    // replay settles status and emits snapshot_dirty after commit
    await env.service.close()
    await env.store.update(alice.userId!, () => { throw new Error("missing user state") }, state => {
      const room = state.rooms.find(r => r.workspaceId === env.workspaceId)!
      const ticket = room.tickets.find(t => t.title === "Slow task")!
      ticket.status = "queued"
    })
    const service2 = env.makeService()
    const tailPushes: SuperFeedbackPush[] = []
    const tailSub = await service2.subscribeFeedback({ workspaceId: env.workspaceId, afterCursor: 0 }, alice, push => tailPushes.push(push))
    try {
      await service2.init()
      await eventually(async () => {
        if (!tailPushes.some(p => p.event.type === "snapshot_dirty")) return false
        const snap = await service2.handle("_deskfleet/super-agent/snapshot", { workspaceId: env.workspaceId }, alice)
        return snap.tickets.find(t => t.title === "Slow task")?.status === "stopped"
      }, Boolean)
    } finally {
      tailSub.unsubscribe()
      await service2.close()
    }
  } finally {
    releaseHungCancel?.()
    releaseCancel?.()
    await env.close()
  }

  // Part 2: Background follow-up report emits snapshot_dirty and creates SA unread marker
  const followDir = await mkdtemp(join(tmpdir(), "deskfleet-sa-followup-dirty-"))
  const projDir = join(followDir, "proj")
  await mkdir(projDir, { recursive: true })
  const harness = await openHarness(followDir, {
    backend: makeAcpToolBackend(() => ({ text: "Scheduled build failed with exit code 1." })),
  })
  try {
    const provider = await harness.providers.create({ template: "codex", name: "Codex", env: {} })
    const ws = await harness.catalog.native.createWorkspace("FollowUp Proj", [{ path: projDir }])
    await harness.enableAuth(alice, "install-1", { takeoverAllSessions: true })
    const pushes: SuperFeedbackPush[] = []
    const sub = await harness.frontDesk.subscribeFeedback({ workspaceId: ws.id, afterCursor: 0 }, alice, push => pushes.push(push))

    const created = await harness.schedules.handle("scheduleCreate", {
      schedule: {
        workspaceId: ws.id,
        title: "Nightly check",
        prompt: "Run nightly check",
        enabled: true,
        target: { kind: "new", provider: provider.id, context: "directory" },
        trigger: { kind: "manual" },
      },
    }, alice) as { id: string }

    pushes.length = 0
    await harness.schedules.handle("scheduleRun", { scheduleId: created.id }, alice)
    await eventually(async () => {
      const hasDirty = pushes.some(p => p.event.type === "snapshot_dirty")
      if (!hasDirty) return false
      const snap = await harness.frontDesk.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws.id }, alice)
      return snap.messages.some(m => m.provenance?.origin === "sa_follow_up")
    }, Boolean)

    const summary = await harness.frontDesk.handle("_deskfleet/super-agent/summary", {}, alice)
    const wsSummary = summary.workspaces.find(w => w.workspaceId === ws.id)!
    assert.ok(wsSummary.latestVisible, "background follow-up report must produce SA unread marker")
    assert.equal(isSaSummaryUnread(wsSummary.latestVisible, wsSummary.lastRead), true)

    sub.unsubscribe()
  } finally {
    await harness.close()
    await rm(followDir, { recursive: true, force: true })
  }
})
