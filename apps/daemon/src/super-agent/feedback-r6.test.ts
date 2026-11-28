import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import {
  applySnapshotFeedback,
  buildRequestFeedbackMap,
  createFeedbackState,
  mergeLoadedProcess,
  type FeedbackState,
} from "@deskfleet/client/workspace-feedback"
import type { AgentClient, AgentConfig, AgentConnection, AgentProvider } from "../acp/connection.ts"
import { AgentProviders } from "../providers/providers.ts"
import type { AgentActor, AgentCommand, AgentEvent, AgentInput, AgentReceipt, AgentSessionRecord } from "@deskfleet/protocol/agent"
import { AgentSessions } from "../agent/sessions.ts"
import { AgentJournal } from "../agent/store.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import { TestAgentQuotas } from "../fixtures/agent-quotas.ts"
import type { SuperFeedbackProcessResult, SuperMessage, SuperSnapshot } from "@deskfleet/protocol/super-agent"
import type { routeSuperMessage } from "./router.ts"
import { SuperAgentService } from "./service.ts"
import type { SuperStateStore, SuperUserState } from "./state.ts"
import { LocalSuperStore } from "./store.ts"
import type { SuperWorkers } from "./worker.ts"
import { superWorkspaces } from "./workspaces.ts"

const actor: AgentActor = { kind: "user", userId: "alice", deviceId: "mac-1" }
const now = () => new Date().toISOString()

function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`)
    await sleep(5)
  }
}

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${label}`)
    await sleep(10)
  }
}

function toolTitle(event: AgentEvent): string | undefined {
  if (event.kind !== "acp" || !("update" in event.payload)) return undefined
  const update = event.payload.update as unknown as Record<string, unknown>
  return update.sessionUpdate === "tool_call" && typeof update.title === "string" ? update.title : undefined
}

async function fullHistory(journal: SuperWorkers["journal"], sessionId: string): Promise<AgentEvent[]> {
  const all: AgentEvent[] = []
  let cursor = "0"
  for (;;) {
    const page = await journal.history(sessionId, cursor, 1000)
    if (!page.length) return all
    all.push(...page)
    if (page.at(-1)!.seq === cursor) return all
    cursor = page.at(-1)!.seq
  }
}

const texts = (result: SuperFeedbackProcessResult) => result.items.map(item => item.text)

// --- P2-32: real AgentSessions + agent runtime + SQLite journal -------------------------------------------------

/** ACP fixture whose single long turn is driven step by step by the test, with real steering support. */
class SteeringProvider implements AgentProvider {
  id = "codex"
  readonly providerSessionId = "p2-32-conversation"
  client?: AgentClient
  prompts: string[] = []
  steers: string[] = []
  #finish?: (result: acp.PromptResponse) => void

  async connect(_config: AgentConfig, client: AgentClient): Promise<AgentConnection> {
    this.client = client
    const text = (prompt: acp.ContentBlock[]) => prompt.map(block => block.type === "text" ? block.text : "").join("")
    return {
      initialization: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
        _meta: { steering: { supported: true, supportsPromptRequired: true } },
      },
      newSession: async () => ({ sessionId: this.providerSessionId, configOptions: [] }),
      resume: async () => ({ configOptions: [] }),
      setConfigOption: async () => ({ configOptions: [] }),
      prompt: async params => {
        this.prompts.push(text(params.prompt))
        const done = new Promise<acp.PromptResponse>(resolve => { this.#finish = resolve })
        await client.onUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "tc-stock-first", title: "最先的库存盘点", status: "completed" } as never,
        })
        return done
      },
      steer: async params => {
        this.steers.push(text(params.prompt))
        return { outcome: "injected" as const }
      },
      cancel: async () => { this.finish("cancelled") },
      close: async () => { this.finish("cancelled") },
    }
  }

  async emit(update: Record<string, unknown>): Promise<void> {
    await this.client!.onUpdate({ sessionId: this.providerSessionId, update: update as never })
  }

  finish(stopReason: acp.PromptResponse["stopReason"] = "end_turn"): void {
    const finish = this.#finish
    this.#finish = undefined
    finish?.({ stopReason })
  }
}

