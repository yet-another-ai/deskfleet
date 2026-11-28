import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { AgentChannel } from "../agent/channel.ts"
import { AgentJournal } from "../agent/store.ts"
import { AuthorizedPeers } from "../peers/authorized-peers.ts"
import { DaemonCatalog } from "../machine/catalog.ts"
import type { AgentActor, AgentCommand, AgentEvent, AgentMethod, AgentPreview, AgentReceipt, AgentSessionRecord, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { ControlPeers } from "../control/server.ts"
import { acpCoordinatorModel } from "./acp.ts"
import type { SuperFeedbackPush, SuperFeedbackSubscribeResult, SuperSnapshot } from "@deskfleet/protocol/super-agent"
import { routeSuperMessage, type SuperRouteContext } from "./router.ts"
import { SuperAgentService } from "./service.ts"
import { emptyState, note, publicRoom, roomFor, type SuperStateStore, type SuperUserState } from "./state.ts"
import { projectSuperEvents, type SuperWorkers } from "./worker.ts"
import type { TerminalSessions } from "../terminals/terminals.ts"
import { AgentMcp } from "../agent/mcp.ts"

const actor = { kind: "user", userId: "alice", deviceId: "mac-1" } as const
const workspaceId = "proj-a"
const now = () => new Date().toISOString()

class CountingMemoryStore implements SuperStateStore {
  data = new Map<string, SuperUserState>()
  writes = 0
  get(uid: string) { return structuredClone(this.data.get(uid)) }
  users() { return [...this.data.keys()] }
  async update<T>(uid: string, init: () => SuperUserState, edit: (state: SuperUserState) => T) {
    const next = this.get(uid) || init()
    const result = edit(next)
    this.data.set(uid, next)
    this.writes++
    return result
  }
}

function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

async function until(check: () => boolean | Promise<boolean>, label = "condition") {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await sleep(5)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

function createFixture(options: { enableReplyFeedback?: boolean } = {}) {
  const store = new CountingMemoryStore()
  const sessions = new Map<string, AgentSnapshot>()
  const receipts = new Map<string, AgentCommand>()
  const events = new Map<string, AgentEvent[]>()
  const listeners = new Set<(event: AgentEvent) => void>()
  const previewListeners = new Set<(preview: AgentPreview) => void>()
  let route: typeof routeSuperMessage = async ctx => ({
    reason: "fixture dispatch",
    actions: [{ kind: "create", title: ctx.text.slice(0, 40), scope: ctx.text, prompt: ctx.text }],
  })
  function createSession(id: string, ws: string) {
    const session: AgentSessionRecord = {
      id, title: id, workspaceId: ws, provider: "codex", providerSessionId: `prov-${id}`,
      context: "directory", lifecycle: "ready", archiveState: "active", createdAt: now(), updatedAt: now(), lastEventSeq: "0",
      capabilities: { resume: true, steering: true },
    }
    const snapshot: AgentSnapshot = { session, runs: [], turns: [], inputs: [], permissions: [], elicitations: [] }
    sessions.set(id, snapshot)
    events.set(id, [])
    return snapshot
  }
  function emit(id: string, kind: AgentEvent["kind"], payload: AgentEvent["payload"], extra: Partial<AgentEvent> = {}) {
    const snap = sessions.get(id)!
    const list = events.get(id)!
    const event: AgentEvent = { sessionId: id, seq: String(list.length + 1), kind, payload, createdAt: now(), ...extra }
    list.push(event)
    snap.session.lastEventSeq = event.seq
    for (const listener of listeners) listener(event)
    return event
  }
  function emitPreview(preview: AgentPreview) {
    for (const listener of previewListeners) listener(preview)
  }
  const workers: SuperWorkers = {
    async handle(method, args, who) {
      const a = args as Record<string, string>
      let sessionId = a.sessionId
      let result: AgentSnapshot | AgentReceipt
      if (method === "_deskfleet/session/create") {
        sessionId = `session-${a.operationId}`
        result = createSession(sessionId, a.workspaceId)
        result.session.provider = a.provider
      } else if (method === "_deskfleet/input/submit") {
        const inputId = `input-${a.operationId}`
        const snap = sessions.get(sessionId)
        if (snap) {
          snap.inputs.push({
            id: inputId,
            sessionId,
            submissionCommandId: a.operationId,
            author: who,
            content: Array.isArray((args as { content?: unknown }).content) ? (args as { content: AgentSnapshot["inputs"][number]["content"] }).content : [],
            acceptedSeq: String((events.get(sessionId)?.length ?? 0) + 1),
            state: "delivered",
            requestedDelivery: a.delivery === "steer" ? "steer" : "backlog",
            ...(a.turnId ? { requestedTurnId: a.turnId } : {}),
            createdAt: now(),
          })
        }
        result = { operationId: a.operationId, sessionId, commandId: a.operationId, inputId }
      } else {
        result = { operationId: a.operationId, sessionId, commandId: a.operationId, inputId: `input-${a.operationId}` }
      }
      receipts.set(a.operationId, {
        method, actor: who, params: a, id: a.operationId, operationId: a.operationId, sessionId,
        status: "completed", result, isCanonical: true, receivedAt: now(),
      })
      return result
    },
    onEvent(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    onPreview(fn) { previewListeners.add(fn); return () => { previewListeners.delete(fn) } },
    journal: {
      async list() { return [...sessions.values()].map(s => structuredClone(s.session)) },
      async read(id) { const s = sessions.get(id); if (!s) throw new Error("Unknown session"); return structuredClone(s) },
      async commands(id) { return [...receipts.values()].filter(r => r.sessionId === id) },
      async command(id) { return structuredClone(receipts.get(id)) || null },
      async history(id, seq, limit = 100) {
        return structuredClone((events.get(id) || []).filter(e => BigInt(e.seq) > BigInt(seq)).slice(0, limit))
      },
    },
  }
  const createService = (override?: { enableReplyFeedback?: boolean }) => new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "machine-1" }),
    coordinatorModel: () => async () => ({ reason: "unused", actions: [{ kind: "answer", text: "ok" }] }),
    coordinatorOptions: async () => ({ models: [{ id: "m1", name: "M1", reasoningEfforts: ["low"] }], defaultModel: "m1", defaultReasoningEfforts: ["low"] }),
    agents: workers,
    store,
    authorize: async who => who,
    ensureDefaultWorkspace: async () => "default-priv",
    workspaces: async (_uid, includeDefault) => [
      ...(includeDefault ? [{ id: "default-priv", name: "default-priv", roots: [] }] : []),
      { id: workspaceId, name: "Project A", roots: [] },
      { id: "proj-a-dup", name: "Project A", roots: [] },
      { id: "proj-b", name: "Project B", roots: [] },
    ],
    providers: () => [{ id: "codex", name: "Codex" }],
    route: (ctx, opts) => route(ctx, opts),
    enableReplyFeedback: override?.enableReplyFeedback ?? options.enableReplyFeedback,
  })
  return {
    store, sessions, events, workers, createSession, emit, emitPreview, createService,
    setRoute: (fn: typeof route) => { route = fn },
  }
}

test("WP1/WP3: Worker A -> tool -> milestone B -> final C delivers B while running and C once without concatenating ABC", async t => {
  const f = createFixture()
  const service = f.createService()
  await service.init()
  t.after(() => service.close())

  const pushes: SuperFeedbackPush[] = []
  const sub = await service.subscribeFeedback({ workspaceId }, actor, push => pushes.push(push))
  t.after(() => sub.unsubscribe())

  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "req-abc", text: "Analyze the pipeline and report findings" }, actor)
  await until(() => f.store.get("alice")?.intents[0]?.phase === "sent", "dispatch sent")

  const initial = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(initial.supportsReplyFeedback, true)
  // Fallback opening ack was created once before work completes, without leaking into legacy snapshot.messages.
  assert.equal(initial.feedback?.items.filter(item => item.kind === "ack").length, 1)
  assert.equal(initial.messages.filter(m => m.role === "assistant" && m.kind !== "dispatch").length, 0)

  const ticket = initial.tickets[0]!
  const sessionId = ticket.sessionId!
  const snap = f.sessions.get(sessionId)!
  const intent = f.store.get("alice")!.intents[0]!
  const turn = { id: "turn-abc", sessionId, runGeneration: 1, dispatchCommandId: "d1", initialInputId: intent.inputId!, startedAt: now(), state: "running" as const }
  snap.turns.push(turn)
  f.emit(sessionId, "turn", turn, { turnId: turn.id, inputId: intent.inputId })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).tickets[0]?.status === "working", "turn running")

  // 1. Opening A (commentary) + Tool call + Thought (private) + Subagent (private) + streaming preview chunks
  const writesBeforeStreaming = f.store.writes
  f.emit(sessionId, "acp", {
    sessionId: snap.session.providerSessionId!,
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "PRIVATE_THOUGHT_DO_NOT_LEAK" } },
  }, { turnId: turn.id, inputId: intent.inputId })
  f.emit(sessionId, "acp", {
    sessionId: snap.session.providerSessionId!,
    update: { sessionUpdate: "agent_message_chunk", messageId: "msg-a", content: { type: "text", text: "Opening A: checking files" }, _meta: { codex: { phase: "commentary" } } } as never,
  }, { turnId: turn.id, inputId: intent.inputId })
  f.emit(sessionId, "acp", {
    sessionId: snap.session.providerSessionId!,
    update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Inspect message pipeline", status: "in_progress", rawInput: { secretToken: "SECRET_ARG" } } as never,
  }, { turnId: turn.id, inputId: intent.inputId })
  f.emit(sessionId, "acp", {
    sessionId: snap.session.providerSessionId!,
    update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", title: "Inspect message pipeline", status: "completed", rawOutput: { rawDump: "SECRET_OUT" } } as never,
  }, { turnId: turn.id, inputId: intent.inputId })
  f.emit(sessionId, "acp", {
    sessionId: "subagent-private-session",
    _meta: { deskfleet: { subagent: true } },
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SUBAGENT_PRIVATE_CHAT" } },
  } as never, { turnId: turn.id, inputId: intent.inputId })

  // Streaming live preview chunks for final/commentary must NOT write full SQLite state per token!
  f.emitPreview({
    sessionId, streamId: "s1", baseSeq: snap.session.lastEventSeq, offset: 0,
    events: [
      { sessionId, kind: "acp", turnId: turn.id, createdAt: now(), payload: { sessionId: snap.session.providerSessionId!, update: { sessionUpdate: "agent_message_chunk", messageId: "msg-a", content: { type: "text", text: " (live)" }, _meta: { codex: { phase: "commentary" } } } as never } },
    ],
  })
  await sleep(40)
  // Zero extra DB writes for ordinary commentary, tool updates, or preview chunks!
  assert.equal(f.store.writes, writesBeforeStreaming)

  // 2. Stage discovery B explicitly marked as milestone — MUST appear while turn is STILL running!
  f.emit(sessionId, "acp", {
    sessionId: snap.session.providerSessionId!,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg-b",
      content: { type: "text", text: "Finding B: root cause confirmed in super-agent-worker.ts." },
      _meta: { deskfleet: { purpose: "milestone", submissionId: "finding-b" } },
    } as never,
  }, { turnId: turn.id, inputId: intent.inputId })

  await until(async () => {
    const mid = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
    return mid.feedback?.items.some(item => item.kind === "milestone" && item.text.includes("Finding B")) === true
  }, "milestone B visible while turn is still running")

  const midSnapshot = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(midSnapshot.tickets[0]!.status, "working", "Worker is STILL running when milestone B arrives")
  assert.equal(midSnapshot.messages.some(m => m.workerEvent === "result"), false, "Final result has NOT arrived yet")
  const milestoneB = midSnapshot.feedback!.items.find(item => item.kind === "milestone")!
  assert.equal(milestoneB.sourceMessageId, "req-abc")
  assert.equal(milestoneB.ticketId, ticket.id)

  // 3. Stream Final C with explicit final_answer phase, then complete turn.
  f.emitPreview({
    sessionId, streamId: "s2", baseSeq: snap.session.lastEventSeq, offset: 0,
    events: [
      { sessionId, kind: "acp", turnId: turn.id, createdAt: now(), payload: { sessionId: snap.session.providerSessionId!, update: { sessionUpdate: "agent_message_chunk", messageId: "msg-c", content: { type: "text", text: "Final C: " }, _meta: { codex: { phase: "final_answer" } } } as never } },
    ],
  })
  f.emit(sessionId, "acp", {
    sessionId: snap.session.providerSessionId!,
    update: { sessionUpdate: "agent_message_chunk", messageId: "msg-c", content: { type: "text", text: "Final C: complete patch ready." }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: turn.id, inputId: intent.inputId })

  const completed = { ...turn, state: "completed" as const }
  snap.turns = [completed]
  f.emit(sessionId, "turn", completed, { turnId: turn.id, inputId: intent.inputId })

  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.workerEvent === "result"), "final result C")

  const finalSnapshot = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  const results = finalSnapshot.messages.filter(m => m.workerEvent === "result")
  assert.equal(results.length, 1, "Final delivery C must appear exactly once")
  assert.equal(results[0]!.text, "Final C: complete patch ready.", "Final C must NOT be concatenated into ABC")
  assert.ok(!results[0]!.text.includes("Opening A"))
  assert.ok(!results[0]!.text.includes("Finding B"))
  assert.equal(results[0]!.logicalId, `worker-final:${sessionId}:${turn.id}`)
  assert.equal(finalSnapshot.tickets[0]!.status, undefined)

  // Restart service and verify journal reconstruction + zero duplicate final delivery + no private leakage!
  await service.close()
  const reopened = f.createService()
  await reopened.init()
  t.after(() => reopened.close())

  const afterRestart = await reopened.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(afterRestart.messages.filter(m => m.workerEvent === "result").length, 1)
  assert.equal(afterRestart.feedback?.items.filter(item => item.kind === "milestone").length, 1)
  assert.equal(afterRestart.feedback?.items.filter(item => item.kind === "ack").length, 1)

  const processPage = await reopened.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId, sourceMessageId: "req-abc" }, actor)
  const processJson = JSON.stringify(processPage)
  assert.ok(processPage.items.some(item => item.activityKind === "tool" && item.text.includes("Inspect message pipeline")))
  assert.ok(processPage.items.some(item => item.activityKind === "commentary" && item.text.includes("Opening A")))
  assert.ok(!processJson.includes("PRIVATE_THOUGHT_DO_NOT_LEAK"))
  assert.ok(!processJson.includes("SECRET_ARG"))
  assert.ok(!processJson.includes("SECRET_OUT"))
  assert.ok(!processJson.includes("SUBAGENT_PRIVATE_CHAT"))
})

test("WP1/WP3: boundary cases — no messageId, long report keeps beginning, unbounded outcome, legacy snapshot", () => {
  const state = emptyState()
  const room = roomFor(state, workspaceId, "codex")
  note(room, "Run check", { id: "u1", role: "user", state: "assigned", ticketId: "t1", revision: 0 })
  const ticket = { id: "t1", title: "Check", scope: "Check", summary: "", provider: "codex", sessionId: "s1", status: "working" as const, updatedAt: now() }
  room.tickets.push(ticket)
  const intents = [{
    id: "i1", roomId: workspaceId, messageId: "u1", ticketId: "t1", actor, operation: "submit" as const,
    prompt: "Check", provider: "codex", sessionId: "s1", inputId: "in1", createId: "c1", submitId: "sub1", phase: "sent" as const,
  }]
  const turn = { id: "turn1", sessionId: "s1", runGeneration: 1, dispatchCommandId: "d1", initialInputId: "in1", startedAt: now(), state: "running" as const }
  const snapshot: AgentSnapshot = {
    session: { id: "s1", title: "s1", workspaceId, provider: "codex", providerSessionId: "p1", context: "directory", lifecycle: "ready", archiveState: "active", createdAt: now(), updatedAt: now(), lastEventSeq: "6" },
    runs: [], turns: [turn], inputs: [], permissions: [], elicitations: [],
  }
  const ev = (seq: string, kind: AgentEvent["kind"], payload: AgentEvent["payload"]): AgentEvent => ({ sessionId: "s1", seq, kind, payload, turnId: turn.id, inputId: "in1", createdAt: now() })
  // No native messageId: separated purely by tool boundary; long final text > 64,000 chars preserves BEGINNING!
  const longStart = "BEGINNING_HEADER_MUST_SURVIVE\n" + "x".repeat(70_000) + "\nTAIL_END"
  projectSuperEvents(room, ticket, [
    ev("1", "acp", { sessionId: "p1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Pre-tool note A" } } }),
    ev("2", "acp", { sessionId: "p1", update: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Run tests", status: "completed" } as never }),
    ev("3", "acp", { sessionId: "p1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: longStart } } }),
    ev("4", "turn", { ...turn, state: "completed" }),
  ], snapshot, intents)
  const result = room.messages.find(m => m.workerEvent === "result")!
  assert.ok(result.text.startsWith("BEGINNING_HEADER_MUST_SURVIVE"), "Long report must keep its beginning")
  assert.ok(!result.text.includes("Pre-tool note A"), "Tool boundary must separate A from C even without native messageId")
  assert.equal(result.truncated, true)

  // Unbounded outcome: text only before tool, then completed turn -> retains text AND sets unboundedOutcome=true
  const ticket2 = { id: "t2", title: "Check2", scope: "Check2", summary: "", provider: "codex", sessionId: "s2", status: "working" as const, updatedAt: now() }
  room.tickets.push(ticket2)
  note(room, "Run check 2", { id: "u2", role: "user", state: "assigned", ticketId: "t2", revision: 0 })
  const intents2 = [...intents, {
    id: "i2", roomId: workspaceId, messageId: "u2", ticketId: "t2", actor, operation: "submit" as const,
    prompt: "Check2", provider: "codex", sessionId: "s2", inputId: "in2", createId: "c2", submitId: "sub2", phase: "sent" as const,
  }]
  const turn2 = { id: "turn2", sessionId: "s2", runGeneration: 1, dispatchCommandId: "d2", initialInputId: "in2", startedAt: now(), state: "running" as const }
  const snapshot2: AgentSnapshot = { ...snapshot, session: { ...snapshot.session, id: "s2", providerSessionId: "p2" }, turns: [turn2] }
  projectSuperEvents(room, ticket2, [
    { sessionId: "s2", seq: "1", kind: "acp", turnId: turn2.id, inputId: "in2", createdAt: now(), payload: { sessionId: "p2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Draft before tool" } } } },
    { sessionId: "s2", seq: "2", kind: "acp", turnId: turn2.id, inputId: "in2", createdAt: now(), payload: { sessionId: "p2", update: { sessionUpdate: "tool_call", toolCallId: "tc2", title: "Run build", status: "completed" } as never } },
    { sessionId: "s2", seq: "3", kind: "turn", turnId: turn2.id, inputId: "in2", createdAt: now(), payload: { ...turn2, state: "completed" } },
  ], snapshot2, intents2)
  const result2 = room.messages.find(m => m.ticketId === "t2" && m.workerEvent === "result")!
  assert.equal(result2.text, "Draft before tool")
  assert.equal(result2.unboundedOutcome, true)

  // Legacy snapshot projection strips internal fields and never injects feedback items into legacy messages.
  const pub = publicRoom(room, "codex", "codex", intents2)
  assert.ok(pub.tickets.every(item => !("turnOutput" in item) && !("output" in item)))
  assert.equal(pub.feedback, undefined)
})

test("WP2: foreground coordinator confirms once before hanging evidence read, skips ack on simple Q&A, never repeats on retries or multi-worker split", async t => {
  const evidenceGate = gate()
  const f = createFixture()
  const service = f.createService()
  let modelCalls = 0

  f.setRoute((ctx, opts) => routeSuperMessage(ctx, {
    ...opts,
    evidence: async () => {
      await evidenceGate.wait
      return JSON.stringify({ title: "Docs", scope: "Review docs" })
    },
    model: async packet => {
      modelCalls++
      if (ctx.text === "What does this square icon do?") {
        return { reason: "simple direct answer", actions: [{ kind: "answer", text: "It stops the running request." }] }
      }
      if (ctx.text === "Invalid first pass") {
        if (packet.validationError) {
          return { reason: "recovered", actions: [{ kind: "answer", text: "Recovered cleanly." }] }
        }
        return { reason: "bad", publicFeedback: { ack: "Should NEVER be published on invalid output" }, actions: [{ kind: "unknown_invalid" }] }
      }
      if (ctx.text === "Split two workers") {
        return {
          reason: "two branches",
          publicFeedback: { ack: "我会同时安排前端与后端两项修改，完成后把结果带回这里。" },
          actions: [
            { kind: "create", title: "Frontend update", scope: "Update UI", prompt: "Update UI" },
            { kind: "create", title: "Backend update", scope: "Update API", prompt: "Update API" },
          ],
        }
      }
      const ev = packet.evidence as unknown[]
      if (ev.length === 0) {
        return {
          reason: "need evidence",
          publicFeedback: { ack: "我会核对设计文档与现有状态条，把方案整理好带回这里。" },
          actions: [{ kind: "evidence", request: { kind: "read", workspaceId, rootIndex: 0, path: "README.md" } }],
        }
      }
      return {
        reason: "answered after evidence",
        publicFeedback: { ack: "Duplicate ack MUST be ignored" },
        actions: [{ kind: "answer", text: "Done checking README." }],
      }
    },
  }))

  await service.init()
  t.after(() => service.close())

  // 1. Simple question -> direct answer, zero ack, zero extra model calls.
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "simple", text: "What does this square icon do?" }, actor)
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.id === "simple" && m.state === "answered"), "simple answered")
  const afterSimple = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(afterSimple.feedback?.items.filter(item => item.sourceMessageId === "simple" && item.kind === "ack").length, 0)
  assert.equal(modelCalls, 1)

  // 2. Invalid model pass -> MUST NOT emit invalid ack before retrying!
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "bad-pass", text: "Invalid first pass" }, actor)
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.id === "bad-pass" && m.state === "answered"), "invalid recovered")
  const afterBad = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(afterBad.feedback?.items.filter(item => item.sourceMessageId === "bad-pass" && item.kind === "ack").length, 0)

  // 3. Long task with hanging evidence tool -> ack arrives BEFORE evidence resolves, and stays deduplicated after evidence finishes!
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "slow-ev", text: "Inspect design doc" }, actor)
  await until(async () => {
    const s = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
    return s.feedback?.items.some(item => item.sourceMessageId === "slow-ev" && item.kind === "ack") === true
  }, "ack published while evidence is still blocked")
  const duringEv = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(duringEv.messages.find(m => m.id === "slow-ev")?.state, "routing", "Request is still routing while evidence hangs")
  assert.equal(duringEv.feedback?.items.find(item => item.sourceMessageId === "slow-ev" && item.kind === "ack")?.text, "我会核对设计文档与现有状态条，把方案整理好带回这里。")
  assert.ok(duringEv.feedback?.items.some(item => item.sourceMessageId === "slow-ev" && item.kind === "activity"))
  evidenceGate.release()
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.id === "slow-ev" && m.state === "answered"), "slow-ev answered")
  const afterEv = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(afterEv.feedback?.items.filter(item => item.sourceMessageId === "slow-ev" && item.kind === "ack").length, 1)

  // 4. Split multi-worker request -> still ONLY ONE ack!
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "split-2", text: "Split two workers" }, actor)
  await until(() => f.store.get("alice")?.intents.filter(i => i.messageId === "split-2" && i.phase === "sent").length === 2, "both split workers sent")
  const afterSplit = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(afterSplit.feedback?.items.filter(item => item.sourceMessageId === "split-2" && item.kind === "ack").length, 1)
})

test("WP2: ACP coordinator separates commentary from JSON decision and never leaks raw partial JSON", async () => {
  const emitted: unknown[] = []
  const model = acpCoordinatorModel({
    config: { cwd: process.cwd() } as never,
    provider: {
      id: "acp",
      async connect(_config, client) {
        return {
          initialization: { protocolVersion: 1, agentCapabilities: {} },
          newSession: async () => ({ sessionId: "s-acp", configOptions: [] }),
          prompt: async () => {
            await client.onUpdate({
              sessionId: "s-acp",
              update: { sessionUpdate: "agent_message_chunk", messageId: "c1", content: { type: "text", text: "Checking context…" }, _meta: { codex: { phase: "commentary" } } } as never,
            })
            await client.onUpdate({
              sessionId: "s-acp",
              update: { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "I will check this." }, _meta: { deskfleet: { publicPurpose: "ack" } } } as never,
            })
            await client.onUpdate({
              sessionId: "s-acp",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"reason":"ok",' } },
            })
            await client.onUpdate({
              sessionId: "s-acp",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: '"actions":[{"kind":"answer","text":"Done"}]}' } },
            })
            return { stopReason: "end_turn" }
          },
          close: async () => {},
        } as never
      },
    },
  })
  const decision = await model({ message: "hi" }, undefined, undefined, { onPublicMessage: msg => emitted.push(msg) })
  assert.deepEqual(decision, { reason: "ok", actions: [{ kind: "answer", text: "Done" }] })
  assert.deepEqual(emitted, [
    { purpose: "activity", itemId: "acp:commentary:c1", delta: true, text: "Checking context…" },
    { purpose: "ack", itemId: "acp:a1", delta: true, text: "I will check this." },
  ])
})

test("WP3: restricted Worker MCP report tool is hidden from classic sessions, idempotent on retry, and resolves quoted milestones", async t => {
  const f = createFixture()
  const service = f.createService()
  await service.init()
  t.after(() => service.close())

  // Unbound classic session MUST NOT get DESKFLEET_SA_REPORT=1 and cannot call reportFromWorker!
  f.createSession("classic-session", workspaceId)
  const mcp = new AgentMcp({
    isSaWorkerSession: (sid, createOpId) => service.isSaWorkerSession(sid, createOpId),
    authorize: async () => {},
    dispatch: async () => ({}),
  })
  await mcp.init()
  t.after(() => mcp.close())
  const classicLease = mcp.lease("classic-session", workspaceId, actor)
  t.after(() => classicLease.close())
  const classicEnv = (classicLease.servers[0] as { env?: { name: string; value: string }[] }).env ?? []
  assert.equal(classicEnv.some(entry => entry.name === "DESKFLEET_SA_REPORT"), false)
  assert.equal(service.isSaWorkerSession("classic-session"), false)
  await assert.rejects(service.reportFromWorker("classic-session", { kind: "milestone", text: "nope" }, actor), /not bound to a Super Agent request/)

  // SA-bound session receives DESKFLEET_SA_REPORT=1, submits an idempotent milestone, and quoting it resolves back to its ticket!
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "m-req", text: "Investigate timeout" }, actor)
  await until(() => f.store.get("alice")?.intents[0]?.phase === "sent", "worker sent")
  const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  const ticket = snap.tickets[0]!
  assert.equal(service.isSaWorkerSession(ticket.sessionId!), true)
  const saLease = mcp.lease(ticket.sessionId!, workspaceId, actor)
  t.after(() => saLease.close())
  const saEnv = (saLease.servers[0] as { env?: { name: string; value: string }[] }).env ?? []
  assert.equal(saEnv.some(entry => entry.name === "DESKFLEET_SA_REPORT" && entry.value === "1"), true)

  const first = await service.reportFromWorker(ticket.sessionId!, { kind: "milestone", text: "Found retry loop in retry.ts", submissionId: "sub-1" }, actor)
  const duplicate = await service.reportFromWorker(ticket.sessionId!, { kind: "milestone", text: "Found retry loop in retry.ts", submissionId: "sub-1" }, actor)
  assert.equal(first.status, "accepted")
  assert.equal(duplicate.status, "duplicate")
  assert.equal(duplicate.itemId, first.itemId)

  let quotedCtx: SuperRouteContext | undefined
  f.setRoute(async ctx => {
    quotedCtx = ctx
    return { reason: "quoted milestone", actions: [{ kind: "answer", ticketId: ctx.quote?.ticketId, text: "Acknowledged quote." }] }
  })
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "m-quote", text: "Fix that retry loop too", replyTo: first.itemId }, actor)
  await until(() => !!quotedCtx, "routed quote")
  assert.equal(quotedCtx!.quote?.ticketId, ticket.id)
  assert.equal(quotedCtx!.quote?.text, "Found retry loop in retry.ts")
})