async function openHost(directory: string, provider: SteeringProvider, route: typeof routeSuperMessage) {
  const catalog = new DaemonCatalog(directory)
  await catalog.init()
  const store = new LocalSuperStore<SuperUserState>(catalog.native)
  await store.init()
  const providers = new AgentProviders(directory, provider)
  await providers.init()
  const workers = new AgentSessions(catalog, catalog.native, provider, providers, undefined, undefined, new TestAgentQuotas())
  await workers.init()
  const service = new SuperAgentService({
    registration: () => ({ teamId: "team", machineId: "machine" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => { throw new Error("The P2-32 fixture supplies its own route") },
    agents: workers, store, providers: () => providers.metadata().providers, ...superWorkspaces(catalog, directory),
    authorize: async who => who,
    route,
  })
  await service.init()
  return {
    catalog, store, providers, workers, service,
    async close() {
      try { await Promise.all([service.close(), workers.close()]); await store.close() } finally { await catalog.close() }
    },
  }
}

test("P2-32: activity emitted after the host accepted an appended steer but before the Worker received it stays on the original request, before and after host restart", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-p2-32-"))
  const project = join(directory, "project")
  await mkdir(project)
  const provider = new SteeringProvider()
  let routeStep = 0
  const route: typeof routeSuperMessage = async ctx => {
    routeStep++
    if (routeStep === 1) {
      return { reason: "stock", actions: [{ kind: "create", title: "库存 Worker", scope: "盘点库存", prompt: ctx.text, context: "directory" }] }
    }
    return { reason: "append bill check", actions: [{ kind: "continue", ticketId: ctx.tickets[0]!.id, delivery: "steer", prompt: ctx.text }] }
  }
  let host = await openHost(directory, provider, route)
  let steerGate: ReturnType<typeof gate> | undefined
  t.after(async () => {
    steerGate?.release()
    try { await host.close() } finally { await rm(directory, { recursive: true, force: true }) }
  })

  // Hold the host's preparation of the steered input: it is accepted and recorded, but the executor's steer has not received it.
  let heldSteers = 0
  const attachments = host.catalog.attachments
  const preparePrompt = attachments.preparePrompt.bind(attachments)
  attachments.preparePrompt = async (...args: Parameters<typeof preparePrompt>) => {
    const held = steerGate
    if (held) {
      heldSteers++
      await held.wait
    }
    return preparePrompt(...args)
  }

  const workspaceId = (await host.catalog.native.createWorkspace("P2-32", [{ path: project }])).id
  await host.providers.create({ template: "codex", name: "Fixture", env: {}, inheritShellEnvironment: false })
  const snap = () => host.service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor) as Promise<SuperSnapshot>
  const processOf = (sourceMessageId: string) =>
    host.service.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId, sourceMessageId }, actor) as Promise<SuperFeedbackProcessResult>
  const replayedThrough = (seq: string) => until(() => {
    const ticket = host.store.get("alice")?.rooms.find(room => room.workspaceId === workspaceId)?.tickets[0]
    return BigInt(ticket?.lastEventSeq ?? "0") >= BigInt(seq)
  }, `SA replay through seq ${seq}`)
  const committedTool = async (sessionId: string, title: string) => {
    await host.workers.journal.serial(sessionId, async () => {})
    return eventually(async () => (await fullHistory(host.workers.journal, sessionId)).find(event => toolTitle(event) === title), Boolean, `tool ${title} committed`) as Promise<AgentEvent>
  }

  // 1. Original 库存 request starts a real Worker turn, which runs its first inventory tool.
  await host.service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "req-stock-32", text: "盘点库存" }, actor)
  await until(() => provider.prompts.length === 1, "stock turn reached the Worker")
  const sessionId = (await eventually(snap, s => !!s.tickets[0]?.sessionId, "ticket bound to Worker")).tickets[0]!.sessionId!
  const running = await eventually(() => host.workers.journal.read(sessionId), s => s.turns[0]?.state === "running", "stock turn running")
  const turnId = running.turns[0]!.id
  const firstTool = await committedTool(sessionId, "最先的库存盘点")
  await replayedThrough(firstTool.seq)

  // 2. SA main chat appends 「核查账单」 into the running turn; the host records it, delivery to the Worker is held.
  steerGate = gate()
  await host.service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "req-bill-32", text: "核查账单" }, actor)
  await until(() => heldSteers === 1, "host accepted the appended input and paused before Worker delivery")
  const accepted = await host.workers.journal.read(sessionId)
  const billInput = accepted.inputs.find(input => input.requestedDelivery === "steer")
  assert.ok(billInput, "Host recorded the appended steer input")
  assert.equal(billInput.state, "dispatching", "Appended input is accepted but still being delivered")
  assert.deepEqual(provider.steers, [], "Worker steer has not received the appended input")

  // 3. During the wait, the ORIGINAL task emits a normal tool activity.
  await provider.emit({ sessionUpdate: "tool_call", toolCallId: "tc-stock-last", title: "库存盘点最后一批", status: "completed" })
  const waitingTool = await committedTool(sessionId, "库存盘点最后一批")
  assert.equal(waitingTool.turnId, turnId)
  assert.ok(BigInt(waitingTool.seq) > BigInt(billInput.acceptedSeq), `waiting activity seq ${waitingTool.seq} follows accepted seq ${billInput.acceptedSeq}`)
  // Live SA replay is not required here: the process query reconstructs from the Worker journal on demand.
  assert.deepEqual(provider.steers, [], "Still undelivered while the original task keeps working")
  assert.deepEqual(texts(await processOf("req-bill-32")), [], "While delivery is pending, original-task activity must not appear in the appended request")

  // 4. Release: the Worker receives the appended input and the host records delivery.
  steerGate.release()
  steerGate = undefined
  const delivered = await eventually(() => host.workers.journal.read(sessionId), s => s.inputs.find(input => input.id === billInput.id)?.state === "delivered", "appended input delivered")
  const deliveredInput = delivered.inputs.find(input => input.id === billInput.id)!
  assert.equal(deliveredInput.actualDelivery, "steer")
  assert.equal(deliveredInput.turnId, turnId)
  assert.equal(provider.steers.length, 1, "Worker received the appended input exactly once")
  const deliveryEvent = (await fullHistory(host.workers.journal, sessionId)).find(event =>
    event.kind === "input" && (event.payload as AgentInput).id === billInput.id && (event.payload as AgentInput).state === "delivered")
  assert.ok(deliveryEvent, "Delivery receipt is journaled")
  assert.ok(BigInt(deliveryEvent.seq) > BigInt(waitingTool.seq), "Delivery receipt follows the waiting-period activity")
  await replayedThrough(deliveryEvent.seq)
  assert.deepEqual(texts(await processOf("req-bill-32")), [], "The receipt alone adds no activity; the waiting-period stock batch is not the appended request's work")

  // 5. The Worker now does the appended work and finishes the shared turn.
  await provider.emit({ sessionUpdate: "tool_call", toolCallId: "tc-bill-appended", title: "补充的账单核对", status: "completed" })
  const billTool = await committedTool(sessionId, "补充的账单核对")
  assert.ok(BigInt(billTool.seq) > BigInt(deliveryEvent.seq))
  await provider.emit({
    sessionUpdate: "agent_message_chunk", messageId: "m-final-32",
    content: { type: "text", text: "库存盘点与账单核对均已完成。" }, _meta: { codex: { phase: "final_answer" } },
  })
  provider.finish()
  await eventually(snap, s => s.messages.some(m => m.workerEvent === "result" && m.turnId === turnId), "shared turn result")

  const assertAttribution = async (phase: string) => {
    const bill = await processOf("req-bill-32")
    assert.deepEqual(texts(bill), ["补充的账单核对"], `${phase}: appended 「核查账单」 shows only work after the Worker received it`)
    const stock = texts(await processOf("req-stock-32"))
    assert.ok(stock.includes("最先的库存盘点"), `${phase}: original request keeps its first inventory step, got ${JSON.stringify(stock)}`)
    assert.ok(stock.includes("库存盘点最后一批"), `${phase}: waiting-period activity belongs to the original request, got ${JSON.stringify(stock)}`)
    const index = (await snap()).feedback?.processes.find(p => p.sourceMessageId === "req-bill-32")
    assert.ok((index?.activityCount ?? 0) >= 1, `${phase}: appended request still offers View Process`)
  }

  await assertAttribution("before restart")

  // Restart the whole SA host on the same directory and replay from SQLite.
  await host.close()
  host = await openHost(directory, provider, route)
  await assertAttribution("after restart")

  // Legacy persisted branch without fromSeq: the journal's delivery receipt still decides attribution.
  await host.store.update("alice", () => assert.fail("missing SA state"), state => {
    const proc = state.rooms.find(room => room.workspaceId === workspaceId)!.feedbackProcesses!.find(p => p.sourceMessageId === "req-bill-32")!
    for (const branch of proc.branches) delete branch.fromSeq
  })
  await assertAttribution("after restart without persisted fromSeq")
})