test("WP4/WP5: AgentChannel & AuthorizedPeers enforce cursor catch-up, resync on gap, read-only ACL, user/workspace isolation, stop race, and capability rollback", async t => {
  const f = createFixture()
  const service = f.createService()
  await service.init()
  t.after(() => service.close())

  // Set up an AgentChannel with feedback subscription support and verify snapshot -> events -> subscribe catch-up!
  const sentNotifications: { method: string; params: unknown }[] = []
  const responses = new Map<number, { result?: unknown; error?: { message: string } }>()
  let buf = ""
  let rpcSeq = 0
  const channel = new AgentChannel({
    journal: { identity: { originId: "o1", machineId: "m1" } },
    onEvent: fn => f.workers.onEvent(fn),
    handle: (m, p, a) => f.workers.handle(m, p, a),
    superAgent: (m, p, a) => service.handle(m, p, a),
    superAgentFeedback: (p, a, push) => service.subscribeFeedback(p, a, push),
  }, actor, async bytes => {
    buf += Buffer.from(bytes).toString()
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (typeof msg.id === "number") responses.set(msg.id, msg)
      else if (typeof msg.method === "string") sentNotifications.push({ method: msg.method, params: msg.params })
    }
  }, err => { throw err })
  t.after(() => channel.close())

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++rpcSeq
    channel.receive(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"))
    await until(() => responses.has(id), method)
    const reply = responses.get(id)!
    responses.delete(id)
    if (reply.error) throw new Error(reply.error.message)
    return reply.result as T
  }
  await rpc("initialize", { protocolVersion: 1 })

  // 1. Read snapshot at cursor 0, THEN send a message before subscribing -> catch-up must recover missed ack!
  const initialSnap = await rpc<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId })
  const cursorBefore = initialSnap.feedback!.cursor
  const genBefore = initialSnap.feedback!.previewGeneration
  await rpc("_deskfleet/super-agent/send", { workspaceId, messageId: "catchup-req", text: "Build release checklist" })
  await until(() => f.store.get("alice")?.intents[0]?.phase === "sent", "catchup worker sent")

  const subRes = await rpc<SuperFeedbackSubscribeResult>("_deskfleet/super-agent/feedbackSubscribe", {
    workspaceId, afterCursor: cursorBefore, previewGeneration: genBefore,
  })
  assert.equal(subRes.resyncRequired, false)
  assert.ok(subRes.events.some(e => e.event.type === "item_upsert" && e.event.item.kind === "ack"), "Missed ack recovered via afterCursor")

  // Generation mismatch forces clean resyncRequired=true
  const staleGenSub = await rpc<SuperFeedbackSubscribeResult>("_deskfleet/super-agent/feedbackSubscribe", {
    workspaceId, afterCursor: 0, previewGeneration: "stale-gen",
  })
  assert.equal(staleGenSub.resyncRequired, true)
  await rpc("_deskfleet/super-agent/feedbackUnsubscribe", { subscriptionId: staleGenSub.subscriptionId })

  // 2. Isolation: another user & same-named duplicate workspace receive ZERO events!
  const bobPushes: SuperFeedbackPush[] = []
  const dupProjectPushes: SuperFeedbackPush[] = []
  const bobSub = await service.subscribeFeedback({ workspaceId: null }, { kind: "user", userId: "bob", deviceId: "bob-ios" }, p => bobPushes.push(p))
  const dupSub = await service.subscribeFeedback({ workspaceId: "proj-a-dup" }, actor, p => dupProjectPushes.push(p))
  t.after(() => { bobSub.unsubscribe(); dupSub.unsubscribe() })

  const ticket = (await rpc<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId })).tickets[0]!
  await service.reportFromWorker(ticket.sessionId!, { kind: "milestone", text: "Private milestone in proj-a", submissionId: "priv-1" }, actor)
  await until(() => sentNotifications.some(n => n.method === "_deskfleet/super-agent/feedback" && JSON.stringify(n.params).includes("Private milestone")), "live notification pushed")
  assert.equal(bobPushes.length, 0, "Other user default workspace must never receive Alice's events")
  assert.equal(dupProjectPushes.length, 0, "Same-named workspace with different ID must never receive proj-a events")

  // 3. Unsubscribe stops further pushes cleanly.
  await rpc("_deskfleet/super-agent/feedbackUnsubscribe", { subscriptionId: subRes.subscriptionId })
  const countBefore = sentNotifications.length
  await service.reportFromWorker(ticket.sessionId!, { kind: "milestone", text: "After unsubscribe", submissionId: "priv-2" }, actor)
  await sleep(30)
  assert.equal(sentNotifications.length, countBefore)

  // 4. Read-only peer via AuthorizedPeers: CAN read snapshot + subscribe + feedbackProcess, CANNOT send/stop!
  const peers = new AuthorizedPeers({
    peers: { create: async () => { throw new Error("unused") }, close: async () => {} } as unknown as ControlPeers,
    agents: {
      journal: { identity: { originId: "o1", machineId: "m1" } },
      onEvent: fn => f.workers.onEvent(fn),
      handle: (m, p, a) => f.workers.handle(m, p, a),
    },
    terminals: { list: () => [] } as unknown as TerminalSessions,
    identity: { originId: "o1", machineId: "m1" },
    superAgent: (m, p, a) => service.handle(m, p, a),
    superAgentFeedback: (p, a, push) => service.subscribeFeedback(p, a, push),
    signal: () => {},
  })
  peers.bind({ serverUrl: "http://local", serverId: "srv", teamId: "team-1", machineId: "machine-1", token: "t" })
  const peerId = "ro-peer"
  const token = "a".repeat(40)
  peers.prepareLocal({
    peerId, token,
    authorization: {
      peerId, serverId: "srv", teamId: "team-1", purpose: "agent", transport: "local",
      actions: ["agent:read"],
      actor,
      targetMachine: { id: "machine-1", originId: "o1", localMachineId: "m1" },
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  })
  const roReplies = new Map<number, { result?: unknown; error?: { message: string } }>()
  let roBuf = ""
  const owner = {}
  peers.openLocal(peerId, token, owner, {
    send: async data => {
      roBuf += data.toString()
      let nl
      while ((nl = roBuf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(roBuf.slice(0, nl))
        roBuf = roBuf.slice(nl + 1)
        if (typeof msg.id === "number") roReplies.set(msg.id, msg)
      }
    },
    close: () => {},
  })
  t.after(() => peers.closeAll())
  async function roCall(id: number, method: string, params: unknown) {
    peers.sendLocal(peerId, owner, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"), false)
    await until(() => roReplies.has(id), `ro ${method}`)
    return roReplies.get(id)!
  }
  await roCall(1, "initialize", { protocolVersion: 1 })
  const roSub = await roCall(2, "_deskfleet/super-agent/feedbackSubscribe", { workspaceId })
  assert.ok(!roSub.error, "Read-only peer must be allowed to subscribe to feedback")
  const roProc = await roCall(3, "_deskfleet/super-agent/feedbackProcess", { workspaceId, sourceMessageId: "catchup-req" })
  assert.ok(!roProc.error, "Read-only peer must be allowed to expand View progress")
  const roSend = await roCall(4, "_deskfleet/super-agent/send", { workspaceId, messageId: "blocked-send", text: "nope" })
  assert.match(roSend.error?.message ?? "", /does not allow/)

  // 5. Rollback toggle: disabling supportsReplyFeedback cleanly removes capability while keeping classic SA usable!
  const disabledService = f.createService({ enableReplyFeedback: false })
  await disabledService.init()
  t.after(() => disabledService.close())
  const disabledSnap = await disabledService.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(disabledSnap.supportsReplyFeedback, undefined)
  assert.equal(disabledSnap.feedback, undefined)
  await assert.rejects(disabledService.subscribeFeedback({ workspaceId }, actor, () => {}), /unavailable/)
})

test("WP4/WP5: stop race, mid-turn crash, parallel branches, cross-project handoff, and host-to-client transport latency", async t => {
  const f = createFixture()
  const service = f.createService()
  f.setRoute(async ctx => {
    if (ctx.workspaceId === null) {
      return {
        reason: "handoff to project",
        actions: [{ kind: "handoff", workspaceId, prompt: ctx.text, context: "Carry request into Project A" }],
      }
    }
    if (ctx.text === "Run A and B in parallel") {
      return {
        reason: "parallel branches",
        publicFeedback: { ack: "I will run Branch A and Branch B and report each result here." },
        actions: [
          { kind: "create", title: "Branch A", scope: "Work A", prompt: "Work A" },
          { kind: "create", title: "Branch B", scope: "Work B", prompt: "Work B" },
        ],
      }
    }
    return {
      reason: "single task",
      publicFeedback: { ack: "I will execute this task in Project A and return the result." },
      actions: [{ kind: "create", title: "Handoff Task", scope: ctx.text, prompt: ctx.text }],
    }
  })
  await service.init()
  t.after(() => service.close())

  // 1. Cross-project handoff from default workspace (null) -> proj-a creates ack in destination workspace cleanly.
  await service.handle("_deskfleet/super-agent/send", { workspaceId: null, messageId: "ho-1", text: "Modify Project A" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.roomId === workspaceId && i.phase === "sent") === true, "handoff dispatched")
  const destSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  const destSource = destSnap.messages.find(m => m.role === "user" && m.sourceMessageId === "ho-1")!
  assert.equal(destSnap.feedback?.items.filter(item => item.sourceMessageId === destSource.id && item.kind === "ack").length, 1)

  // 2. Parallel branches A & B: A crashes/cancels mid-stream (aborted draft), B stays active and finishes cleanly!
  const latenciesMs: number[] = []
  let emittedAt = 0
  const pushedEvents: SuperFeedbackPush[] = []
  const sub = await service.subscribeFeedback({ workspaceId }, actor, push => {
    if (emittedAt > 0) { latenciesMs.push(performance.now() - emittedAt); emittedAt = 0 }
    pushedEvents.push(push)
  })
  t.after(() => sub.unsubscribe())

  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "par-1", text: "Run A and B in parallel" }, actor)
  await until(() => f.store.get("alice")?.intents.filter(i => i.messageId === "par-1" && i.phase === "sent").length === 2, "parallel intents sent")
  const parSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  const [ticketA, ticketB] = parSnap.tickets.filter(item => item.title === "Branch A" || item.title === "Branch B")
  assert.ok(ticketA?.sessionId && ticketB?.sessionId)
  const [intentA, intentB] = f.store.get("alice")!.intents.filter(i => i.messageId === "par-1")

  const turnA = { id: "turn-a", sessionId: ticketA.sessionId, runGeneration: 1, dispatchCommandId: "da", initialInputId: intentA!.inputId!, startedAt: now(), state: "running" as const }
  const turnB = { id: "turn-b", sessionId: ticketB.sessionId, runGeneration: 1, dispatchCommandId: "db", initialInputId: intentB!.inputId!, startedAt: now(), state: "running" as const }
  f.sessions.get(ticketA.sessionId)!.turns.push(turnA)
  f.sessions.get(ticketB.sessionId)!.turns.push(turnB)
  f.emit(ticketA.sessionId, "turn", turnA, { turnId: turnA.id, inputId: intentA!.inputId })
  f.emit(ticketB.sessionId, "turn", turnB, { turnId: turnB.id, inputId: intentB!.inputId })

  // Stream a partial final draft on Branch A, then cancel Branch A -> marks A's draft aborted while B keeps running!
  f.emit(ticketA.sessionId, "acp", {
    sessionId: f.sessions.get(ticketA.sessionId)!.session.providerSessionId!,
    update: { sessionUpdate: "agent_message_chunk", messageId: "a-draft", content: { type: "text", text: "Half draft A" }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: turnA.id, inputId: intentA!.inputId })
  const cancelledA = { ...turnA, state: "cancelled" as const }
  f.sessions.get(ticketA.sessionId)!.turns = [cancelledA]
  f.emit(ticketA.sessionId, "turn", cancelledA, { turnId: turnA.id, inputId: intentA!.inputId })

  await until(async () => {
    const s = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
    return s.tickets.find(item => item.id === ticketA.id)?.status === "stopped"
  }, "branch A cancelled")

  const midPar = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(midPar.tickets.find(item => item.id === ticketA.id)?.status, "stopped")
  assert.equal(midPar.tickets.find(item => item.id === ticketB.id)?.status, "working", "Branch B remains working after Branch A stops")
  const resA = midPar.messages.find(m => m.ticketId === ticketA.id && m.workerEvent === "result")!
  assert.equal(resA.stopState, "stopped")
  assert.equal(resA.text, "Half draft A")
  assert.ok(pushedEvents.some(p => p.event.type === "item_status" && p.event.status === "aborted"))

  // Measure host-to-subscriber delivery latency over 5 milestone bursts on Branch B (zero duplicate deliveries).
  for (let i = 0; i < 5; i++) {
    emittedAt = performance.now()
    await service.reportFromWorker(ticketB.sessionId, { kind: "milestone", text: `Branch B check #${i + 1}`, submissionId: `b-ms-${i}` }, actor)
  }
  assert.equal(latenciesMs.length, 5)
  assert.ok(latenciesMs.every(ms => ms < 500), `Expected fast in-process delivery, got ${JSON.stringify(latenciesMs)}`)

  // Finish Branch B -> single formal delivery for B; Branch A remains stopped (no overwrite!).
  f.emit(ticketB.sessionId, "acp", {
    sessionId: f.sessions.get(ticketB.sessionId)!.session.providerSessionId!,
    update: { sessionUpdate: "agent_message_chunk", messageId: "b-final", content: { type: "text", text: "Branch B completed cleanly." }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: turnB.id, inputId: intentB!.inputId })
  const completedB = { ...turnB, state: "completed" as const }
  f.sessions.get(ticketB.sessionId)!.turns = [completedB]
  f.emit(ticketB.sessionId, "turn", completedB, { turnId: turnB.id, inputId: intentB!.inputId })

  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.ticketId === ticketB.id && m.workerEvent === "result"), "branch B finished")
  const endPar = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(endPar.tickets.find(item => item.id === ticketA.id)?.status, "stopped")
  assert.equal(endPar.tickets.find(item => item.id === ticketB.id)?.status, undefined)
  assert.equal(endPar.messages.filter(m => m.ticketId === ticketB.id && m.workerEvent === "result").length, 1)
  assert.equal(endPar.messages.find(m => m.ticketId === ticketB.id && m.workerEvent === "result")?.text, "Branch B completed cleanly.")

  // Mid-turn Worker crash on Handoff Task marks ticket blocked with error message and keeps known state honest.
  const hoTicket = endPar.tickets.find(item => item.title === "Handoff Task")!
  const hoIntent = f.store.get("alice")!.intents.find(i => i.ticketId === hoTicket.id)!
  const hoTurn = { id: "turn-ho", sessionId: hoTicket.sessionId!, runGeneration: 1, dispatchCommandId: "dho", initialInputId: hoIntent.inputId!, startedAt: now(), state: "running" as const }
  f.sessions.get(hoTicket.sessionId!)!.turns.push(hoTurn)
  f.emit(hoTicket.sessionId!, "turn", hoTurn, { turnId: hoTurn.id, inputId: hoIntent.inputId })
  f.emit(hoTicket.sessionId!, "run", { sessionId: hoTicket.sessionId!, generation: 1, state: "interrupted", startedAt: now(), error: "Provider process crashed mid-turn" })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).tickets.find(item => item.id === hoTicket.id)?.status === "blocked", "crash blocked")
  const afterCrash = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.ok(afterCrash.messages.some(m => m.ticketId === hoTicket.id && m.text.includes("Provider process crashed mid-turn")))
})