// --- P2-28: same tool across a >20,000-event window ---------------------------------------------------------------

class MemoryStore implements SuperStateStore {
  data = new Map<string, SuperUserState>()
  get(uid: string) { return structuredClone(this.data.get(uid)) }
  users() { return [...this.data.keys()] }
  async update<T>(uid: string, init: () => SuperUserState, edit: (state: SuperUserState) => T) {
    const next = this.get(uid) || init()
    const result = edit(next)
    this.data.set(uid, next)
    return result
  }
}

async function createJournalHarness(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const catalog = new DaemonCatalog(dir)
  await catalog.init()
  const journal = new AgentJournal(catalog.native)
  await journal.init()
  const store = new MemoryStore()
  const ws = (await catalog.native.createWorkspace(prefix, [{ path: dir }])).id
  const workers: SuperWorkers = {
    async handle(method, args, who) {
      const a = args as Record<string, string>
      if (method === "_deskfleet/session/create") {
        const cmd: AgentCommand = { id: await journal.id(), operationId: a.operationId, workspaceId: a.workspaceId, method, params: a, actor: who, status: "accepted", isCanonical: true, receivedAt: now() }
        const created = await journal.create(cmd, a.workspaceId, a.title || "Worker", "directory", a.provider || "codex")
        const ready: AgentSessionRecord = {
          ...created, lifecycle: "ready", providerSessionId: `prov-${created.id}`, capabilities: { steering: true, resume: true }, updatedAt: now(),
        }
        await journal.commit(created, {
          command: { ...cmd, sessionId: created.id, status: "completed", completedAt: now() },
          session: ready,
          events: [journal.event(created.id, "session", ready)],
        })
        return journal.read(created.id)
      }
      if (method === "_deskfleet/input/submit") {
        const snap = await journal.read(a.sessionId)
        const commandId = await journal.id()
        const inputId = await journal.id()
        const input = {
          id: inputId, sessionId: a.sessionId, submissionCommandId: commandId, author: who,
          content: [{ type: "text" as const, text: a.text || "run" }],
          acceptedSeq: String(BigInt(snap.session.lastEventSeq) + 1n),
          state: "delivered" as const,
          requestedDelivery: "backlog" as const,
          createdAt: now(),
        }
        const cmd: AgentCommand = {
          id: commandId, operationId: a.operationId, sessionId: a.sessionId, method, params: a, actor: who,
          status: "completed", isCanonical: true, result: { operationId: a.operationId, sessionId: a.sessionId, commandId, inputId },
          receivedAt: now(), completedAt: now(),
        }
        await journal.commit(snap, { command: cmd, inputs: [input], events: [journal.event(a.sessionId, "input", input, { inputId })] })
        return cmd.result as AgentReceipt
      }
      throw new Error(`Unexpected worker RPC ${method}`)
    },
    onEvent: fn => journal.onEvent(fn),
    onPreview: fn => journal.onPreview(fn),
    preview: id => journal.preview(id),
    journal,
  }
  const createService = () => new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({}),
    agents: workers,
    store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [{ id: ws, name: prefix, roots: [dir] }],
    ensureDefaultWorkspace: async () => ws,
    authorize: async who => who,
    route: async ctx => ({ reason: "dispatch", actions: [{ kind: "create", title: "支付核对", scope: "Audit", prompt: ctx.text }] }),
  })
  const cleanup = async () => {
    await catalog.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, catalog, journal, store, ws, workers, createService, cleanup }
}