test("P1-5: independent manual Worker turn never leaks progress or reports into old SA request, and cross-conversation Worker progress stays in original conversation", async t => {
  const f = createFixture()
  const wsA = "ws-a"
  const wsB = "ws-b"
  const service = new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({}),
    agents: f.workers,
    store: f.store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [
      { id: wsA, name: "Project A", roots: ["/tmp/proj-a"] },
      { id: wsB, name: "Project B", roots: ["/tmp/proj-b"] },
    ],
    ensureDefaultWorkspace: async () => wsA,
    authorize: async who => who,
    route: async ctx => ({
      reason: "dispatch",
      publicFeedback: { ack: `Handling ${ctx.text}` },
      actions: [{ kind: "create", title: ctx.text, scope: ctx.text, prompt: ctx.text }],
    }),
  })
  await service.init()
  t.after(() => service.close())

  // 1. Dispatch SA Request 1 in wsA -> completes cleanly on Worker s1.
  await service.handle("_deskfleet/super-agent/send", { workspaceId: wsA, messageId: "req-1", text: "Task A1" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "req-1" && i.phase === "sent") === true, "req-1 sent")
  const snap1 = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, actor)
  const ticket1 = snap1.tickets[0]!
  const s1 = ticket1.sessionId!
  const intent1 = f.store.get("alice")!.intents.find(i => i.messageId === "req-1")!
  const turn1 = { id: "turn-1", sessionId: s1, runGeneration: 1, dispatchCommandId: "d1", initialInputId: intent1.inputId!, startedAt: now(), state: "running" as const }
  f.sessions.get(s1)!.turns.push(turn1)
  f.emit(s1, "turn", turn1, { turnId: turn1.id, inputId: intent1.inputId })
  f.emit(s1, "acp", {
    sessionId: f.sessions.get(s1)!.session.providerSessionId!,
    update: { sessionUpdate: "agent_message_chunk", messageId: "r1-final", content: { type: "text", text: "Task A1 finished." }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: turn1.id, inputId: intent1.inputId })
  const done1 = { ...turn1, state: "completed" as const }
  f.sessions.get(s1)!.turns = [done1]
  f.emit(s1, "turn", done1, { turnId: turn1.id, inputId: intent1.inputId })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, actor)).messages.some(m => m.sourceMessageId === "req-1" && m.workerEvent === "result"), "req-1 finished")

  const pushesA: SuperFeedbackPush[] = []
  const subA = await service.subscribeFeedback({ workspaceId: wsA }, actor, p => pushesA.push(p))
  t.after(() => subA.unsubscribe())

  // 2. Same user opens Worker s1 directly and runs an independent manual turn (unmatched inputId & turnId).
  const manualInput = { id: "in-manual", sessionId: s1, submissionCommandId: "cmd-manual", author: actor, content: [{ type: "text" as const, text: "Manual prompt" }], acceptedSeq: "99", state: "delivered" as const, requestedDelivery: "backlog" as const, actualDelivery: "turn_start" as const, turnId: "turn-manual", createdAt: now() }
  const manualTurn = { id: "turn-manual", sessionId: s1, runGeneration: 1, dispatchCommandId: "dm", initialInputId: "in-manual", startedAt: now(), state: "running" as const }
  f.sessions.get(s1)!.inputs.push(manualInput)
  f.sessions.get(s1)!.turns.push(manualTurn)
  f.emit(s1, "input", manualInput, { inputId: manualInput.id, turnId: manualTurn.id })
  f.emit(s1, "turn", manualTurn, { turnId: manualTurn.id, inputId: manualInput.id })
  f.emit(s1, "acp", {
    sessionId: f.sessions.get(s1)!.session.providerSessionId!,
    update: { sessionUpdate: "tool_call", toolCallId: "manual-tc-1", title: "Manual grep secret", status: "in_progress" } as never,
  }, { turnId: manualTurn.id })
  f.emit(s1, "acp", {
    sessionId: f.sessions.get(s1)!.session.providerSessionId!,
    update: { sessionUpdate: "agent_message_chunk", messageId: "manual-ms", content: { type: "text", text: "Manual milestone" }, _meta: { deskfleet: { publicPurpose: "milestone" } } } as never,
  }, { turnId: manualTurn.id })
  f.emitPreview({
    sessionId: s1, streamId: "stream-manual", baseSeq: "100", offset: 0,
    events: [{ sessionId: s1, kind: "acp", turnId: manualTurn.id, createdAt: now(), payload: { sessionId: f.sessions.get(s1)!.session.providerSessionId!, update: { sessionUpdate: "agent_message_chunk", messageId: "manual-final", content: { type: "text", text: "Manual draft" }, _meta: { codex: { phase: "final_answer" } } } as never } }],
  })
  await sleep(50)

  // Manual turn MUST NOT leak any live feedback item/delta/process onto old SA Request req-1.
  assert.equal(pushesA.filter(p => p.event.type !== "snapshot_dirty").length, 0, "Manual Worker turn must not push any feedback onto old SA request")
  const snapAfterManual = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsA }, actor)
  assert.equal(snapAfterManual.feedback?.items.some(i => i.turnId === "turn-manual" || i.text.includes("Manual")), false)
  // deskfleet_sa_report from the manual turn must also be rejected instead of leaking into req-1.
  await assert.rejects(
    () => service.reportFromWorker(s1, { kind: "milestone", text: "Manual MCP report" }, actor),
    /not bound to a Super Agent request/,
  )

  // 3. Switch to Conversation B (wsB) while a second active SA Worker in wsA emits progress -> stays strictly in wsA!
  await service.handle("_deskfleet/super-agent/send", { workspaceId: wsA, messageId: "req-a2", text: "Task A2" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "req-a2" && i.phase === "sent") === true, "req-a2 sent")
  await service.handle("_deskfleet/super-agent/send", { workspaceId: wsB, messageId: "req-b1", text: "Task B1" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "req-b1" && i.phase === "sent") === true, "req-b1 sent")

  const pushesB: SuperFeedbackPush[] = []
  const subB = await service.subscribeFeedback({ workspaceId: wsB }, actor, p => pushesB.push(p))
  t.after(() => subB.unsubscribe())

  const intentA2 = f.store.get("alice")!.intents.find(i => i.messageId === "req-a2")!
  const sA2 = intentA2.sessionId!
  const turnA2 = { id: "turn-a2", sessionId: sA2, runGeneration: 1, dispatchCommandId: "da2", initialInputId: intentA2.inputId!, startedAt: now(), state: "running" as const }
  f.sessions.get(sA2)!.turns.push(turnA2)
  f.emit(sA2, "turn", turnA2, { turnId: turnA2.id, inputId: intentA2.inputId })
  f.emit(sA2, "acp", {
    sessionId: f.sessions.get(sA2)!.session.providerSessionId!,
    update: { sessionUpdate: "tool_call", toolCallId: "tc-a2", title: "Analyzing Project A", status: "in_progress" } as never,
  }, { turnId: turnA2.id })
  await sleep(40)

  assert.equal(pushesB.filter(p => p.event.type !== "snapshot_dirty").length, 0, "Conversation B must never receive Conversation A Worker progress")
  assert.ok(pushesA.some(p => p.event.type === "item_upsert" && p.event.item.sourceMessageId === "req-a2" && p.event.item.text === "Analyzing Project A"))
  const snapB = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: wsB }, actor)
  assert.equal(snapB.feedback?.items.some(i => i.sourceMessageId === "req-a2" || i.text.includes("Project A")), false)
})

test("P1-5: crossing delivery receipts buffer live progress without leaking to old request, and shared steered turns attribute accurately", async t => {
  const f = createFixture()
  const workspaceId = "ws-cross"
  let holdSubmit: { release: () => void } | undefined
  const origHandle = f.workers.handle
  f.workers.handle = async (method, params, who) => {
    if (method === "_deskfleet/input/submit" && holdSubmit) {
      const result = await origHandle(method, params, who) as { sessionId: string; inputId: string }
      // Simulate receipt crossing: Worker starts executing and emits live events BEFORE submit returns to checkpoint!
      const s = f.sessions.get(result.sessionId)!
      const turnId = `turn-cross-${result.inputId}`
      const turn = { id: turnId, sessionId: result.sessionId, runGeneration: 1, dispatchCommandId: `dc-${result.inputId}`, initialInputId: result.inputId, startedAt: now(), state: "running" as const }
      const inp = s.inputs.find(i => i.id === result.inputId)!
      inp.turnId = turnId
      inp.actualDelivery = "turn_start"
      s.turns.push(turn)
      f.emit(result.sessionId, "input", inp, { inputId: inp.id, turnId })
      f.emit(result.sessionId, "turn", turn, { turnId, inputId: inp.id })
      f.emit(result.sessionId, "acp", {
        sessionId: s.session.providerSessionId!,
        update: { sessionUpdate: "tool_call", toolCallId: `tc-${turnId}`, title: "Crossing receipt tool", status: "in_progress" } as never,
      }, { turnId })
      // Concurrently emit an unrelated manual turn while receipt is in flight -> must NOT leak after receipt arrives!
      const strayTurnId = `turn-stray-${result.inputId}`
      const strayTurn = { id: strayTurnId, sessionId: result.sessionId, runGeneration: 1, dispatchCommandId: "d-stray", initialInputId: "in-stray", startedAt: now(), state: "running" as const }
      s.turns.push(strayTurn)
      f.emit(result.sessionId, "turn", strayTurn, { turnId: strayTurnId, inputId: "in-stray" })
      f.emit(result.sessionId, "acp", {
        sessionId: s.session.providerSessionId!,
        update: { sessionUpdate: "tool_call", toolCallId: "tc-stray", title: "Stray manual tool", status: "in_progress" } as never,
      }, { turnId: strayTurnId })
      await new Promise<void>(resolve => { holdSubmit = { release: resolve } })
      return result
    }
    return origHandle(method, params, who)
  }

  let routeCount = 0
  const service = new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({}),
    agents: f.workers,
    store: f.store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [{ id: workspaceId, name: "Cross", roots: ["/tmp/cross"] }],
    ensureDefaultWorkspace: async () => workspaceId,
    authorize: async who => who,
    route: async ctx => {
      routeCount++
      if (routeCount === 1) {
        return { reason: "r1", actions: [{ kind: "create", title: "Shared Worker", scope: "s", prompt: ctx.text }] }
      }
      const tid = ctx.tickets[0]!.id
      if (routeCount === 2) {
        return { reason: "r2", actions: [{ kind: "continue", ticketId: tid, prompt: ctx.text }] }
      }
      return { reason: "r3-steer", actions: [{ kind: "continue", ticketId: tid, prompt: ctx.text, delivery: "steer" }] }
    },
  })
  await service.init()
  t.after(() => service.close())

  // Request 1 completes on Worker s1.
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "c-req-1", text: "First task" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "c-req-1" && i.phase === "sent") === true, "c-req-1 sent")
  const i1 = f.store.get("alice")!.intents.find(i => i.messageId === "c-req-1")!
  const s1 = i1.sessionId!
  const t1 = { id: "t-c1", sessionId: s1, runGeneration: 1, dispatchCommandId: "d1", initialInputId: i1.inputId!, startedAt: now(), state: "completed" as const }
  f.sessions.get(s1)!.turns.push(t1)
  f.emit(s1, "turn", t1, { turnId: t1.id, inputId: i1.inputId })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.sourceMessageId === "c-req-1" && m.workerEvent === "result"), "c-req-1 done")

  const pushes: SuperFeedbackPush[] = []
  const sub = await service.subscribeFeedback({ workspaceId }, actor, p => pushes.push(p))
  t.after(() => sub.unsubscribe())

  // Request 2 with held receipt (crossing arrival!).
  holdSubmit = { release: () => {} }
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "c-req-2", text: "Second task" }, actor)
  await until(() => (f.sessions.get(s1)?.turns.some(turn => turn.id.startsWith("turn-cross-")) ?? false), "crossing turn started")
  await sleep(40)

  // BEFORE receipt returns: neither the crossing tool nor the stray manual tool may leak onto c-req-1!
  assert.equal(pushes.some(p => p.event.type === "item_upsert" && p.event.item.sourceMessageId === "c-req-1" && (p.event.item.text.includes("Crossing") || p.event.item.text.includes("Stray"))), false)

  // Release receipt -> buffered crossing tool flushes strictly to c-req-2; stray manual tool is discarded!
  const release = holdSubmit.release
  holdSubmit = undefined
  release()
  await until(() => pushes.some(p => p.event.type === "item_upsert" && p.event.item.sourceMessageId === "c-req-2" && p.event.item.text === "Crossing receipt tool"), "crossing event flushed to c-req-2")
  await sleep(30)
  assert.equal(pushes.some(p => p.event.type === "item_upsert" && p.event.item.text === "Stray manual tool"), false, "Stray manual tool must be discarded after receipt resolution")

  // Shared turn (manual base turn steered by SA Request 3) -> progress attributes to c-req-3!
  const s = f.sessions.get(s1)!
  s.session.capabilities = { steering: true, resume: true, fork: false }
  const manualBaseTurn = { id: "turn-shared-manual", sessionId: s1, runGeneration: 1, dispatchCommandId: "d-mb", initialInputId: "in-manual-base", startedAt: now(), state: "running" as const }
  s.turns = [t1, manualBaseTurn]
  f.emit(s1, "turn", manualBaseTurn, { turnId: manualBaseTurn.id, inputId: "in-manual-base" })

  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "c-req-3", text: "Steer into shared turn" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "c-req-3" && i.phase === "sent") === true, "c-req-3 steer sent")
  const i3 = f.store.get("alice")!.intents.find(i => i.messageId === "c-req-3")!
  const steerInp = s.inputs.find(inp => inp.id === i3.inputId)!
  steerInp.turnId = manualBaseTurn.id
  steerInp.actualDelivery = "steer"
  f.emit(s1, "input", steerInp, { inputId: steerInp.id, turnId: manualBaseTurn.id })
  await sleep(20)
  f.emit(s1, "acp", {
    sessionId: s.session.providerSessionId!,
    update: { sessionUpdate: "tool_call", toolCallId: "tc-shared", title: "Shared turn progress", status: "in_progress" } as never,
  }, { turnId: manualBaseTurn.id })
  await until(() => pushes.some(p => p.event.type === "item_upsert" && p.event.item.sourceMessageId === "c-req-3" && p.event.item.text === "Shared turn progress"), "shared turn attributed to c-req-3")
})

test("P1-6: multi-chunk milestone updates in place before final reply, confirms full text at boundary, survives refresh/replay, and marks mid-stream crash aborted", async t => {
  const f = createFixture()
  const workspaceId = "ws-ms"
  const service = new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({}),
    agents: f.workers,
    store: f.store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [{ id: workspaceId, name: "Milestone Proj", roots: ["/tmp/ms"] }],
    ensureDefaultWorkspace: async () => workspaceId,
    authorize: async who => who,
    route: async ctx => ({
      reason: "dispatch",
      publicFeedback: { ack: "Investigating delivery issue." },
      actions: [{ kind: "create", title: ctx.text, scope: ctx.text, prompt: ctx.text }],
    }),
  })
  await service.init()
  t.after(() => service.close())

  const pushes: SuperFeedbackPush[] = []
  const sub = await service.subscribeFeedback({ workspaceId }, actor, p => pushes.push(p))
  t.after(() => sub.unsubscribe())

  // 1. Multi-chunk milestone with same messageId -> boundary confirmation -> final reply C.
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "ms-req-1", text: "Find delivery root cause" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "ms-req-1" && i.phase === "sent") === true, "ms-req-1 sent")
  const i1 = f.store.get("alice")!.intents.find(i => i.messageId === "ms-req-1")!
  const s1 = i1.sessionId!
  const prov1 = f.sessions.get(s1)!.session.providerSessionId!
  const t1 = { id: "t-ms-1", sessionId: s1, runGeneration: 1, dispatchCommandId: "dm1", initialInputId: i1.inputId!, startedAt: now(), state: "running" as const }
  f.sessions.get(s1)!.turns.push(t1)
  f.emit(s1, "turn", t1, { turnId: t1.id, inputId: i1.inputId })

  // Chunk 1 -> persisted as streaming ("定位到")
  f.emit(s1, "acp", {
    sessionId: prov1,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m-b1", content: { type: "text", text: "定位到" }, _meta: { codex: { phase: "partial_answer" } } } as never,
  }, { turnId: t1.id, inputId: i1.inputId })
  await until(async () => {
    const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
    return snap.feedback?.items.some(item => item.kind === "milestone" && item.sourceMessageId === "ms-req-1" && item.text === "定位到") === true
  }, "chunk 1 persisted")

  // Chunks 2 & 3 -> BEFORE any tool boundary or final reply, persisted & pushed text is COMPLETE ("定位到问题在投递环节。")!
  f.emit(s1, "acp", {
    sessionId: prov1,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m-b1", content: { type: "text", text: "问题在投递" }, _meta: { codex: { phase: "partial_answer" } } } as never,
  }, { turnId: t1.id, inputId: i1.inputId })
  f.emit(s1, "acp", {
    sessionId: prov1,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m-b1", content: { type: "text", text: "环节。" }, _meta: { codex: { phase: "partial_answer" } } } as never,
  }, { turnId: t1.id, inputId: i1.inputId })

  await until(async () => {
    const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
    return snap.feedback?.items.some(item => item.kind === "milestone" && item.sourceMessageId === "ms-req-1" && item.text === "定位到问题在投递环节。") === true
  }, "chunks 2+3 merged into persisted milestone before final reply")

  const midSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  const midMilestones = midSnap.feedback!.items.filter(item => item.kind === "milestone" && item.sourceMessageId === "ms-req-1")
  assert.equal(midMilestones.length, 1, "Multi-chunk milestone must stay a single item")
  assert.equal(midMilestones[0]!.text, "定位到问题在投递环节。")
  assert.equal(midMilestones[0]!.status, "streaming", "Still open before explicit boundary")
  assert.equal(midSnap.messages.some(m => m.sourceMessageId === "ms-req-1" && m.workerEvent === "result"), false, "Final reply has not arrived yet")
  assert.ok(pushes.some(p => p.event.type === "item_upsert" && p.event.item.itemId === midMilestones[0]!.itemId && p.event.item.text === "定位到问题在投递环节。"))

  // Explicit tool boundary while Worker is STILL running confirms the milestone as completed!
  f.emit(s1, "acp", {
    sessionId: prov1,
    update: { sessionUpdate: "tool_call", toolCallId: "tc-after-ms", title: "Applying delivery fix", status: "in_progress" } as never,
  }, { turnId: t1.id, inputId: i1.inputId })
  await until(async () => {
    const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
    return snap.feedback?.items.find(item => item.itemId === midMilestones[0]!.itemId)?.status === "completed"
  }, "boundary confirms milestone completed while still running")

  // Verify persisted store (simulating refresh/restart) holds the complete confirmed milestone.
  const persistedRoom = f.store.get("alice")!.rooms.find(r => r.workspaceId === workspaceId)!
  const storedMs = persistedRoom.feedbackItems!.filter(item => item.kind === "milestone" && item.sourceMessageId === "ms-req-1")
  assert.equal(storedMs.length, 1)
  assert.equal(storedMs[0]!.text, "定位到问题在投递环节。")
  assert.equal(storedMs[0]!.status, "completed")

  // Final reply C arrives -> milestone untouched, C delivered once without concatenating B.
  f.emit(s1, "acp", {
    sessionId: prov1,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m-c1", content: { type: "text", text: "投递修复已完成并验证。" }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: t1.id, inputId: i1.inputId })
  const done1 = { ...t1, state: "completed" as const }
  f.sessions.get(s1)!.turns = [done1]
  f.emit(s1, "turn", done1, { turnId: t1.id, inputId: i1.inputId })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.sourceMessageId === "ms-req-1" && m.workerEvent === "result"), "ms-req-1 final delivered")
  const endSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(endSnap.feedback!.items.filter(item => item.kind === "milestone" && item.sourceMessageId === "ms-req-1").length, 1)
  assert.equal(endSnap.messages.find(m => m.sourceMessageId === "ms-req-1" && m.workerEvent === "result")?.text, "投递修复已完成并验证。")

  // 2. Mid-stream crash during a multi-chunk milestone -> keeps all received chunks AND marks status "aborted"!
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "ms-req-crash", text: "Check secondary node" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "ms-req-crash" && i.phase === "sent") === true, "ms-req-crash sent")
  const i2 = f.store.get("alice")!.intents.find(i => i.messageId === "ms-req-crash")!
  const s2 = i2.sessionId!
  const prov2 = f.sessions.get(s2)!.session.providerSessionId!
  const t2 = { id: "t-ms-crash", sessionId: s2, runGeneration: 1, dispatchCommandId: "dm2", initialInputId: i2.inputId!, startedAt: now(), state: "running" as const }
  f.sessions.get(s2)!.turns.push(t2)
  f.emit(s2, "turn", t2, { turnId: t2.id, inputId: i2.inputId })
  f.emit(s2, "acp", {
    sessionId: prov2,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m-crash", content: { type: "text", text: "已定位到第一处" }, _meta: { codex: { phase: "partial_answer" } } } as never,
  }, { turnId: t2.id, inputId: i2.inputId })
  f.emit(s2, "acp", {
    sessionId: prov2,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m-crash", content: { type: "text", text: "异常节点" }, _meta: { codex: { phase: "partial_answer" } } } as never,
  }, { turnId: t2.id, inputId: i2.inputId })
  await until(async () => {
    const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
    return snap.feedback?.items.some(item => item.kind === "milestone" && item.sourceMessageId === "ms-req-crash" && item.text === "已定位到第一处异常节点") === true
  }, "crash milestone chunks accumulated")

  // Crash Worker run mid-milestone without emitting a closing boundary!
  f.emit(s2, "run", { sessionId: s2, generation: 1, state: "interrupted", startedAt: now(), error: "Worker died mid-milestone" })
  await until(async () => {
    const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
    return snap.feedback?.items.find(item => item.kind === "milestone" && item.sourceMessageId === "ms-req-crash")?.status === "aborted"
  }, "mid-stream milestone marked aborted on crash")

  const crashSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  const crashMs = crashSnap.feedback!.items.filter(item => item.kind === "milestone" && item.sourceMessageId === "ms-req-crash")
  assert.equal(crashMs.length, 1)
  assert.equal(crashMs[0]!.text, "已定位到第一处异常节点")
  assert.equal(crashMs[0]!.status, "aborted")
})

test("P1-5 Round 2: completed SA Worker running an independent manual turn never enters main chat or overwrites ticket summary, while subsequent SA dispatch still delivers", async t => {
  const f = createFixture()
  const ws = "proj-r2-p1"
  let routeStep = 0
  const service = new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({}),
    agents: f.workers,
    store: f.store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [{ id: ws, name: "Project R2", roots: ["/tmp/r2"] }],
    ensureDefaultWorkspace: async () => ws,
    authorize: async who => who,
    route: async ctx => {
      routeStep++
      if (routeStep === 1) {
        return { reason: "r1", publicFeedback: { ack: "Handling original SA task." }, actions: [{ kind: "create", title: "SA Task", scope: "SA scope", prompt: ctx.text }] }
      }
      return { reason: "r2", publicFeedback: { ack: "Handling SA follow-up." }, actions: [{ kind: "continue", ticketId: ctx.tickets[0]!.id, prompt: ctx.text }] }
    },
  })
  await service.init()
  t.after(() => service.close())

  // 1. Complete SA Request 1 -> confirm formal result and original ticket summary.
  await service.handle("_deskfleet/super-agent/send", { workspaceId: ws, messageId: "sa-req-1", text: "Run original SA task" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "sa-req-1" && i.phase === "sent") === true, "sa-req-1 sent")
  const intent1 = f.store.get("alice")!.intents.find(i => i.messageId === "sa-req-1")!
  const sessionId = intent1.sessionId!
  const prov = f.sessions.get(sessionId)!.session.providerSessionId!
  const t1 = { id: "turn-sa-1", sessionId, runGeneration: 1, dispatchCommandId: "d1", initialInputId: intent1.inputId!, startedAt: now(), state: "running" as const }
  f.sessions.get(sessionId)!.turns.push(t1)
  f.emit(sessionId, "turn", t1, { turnId: t1.id, inputId: intent1.inputId })
  f.emit(sessionId, "acp", {
    sessionId: prov,
    update: { sessionUpdate: "agent_message_chunk", messageId: "sa-c1", content: { type: "text", text: "原 SA 委托已完成。" }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: t1.id, inputId: intent1.inputId })
  const t1Done = { ...t1, state: "completed" as const }
  f.sessions.get(sessionId)!.turns = [t1Done]
  f.emit(sessionId, "turn", t1Done, { turnId: t1.id, inputId: intent1.inputId })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)).messages.some(m => m.sourceMessageId === "sa-req-1" && m.workerEvent === "result"), "sa-req-1 completed")

  const baseline = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
  const baselineMsgCount = baseline.messages.length
  assert.equal(baseline.tickets[0]!.summary, "原 SA 委托已完成。")
  assert.equal(baseline.tickets[0]!.status, undefined)

  const pushes: SuperFeedbackPush[] = []
  const sub = await service.subscribeFeedback({ workspaceId: ws }, actor, p => pushes.push(p))
  t.after(() => sub.unsubscribe())

  // 2. Open the SAME Worker directly and run a full independent manual turn through tool, permission, text, and completion!
  const manualInput = { id: "in-indep-manual", sessionId, submissionCommandId: "cmd-indep", author: actor, content: [{ type: "text" as const, text: "Independent manual prompt" }], acceptedSeq: "50", state: "delivered" as const, requestedDelivery: "backlog" as const, actualDelivery: "turn_start" as const, turnId: "turn-indep-manual", createdAt: now() }
  const manualTurn = { id: "turn-indep-manual", sessionId, runGeneration: 1, dispatchCommandId: "d-indep", initialInputId: manualInput.id, startedAt: now(), state: "running" as const }
  const manualPerm = {
    id: "perm-indep", sessionId, runGeneration: 1, turnId: manualTurn.id, state: "pending" as const, createdAt: now(),
    request: { sessionId: prov, toolCall: { toolCallId: "tc-indep", title: "Manual bash" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }] },
  }
  const sess = f.sessions.get(sessionId)!
  sess.inputs.push(manualInput)
  sess.turns.push(manualTurn)
  sess.permissions.push(manualPerm)
  f.emit(sessionId, "input", manualInput, { inputId: manualInput.id, turnId: manualTurn.id })
  f.emit(sessionId, "turn", manualTurn, { turnId: manualTurn.id, inputId: manualInput.id })
  f.emit(sessionId, "permission", manualPerm, { turnId: manualTurn.id })
  f.emit(sessionId, "acp", {
    sessionId: prov,
    update: { sessionUpdate: "tool_call", toolCallId: "tc-indep", title: "Manual bash", status: "in_progress" } as never,
  }, { turnId: manualTurn.id })
  f.emit(sessionId, "acp", {
    sessionId: prov,
    update: { sessionUpdate: "agent_message_chunk", messageId: "indep-final", content: { type: "text", text: "独立手动回合的终稿" }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: manualTurn.id })
  await sleep(40)

  // While running: zero live feedback, zero pending permission cards, ticket stays idle!
  const midManual = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
  assert.equal(midManual.tickets[0]!.status, undefined)
  assert.equal(midManual.pendingRequests?.length ?? 0, 0, "Independent manual permission must not surface in SA main chat")

  // Complete the independent manual turn!
  const manualPermDone = { ...manualPerm, state: "resolved" as const, optionId: "allow" }
  const manualDone = { ...manualTurn, state: "completed" as const }
  sess.permissions = [manualPermDone]
  sess.turns = [t1Done, manualDone]
  f.emit(sessionId, "permission", manualPermDone, { turnId: manualTurn.id })
  f.emit(sessionId, "turn", manualDone, { turnId: manualTurn.id, inputId: manualInput.id })
  await until(() => BigInt(f.store.get("alice")!.rooms.find(r => r.workspaceId === ws)!.tickets[0]!.lastEventSeq ?? "0") >= BigInt(sess.session.lastEventSeq), "replay advanced past manual turn")

  const afterManual = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
  assert.equal(pushes.filter(p => p.event.type !== "snapshot_dirty").length, 0, "Manual turn must emit 0 feedback items")
  assert.equal(afterManual.messages.length, baselineMsgCount, "Manual turn completion must NOT append any message to SA main chat")
  assert.equal(afterManual.messages.some(m => m.text.includes("独立手动回合的终稿") || m.turnId === manualTurn.id), false)
  assert.equal(afterManual.tickets[0]!.summary, "原 SA 委托已完成。", "Original ticket summary must remain unchanged")
  assert.equal(afterManual.tickets[0]!.status, undefined)
  assert.equal(afterManual.messages.filter(m => m.sourceMessageId === "sa-req-1" && m.workerEvent === "result").length, 1)

  // 3. Subsequent SA follow-up on the SAME Worker still delivers normally!
  await service.handle("_deskfleet/super-agent/send", { workspaceId: ws, messageId: "sa-req-2", text: "Continue SA task" }, actor)
  await until(() => f.store.get("alice")?.intents.some(i => i.messageId === "sa-req-2" && i.phase === "sent") === true, "sa-req-2 sent")
  const intent2 = f.store.get("alice")!.intents.find(i => i.messageId === "sa-req-2")!
  const t2 = { id: "turn-sa-2", sessionId, runGeneration: 1, dispatchCommandId: "d2", initialInputId: intent2.inputId!, startedAt: now(), state: "running" as const }
  sess.turns.push(t2)
  f.emit(sessionId, "turn", t2, { turnId: t2.id, inputId: intent2.inputId })
  f.emit(sessionId, "acp", {
    sessionId: prov,
    update: { sessionUpdate: "agent_message_chunk", messageId: "sa-c2", content: { type: "text", text: "SA 续派终稿正常交付。" }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: t2.id, inputId: intent2.inputId })
  const t2Done = { ...t2, state: "completed" as const }
  sess.turns = [t1Done, manualDone, t2Done]
  f.emit(sessionId, "turn", t2Done, { turnId: t2.id, inputId: intent2.inputId })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)).messages.some(m => m.sourceMessageId === "sa-req-2" && m.workerEvent === "result"), "sa-req-2 delivered")
  const finalSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
  assert.equal(finalSnap.messages.find(m => m.sourceMessageId === "sa-req-2" && m.workerEvent === "result")?.text, "SA 续派终稿正常交付。")
  assert.equal(finalSnap.tickets[0]!.summary, "SA 续派终稿正常交付。")
})

test("P2-7: real AgentJournal preview-then-commit delivers final_preview once without duplicating text", async t => {
  const dir = await mkdtemp(join(tmpdir(), "df-p2-7-"))
  const catalog = new DaemonCatalog(dir)
  await catalog.init()
  const journal = new AgentJournal(catalog.native)
  await journal.init()
  const store = new CountingMemoryStore()
  const ws = (await catalog.native.createWorkspace("P2-7", [{ path: dir }])).id
  t.after(async () => {
    await catalog.close()
    await rm(dir, { recursive: true, force: true })
  })

  const workers: SuperWorkers = {
    async handle(method, args, who) {
      const a = args as Record<string, string>
      if (method === "_deskfleet/session/create") {
        const cmd: AgentCommand = { id: await journal.id(), operationId: a.operationId, workspaceId: a.workspaceId, method, params: a, actor: who, status: "accepted", isCanonical: true, receivedAt: now() }
        const created = await journal.create(cmd, a.workspaceId, a.title || "Worker", "directory", a.provider || "codex")
        const ready: AgentSessionRecord = { ...created, lifecycle: "ready", providerSessionId: `prov-${created.id}`, updatedAt: now() }
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
          content: [{ type: "text" as const, text: "check" }], acceptedSeq: snap.session.lastEventSeq,
          state: "delivered" as const, requestedDelivery: "backlog" as const, createdAt: now(),
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

  const service = new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({}),
    agents: workers,
    store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [{ id: ws, name: "P2-7", roots: [dir] }],
    ensureDefaultWorkspace: async () => ws,
    authorize: async who => who,
    route: async ctx => ({ reason: "dispatch", actions: [{ kind: "create", title: "Audit", scope: "Audit", prompt: ctx.text }] }),
  })
  await service.init()
  t.after(() => service.close())

  await service.handle("_deskfleet/super-agent/send", { workspaceId: ws, messageId: "p2-7-req", text: "核对数据" }, actor)
  await until(() => store.get("alice")?.intents.some(i => i.messageId === "p2-7-req" && i.phase === "sent") === true, "p2-7 sent")
  const intent = store.get("alice")!.intents.find(i => i.messageId === "p2-7-req")!
  const sessionId = intent.sessionId!
  const snap0 = await journal.read(sessionId)
  const run = { sessionId, generation: 1, state: "running" as const, startedAt: now() }
  const turn = { id: await journal.id(), sessionId, runGeneration: 1, dispatchCommandId: snap0.inputs[0]!.submissionCommandId, initialInputId: intent.inputId!, startedAt: now(), state: "running" as const }
  await journal.commit(snap0, { runs: [run], turns: [turn], events: [journal.event(sessionId, "run", run, { runGeneration: 1 }), journal.event(sessionId, "turn", turn, { turnId: turn.id, inputId: intent.inputId })] })
  await until(() => store.get("alice")?.rooms.find(r => r.workspaceId === ws)?.tickets[0]?.status === "working", "turn running")

  // 1. Stream via REAL AgentJournal.stream() -> triggers onPreview!
  const draft = journal.event(sessionId, "acp", {
    sessionId: snap0.session.providerSessionId!,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m-p2-7", content: { type: "text", text: "数据已核对" }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: turn.id })
  await journal.stream(draft, err => { throw err })
  const previewSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
  const previewBeforeCommit = previewSnap.feedback!.items.find(item => item.kind === "final_preview" && item.sourceMessageId === "p2-7-req")
  assert.equal(previewBeforeCommit?.text, "数据已核对")

  // 2. Flush stream through REAL AgentJournal.serial() -> commits the exact previewed event & fires onEvent!
  await journal.serial(sessionId, async () => {})
  await sleep(40)
  const afterCommitSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
  const previewAfterCommit = afterCommitSnap.feedback!.items.find(item => item.kind === "final_preview" && item.sourceMessageId === "p2-7-req")
  assert.equal(previewAfterCommit?.text, "数据已核对", "Committed journal event must confirm preview without duplicating text")

  // 3. Complete turn -> single formal delivery with "数据已核对".
  const snapBeforeEnd = await journal.read(sessionId)
  const turnDone = { ...turn, state: "completed" as const, endedAt: now() }
  await journal.commit(snapBeforeEnd, { turns: [turnDone], events: [journal.event(sessionId, "turn", turnDone, { turnId: turn.id, inputId: intent.inputId })] })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)).messages.some(m => m.sourceMessageId === "p2-7-req" && m.workerEvent === "result"), "p2-7 completed")
  const finalSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
  assert.equal(finalSnap.messages.filter(m => m.sourceMessageId === "p2-7-req" && m.workerEvent === "result").length, 1)
  assert.equal(finalSnap.messages.find(m => m.sourceMessageId === "p2-7-req" && m.workerEvent === "result")?.text, "数据已核对")
})