type JournalHarness = Awaited<ReturnType<typeof createJournalHarness>>

/** 核对支付账单 starts on page 1; only its untitled completion lands after 20,005 streamed chunks on the next page. */
async function seedCrossWindowTool(h: JournalHarness, service: SuperAgentService, reqId: string) {
  await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: reqId, text: "核对支付账单并记录对照样本" }, actor)
  await until(() => h.store.get("alice")?.intents.some(i => i.messageId === reqId && i.phase === "sent") === true, `${reqId} sent`)
  const intent = h.store.get("alice")!.intents.find(i => i.messageId === reqId)!
  const sessionId = intent.sessionId!
  const snap0 = await h.journal.read(sessionId)
  const prov = snap0.session.providerSessionId!
  const run = { sessionId, generation: 1, state: "running" as const, startedAt: now() }
  const turn = { id: await h.journal.id(), sessionId, runGeneration: 1, dispatchCommandId: snap0.inputs[0]!.submissionCommandId, initialInputId: intent.inputId!, startedAt: now(), state: "running" as const }
  await h.journal.commit(snap0, {
    runs: [run], turns: [turn],
    events: [h.journal.event(sessionId, "run", run, { runGeneration: 1 }), h.journal.event(sessionId, "turn", turn, { turnId: turn.id, inputId: intent.inputId })],
  })
  const acpEvent = (update: Record<string, unknown>) => h.journal.event(sessionId, "acp", { sessionId: prov, update: update as never }, { turnId: turn.id })
  const events: ReturnType<typeof h.journal.event>[] = [
    acpEvent({ sessionUpdate: "tool_call", toolCallId: "tc-pay", title: "核对支付账单", status: "in_progress" }),
    acpEvent({ sessionUpdate: "tool_call", toolCallId: "tc-sample", title: "记录对照样本", status: "completed" }),
  ]
  for (let i = 0; i < 20_005; i++) {
    events.push(acpEvent({ sessionUpdate: "agent_message_chunk", messageId: "m-long-28", content: { type: "text", text: "a" }, _meta: { codex: { phase: "commentary" } } }))
  }
  // Same tool completes on the next window with a status-only update (no title).
  events.push(acpEvent({ sessionUpdate: "tool_call_update", toolCallId: "tc-pay", status: "completed" }))
  events.push(acpEvent({ sessionUpdate: "agent_message_chunk", messageId: "m-final-28", content: { type: "text", text: "支付账单核对完成。" }, _meta: { codex: { phase: "final_answer" } } }))
  const turnDone = { ...turn, state: "completed" as const, endedAt: now() }
  events.push(h.journal.event(sessionId, "turn", turnDone, { turnId: turn.id, inputId: intent.inputId }))
  const snapBefore = await h.journal.read(sessionId)
  await h.journal.commit(snapBefore, { turns: [turnDone], events })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor) as SuperSnapshot).messages
    .some(m => m.sourceMessageId === reqId && m.workerEvent === "result"), `${reqId} finished`, 60_000)
}