test("P2-8: untagged multi-message output preserves earlier conclusion and marks unboundedOutcome instead of mistaking trailing process narration as final answer", async () => {
  const room = roomFor(emptyState(), workspaceId, "codex")
  const user = note(room, "Analyze delivery", { id: "u-p2-8", role: "user", ticketId: "tk-p2-8", state: "assigned" })
  const ticket = { id: "tk-p2-8", title: "Analyze", scope: "Analyze", summary: "", provider: "codex", sessionId: "s-p2-8", status: "working" as const, updatedAt: now() }
  room.tickets.push(ticket)
  const intent = {
    id: "i-p2-8", roomId: workspaceId, messageId: user.id, ticketId: ticket.id, actor, provider: "codex",
    sessionId: "s-p2-8", prompt: "Analyze", createId: "c1", submitId: "s1", inputId: "in-p2-8", operation: "submit" as const, phase: "sent" as const,
  }
  const turn = { id: "turn-p2-8", sessionId: "s-p2-8", runGeneration: 1, dispatchCommandId: "d8", initialInputId: "in-p2-8", startedAt: now(), state: "completed" as const }
  const snap: AgentSnapshot = {
    session: { id: "s-p2-8", title: "S", workspaceId, provider: "codex", providerSessionId: "prov-8", context: "directory", lifecycle: "ready", archiveState: "active", createdAt: now(), updatedAt: now(), lastEventSeq: "3" },
    runs: [], turns: [turn], inputs: [], permissions: [], elicitations: [],
  }
  // Distinct messageIds with NO phase/purpose tags: conclusion first, then "我再检查一下。" -> turn ends!
  projectSuperEvents(room, ticket, [
    { sessionId: "s-p2-8", seq: "1", kind: "acp", turnId: turn.id, inputId: "in-p2-8", createdAt: now(), payload: { sessionId: "prov-8", update: { sessionUpdate: "agent_message_chunk", messageId: "m-1", content: { type: "text", text: "已确认的分析主体。" } } as never } },
    { sessionId: "s-p2-8", seq: "2", kind: "acp", turnId: turn.id, inputId: "in-p2-8", createdAt: now(), payload: { sessionId: "prov-8", update: { sessionUpdate: "agent_message_chunk", messageId: "m-2", content: { type: "text", text: "我再检查一下。" } } as never } },
    { sessionId: "s-p2-8", seq: "3", kind: "turn", turnId: turn.id, inputId: "in-p2-8", createdAt: now(), payload: turn },
  ], snap, [intent])

  const result = room.messages.find(m => m.ticketId === ticket.id && m.workerEvent === "result")!
  assert.ok(result.text.includes("已确认的分析主体。"), `Earlier conclusion must be preserved, got: ${result.text}`)
  assert.equal(result.unboundedOutcome, true, "Untagged multi-message turn must be marked unboundedOutcome")

  // Single untagged tentative narration ("我再检查一下。") also sets unboundedOutcome = true.
  const ticket2 = { id: "tk-p2-8b", title: "Analyze2", scope: "Analyze2", summary: "", provider: "codex", sessionId: "s-p2-8b", status: "working" as const, updatedAt: now() }
  room.tickets.push(ticket2)
  const intent2 = { ...intent, id: "i-p2-8b", ticketId: ticket2.id, sessionId: "s-p2-8b", inputId: "in-p2-8b" }
  const turn2 = { ...turn, id: "turn-p2-8b", sessionId: "s-p2-8b", initialInputId: "in-p2-8b" }
  const snap2: AgentSnapshot = { ...snap, session: { ...snap.session, id: "s-p2-8b", providerSessionId: "prov-8b" }, turns: [turn2] }
  projectSuperEvents(room, ticket2, [
    { sessionId: "s-p2-8b", seq: "1", kind: "acp", turnId: turn2.id, inputId: "in-p2-8b", createdAt: now(), payload: { sessionId: "prov-8b", update: { sessionUpdate: "agent_message_chunk", messageId: "m-solo", content: { type: "text", text: "我再检查一下。" } } as never } },
    { sessionId: "s-p2-8b", seq: "2", kind: "turn", turnId: turn2.id, inputId: "in-p2-8b", createdAt: now(), payload: turn2 },
  ], snap2, [intent2])
  const result2 = room.messages.find(m => m.ticketId === ticket2.id && m.workerEvent === "result")!
  assert.equal(result2.text, "我再检查一下。")
  assert.equal(result2.unboundedOutcome, true)
})

test("P2-10: pure evidence-gathering substantive task emits opening ack before slow read even when coordinator omits publicFeedback.ack, while simple Q&A stays silent", async t => {
  const f = createFixture()
  const readGate = gate()
  const service = new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [{ id: "m1", name: "M1", reasoningEfforts: ["low"] }], defaultModel: "m1", defaultReasoningEfforts: ["low"] }),
    coordinatorModel: () => async () => ({}),
    agents: f.workers,
    store: f.store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [{ id: workspaceId, name: "Project A", roots: ["/tmp/proj-a"] }],
    ensureDefaultWorkspace: async () => workspaceId,
    authorize: async who => who,
    route: (ctx, opts) => routeSuperMessage(ctx, {
      ...opts,
      evidence: async req => {
        if (ctx.text.includes("兼容性报告")) await readGate.wait
        return `Evidence for ${req.kind}`
      },
      model: async packet => {
        const ev = packet.evidence as unknown[]
        if (!ev.length) {
          if (ctx.text.includes("兼容性报告")) {
            // Deliberately OMIT optional publicFeedback.ack!
            return { reason: "Read compatibility notes", actions: [{ kind: "evidence", request: { kind: "read", workspaceId, rootIndex: 0, path: "docs/compat.md" } }] }
          }
          return { reason: "Quick ticket check", actions: [{ kind: "evidence", request: { kind: "read", workspaceId, rootIndex: 0, path: "docs/note.md" } }] }
        }
        return { reason: "Grounded answer", actions: [{ kind: "answer", text: ctx.text.includes("兼容性报告") ? "Mac 与 iPhone 兼容性报告：全部通过。" : "That means ready." }] }
      },
    }),
  })
  await service.init()
  t.after(() => { readGate.release(); return service.close() })

  const pushes: SuperFeedbackPush[] = []
  const sub = await service.subscribeFeedback({ workspaceId }, actor, p => pushes.push(p))
  t.after(() => sub.unsubscribe())

  // 1. Substantive pure-evidence task omitting publicFeedback.ack -> host emits opening ack BEFORE slow read finishes!
  await service.handle("_deskfleet/super-agent/send", {
    workspaceId, messageId: "ev-substantive", text: "请核对 Mac 与 iPhone 的兼容性，给我一份兼容性报告。",
  }, actor)
  await until(() => pushes.some(p => p.event.type === "item_upsert" && p.event.item.sourceMessageId === "ev-substantive" && p.event.item.kind === "ack"), "fallback ack emitted during pending evidence read")

  const duringRead = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  const acksDuring = duringRead.feedback!.items.filter(i => i.sourceMessageId === "ev-substantive" && i.kind === "ack")
  assert.equal(acksDuring.length, 1)
  assert.ok(acksDuring[0]!.text.includes("compat.md"))
  assert.equal(duringRead.messages.some(m => m.role === "assistant" && m.sourceMessageId === "ev-substantive"), false, "Final answer has not arrived while read is suspended")

  readGate.release()
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.role === "assistant" && m.sourceMessageId === "ev-substantive"), "substantive evidence answer arrived")
  const afterSubstantive = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(afterSubstantive.feedback!.items.filter(i => i.sourceMessageId === "ev-substantive" && i.kind === "ack").length, 1)
  assert.equal(afterSubstantive.tickets.length, 0)

  // 2. Simple short question -> stays silent with 0 opening ack!
  await service.handle("_deskfleet/super-agent/send", {
    workspaceId, messageId: "ev-simple", text: "What does that mean?",
  }, actor)
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)).messages.some(m => m.role === "assistant" && m.sourceMessageId === "ev-simple"), "simple answer arrived")
  const afterSimple = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  assert.equal(afterSimple.feedback!.items.filter(i => i.sourceMessageId === "ev-simple" && i.kind === "ack").length, 0, "Simple Q&A must not emit fallback opening ack")
})

async function createJournalHarness(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const catalog = new DaemonCatalog(dir)
  await catalog.init()
  const journal = new AgentJournal(catalog.native)
  await journal.init()
  const store = new CountingMemoryStore()
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
        const isSteer = a.delivery === "steer"
        const input = {
          id: inputId, sessionId: a.sessionId, submissionCommandId: commandId, author: who,
          content: [{ type: "text" as const, text: a.text || "run" }],
          acceptedSeq: String(BigInt(snap.session.lastEventSeq) + 1n),
          state: "delivered" as const,
          requestedDelivery: isSteer ? "steer" as const : "backlog" as const,
          ...(isSteer && a.turnId ? { requestedTurnId: a.turnId, turnId: a.turnId, actualDelivery: "steer" as const, deliveredAt: now() } : {}),
          createdAt: now(),
        }
        const cmd: AgentCommand = {
          id: commandId, operationId: a.operationId, sessionId: a.sessionId, method, params: a, actor: who,
          status: "completed", isCanonical: true, result: { operationId: a.operationId, sessionId: a.sessionId, commandId, inputId },
          receivedAt: now(), completedAt: now(),
        }
        await journal.commit(snap, {
          command: cmd, inputs: [input],
          events: [journal.event(a.sessionId, "input", input, { inputId, ...(isSteer && a.turnId ? { turnId: a.turnId } : {}) })],
        })
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
    route: async ctx => ({ reason: "dispatch", actions: [{ kind: "create", title: "Audit", scope: "Audit", prompt: ctx.text }] }),
  })
  const cleanup = async () => {
    await catalog.close()
    await rm(dir, { recursive: true, force: true })
  }
  return { dir, catalog, journal, store, ws, workers, createService, cleanup }
}

test("P2-15: anonymous public progress without messageId stays a single item after journal commit, while separate progress after a boundary stays distinct", async t => {
  const h = await createJournalHarness("df-p2-15-")
  t.after(h.cleanup)
  const service = h.createService()
  await service.init()
  t.after(() => service.close())

  await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: "p2-15-req", text: "核对账单" }, actor)
  await until(() => h.store.get("alice")?.intents.some(i => i.messageId === "p2-15-req" && i.phase === "sent") === true, "p2-15 sent")
  const intent = h.store.get("alice")!.intents.find(i => i.messageId === "p2-15-req")!
  const sessionId = intent.sessionId!
  const snap0 = await h.journal.read(sessionId)
  const prov = snap0.session.providerSessionId!
  const run = { sessionId, generation: 1, state: "running" as const, startedAt: now() }
  const turn = { id: await h.journal.id(), sessionId, runGeneration: 1, dispatchCommandId: snap0.inputs[0]!.submissionCommandId, initialInputId: intent.inputId!, startedAt: now(), state: "running" as const }
  await h.journal.commit(snap0, {
    runs: [run], turns: [turn],
    events: [h.journal.event(sessionId, "run", run, { runGeneration: 1 }), h.journal.event(sessionId, "turn", turn, { turnId: turn.id, inputId: intent.inputId })],
  })
  await until(() => h.store.get("alice")?.rooms.find(r => r.workspaceId === h.ws)?.tickets[0]?.status === "working", "p2-15 running")

  // 1. Stream two anonymous commentary chunks ("正在" + "核对") with NO messageId!
  for (const text of ["正在", "核对"]) {
    const draft = h.journal.event(sessionId, "acp", {
      sessionId: prov,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, _meta: { codex: { phase: "commentary" }, deskfleet: { purpose: "activity" } } } as never,
    }, { turnId: turn.id })
    await h.journal.stream(draft, err => { throw err })
  }
  const beforeCommit = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
  const commentaryBefore = beforeCommit.feedback!.items.filter(i => i.sourceMessageId === "p2-15-req" && i.kind === "activity" && i.activityKind === "commentary")
  assert.deepEqual(commentaryBefore.map(i => i.text), ["正在核对"], "Before commit: exactly 1 combined item")

  // 2. Commit journal stream -> MUST remain 1 item "正在核对" (NOT "正在核对", "正在", "核对"!).
  await h.journal.serial(sessionId, async () => {})
  await sleep(40)
  const afterCommit = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
  const commentaryAfter = afterCommit.feedback!.items.filter(i => i.sourceMessageId === "p2-15-req" && i.kind === "activity" && i.activityKind === "commentary")
  assert.deepEqual(commentaryAfter.map(i => i.text), ["正在核对"], "After commit: must stay a single complete item without appending fragments")

  // 3. Tool boundary separates a second independent anonymous progress ("准备" + "写入").
  const snapMid = await h.journal.read(sessionId)
  await h.journal.commit(snapMid, {
    events: [h.journal.event(sessionId, "acp", {
      sessionId: prov,
      update: { sessionUpdate: "tool_call", toolCallId: "tc-mid", title: "Read ledger", status: "completed" } as never,
    }, { turnId: turn.id })],
  })
  for (const text of ["准备", "写入"]) {
    const draft = h.journal.event(sessionId, "acp", {
      sessionId: prov,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, _meta: { codex: { phase: "commentary" } } } as never,
    }, { turnId: turn.id })
    await h.journal.stream(draft, err => { throw err })
  }
  await h.journal.serial(sessionId, async () => {})
  await sleep(40)
  const afterSecond = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
  const commentaryBoth = afterSecond.feedback!.items.filter(i => i.sourceMessageId === "p2-15-req" && i.kind === "activity" && i.activityKind === "commentary")
  assert.deepEqual(commentaryBoth.map(i => i.text), ["正在核对", "准备写入"], "Two anonymous commentary items separated by a tool boundary stay distinct")

  // 4. Complete turn and verify reopened history reconstruction yields the exact same 2 commentary items + 1 tool.
  const snapEnd = await h.journal.read(sessionId)
  const turnDone = { ...turn, state: "completed" as const, endedAt: now() }
  await h.journal.commit(snapEnd, {
    turns: [turnDone],
    events: [
      h.journal.event(sessionId, "acp", {
        sessionId: prov,
        update: { sessionUpdate: "agent_message_chunk", messageId: "m-final-15", content: { type: "text", text: "账单核对完成。" }, _meta: { codex: { phase: "final_answer" } } } as never,
      }, { turnId: turn.id }),
      h.journal.event(sessionId, "turn", turnDone, { turnId: turn.id, inputId: intent.inputId }),
    ],
  })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)).messages.some(m => m.sourceMessageId === "p2-15-req" && m.workerEvent === "result"), "p2-15 finished")
  await service.close()

  const reopened = h.createService()
  await reopened.init()
  t.after(() => reopened.close())
  const proc = await reopened.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "p2-15-req" }, actor)
  assert.deepEqual(proc.items.filter(i => i.activityKind === "commentary").map(i => i.text), ["正在核对", "准备写入"])
  assert.equal(proc.items.filter(i => i.activityKind === "tool").length, 1)
})

test("P2-16: real AgentJournal streaming batches of both 512 and 513 chunks never duplicate the first character on commit and save exact final text", async t => {
  for (const chunkCount of [512, 513]) {
    const h = await createJournalHarness(`df-p2-16-${chunkCount}-`)
    t.after(h.cleanup)
    const service = h.createService()
    await service.init()
    t.after(() => service.close())

    const reqId = `p2-16-req-${chunkCount}`
    await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: reqId, text: `长回复 ${chunkCount}` }, actor)
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
    await until(() => h.store.get("alice")?.rooms.find(r => r.workspaceId === h.ws)?.tickets[0]?.status === "working", `${reqId} running`)

    // Stream `chunkCount` single-char chunks in ONE uncommitted batch; first char '首' makes any duplication unmistakable!
    const expectedText = "首" + "字".repeat(chunkCount - 1)
    for (let i = 0; i < expectedText.length; i++) {
      const draft = h.journal.event(sessionId, "acp", {
        sessionId: prov,
        update: { sessionUpdate: "agent_message_chunk", messageId: `m-final-${chunkCount}`, content: { type: "text", text: expectedText[i]! }, _meta: { codex: { phase: "final_answer" } } } as never,
      }, { turnId: turn.id })
      await h.journal.stream(draft, err => { throw err })
    }

    const beforeCommit = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
    const previewBefore = beforeCommit.feedback!.items.find(i => i.kind === "final_preview" && i.sourceMessageId === reqId)
    assert.equal(previewBefore?.text.length, chunkCount, `${chunkCount} chunks before commit length`)
    assert.equal(previewBefore?.text, expectedText, `${chunkCount} chunks before commit exact text`)

    // Flush stream -> commits all `chunkCount` chunks; preview MUST NOT append duplicate first char!
    await h.journal.serial(sessionId, async () => {})
    await sleep(40)
    const afterCommit = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
    const previewAfter = afterCommit.feedback!.items.find(i => i.kind === "final_preview" && i.sourceMessageId === reqId)
    assert.equal(previewAfter?.text.length, chunkCount, `${chunkCount} chunks after commit must not duplicate first character`)
    assert.equal(previewAfter?.text, expectedText, `${chunkCount} chunks after commit exact text`)

    // Complete turn -> formal saved result matches exact text once!
    const snapEnd = await h.journal.read(sessionId)
    const turnDone = { ...turn, state: "completed" as const, endedAt: now() }
    await h.journal.commit(snapEnd, { turns: [turnDone], events: [h.journal.event(sessionId, "turn", turnDone, { turnId: turn.id, inputId: intent.inputId })] })
    await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)).messages.some(m => m.sourceMessageId === reqId && m.workerEvent === "result"), `${reqId} completed`)
    const finalSnap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
    const results = finalSnap.messages.filter(m => m.sourceMessageId === reqId && m.workerEvent === "result")
    assert.equal(results.length, 1)
    assert.equal(results[0]!.text, expectedText)
  }
})

test("P2-17: reopening a completed task with 85 tool calls paginates 80 + 5 with valid nextAfterSeq, zero duplicates, and zero omissions", async t => {
  const h = await createJournalHarness("df-p2-17-")
  t.after(h.cleanup)
  const service = h.createService()
  await service.init()

  await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: "p2-17-req", text: "执行 85 次工具检查" }, actor)
  await until(() => h.store.get("alice")?.intents.some(i => i.messageId === "p2-17-req" && i.phase === "sent") === true, "p2-17 sent")
  const intent = h.store.get("alice")!.intents.find(i => i.messageId === "p2-17-req")!
  const sessionId = intent.sessionId!
  const snap0 = await h.journal.read(sessionId)
  const prov = snap0.session.providerSessionId!
  const run = { sessionId, generation: 1, state: "running" as const, startedAt: now() }
  const turn = { id: await h.journal.id(), sessionId, runGeneration: 1, dispatchCommandId: snap0.inputs[0]!.submissionCommandId, initialInputId: intent.inputId!, startedAt: now(), state: "running" as const }
  await h.journal.commit(snap0, {
    runs: [run], turns: [turn],
    events: [h.journal.event(sessionId, "run", run, { runGeneration: 1 }), h.journal.event(sessionId, "turn", turn, { turnId: turn.id, inputId: intent.inputId })],
  })

  // Execute 85 distinct tools (each with in_progress + completed -> 170 raw ACP events) and finish turn!
  const toolEvents: ReturnType<typeof h.journal.event>[] = []
  for (let i = 1; i <= 85; i++) {
    const label = `Inspect step ${String(i).padStart(2, "0")}`
    const toolCallId = `tc-${String(i).padStart(2, "0")}`
    toolEvents.push(h.journal.event(sessionId, "acp", {
      sessionId: prov,
      update: { sessionUpdate: "tool_call", toolCallId, title: label, status: "in_progress" } as never,
    }, { turnId: turn.id }))
    toolEvents.push(h.journal.event(sessionId, "acp", {
      sessionId: prov,
      update: { sessionUpdate: "tool_call_update", toolCallId, title: label, status: "completed" } as never,
    }, { turnId: turn.id }))
  }
  const snapTools = await h.journal.read(sessionId)
  const turnDone = { ...turn, state: "completed" as const, endedAt: now() }
  await h.journal.commit(snapTools, {
    turns: [turnDone],
    events: [
      ...toolEvents,
      h.journal.event(sessionId, "acp", {
        sessionId: prov,
        update: { sessionUpdate: "agent_message_chunk", messageId: "m-final-85", content: { type: "text", text: "85 项工具检查全部完成。" }, _meta: { codex: { phase: "final_answer" } } } as never,
      }, { turnId: turn.id }),
      h.journal.event(sessionId, "turn", turnDone, { turnId: turn.id, inputId: intent.inputId }),
    ],
  })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)).messages.some(m => m.sourceMessageId === "p2-17-req" && m.workerEvent === "result"), "p2-17 finished")

  // Close & reopen host completely so in-memory SuperFeedbackHub starts empty!
  await service.close()
  const reopened = h.createService()
  await reopened.init()
  t.after(() => reopened.close())

  const snapReopened = await reopened.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
  assert.equal(snapReopened.feedback!.processes.find(p => p.sourceMessageId === "p2-17-req")?.activityCount, 85)

  // Page 1 (default limit 80): must return first 80 tools + hasMore: true + valid nextAfterSeq!
  const page1 = await reopened.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "p2-17-req" }, actor)
  assert.equal(page1.items.length, 80)
  assert.equal(page1.hasMore, true)
  assert.equal(page1.nextAfterSeq, "80")
  assert.equal(page1.items[0]!.text, "Inspect step 01")
  assert.equal(page1.items[79]!.text, "Inspect step 80")

  // Page 2 ("Load more" using page1.nextAfterSeq): must return remaining 5 tools + hasMore: false!
  const page2 = await reopened.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "p2-17-req", afterSeq: page1.nextAfterSeq }, actor)
  assert.equal(page2.items.length, 5)
  assert.equal(page2.hasMore, false)
  assert.equal(page2.nextAfterSeq, undefined)
  assert.equal(page2.items[0]!.text, "Inspect step 81")
  assert.equal(page2.items[4]!.text, "Inspect step 85")

  // Combined 85 items: unique IDs, exact order 01..85, zero duplicates, zero omissions!
  const combined = [...page1.items, ...page2.items]
  assert.equal(combined.length, 85)
  assert.equal(new Set(combined.map(i => i.itemId)).size, 85)
  assert.deepEqual(
    combined.map(i => i.text),
    Array.from({ length: 85 }, (_, i) => `Inspect step ${String(i + 1).padStart(2, "0")}`),
  )
})

test("P1-22: same Worker running stock check -> continued bill check -> independent manual bookmark check keeps bill View Process strictly isolated before and after reopen", async t => {
  const h = await createJournalHarness("df-p1-22-")
  t.after(h.cleanup)
  let routeStep = 0
  const makeService = () => new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({}),
    agents: h.workers,
    store: h.store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [{ id: h.ws, name: "P1-22", roots: [h.dir] }],
    ensureDefaultWorkspace: async () => h.ws,
    authorize: async who => who,
    route: async ctx => {
      routeStep++
      if (routeStep === 1) {
        return { reason: "r1", actions: [{ kind: "create", title: "Inventory Worker", scope: "Check stock & bills", prompt: ctx.text }] }
      }
      return { reason: "r2", actions: [{ kind: "continue", ticketId: ctx.tickets[0]!.id, prompt: ctx.text }] }
    },
  })
  const service = makeService()
  await service.init()

  // 1. Request 1: check inventory ("核对库存").
  await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: "req-stock", text: "核对库存" }, actor)
  await until(() => h.store.get("alice")?.intents.some(i => i.messageId === "req-stock" && i.phase === "sent") === true, "req-stock sent")
  const intent1 = h.store.get("alice")!.intents.find(i => i.messageId === "req-stock")!
  const sessionId = intent1.sessionId!
  const snap0 = await h.journal.read(sessionId)
  const prov = snap0.session.providerSessionId!
  const run = { sessionId, generation: 1, state: "running" as const, startedAt: now() }
  const turn1 = { id: await h.journal.id(), sessionId, runGeneration: 1, dispatchCommandId: snap0.inputs[0]!.submissionCommandId, initialInputId: intent1.inputId!, startedAt: now(), state: "running" as const }
  await h.journal.commit(snap0, {
    runs: [run], turns: [turn1],
    events: [h.journal.event(sessionId, "run", run, { runGeneration: 1 }), h.journal.event(sessionId, "turn", turn1, { turnId: turn1.id, inputId: intent1.inputId })],
  })
  const snap1 = await h.journal.read(sessionId)
  const turn1Done = { ...turn1, state: "completed" as const, endedAt: now() }
  await h.journal.commit(snap1, {
    turns: [turn1Done],
    events: [
      h.journal.event(sessionId, "acp", { sessionId: prov, update: { sessionUpdate: "tool_call", toolCallId: "tc-stock", title: "第一条委托的库存核对", status: "completed" } as never }, { turnId: turn1.id }),
      h.journal.event(sessionId, "acp", { sessionId: prov, update: { sessionUpdate: "agent_message_chunk", messageId: "m-stock-final", content: { type: "text", text: "库存核对完成。" }, _meta: { codex: { phase: "final_answer" } } } as never }, { turnId: turn1.id }),
      h.journal.event(sessionId, "turn", turn1Done, { turnId: turn1.id, inputId: intent1.inputId }),
    ],
  })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)).messages.some(m => m.sourceMessageId === "req-stock" && m.workerEvent === "result"), "req-stock completed")

  // 2. Request 2: continue on the SAME Worker to check bills ("核对账单").
  await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: "req-bill", text: "核对账单" }, actor)
  await until(() => h.store.get("alice")?.intents.some(i => i.messageId === "req-bill" && i.phase === "sent") === true, "req-bill sent")
  const intent2 = h.store.get("alice")!.intents.find(i => i.messageId === "req-bill")!
  assert.equal(intent2.sessionId, sessionId, "Request 2 must reuse the same Worker session")

  // Even BEFORE turn-2 starts, opening View Process for req-bill must NOT leak req-stock's tool!
  const beforeTurn2Proc = await service.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "req-bill" }, actor)
  assert.equal(beforeTurn2Proc.items.length, 0, "Unstarted continued request must not leak earlier turns from same Worker")

  const snap2a = await h.journal.read(sessionId)
  const input2Rec = snap2a.inputs.find(i => i.id === intent2.inputId)!
  const turn2 = { id: await h.journal.id(), sessionId, runGeneration: 1, dispatchCommandId: input2Rec.submissionCommandId, initialInputId: intent2.inputId!, startedAt: now(), state: "running" as const }
  await h.journal.commit(snap2a, {
    turns: [turn2],
    events: [h.journal.event(sessionId, "turn", turn2, { turnId: turn2.id, inputId: intent2.inputId })],
  })
  const snap2b = await h.journal.read(sessionId)
  const turn2Done = { ...turn2, state: "completed" as const, endedAt: now() }
  await h.journal.commit(snap2b, {
    turns: [turn2Done],
    events: [
      h.journal.event(sessionId, "acp", { sessionId: prov, update: { sessionUpdate: "tool_call", toolCallId: "tc-bill", title: "第二条委托的账单核对", status: "completed" } as never }, { turnId: turn2.id }),
      h.journal.event(sessionId, "acp", { sessionId: prov, update: { sessionUpdate: "agent_message_chunk", messageId: "m-bill-final", content: { type: "text", text: "账单核对完成。" }, _meta: { codex: { phase: "final_answer" } } } as never }, { turnId: turn2.id }),
      h.journal.event(sessionId, "turn", turn2Done, { turnId: turn2.id, inputId: intent2.inputId }),
    ],
  })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)).messages.some(m => m.sourceMessageId === "req-bill" && m.workerEvent === "result"), "req-bill completed")

  // 3. Independent manual task on the SAME Worker: organize bookmarks ("整理书签").
  const snap3a = await h.journal.read(sessionId)
  const manualCmdId = await h.journal.id()
  const manualInputId = await h.journal.id()
  const manualTurnId = await h.journal.id()
  const manualCmd: AgentCommand = {
    id: manualCmdId, operationId: crypto.randomUUID(), sessionId, method: "_deskfleet/input/submit", params: { text: "整理书签" }, actor,
    status: "completed", isCanonical: true, receivedAt: now(), completedAt: now(),
  }
  const manualInput = {
    id: manualInputId, sessionId, submissionCommandId: manualCmdId, author: actor,
    content: [{ type: "text" as const, text: "整理书签" }], acceptedSeq: snap3a.session.lastEventSeq,
    state: "delivered" as const, requestedDelivery: "backlog" as const, actualDelivery: "turn_start" as const, turnId: manualTurnId, createdAt: now(),
  }
  const manualTurnDone = { id: manualTurnId, sessionId, runGeneration: 1, dispatchCommandId: manualCmdId, initialInputId: manualInputId, startedAt: now(), endedAt: now(), state: "completed" as const }
  await h.journal.commit(snap3a, {
    command: manualCmd, inputs: [manualInput], turns: [manualTurnDone],
    events: [
      h.journal.event(sessionId, "input", manualInput, { inputId: manualInputId, turnId: manualTurnId }),
      h.journal.event(sessionId, "turn", { ...manualTurnDone, state: "running" as const, endedAt: undefined }, { turnId: manualTurnId, inputId: manualInputId }),
      h.journal.event(sessionId, "acp", { sessionId: prov, update: { sessionUpdate: "tool_call", toolCallId: "tc-bookmark", title: "单独打开 Worker 后的书签整理", status: "completed" } as never }, { turnId: manualTurnId }),
      h.journal.event(sessionId, "acp", { sessionId: prov, update: { sessionUpdate: "agent_message_chunk", messageId: "m-bm-prog", content: { type: "text", text: "正在核对这次手动任务的书签" }, _meta: { codex: { phase: "commentary" } } } as never }, { turnId: manualTurnId }),
      h.journal.event(sessionId, "acp", { sessionId: prov, update: { sessionUpdate: "agent_message_chunk", messageId: "m-bm-final", content: { type: "text", text: "书签整理完成。" }, _meta: { codex: { phase: "final_answer" } } } as never }, { turnId: manualTurnId }),
      h.journal.event(sessionId, "turn", manualTurnDone, { turnId: manualTurnId, inputId: manualInputId }),
    ],
  })
  const afterManualSnap = await h.journal.read(sessionId)
  await until(() => BigInt(h.store.get("alice")!.rooms.find(r => r.workspaceId === h.ws)!.tickets[0]!.lastEventSeq ?? "0") >= BigInt(afterManualSnap.session.lastEventSeq), "replayed past manual bookmark turn")

  const assertIsolated = async (svc: SuperAgentService, phaseLabel: string) => {
    const snap = await svc.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
    assert.equal(snap.messages.find(m => m.sourceMessageId === "req-stock" && m.workerEvent === "result")?.text, "库存核对完成。", `${phaseLabel}: stock formal reply`)
    assert.equal(snap.messages.find(m => m.sourceMessageId === "req-bill" && m.workerEvent === "result")?.text, "账单核对完成。", `${phaseLabel}: bill formal reply`)
    assert.equal(snap.messages.some(m => m.text.includes("书签整理完成") || m.turnId === manualTurnId), false, `${phaseLabel}: manual turn excluded from main chat`)
    assert.equal(snap.tickets[0]!.summary, "账单核对完成。", `${phaseLabel}: ticket summary preserved`)

    const billProc = await svc.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "req-bill" }, actor)
    assert.deepEqual(billProc.items.map(i => i.text), ["第二条委托的账单核对"], `${phaseLabel}: req-bill process must contain ONLY bill activity`)

    const stockProc = await svc.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "req-stock" }, actor)
    assert.deepEqual(stockProc.items.map(i => i.text), ["第一条委托的库存核对"], `${phaseLabel}: req-stock process must contain ONLY stock activity`)
  }

  // Verify BEFORE reopen:
  await assertIsolated(service, "before reopen")
  // Verify persisted process index for req-bill has ZERO unbound placeholder entries!
  const persistedBillBranches = h.store.get("alice")!.rooms.find(r => r.workspaceId === h.ws)!.feedbackProcesses!.find(p => p.sourceMessageId === "req-bill")!.branches
  assert.equal(persistedBillBranches.length, 1)
  assert.equal(persistedBillBranches[0]!.turnId, turn2.id)

  // Close & reopen host completely and verify again!
  await service.close()
  const reopened = makeService()
  await reopened.init()
  t.after(() => reopened.close())
  await assertIsolated(reopened, "after reopen")

  // Also verify legacy corrupted placeholder in persisted store still cannot leak inventory/bookmark turns!
  const storedState = h.store.get("alice")!
  const billIdx = storedState.rooms.find(r => r.workspaceId === h.ws)!.feedbackProcesses!.find(p => p.sourceMessageId === "req-bill")!
  billIdx.branches.unshift({ ticketId: persistedBillBranches[0]!.ticketId, sessionId, activityCount: 0 })
  await assertIsolated(reopened, "with legacy unbound placeholder")
})