function uiTools(messages: readonly SuperMessage[], state: FeedbackState, reqId: string) {
  return (buildRequestFeedbackMap(messages, state).get(reqId)?.activities ?? [])
    .filter(item => item.activityKind === "tool")
    .map(item => [item.text, item.activityStatus])
}

function assertLoadedPages(state: FeedbackState, messages: readonly SuperMessage[], reqId: string, phase: string) {
  assert.deepEqual(uiTools(messages, state, reqId), [["核对支付账单", "completed"], ["记录对照样本", "completed"]],
    `${phase}: after Load More the first tool keeps its name and first position, and is now completed`)
  const loaded = state.loadedProcesses.get(reqId)!.items
  assert.equal(new Set(loaded.map(item => item.itemId)).size, loaded.length, `${phase}: no duplicate items`)
  assert.equal(loaded.filter(item => item.activityKind === "tool").length, 2, `${phase}: no duplicated or missing tools`)
  assert.ok(!loaded.some(item => item.text === "Running tool"), `${phase}: never degrades to the generic Running tool`)
}

test("P2-28: a tool started on page 1 and completed only on a later >20,000-event page keeps its name and order through host query and UI Load More", async t => {
  const h = await createJournalHarness("df-p2-28-live-")
  t.after(h.cleanup)
  const service = h.createService()
  await service.init()
  t.after(() => service.close())
  const reqId = "p2-28-live"
  await seedCrossWindowTool(h, service, reqId)

  const snapshot = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor) as SuperSnapshot
  const state = createFeedbackState(h.ws)
  const page1 = await service.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: reqId }, actor) as SuperFeedbackProcessResult
  assert.equal(page1.hasMore, true, "First 20,000-event window does not reach the journal end")
  mergeLoadedProcess(state, page1)
  assert.deepEqual(uiTools(snapshot.messages, state, reqId).map(([text]) => text), ["核对支付账单", "记录对照样本"], "Page 1 order")

  const page2 = await service.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: reqId, afterSeq: page1.nextAfterSeq }, actor) as SuperFeedbackProcessResult
  assert.equal(page2.hasMore, false)
  mergeLoadedProcess(state, page2, true)
  assertLoadedPages(state, snapshot.messages, reqId, "live host")
})

test("P2-28 restart: after host restarts before page 1 and again before Load More, the cross-window tool keeps its name, order and final status", async t => {
  const h = await createJournalHarness("df-p2-28-restart-")
  t.after(h.cleanup)
  const reqId = "p2-28-restart"
  const seeded = h.createService()
  await seeded.init()
  await seedCrossWindowTool(h, seeded, reqId)
  await seeded.close()

  // Restart 1: page 1 is rebuilt purely from the SQLite journal.
  const first = h.createService()
  await first.init()
  const snapshot = await first.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor) as SuperSnapshot
  const state = createFeedbackState(h.ws)
  applySnapshotFeedback(state, snapshot)
  const page1 = await first.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: reqId }, actor) as SuperFeedbackProcessResult
  assert.equal(page1.hasMore, true)
  mergeLoadedProcess(state, page1)
  assert.deepEqual(uiTools(snapshot.messages, state, reqId), [["核对支付账单", "in_progress"], ["记录对照样本", "completed"]], "Page 1 after restart")
  await first.close()

  // Restart 2: Load More continues with the page-1 cursor on a fresh host.
  const second = h.createService()
  await second.init()
  t.after(() => second.close())
  const page2 = await second.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: reqId, afterSeq: page1.nextAfterSeq }, actor) as SuperFeedbackProcessResult
  assert.equal(page2.hasMore, false)
  mergeLoadedProcess(state, page2, true)
  assertLoadedPages(state, snapshot.messages, reqId, "restarted host")

  // Host contract: the status-only update is marked as such instead of inventing a generic title.
  const payUpdate = page2.items.find(item => item.itemId.endsWith(":tc-pay"))
  assert.ok(payUpdate, "Page 2 carries the completion of 核对支付账单")
  assert.equal(payUpdate.activityStatus, "completed")
  assert.equal(payUpdate.updateOnly, true)
  assert.notEqual(payUpdate.text, "Running tool")
})