test("P2-23: 20,010-event journal with tools only at start and end exposes both tools across pages and never marks done before journal end", async t => {
  const h = await createJournalHarness("df-p2-23-")
  t.after(h.cleanup)
  const service = h.createService()
  await service.init()

  await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: "p2-23-req", text: "超长日志双端工具核对" }, actor)
  await until(() => h.store.get("alice")?.intents.some(i => i.messageId === "p2-23-req" && i.phase === "sent") === true, "p2-23 sent")
  const intent = h.store.get("alice")!.intents.find(i => i.messageId === "p2-23-req")!
  const sessionId = intent.sessionId!
  const snap0 = await h.journal.read(sessionId)
  const prov = snap0.session.providerSessionId!
  const run = { sessionId, generation: 1, state: "running" as const, startedAt: now() }
  const turn = { id: await h.journal.id(), sessionId, runGeneration: 1, dispatchCommandId: snap0.inputs[0]!.submissionCommandId, initialInputId: intent.inputId!, startedAt: now(), state: "running" as const }
  await h.journal.commit(snap0, {
    runs: [run], turns: [turn],
    events: [h.journal.event(sessionId, "run", run, { runGeneration: 1 }), h.journal.event(sessionId, "turn", turn, { turnId: turn.id, inputId: intent.inputId })],
  })

  // Build EXACTLY 20,010 raw events for this turn: start tool + 20,006 commentary fragments + end tool + final answer + turn completion!
  const events: ReturnType<typeof h.journal.event>[] = []
  events.push(h.journal.event(sessionId, "acp", {
    sessionId: prov,
    update: { sessionUpdate: "tool_call", toolCallId: "tc-first", title: "首端工具检查", status: "completed" } as never,
  }, { turnId: turn.id }))
  for (let i = 0; i < 20_006; i++) {
    events.push(h.journal.event(sessionId, "acp", {
      sessionId: prov,
      update: { sessionUpdate: "agent_message_chunk", messageId: "m-long-stream", content: { type: "text", text: "a" }, _meta: { codex: { phase: "commentary" } } } as never,
    }, { turnId: turn.id }))
  }
  events.push(h.journal.event(sessionId, "acp", {
    sessionId: prov,
    update: { sessionUpdate: "tool_call", toolCallId: "tc-last", title: "尾端工具检查", status: "completed" } as never,
  }, { turnId: turn.id }))
  events.push(h.journal.event(sessionId, "acp", {
    sessionId: prov,
    update: { sessionUpdate: "agent_message_chunk", messageId: "m-final-23", content: { type: "text", text: "超长日志任务已完成。" }, _meta: { codex: { phase: "final_answer" } } } as never,
  }, { turnId: turn.id }))
  const turnDone = { ...turn, state: "completed" as const, endedAt: now() }
  events.push(h.journal.event(sessionId, "turn", turnDone, { turnId: turn.id, inputId: intent.inputId }))
  assert.equal(events.length, 20_010)

  const snapBefore = await h.journal.read(sessionId)
  await h.journal.commit(snapBefore, { turns: [turnDone], events })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)).messages.some(m => m.sourceMessageId === "p2-23-req" && m.workerEvent === "result"), "p2-23 finished")

  // Close & reopen host completely so feedbackProcess reconstructs purely from SQLite journal!
  await service.close()
  const reopened = h.createService()
  await reopened.init()
  t.after(() => reopened.close())

  // Page 1: hits 20,000 raw-event budget BEFORE end of journal -> MUST return hasMore: true + valid cursor (NEVER falsely done!).
  const page1 = await reopened.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "p2-23-req" }, actor)
  assert.ok(page1.items.some(i => i.activityKind === "tool" && i.text === "首端工具检查"), "Page 1 must contain start tool check")
  assert.equal(page1.hasMore, true, "Must NOT report end of process before reaching journal end")
  assert.ok(page1.nextAfterSeq && /^\d{1,22}$/u.test(page1.nextAfterSeq), `Expected valid numeric resume cursor, got ${page1.nextAfterSeq}`)

  // Page 2: resumes after 20,000 scanned events -> finds end tool check and reaches journal end!
  const page2 = await reopened.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "p2-23-req", afterSeq: page1.nextAfterSeq }, actor)
  assert.ok(page2.items.some(i => i.activityKind === "tool" && i.text === "尾端工具检查"), "Page 2 must contain end tool check")
  assert.equal(page2.hasMore, false, "Page 2 reached journal end")
  assert.equal(page2.nextAfterSeq, undefined)

  // Combined pages: both tools present in chronological order, zero duplicate itemIds!
  const combined = [...page1.items, ...page2.items]
  assert.equal(new Set(combined.map(i => i.itemId)).size, combined.length, "Combined pages must have zero duplicate itemIds")
  const firstTool = combined.find(i => i.text === "首端工具检查")!
  const lastTool = combined.find(i => i.text === "尾端工具检查")!
  assert.ok(firstTool.seq < lastTool.seq, `Start tool seq (${firstTool.seq}) must precede end tool seq (${lastTool.seq})`)
})

test("P1-27: mid-turn steered follow-up ('核对账单') on the same Worker excludes earlier stock-check activities before and after host restart", async t => {
  const h = await createJournalHarness("df-p1-27-")
  t.after(h.cleanup)
  let routeStep = 0
  const makeService = () => new SuperAgentService({
    registration: () => ({ teamId: "team-1", machineId: "mac-1" }),
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({}),
    agents: h.workers,
    store: h.store,
    providers: () => [{ id: "codex", name: "Codex", template: "codex" }],
    workspaces: async () => [{ id: h.ws, name: "P1-27", roots: [h.dir] }],
    ensureDefaultWorkspace: async () => h.ws,
    authorize: async who => who,
    route: async ctx => {
      routeStep++
      if (routeStep === 1) {
        return { reason: "stock", actions: [{ kind: "create", title: "Stock & Bill Worker", scope: "Inventory check", prompt: ctx.text }] }
      }
      return { reason: "steer-bill", actions: [{ kind: "continue", ticketId: ctx.tickets[0]!.id, delivery: "steer", prompt: ctx.text }] }
    },
  })
  const service = makeService()
  await service.init()

  // 1. Request 1 ("盘点库存") starts turn-1 and executes prior inventory tool.
  await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: "req-stock-27", text: "盘点库存" }, actor)
  await until(() => h.store.get("alice")?.intents.some(i => i.messageId === "req-stock-27" && i.phase === "sent") === true, "req-stock-27 sent")
  const intent1 = h.store.get("alice")!.intents.find(i => i.messageId === "req-stock-27")!
  const sessionId = intent1.sessionId!
  const snap0 = await h.journal.read(sessionId)
  const prov = snap0.session.providerSessionId!
  const run = { sessionId, generation: 1, state: "running" as const, startedAt: now() }
  const turn = { id: await h.journal.id(), sessionId, runGeneration: 1, dispatchCommandId: snap0.inputs[0]!.submissionCommandId, initialInputId: intent1.inputId!, startedAt: now(), state: "running" as const }
  await h.journal.commit(snap0, {
    runs: [run], turns: [turn],
    events: [
      h.journal.event(sessionId, "run", run, { runGeneration: 1 }),
      h.journal.event(sessionId, "turn", turn, { turnId: turn.id, inputId: intent1.inputId }),
    ],
  })
  const snapBeforeStockTool = await h.journal.read(sessionId)
  await h.journal.commit(snapBeforeStockTool, {
    events: [
      h.journal.event(sessionId, "acp", {
        sessionId: prov,
        update: { sessionUpdate: "tool_call", toolCallId: "tc-stock-prior", title: "先前的库存盘点", status: "completed" } as never,
      }, { turnId: turn.id }),
    ],
  })
  const snapAfterStockTool = await h.journal.read(sessionId)
  await until(() => BigInt(h.store.get("alice")!.rooms.find(r => r.workspaceId === h.ws)!.tickets[0]!.lastEventSeq ?? "0") >= BigInt(snapAfterStockTool.session.lastEventSeq), "stock tool replayed")

  // 2. While turn-1 is STILL running, user appends Request 2 ("核对账单") -> delivered via steer into THE SAME turn!
  await service.handle("_deskfleet/super-agent/send", { workspaceId: h.ws, messageId: "req-bill-27", text: "核对账单" }, actor)
  await until(() => h.store.get("alice")?.intents.some(i => i.messageId === "req-bill-27" && i.phase === "sent" && i.deliveredTurnId === turn.id) === true, "req-bill-27 steered")
  const intent2 = h.store.get("alice")!.intents.find(i => i.messageId === "req-bill-27")!
  assert.equal(intent2.sessionId, sessionId)
  assert.equal(intent2.deliveredTurnId, turn.id)

  // Before any post-steer tool runs, req-bill-27 View Process must already exclude prior stock tool!
  const beforeBillTool = await service.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "req-bill-27" }, actor)
  assert.deepEqual(beforeBillTool.items, [], "Before post-steer tool executes, prior inventory check must not appear in appended request")

  // 3. Worker now executes the appended bill check tool and completes the shared turn.
  const snapBeforeBillTool = await h.journal.read(sessionId)
  const turnDone = { ...turn, state: "completed" as const, endedAt: now() }
  await h.journal.commit(snapBeforeBillTool, {
    turns: [turnDone],
    events: [
      h.journal.event(sessionId, "acp", {
        sessionId: prov,
        update: { sessionUpdate: "tool_call", toolCallId: "tc-bill-appended", title: "后来追加的账单复核", status: "completed" } as never,
      }, { turnId: turn.id }),
      h.journal.event(sessionId, "acp", {
        sessionId: prov,
        update: { sessionUpdate: "agent_message_chunk", messageId: "m-shared-final", content: { type: "text", text: "库存盘点与账单复核均已完成。" }, _meta: { codex: { phase: "final_answer" } } } as never,
      }, { turnId: turn.id }),
      h.journal.event(sessionId, "turn", turnDone, { turnId: turn.id, inputId: intent1.inputId }),
    ],
  })
  await until(async () => (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)).messages.some(m => m.workerEvent === "result" && m.turnId === turn.id), "shared turn completed")

  const assertSteerIsolation = async (svc: SuperAgentService, phase: string) => {
    const snap = await svc.handle("_deskfleet/super-agent/snapshot", { workspaceId: h.ws }, actor)
    const billProcessIndex = snap.feedback!.processes.find(p => p.sourceMessageId === "req-bill-27")
    assert.ok((billProcessIndex?.activityCount ?? 0) >= 1, `${phase}: req-bill-27 must expose View Process button`)

    const billProc = await svc.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "req-bill-27" }, actor)
    assert.deepEqual(billProc.items.map(i => i.text), ["后来追加的账单复核"], `${phase}: req-bill-27 must ONLY show post-steer bill check and NEVER prior inventory check`)

    const stockProc = await svc.handle("_deskfleet/super-agent/feedbackProcess", { workspaceId: h.ws, sourceMessageId: "req-stock-27" }, actor)
    assert.ok(stockProc.items.some(i => i.text === "先前的库存盘点"), `${phase}: req-stock-27 keeps prior inventory check`)
  }

  // Verify BEFORE restart:
  await assertSteerIsolation(service, "before restart")

  // Restart host completely and verify BOTH requests again!
  await service.close()
  const reopened = makeService()
  await reopened.init()
  t.after(() => reopened.close())
  await assertSteerIsolation(reopened, "after restart")

  // Simulate legacy persisted branch missing `fromSeq`: snapshot.inputs acceptedSeq floor must STILL block prior inventory tool!
  const storedBillBranch = h.store.get("alice")!.rooms.find(r => r.workspaceId === h.ws)!.feedbackProcesses!.find(p => p.sourceMessageId === "req-bill-27")!.branches[0]!
  delete storedBillBranch.fromSeq
  await assertSteerIsolation(reopened, "after restart without persisted fromSeq")
})