// --- P2-36: mixed versions, a build 32 client reading a new host's cross-window pages ------------------------------

/**
 * Process-page merge as shipped in client build 32 (iPhone IPA `WorkspaceAgentView` chunk, minified `Ni`):
 * every page item replaces the loaded item with the same ID, then items are ordered by `seq`, then `createdAt`.
 */
function build32MergeLoadedProcess(state: FeedbackState, result: SuperFeedbackProcessResult, append = false): void {
  const prior = append ? state.loadedProcesses.get(result.sourceMessageId) : undefined
  const byId = new Map<string, SuperFeedbackProcessResult["items"][number]>()
  if (prior && prior.revision === result.revision) for (const item of prior.items) byId.set(item.itemId, item)
  for (const item of result.items) byId.set(item.itemId, { ...item })
  const items = [...byId.values()].sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
  state.loadedProcesses.set(result.sourceMessageId, { revision: result.revision, items, hasMore: result.hasMore, nextAfterSeq: result.nextAfterSeq, loading: false })
}

test("P2-36: a build 32 client merging a new host's cross-window completion keeps the tool name and first position", async t => {
  const h = await createJournalHarness("df-p2-36-")
  t.after(h.cleanup)
  const reqId = "p2-36"
  const seeded = h.createService()
  await seeded.init()
  await seedCrossWindowTool(h, seeded, reqId)
  await seeded.close()

  // Restart so neither page can borrow a title from live in-memory state.
  const service = h.createService()
  await service.init()
  t.after(() => service.close())
  const snapshot = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor) as SuperSnapshot
  const page1 = await service.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: reqId }, actor) as SuperFeedbackProcessResult
  assert.equal(page1.hasMore, true)
  const page2 = await service.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: reqId, afterSeq: page1.nextAfterSeq }, actor) as SuperFeedbackProcessResult
  if (process.env.P2_36_DUMP) {
    const { writeFile } = await import("node:fs/promises")
    await writeFile(process.env.P2_36_DUMP, JSON.stringify({ reqId, messages: snapshot.messages, page1, page2 }))
  }

  // Host contract: the status-only completion still says it is status-only, but carries the known title and first position.
  const startItem = page1.items.find(item => item.itemId.endsWith(":tc-pay"))!
  const completion = page2.items.find(item => item.itemId.endsWith(":tc-pay"))!
  assert.equal(completion.updateOnly, true)
  assert.equal(completion.activityStatus, "completed")
  assert.equal(completion.text, "核对支付账单", "cross-window completion carries the original tool title")
  assert.equal(completion.seq, startItem.seq, "cross-window completion carries the tool's first position")
  assert.equal(completion.createdAt, startItem.createdAt)

  const expected = [["核对支付账单", "completed"], ["记录对照样本", "completed"]]
  const legacy = createFeedbackState(h.ws)
  build32MergeLoadedProcess(legacy, page1)
  build32MergeLoadedProcess(legacy, page2, true)
  assert.deepEqual(uiTools(snapshot.messages, legacy, reqId), expected, "build 32 client: name and order preserved after Load More")
  const current = createFeedbackState(h.ws)
  mergeLoadedProcess(current, page1)
  mergeLoadedProcess(current, page2, true)
  assert.deepEqual(uiTools(snapshot.messages, current, reqId), expected, "current client: unchanged")
})
