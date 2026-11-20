import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { SuperAttachmentStore } from "./super-agent-attachments.ts"
import { setTimeout as sleep } from "node:timers/promises"
import type { AgentActor, AgentCommand, AgentEvent, AgentMethod, AgentReceipt, AgentSessionRecord, AgentSnapshot } from "./agent-protocol.ts"
import { SuperAgentService } from "./super-agent-service.ts"
import { routeSuperMessage, type SuperRouteContext } from "./super-agent-router.ts"
import { emptyState, note, publicRoom, roomFor, type DispatchIntent, type SuperStateStore, type SuperUserState } from "./super-agent-state.ts"
import type { SuperWorkers } from "./super-agent-worker.ts"

const actor: AgentActor = { kind: "user", userId: "user", deviceId: "device" }
const workspaceId = "project"
const time = () => new Date().toISOString()

test("a workspace snapshot correlates dispatch receipts and targeted turns without changing stored notes", () => {
  const room = roomFor(emptyState(), workspaceId, "codex")
  const ticketId = "task"
  room.tickets.push({ id: ticketId, title: "Task", scope: "inspect", summary: "", provider: "codex", status: "working", updatedAt: time() })
  for (const id of ["original", "adjust", "cancel", "corrected"]) {
    note(room, id, { id, role: "user", state: "assigned", ticketId })
  }
  const dispatch = (sourceMessageId: string, legacy = false) => note(room, "Task", {
    sourceMessageId, ticketId, reason: "dispatch task", ...(!legacy && { kind: "dispatch" as const }),
  })
  room.messages[0]!.actor = actor
  const original = dispatch("original"), adjust = dispatch("adjust", true), stop = dispatch("cancel")
  const withdrawn = dispatch("corrected")
  const interim = note(room, "Task", { sourceMessageId: "original", ticketId })
  const intent = (messageId: string, operation: DispatchIntent["operation"], inputId?: string): DispatchIntent => ({
    id: messageId, messageId, ticketId, roomId: workspaceId, actor, operation, phase: "sent",
    prompt: "inspect", provider: "codex", createId: "c", submitId: "s", inputId, turnId: "active",
  })
  const intents: DispatchIntent[] = [
    intent("original", "submit", "first-input"), intent("adjust", "steer", "steered-input"), intent("cancel", "stop"),
    { ...intent("original", "stop", "other-room"), roomId: "other-project" },
    { ...intent("original", "stop", "other-ticket"), ticketId: "other-task" },
    intent("unrelated-request", "stop", "other-message"),
    { ...intent("corrected", "steer", "obsolete"), phase: "withdrawn" },
  ]
  const snapshot = publicRoom(room, "codex", "codex", intents)
  assert.deepEqual(snapshot.messages[0]!.author, { kind: "user", userId: actor.userId })
  assert.equal(snapshot.messages[0]!.createdAt, room.messages[0]!.createdAt)
  assert.ok(!("actor" in snapshot.messages[0]!))
  const correlation = (id: string) => {
    const marker = snapshot.messages.find(message => message.id === id)!
    return [marker.inputId, marker.turnId]
  }
  assert.deepEqual(correlation(original.id), ["first-input", undefined])
  assert.deepEqual(correlation(adjust.id), ["steered-input", "active"])
  assert.deepEqual(correlation(stop.id), [undefined, "active"])
  assert.deepEqual(correlation(withdrawn.id), [undefined, undefined])
  assert.deepEqual(correlation(interim.id), [undefined, undefined])
  assert.ok(room.messages.every(message => message.inputId === undefined && message.turnId === undefined))
})

class MemoryState implements SuperStateStore {
  data = new Map<string, SuperUserState>()
  get(uid: string) { return structuredClone(this.data.get(uid)) }
  users() { return [...this.data.keys()] }
  async update<T>(uid: string, init: () => SuperUserState, edit: (state: SuperUserState) => T) {
    const next = this.get(uid) || init(), result = edit(next)
    this.data.set(uid, next)
    return result
  }
}
const bothProviders = () => [{ id: "codex", name: "Codex" }, { id: "claude-code", name: "Claude" }]
function fixture(providers: { id: string; name: string; template?: string }[] = [{ id: "codex", name: "Codex" }], project = workspaceId) {
  const store = new MemoryState()
  const sessions = new Map<string, AgentSnapshot>(), receipts = new Map<string, AgentCommand>()
  const events = new Map<string, AgentEvent[]>(), listeners = new Set<(event: AgentEvent) => void>()
  const calls: { method: AgentMethod; args: Record<string, unknown> }[] = []
  const routeCalls: SuperRouteContext[] = []
  let route: typeof routeSuperMessage = async ctx => ({
    reason: "fixture dispatch", actions: [{ kind: "create", title: ctx.text, scope: ctx.text, prompt: ctx.text }],
  })
  let unknown = false
  let verify: (who: AgentActor) => Promise<AgentActor> = async who => who
  function create(id: string, ws: string) {
    const session: AgentSessionRecord = { id, title: id, workspaceId: ws, provider: "codex", providerSessionId: "provider-" + id,
      context: "directory", lifecycle: "ready", archiveState: "active", createdAt: time(), updatedAt: time(), lastEventSeq: "0",
      capabilities: { resume: true, steering: true } }
    const snapshot: AgentSnapshot = { session, runs: [], turns: [], inputs: [], permissions: [], elicitations: [] }
    sessions.set(id, snapshot); events.set(id, [])
    return snapshot
  }
  function emit(id: string, kind: AgentEvent["kind"], payload: AgentEvent["payload"], turnId?: string) {
    const session = sessions.get(id)!, list = events.get(id)!
    const event: AgentEvent = { sessionId: id, seq: String(list.length + 1), kind, payload, createdAt: time(), turnId }
    list.push(event); session.session.lastEventSeq = event.seq
    for (const listener of listeners) listener(event)
    return event
  }
  const workers: SuperWorkers = {
    async handle(method, args, actor) {
      const a = args as Record<string, string>
      calls.push({ method, args: a })
      let sessionId = a.sessionId, result: AgentSnapshot | AgentReceipt
      if (method === "_deskfleet/session/create") {
        sessionId = "session-" + a.operationId
        result = create(sessionId, a.workspaceId)
        result.session.provider = a.provider
      } else {
        result = { operationId: a.operationId, sessionId, commandId: a.operationId, inputId: "input-" + a.operationId }
      }
      receipts.set(a.operationId, {
        method, actor, params: a, id: a.operationId, operationId: a.operationId, sessionId,
        status: unknown && method === "_deskfleet/input/submit" ? "uncertain" : "completed",
        result, isCanonical: true, receivedAt: time(),
      })
      if (unknown && method === "_deskfleet/input/submit") throw new Error("Reply lost")
      return result
    },
    onEvent(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    journal: {
      async list() { return [...sessions.values()].map(s => structuredClone(s.session)) },
      async read(id) { const s = sessions.get(id); if (!s) throw new Error("Unknown session"); return structuredClone(s) },
      async commands(id) { return [...receipts.values()].filter(r => r.sessionId === id) },
      async command(id) { return structuredClone(receipts.get(id)) || null },
      async history(id, seq, limit = 100) { return structuredClone((events.get(id) || []).filter(e => BigInt(e.seq) > BigInt(seq)).slice(0, limit)) },
    },
  }
  const service = (defaultCoordinator?: "claude-code" | "codex", attachments?: SuperAttachmentStore) => new SuperAgentService({
    defaultCoordinator, attachments, registration: () => ({ teamId: "team", machineId: "machine" }),
    supportsCoordinator: id => providers.some(entry => entry.id === id && entry.template !== "acp"),
    coordinatorModel: id => async () => ({ registeredId: id }),
    coordinatorOptions: async coordinator => coordinator === "codex" ? { defaultModel: "gpt-6.2-sol", defaultReasoningEfforts: ["low", "high"],
      models: [{ id: "gpt-6.2-sol", name: "Sol", reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium" },
        { id: "gpt-6.2-astra", name: "Astra", reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" }] }
      : { models: [{ id: "opus", name: "Opus", reasoningEfforts: ["high"] }], defaultReasoningEfforts: ["high"] },
    agents: workers, store, authorize: (a) => verify(a), ensureDefaultWorkspace: async () => "default-physical",
    workspaces: async (_uid, includePrivate) => (includePrivate ? ["default-physical", project, "b"] : [project, "b"]).map(id => ({ id, name: id, roots: [] })),
    providers: () => providers, route: async (ctx, options) => { routeCalls.push(ctx); return route(ctx, options) },
  })
  const send = (s: SuperAgentService, id: string, text: string, workspace: string | null = workspaceId, replyTo?: string) =>
    s.handle("_deskfleet/super-agent/send", { workspaceId: workspace, messageId: id, text, replyTo }, actor)
  const snap = (s: SuperAgentService, workspace: string | null = workspaceId) => s.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspace }, actor)
  return { create, emit, service, store, workers, verify: (fn: typeof verify) => { verify = fn }, send, snap, calls, sessions, receipts, routeCalls,
    route: (fn: typeof route) => { route = fn }, unknown: (value: boolean) => { unknown = value } }
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(5) }
  assert.fail("Condition did not become true")
}

test("user scope, idempotent submit, quoted follow-up, real worker result and focus survive restart", async () => {
  const f = fixture(); let s = f.service(); await s.init()
  try {
    await f.send(s, "m1", "Find the OAuth regression")
    await f.send(s, "m1", "Find the OAuth regression")
    await assert.rejects(f.send(s, "m1", "Different operation"), /already used/)
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    const first = await f.snap(s), ticket = first.tickets[0]!, session = f.sessions.get(ticket.sessionId!)!
    assert.equal(first.focusTicketId, ticket.id)
    const turn = { id: "turn1", sessionId: ticket.sessionId!, runGeneration: 1, dispatchCommandId: "c", initialInputId: "i", startedAt: time(), state: "completed" as const }
    f.emit(ticket.sessionId!, "acp", { sessionId: session.session.providerSessionId!, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The duplicate request is in login.ts" } } }, turn.id)
    f.emit(ticket.sessionId!, "turn", turn)
    await until(async () => (await f.snap(s)).messages.some(m => m.workerEvent === "result" && m.turnId === turn.id))
    const done = await f.snap(s)
    assert.equal(done.tickets[0]!.status, undefined)
    const report = done.messages.find(m => m.role === "worker")!
    assert.match(report.text, /duplicate request/); assert.equal(done.focusTicketId, ticket.id)
    await s.close()
    s = f.service(); await s.init()
    assert.equal((await f.snap(s)).tickets[0]!.status, undefined)
    f.route(async ctx => { assert.equal(ctx.quote?.ticketId, ticket.id); return { reason: "same ticket", actions: [{ kind: "continue", ticketId: ticket.id, prompt: ctx.text }] } })
    await f.send(s, "m2", "Go on", workspaceId, report.id)
    await until(() => f.store.get("user")?.intents.find(intent => intent.messageId === "m2")?.phase === "sent")
    assert.equal(f.store.get("user")!.intents.at(-1)!.priorTicketStatus, null)
    assert.equal(f.calls.filter(c => c.method === "_deskfleet/session/create").length, 1)
    assert.equal(f.calls.filter(c => c.method === "_deskfleet/input/submit").length, 2)
    const isolated = await s.handle("_deskfleet/super-agent/snapshot", { workspaceId }, { ...actor, userId: "other" })
    assert.equal(isolated.messages.length, 0)
    await assert.rejects(s.handle("_deskfleet/super-agent/correct", { workspaceId, messageId: "m2", ticketId: ticket.id }, actor), /already/)
    await s.close(); s = f.service(); await s.init()
    assert.equal((await f.snap(s)).focusTicketId, ticket.id)
    assert.equal((await f.snap(s)).messages.filter(m => m.id === report.id).length, 1)
    assert.equal(f.calls.length, 3)
  } finally { await s.close() }
})

test("a Worker finishing between the snapshot and its history page clears its running status", async () => {
  const f = fixture(), service = f.service()
  await service.init()
  try {
    await f.send(service, "request", "Read the project file")
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    const ticket = (await f.snap(service)).tickets[0]!
    const id = ticket.sessionId!
    const session = f.sessions.get(id)!
    const turn = { id: "turn", sessionId: id, runGeneration: 1, dispatchCommandId: "command",
      initialInputId: "input", startedAt: time(), state: "running" as const }
    session.turns.push(turn)
    const history = f.workers.journal.history.bind(f.workers.journal)
    f.workers.journal.history = async (...args) => {
      f.workers.journal.history = history
      const completed = { ...turn, state: "completed" as const }
      session.turns = [completed]
      f.emit(id, "turn", completed)
      return history(...args)
    }
    f.emit(id, "turn", turn)
    await until(async () => (await f.snap(service)).messages.some(m => m.workerEvent === "result"))
    assert.equal((await f.snap(service)).tickets[0]!.status, undefined)
  } finally { await service.close() }
})

test("finishing one turn keeps a follow-up queued until its own result arrives", async () => {
  const f = fixture(), service = f.service()
  await service.init()
  try {
    await f.send(service, "request", "Read the first file")
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    const ticket = (await f.snap(service)).tickets[0]!
    const id = ticket.sessionId!, session = f.sessions.get(id)!
    const first = { id: "first", sessionId: id, runGeneration: 1, dispatchCommandId: "command",
      initialInputId: "one", startedAt: time(), state: "completed" as const }
    const nextInput = { id: "two", sessionId: id, submissionCommandId: "follow", author: actor, content: [],
      acceptedSeq: "0", state: "pending" as const, requestedDelivery: "backlog" as const, createdAt: time() }
    session.turns.push(first)
    session.inputs.push(nextInput)
    f.emit(id, "turn", first)
    await until(async () => (await f.snap(service)).messages.some(m => m.workerEvent === "result" && m.turnId === first.id))
    assert.equal((await f.snap(service)).tickets[0]!.status, "queued")
    const second = { ...first, id: "second", initialInputId: nextInput.id }
    session.inputs[0].state = "delivered"
    session.turns.push(second)
    f.emit(id, "turn", second)
    await until(async () => (await f.snap(service)).messages.some(m => m.workerEvent === "result" && m.turnId === second.id))
    assert.equal((await f.snap(service)).tickets[0]!.status, undefined)
  } finally { await service.close() }
})

test("default room transfers a single scoped message and its context without leaking other dialog", async () => {
  const f = fixture(), s = f.service(); await s.init()
  try {
    f.route(async ctx => ctx.workspaceId === null ? { reason: "Project write", actions: [{ kind: "handoff", workspaceId, prompt: ctx.text, context: "Second option means reuse the OAuth return URL." }] }
      : { reason: "Implementation", actions: [{ kind: "create", title: "OAuth", scope: "Fix return URL", prompt: ctx.text }] })
    await f.send(s, "h", "Use the second option", null)
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    assert.equal((await f.snap(s, null)).messages[0].targetWorkspaceId, workspaceId)
    assert.equal((await f.snap(s)).messages[0].sourceMessageId, "h")
    assert.equal((await f.snap(s)).messages[0].sourceWorkspaceId, null)
    assert.match(JSON.stringify(f.calls[1].args.content), /OAuth return URL/)
    await f.send(s, "h", "Use the second option", null)
    assert.equal(f.calls.length, 2)
  } finally { await s.close() }
})

test("restoring an uncertain worker receipt cannot replay or transfer it", async () => {
  const f = fixture(); let s = f.service(); await s.init()
  try {
    f.unknown(true)
    await f.send(s, "uncertain", "Implement the change")
    await until(() => f.store.get("user")?.intents[0]?.phase === "uncertain")
    const ticket = (await f.snap(s)).tickets[0]!
    await s.close(); s = f.service(); await s.init()
    assert.equal((await f.snap(s)).messages[0].state, "uncertain")
    await assert.rejects(s.handle("_deskfleet/super-agent/correct", { workspaceId, messageId: "uncertain", ticketId: ticket.id }, actor))
    assert.equal(f.calls.filter(c => c.method === "_deskfleet/input/submit").length, 1)
  } finally { await s.close() }
})

test("worker ACL prevents historical attachment outside the room and verified identity is required", async () => {
  const f = fixture(), s = f.service(); await s.init()
  try {
    f.create("external", "b")
    f.route(async () => ({ reason: "wrong room", actions: [{ kind: "create", title: "attach", scope: "attach", prompt: "attach", sessionId: "external" }] }))
    await f.send(s, "attach", "continue")
    await until(async () => (await f.snap(s)).messages[0]?.state === "failed")
    assert.equal(f.calls.length, 0)
    await assert.rejects(f.send(s, "bogus", "reply", workspaceId, "absent"))
    await assert.rejects(s.handle("_deskfleet/super-agent/snapshot", { workspaceId }, { kind: "local_token" }))
  } finally { await s.close() }
})

test("restart at each persisted dispatch boundary reuses the original creation and submission IDs", async () => {
  for (const boundary of ["before creation", "after creation", "after input receipt"]) {
    const f = fixture(); let s = f.service(); await s.init()
    try {
      await f.send(s, "stable-id", "Check the login flow")
      await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
      await s.close()
      const ledger = f.store.get("user")!, intent = ledger.intents[0]!, ticket = ledger.rooms[0]!.tickets[0]!
      const sessionId = ticket.sessionId!, createId = intent.createId, submitId = intent.submitId
      // Restore the durable pre-crash image without rolling back already committed worker receipts.
      intent.inputId = undefined; intent.phase = boundary === "before creation" ? "planned" : "working"
      intent.sessionId = undefined; ticket.sessionId = undefined
      if (boundary !== "after input receipt") f.receipts.delete(submitId)
      if (boundary === "before creation") { f.receipts.delete(createId); f.sessions.delete(sessionId) }
      f.store.data.set("user", ledger); f.calls.length = 0
      s = f.service(); await s.init()
      await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
      const mutations = f.calls.filter(c => c.method === "_deskfleet/session/create" || c.method === "_deskfleet/input/submit")
      assert.deepEqual(mutations.map(c => c.args.operationId),
        boundary === "before creation" ? [createId, submitId] : boundary === "after creation" ? [submitId] : [], boundary)
      assert.equal((await f.snap(s)).tickets[0]!.sessionId, sessionId)
    } finally { await s.close() }
  }
})

test("correcting a pending classification discards its late answer and sends exactly once to the chosen worker", async () => {
  const f = fixture(), s = f.service(); await s.init()
  let release = () => {}
  const pause = new Promise<void>(resolve => { release = resolve })
  try {
    await f.send(s, "first", "Investigate login")
    await f.send(s, "second", "Investigate billing")
    await until(() => f.store.get("user")?.intents.filter(i => i.phase === "sent").length === 2)
    const [login, billing] = (await f.snap(s)).tickets
    let waiting = false
    f.route(async ctx => {
      if (!ctx.quote) { waiting = true; await pause }
      return { reason: "follow up", actions: [{ kind: "continue", ticketId: ctx.quote?.ticketId || login!.id, prompt: ctx.text }] }
    })
    await f.send(s, "unclear", "Please continue")
    await until(() => waiting)
    await s.handle("_deskfleet/super-agent/correct", { workspaceId, messageId: "unclear", ticketId: billing!.id }, actor)
    release()
    await until(() => f.store.get("user")?.intents.filter(i => i.phase === "sent").length === 3)
    assert.equal(f.calls.at(-1)?.args.sessionId, billing!.sessionId)
    assert.equal(f.calls.filter(call => call.method === "_deskfleet/input/submit").length, 3)
    assert.equal((await f.snap(s)).focusTicketId, billing!.id)
  } finally { release(); await s.close() }
})

test("correcting a queued follow-up restores its idle ticket and only stops a never-started ticket", async () => {
  const f = fixture(), s = f.service(); await s.init()
  try {
    const state = emptyState(), room = roomFor(state, workspaceId)
    for (const id of ["existing", "new", "target"]) {
      room.tickets.push({ id, title: id, scope: id, summary: "", provider: "codex", updatedAt: time() })
    }
    f.route(async ctx => ({ reason: "correction", actions: [{ kind: "answer", ticketId: "target", text: ctx.text }] }))
    for (const ticket of room.tickets.slice(0, 2)) {
      const id = ticket.id
      ticket.status = "queued"
      note(room, id, { id, role: "user", ticketId: id, state: "assigned" })
      state.intents.push({ id, roomId: workspaceId, messageId: id, ticketId: id, actor, operation: "submit",
        prompt: id, provider: "codex", createId: id, submitId: id, phase: "planned",
        priorTicketStatus: id === "existing" ? null : undefined })
    }
    f.store.data.set("user", state)
    for (const id of ["existing", "new"]) {
      await s.handle("_deskfleet/super-agent/correct", { workspaceId, messageId: id, ticketId: "target" }, actor)
      await until(async () => (await f.snap(s)).messages.find(m => m.id === id)?.state === "answered")
    }
    const after = await f.snap(s)
    assert.equal(after.tickets.find(t => t.id === "existing")!.status, undefined)
    assert.equal(after.tickets.find(t => t.id === "new")!.status, "stopped")
    assert.equal(f.calls.length, 0)
  } finally { await s.close() }
})

test("routing failures support one explicit safe retry with unchanged content and quoted target", async () => {
  const f = fixture(), s = f.service(); await s.init()
  try {
    f.route(async () => { throw new Error("Model unavailable") })
    await f.send(s, "retry", "Read the README")
    await until(async () => !!(await f.snap(s)).messages[0]?.retryable)
    f.route(async () => ({ reason: "lookup", actions: [{ kind: "answer", text: "The project uses pnpm." }] }))
    await f.send(s, "retry", "Read the README")
    assert.equal(f.routeCalls.length, 1)
    await s.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "retry", text: "Read the README", retry: true }, actor)
    await until(async () => (await f.snap(s)).messages[0]?.state === "answered")
    assert.equal(f.calls.length, 0)
    assert.equal((await f.snap(s)).messages.length, 2)
  } finally { await s.close() }
})

test("a late cancellation cannot interrupt the following turn; unsupported steering remains linked and blocked", async () => {
  const f = fixture(), s = f.service(); await s.init()
  try {
    await f.send(s, "start", "Investigate A")
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    const ticket = (await f.snap(s)).tickets[0]!, worker = f.sessions.get(ticket.sessionId!)!
    const running = { id: "old", sessionId: ticket.sessionId!, runGeneration: 1, initialInputId: "input", dispatchCommandId: "cmd", startedAt: time(), state: "running" as const }
    worker.turns.push(running)
    f.route(async () => ({ reason:"Stop the active turn", actions:[{kind:"stop", ticketId:ticket.id, prompt:"Stop now"}] }))
    let verifications = 0
    f.verify(async who => {
      if (++verifications === 2) worker.turns = [{...running, state:"completed"}, {...running, id:"new"}]
      return who
    })
    await f.send(s, "stop", "Stop now")
    await until(() => f.store.get("user")?.intents[1]?.phase === "failed")
    assert.ok(!f.calls.some(call => call.method === "_deskfleet/turn/cancel"))
    assert.match((await f.snap(s)).messages.find(m => m.id === "stop")!.reason!, /no longer active/)
    f.route(async () => ({ reason:"Adjust the active turn", actions:[{kind:"continue", ticketId:ticket.id, prompt:"Correct now", delivery:"steer"}] }))
    worker.session.capabilities = {resume:true, steering:false}
    await f.send(s,"steer","Correct now")
    await until(() => f.store.get("user")?.intents[2]?.phase === "failed")
    const blocked = (await f.snap(s)).messages.find(m => m.id === "steer")!
    assert.match(blocked.reason!, /cannot be steered/)
    assert.equal(blocked.sessionId, ticket.sessionId)
    assert.equal(f.calls.filter(call => call.method === "_deskfleet/input/submit").length,1)
  } finally { await s.close() }
})

test("the coordinator setting belongs to the user and registration independently of room worker settings", async () => {
  const f = fixture(bothProviders()); let s = f.service("claude-code"); await s.init()
  try {
    assert.equal((await f.snap(s)).coordinator,"claude-code")
    const change = (args: Record<string, unknown>) => s.handle("_deskfleet/super-agent/settings", {workspaceId, ...args}, actor)
    await assert.rejects(change({}), /Select/)
    await assert.rejects(change({coordinator:"other"}), /Unknown coordinator/)
    await change({coordinator:"codex"})
    assert.equal((await f.snap(s, null)).coordinator, "codex")
    assert.equal((await f.snap(s)).provider, "codex")
    const other = await s.handle("_deskfleet/super-agent/snapshot", {workspaceId}, {...actor, userId:"second"})
    assert.equal(other.coordinator, "claude-code")
    await s.close(); s = f.service(); await s.init()
    f.route(async ctx => { assert.equal(ctx.coordinator, "codex"); return {reason:"fixture",actions:[{kind:"answer",text:"OK"}]} })
    await f.send(s,"saved","Hello","b")
    await until(async () => (await f.snap(s,"b")).messages[0]?.state === "answered")
    await change({provider:"codex"})
    assert.equal((await f.snap(s)).coordinator, "codex")
  } finally { await s.close() }
})

test("the live registry owns both menus; routing, removal and retry use exact registration IDs", async t => {
  const codex = { id: "registered-one", name: "Home Codex", template: "codex" }
  const workerOnly = { id: "worker-only", name: "Script", template: "acp" }
  const providers = [codex, workerOnly]
  const f = fixture(providers)
  const service = f.service("codex")
  await service.init()
  t.after(() => service.close())
  const change = (coordinator: string) => service.handle("_deskfleet/super-agent/settings", { workspaceId, coordinator }, actor)
  const initial = await f.snap(service)
  assert.equal(initial.coordinator, codex.id)
  assert.deepEqual(initial.coordinatorProviders?.map(p => p.id), [codex.id])
  assert.deepEqual(initial.workerProviders?.map(p => p.id), [codex.id, workerOnly.id])
  await assert.rejects(change(workerOnly.id), /Unknown coordinator/)
  await assert.rejects(change("claude-code"), /Unknown coordinator/)
  const dsh = { id: "custom-id-42", name: "My DeepSeek", template: "deepseek-harness" }
  providers.push(dsh)
  assert.deepEqual((await f.snap(service)).coordinatorProviders?.at(-1), { id: dsh.id, name: dsh.name })
  await change(dsh.id)
  assert.equal((await f.snap(service, "b")).coordinator, dsh.id)
  assert.equal((await f.snap(service)).provider, codex.id)
  f.route(async (ctx, options) => {
    assert.deepEqual(await options!.model!({}), { registeredId: ctx.coordinator })
    return { reason: "fixture", actions: [{ kind: "answer", text: ctx.coordinator! }] }
  })
  await f.send(service, "first", "Hello")
  await until(async () => (await f.snap(service)).messages.at(-1)?.text === dsh.id)
  providers.pop()
  providers.push({ ...dsh, id: "a-different-account" })
  assert.equal((await f.snap(service)).coordinator, undefined)
  await f.send(service, "second", "Continue")
  await until(async () => (await f.snap(service)).messages.at(-1)?.failureCode === "coordinator_unconfigured")
  assert.equal(f.routeCalls.length, 1)
  await change(codex.id)
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "second", text: "Continue", retry: true }, actor)
  await until(async () => (await f.snap(service)).messages.at(-1)?.text === codex.id)
  providers.length = 0
  const empty = await f.snap(service)
  assert.equal(empty.coordinator, undefined)
  assert.deepEqual(empty.coordinatorProviders, [])
  assert.deepEqual(empty.workerProviders, [])
})

test("coordinator choices survive restarts, provider switches and clearing each optional field", async () => {
  const f = fixture(bothProviders())
  let s = f.service("codex")
  await s.init()
  const change = (args: object) => s.handle("_deskfleet/super-agent/settings", { workspaceId, ...args }, actor)
  const front = (model?: string, reasoningEffort?: string) => change({ coordinatorSelection: { provider: "codex", model, reasoningEffort } })
  try {
    const selected = await front("gpt-6.2-astra", "high")
    assert.deepEqual(selected.coordinatorOverrides, { model: "gpt-6.2-astra", reasoningEffort: "high" })
    assert.deepEqual(selected.workerSelection, {})
    await assert.rejects(front("not-offered", "high"), /does not offer this model/)
    await assert.rejects(front("gpt-6.2-astra", "low"), /does not offer this reasoning effort/)
    await s.close(); s = f.service(); await s.init()
    assert.deepEqual((await f.snap(s, "b")).coordinatorSelection, selected.coordinatorSelection)
    f.route(async ctx => {
      assert.equal(ctx.coordinator, "codex")
      assert.deepEqual(ctx.coordinatorSelection, { model: "gpt-6.2-astra", reasoningEffort: "high" })
      return { reason: "fixture", actions: [{ kind: "answer", text: "OK" }] }
    })
    await f.send(s, "model-check", "Hello")
    await until(async () => (await f.snap(s)).messages[0]?.state === "answered")
    await change({ coordinator: "claude-code" })
    await assert.rejects(front("gpt-6.2-sol"), /coordinator has changed/)
    await change({ coordinatorSelection: { provider: "claude-code", model: "opus", reasoningEffort: "high" } })
    assert.deepEqual((await change({ coordinator: "codex" })).coordinatorSelection, selected.coordinatorSelection)
    assert.deepEqual((await front("gpt-6.2-astra")).coordinatorSelection, { model: "gpt-6.2-astra", reasoningEffort: "medium" })
    assert.deepEqual((await front(undefined, "high")).coordinatorSelection, { model: "gpt-6.2-sol", reasoningEffort: "high" })
    assert.deepEqual((await front()).coordinatorSelection, { model: "gpt-6.2-sol", reasoningEffort: "low" })
  } finally { await s.close() }
})

test("a workspace model selection is applied only on creation of a matching Worker", async () => {
  const f = fixture([{ id: "codex", name: "Codex" }, { id: "other", name: "Other" }])
  const s = f.service("codex")
  await s.init()
  const settings = (value: object) => s.handle("_deskfleet/super-agent/settings", { workspaceId, ...value }, actor)
  try {
    const firstSettings = await settings({ workerSelection: { provider: "codex", model: "test-model", reasoningEffort: "high" } })
    assert.deepEqual(firstSettings.workerSelection, { model: "test-model", reasoningEffort: "high" })
    assert.deepEqual(firstSettings.coordinatorSelection, { model: "gpt-6.2-sol", reasoningEffort: "low" })
    assert.deepEqual((await f.snap(s, "b")).workerSelection, {})
    await f.send(s, "new-worker", "Check the export")
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    const creation = f.calls.find(c => c.method === "_deskfleet/session/create")!
    assert.equal(creation.args.model, "test-model")
    assert.equal(creation.args.reasoningEffort, "high")
    const existing = (await f.snap(s)).tickets[0]!
    await settings({ workerSelection: { provider: "codex", model: "next-model", reasoningEffort: "low" } })
    f.route(async ctx => ({ reason: "same work", actions: [{ kind: "continue", ticketId: existing.id, prompt: ctx.text }] }))
    await f.send(s, "follow-worker", "Continue")
    await until(() => f.store.get("user")?.intents[1]?.phase === "sent")
    assert.deepEqual(f.calls.map(c => c.method), ["_deskfleet/session/create", "_deskfleet/input/submit", "_deskfleet/input/submit"])
    const switched = await settings({ provider: "other" })
    assert.deepEqual(switched.workerSelection, {})
    await assert.rejects(settings({ workerSelection: { provider: "codex", model: "stale" } }), /default worker has changed/)
    assert.equal((await f.snap(s)).provider, "other")
  } finally { await s.close() }
})

test("later conclusive journal evidence reconciles unknown delivery without another worker mutation", async () => {
  const f = fixture(); let s = f.service(); await s.init()
  try {
    f.unknown(true)
    await f.send(s, "late", "Run the review")
    await until(() => f.store.get("user")?.intents[0]?.phase === "uncertain")
    const original = f.store.get("user")!.intents[0]!
    f.receipts.get(original.submitId)!.status = "completed"
    await s.close(); s = f.service(); await s.init()
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    const snapshot = await f.snap(s)
    assert.equal(snapshot.messages[0]!.state,"assigned")
    assert.equal(f.calls.filter(call => call.method === "_deskfleet/input/submit").length,1)
  } finally { await s.close() }
})

test("background ticket completion preserves the foreground pending choice and an unquoted number reuses its worker", async () => {
  const f = fixture(), s = f.service(); await s.init()
  try {
    await f.send(s,"fix","Fix the login callback")
    await f.send(s,"sign","Investigate signing")
    await until(() => f.store.get("user")?.intents.filter(i => i.phase === "sent").length === 2)
    const [login, signing] = (await f.snap(s)).tickets
    f.route(async () => ({reason:"pre-authorized choices", actions:[{kind:"clarify", ticketId:login!.id,
      text:"Choose between two in-scope fixes", options:["cache token","reuse nonce"], optionDisposition:"continue"}]}))
    await f.send(s,"question","Which approach to login?")
    await until(async () => (await f.snap(s)).messages.find(m => m.id === "question")?.state === "answered")
    const turn = {id:"background", sessionId:signing!.sessionId!, runGeneration:1, initialInputId:"old", dispatchCommandId:"cmd", startedAt:time(), state:"completed" as const}
    f.emit(signing!.sessionId!,"turn",turn)
    await until(async () => (await f.snap(s)).messages.some(m => m.workerEvent === "result" && m.ticketId === signing!.id))
    assert.equal((await f.snap(s)).focusTicketId,login!.id)
    f.route(ctx => routeSuperMessage(ctx,{model: async () => { throw new Error("Exact option must not call the model") }}))
    await f.send(s,"choice","2")
    await until(() => f.store.get("user")?.intents[2]?.phase === "sent")
    assert.equal(f.calls.at(-1)?.args.sessionId,login!.sessionId)
    assert.match(JSON.stringify(f.calls.at(-1)?.args.content),/reuse nonce/)
  } finally { await s.close() }
})

test("a revised acceptance criterion for the same artifact is saved separately from original scope", async () => {
  const f = fixture(), s = f.service(); await s.init()
  try {
    const scope = "Only edit result.txt; initial expected content PASSED"
    f.route(async () => ({reason:"authorized file write",actions:[{kind:"create", title:"result.txt", scope, prompt:"Write PASSED"}]}))
    await f.send(s,"file","Write PASSED to result.txt")
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    const first = (await f.snap(s)).tickets[0]!
    f.route(async ctx => ({reason:"same deliverable and write authority",actions:[
      {kind:"continue", ticketId:first.id, prompt:ctx.text, acceptanceUpdate:"First line PASSED, second line NEXT."},
    ]}))
    await f.send(s,"update","Keep line one and append NEXT on line two")
    await until(() => f.store.get("user")?.intents[1]?.phase === "sent")
    const revised = (await f.snap(s)).tickets[0]!
    assert.equal(revised.sessionId,first.sessionId); assert.equal(revised.scope,scope)
    assert.equal(revised.latestAcceptance,"First line PASSED, second line NEXT.")
    f.route(async ctx => {
      assert.equal(ctx.tickets[0]?.latestAcceptance, revised.latestAcceptance)
      return {reason:"known acceptance",actions:[{kind:"answer",ticketId:first.id,text:revised.latestAcceptance!}]}
    })
    await f.send(s,"ask","What did we agree?")
    await until(async () => (await f.snap(s)).messages.find(m => m.id === "ask")?.state === "answered")
  } finally { await s.close() }
})

test("a new user sees the platform coordinator before the first write; saved choices survive", async () => {
  const f = fixture(bothProviders())
  f.store.data.set("existing", {rooms: [], intents: []})
  f.store.data.set("explicit", {rooms: [], intents: [], coordinatorProviderId: "claude-code"})
  let s = f.service("codex"); await s.init()
  const view = (userId: string) => s.handle("_deskfleet/super-agent/snapshot", {workspaceId: null}, {...actor, userId})
  try {
    assert.equal((await view("user")).coordinator, "codex")
    assert.equal(f.store.get("user"), undefined)
    assert.equal((await view("existing")).coordinator, "codex")
    assert.equal((await view("explicit")).coordinator, "claude-code")
    f.route(async ctx => ({reason:"fixture", actions:[{kind:"answer", text:ctx.coordinator!}]}))
    await f.send(s, "fresh", "Which coordinator?")
    await until(async () => (await f.snap(s)).messages.at(-1)?.text === "codex")
    assert.equal(f.store.get("user")!.coordinatorProviderId, "codex")
    await s.close(); s = f.service("claude-code"); await s.init()
    assert.equal((await view("user")).coordinator, "codex")
    assert.equal((await view("another-new-user")).coordinator, "claude-code")
  } finally { await s.close() }
})

test("an unconfigured Worker can be dispatched from an old message without repeating the answer, ticket or commands", async () => {
  const providers = [{ id: "codex", name: "Codex" }]
  const f = fixture(providers)
  let service = f.service()
  await service.init()
  try {
    f.route(async ({ text }) => {
      providers.length = 0 // Removed after inference, before Worker dispatch.
      return { reason: "split answer and work", actions: [
        { kind: "answer", text: "An initial answer" }, { kind: "create", title: "Check", scope: "Read only", prompt: text },
      ] }
    })
    const retry = () => service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "m", text: "Check it", retry: true }, actor)
    await f.send(service, "m", "Check it")
    await until(async () => (await f.snap(service)).messages[0]?.failureCode === "worker_unconfigured")
    assert.equal(f.calls.length, 0)
    await assert.rejects(retry(), /No configured worker/)
    await service.close()
    // The previous release persisted plain rows without presentation or recovery annotations.
    await f.store.update("user", () => assert.fail(), state => {
      for (const message of state.rooms[0]!.messages) {
        delete message.kind
        delete message.failureCode
        delete message.retryable
      }
    })
    const blocked = f.store.get("user")!.intents[0]!
    providers.push({ id: "codex", name: "Codex" })
    service = f.service()
    await service.init()
    const before = await f.snap(service)
    assert.equal(before.messages[0]?.retryable, true)
    assert.equal(before.provider, "codex")
    assert.deepEqual(before.workerProviders, [{ id: "codex", name: "Codex" }])
    const answer = before.messages.find(message => message.text === "An initial answer")!
    assert.equal(answer.ticketId, blocked.ticketId)
    assert.equal(f.calls.length, 0)
    await Promise.allSettled([retry(), retry()])
    await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
    const after = await f.snap(service)
    assert.equal(after.messages[0]?.state, "assigned")
    assert.equal(after.messages[0]?.failureCode, undefined)
    assert.equal(after.tickets.length, 1)
    assert.equal(after.tickets[0]?.id, blocked.ticketId)
    assert.equal(f.routeCalls.length, 1)
    assert.deepEqual(f.calls.map(call => call.args.operationId), [blocked.createId, blocked.submitId])
    f.route(async context => {
      assert.equal(context.quote?.ticketId, blocked.ticketId)
      return { reason: "continue", actions: [{ kind: "continue", ticketId: blocked.ticketId, prompt: context.text }] }
    })
    await f.send(service, "follow", "Next", workspaceId, answer.id)
    await until(() => f.store.get("user")?.intents[1]?.phase === "sent")
    assert.equal(f.sessions.size, 1)
  } finally { await service.close() }
})

test("a later dispatch for the same ticket supersedes an old preflight retry", async () => {
  const providers = [{ id: "codex", name: "Codex" }]
  const f = fixture(providers)
  const service = f.service()
  await service.init()
  try {
    f.route(async ctx => {
      providers.length = 0
      return { reason: "create", actions: [{ kind: "create", title: "Original task", scope: ctx.text, prompt: ctx.text }] }
    })
    await f.send(service, "first", "Original task")
    await until(async () => !!(await f.snap(service)).messages[0]?.retryable)
    const ticketId = (await f.snap(service)).tickets[0]!.id
    providers.push({ id: "codex", name: "Codex" })
    f.route(async ctx => {
      providers.length = 0
      return { reason: "follow-up", actions: [{ kind: "continue", ticketId, prompt: ctx.text }] }
    })
    await f.send(service, "second", "Updated task")
    await until(() => f.store.get("user")?.intents[1]?.phase === "failed")
    providers.push({ id: "codex", name: "Codex" })
    const source = (await f.snap(service)).messages.find(m => m.id === "first")
    assert.equal(source?.retryable, false)
    assert.equal(source?.failureCode, "worker_unconfigured")
    await assert.rejects(service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "first", text: "Original task", retry: true }, actor), /cannot be safely retried/)
    assert.equal(f.calls.length, 0)
  } finally { await service.close() }
})

test("attachments survive a routing failure, retry, project handoff and explicit quotation without leaking bytes into snapshots", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-attachment-route-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const f = fixture(), store = new SuperAttachmentStore(directory, () => ""), s = f.service("codex", store)
  await s.init()
  t.after(() => s.close())
  const textBlock = { type: "resource", resource: { uri: "deskfleet://pasted-text/fixture.txt", mimeType: "text/plain", text: "a private paste" } }
  const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }
  const request = { workspaceId: null, messageId: "source", text: "" }
  f.route(async () => { throw new Error("Coordinator temporarily down") })
  await s.handle("_deskfleet/super-agent/send", { ...request, attachments: [textBlock, image] }, actor)
  await until(async () => (await f.snap(s,null)).messages[0]?.state === "failed")
  const failed = await f.snap(s,null)
  assert.equal(failed.supportsAttachments, true)
  assert.equal(failed.messages[0].attachments?.length, 2)
  assert.equal(failed.supportsAttachmentPreviews, true)
  const requested = { workspaceId: null, attachment: { messageId: request.messageId, index: 0 } }
  const read = await s.handle("_deskfleet/super-agent/snapshot", requested, actor)
  assert.deepEqual(read.attachmentPreview, { ...requested.attachment, content: { type: "resource", text: "a private paste" } })
  assert.doesNotMatch(JSON.stringify(read), /aW1hZ2U=|attachmentKeys|deskfleet:\/\/pasted-text/)
  assert.equal((await f.snap(s, null)).attachmentPreview, undefined)
  await assert.rejects(s.handle("_deskfleet/super-agent/snapshot", requested, { ...actor, userId: "other" }), /unavailable/)
  await assert.rejects(s.handle("_deskfleet/super-agent/snapshot", { ...requested, workspaceId }, actor), /unavailable/)
  for (const index of [-1, 0.1, 2]) {
    await assert.rejects(s.handle("_deskfleet/super-agent/snapshot", { ...requested, attachment: { messageId: request.messageId, index } }, actor), /unavailable/)
  }
  assert.doesNotMatch(JSON.stringify(failed), /a private paste|aW1hZ2U=|attachmentKeys/)
  await assert.rejects(s.handle("_deskfleet/super-agent/send", {...request, retry: true, attachments: [image]}, actor), /different request/)
  f.route(async ctx => {
    assert.equal(ctx.attachments?.previews[0]?.excerpt, "a private paste")
    assert.deepEqual(ctx.attachments.images, [image])
    return ctx.workspaceId === null
      ? { reason: "project change", actions: [{kind: "handoff", workspaceId, prompt: "", context: "Use the submitted material"}] }
      : { reason: "work", actions: [{kind: "create", title: "work", scope: "work", prompt: "Read these"}] }
  })
  await s.handle("_deskfleet/super-agent/send", {...request, retry:true}, actor)
  await until(() => f.store.get(actor.userId!)?.intents[0]?.phase === "sent")
  const first = (await f.snap(s)).messages.find(m => m.role === "user")!
  assert.equal(first.attachments?.length, 2)
  const handedOff = await s.handle("_deskfleet/super-agent/snapshot", { workspaceId, attachment: { messageId: first.id, index: 1 } }, actor)
  assert.deepEqual(handedOff.attachmentPreview?.content, image)
  assert.doesNotMatch(JSON.stringify(first), /a private paste|aW1hZ2U=/)
  await f.send(s, "follow", "Please also summarize the attached material", workspaceId, first.id)
  await until(() => f.store.get(actor.userId!)?.intents[1]?.phase === "sent")
  const submissions = f.calls.filter(c => c.method === "_deskfleet/input/submit")
  assert.equal(submissions.length, 2)
  for (const submit of submissions) assert.deepEqual((submit.args.content as unknown[]).slice(0,2), [textBlock, image])
})

test("foreground usage follows the last coordinator inference in this project and profile across restarts", async () => {
  const f = fixture(bothProviders())
  f.route(async (ctx, options) => {
    if (ctx.text === "measure") {
      options?.onUsage?.({ used: 30, size: 200 })
      options?.onUsage?.({ used: 70, size: 200 })
    }
    if (ctx.text === "unreported") options?.onUsage?.(undefined)
    return { reason: "fixture answer", actions: [{ kind: "answer", text: "OK" }] }
  })
  let service = f.service("claude-code")
  async function deliver(id: string, text: string) {
    await f.send(service, id, text)
    await until(async () => (await f.snap(service)).messages.some(m => m.id === id && m.state === "answered"))
  }
  await service.init()
  try {
    await deliver("m1", "measure")
    assert.deepEqual((await f.snap(service)).coordinatorUsage, { used: 70, size: 200 })
    assert.equal((await f.snap(service, "b")).coordinatorUsage, undefined)
    await service.close()
    service = f.service(); await service.init()
    // A deterministic route does not start a fresh coordinator context.
    await deliver("m2", "fast-path")
    assert.deepEqual((await f.snap(service)).coordinatorUsage, { used: 70, size: 200 })
    await service.handle("_deskfleet/super-agent/settings", { workspaceId, coordinator: "codex" }, actor)
    assert.equal((await f.snap(service)).coordinatorUsage, undefined)
    await service.handle("_deskfleet/super-agent/settings", { workspaceId, coordinator: "claude-code" }, actor)
    await deliver("m3", "unreported")
    assert.equal((await f.snap(service)).coordinatorUsage, undefined)
  } finally { await service.close() }
})


test("a Worker ID directs a follow-up to the exact ticket despite a different focus; repeat delivery and default handoff are safe", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-worker-attachment-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const f = fixture(), s = f.service("codex", new SuperAttachmentStore(directory, () => ""))
  await s.init()
  t.after(() => s.close())
  for (const id of ["first", "second"]) {
    await f.send(s, id, "Start " + id)
    await until(() => f.store.get("user")?.intents.find(i => i.messageId === id)?.phase === "sent")
  }
  const [first, second] = (await f.snap(s)).tickets
  const text = `@worker[team/machine/${first!.sessionId}] Continue the first task`
  assert.notEqual(first!.sessionId, second!.sessionId)
  assert.equal((await f.snap(s)).focusTicketId, second!.id)
  await f.send(s, "follow", text, workspaceId, "first")
  await f.send(s, "follow", text, workspaceId, "first")
  await until(() => f.store.get("user")?.intents.find(i => i.messageId === "follow")?.phase === "sent")
  const state = f.store.get("user")!
  const follow = state.intents.filter(i => i.messageId === "follow")
  assert.equal(follow.length, 1)
  assert.equal(follow[0]!.sessionId, first!.sessionId)
  assert.equal(follow[0]!.ticketId, first!.id)
  assert.match(follow[0]!.prompt, /Continue the first task[\s\S]*Quoted background:[\s\S]*Start first/)
  assert.doesNotMatch(follow[0]!.prompt, /@worker/)
  assert.equal((await f.snap(s)).supportsWorkerReferences, true)
  const image = {type:"image", mimeType:"image/png", data:"aW1hZ2U="}
  await s.handle("_deskfleet/super-agent/send", { workspaceId: null, messageId:"forward", text, attachments:[image] }, actor)
  await until(() => f.store.get("user")?.intents.length === 4 && f.store.get("user")!.intents[3]!.phase === "sent")
  assert.equal(f.store.get("user")!.intents[3]!.sessionId, first!.sessionId)
  assert.deepEqual(f.calls.filter(c => c.method === "_deskfleet/input/submit").at(-1)?.args.content,
    [image, {type:"text", text:"Continue the first task"}])
  assert.equal((await f.snap(s, null)).messages[0]!.targetWorkspaceId, workspaceId)
  assert.equal((await f.snap(s)).tickets.length, 2)
  assert.equal(f.calls.filter(c => c.method === "_deskfleet/session/create").length, 2)
  assert.equal(f.routeCalls.length, 2)
})

test("wrong registration, unknown, unowned, wrong project, archived, empty and contradictory Worker addresses fail closed", async t => {
  const f = fixture(), s = f.service()
  await s.init()
  t.after(() => s.close())
  for (const id of ["one", "two"]) {
    await f.send(s, id, id)
    await until(() => f.store.get("user")?.intents.find(i => i.messageId === id)?.phase === "sent")
  }
  const session = (await f.snap(s)).tickets[0]!.sessionId!
  const token = `@worker[team/machine/${session}]`
  async function rejected(id: string, text: string, reason: RegExp, room = workspaceId, quote?: string) {
    await f.send(s, id, text, room, quote)
    await until(() => f.store.get("user")?.rooms.find(r => r.workspaceId === room)?.messages.find(m => m.id === id)?.state === "failed")
    const failed = (await f.snap(s, room)).messages.find(m => m.id === id)!
    assert.match(failed.reason!, reason)
  }
  await rejected("team", token.replace("team/", "other/") + " Go", /team or machine/)
  await rejected("machine", token.replace("/machine/", "/elsewhere/") + " Go", /team or machine/)
  await rejected("missing", "@worker[team/machine/missing] Go", /session/i)
  await rejected("broken", "@worker[abc] Go", /Invalid Worker ID/)
  await rejected("empty", token, /Add a task/)
  await rejected("workspace", token + " Go", /does not belong/, "b")
  await rejected("quote", token + " Go", /disagree/, workspaceId, "two")
  f.create("unowned", workspaceId)
  await rejected("owner", "@worker[team/machine/unowned] Go", /owner/)
  f.sessions.get(session)!.session.archiveState = "archived"
  await rejected("archived", token + " Go", /archived/)
  assert.equal(f.store.get("user")!.intents.length, 2)
  assert.equal(f.routeCalls.length, 2)
})

test("workspace commands preserve native spelling and chosen Worker across focus, retries and provider changes", async t => {
  const f = fixture(bothProviders()), service = f.service("codex")
  await service.init(); t.after(() => service.close())
  const handle = f.workers.handle
  f.workers.handle = async (method, value, actor) => {
    if (method !== "_deskfleet/session/configuration" && method !== "_deskfleet/agent/configuration") return handle(method, value, actor)
    const params = value as { sessionId?: string; provider?: string; composer?: boolean }
    assert.equal(params.composer, true)
    const id = params.sessionId ? f.sessions.get(params.sessionId)!.session.provider : params.provider
    return { provider: { id }, commands: [{ name: "plan" }, { name: "status" }], skills: [{ id: "scan", name: "audit", invocation: "/audit" }] }
  }
  const sendCommand = (args: Record<string, unknown>) => service.handle("_deskfleet/super-agent/send", { workspaceId, ...args }, actor)
  const sent = (messageId: string) => until(() => f.store.get("user")?.intents.some(i => i.messageId === messageId && i.phase === "sent") === true)
  const failed = (id: string) => until(async () => (await f.snap(service)).messages.some(m => m.id === id && m.state === "failed"))
  const submits = () => f.calls.filter(call => call.method === "_deskfleet/input/submit")
  await sendCommand({ messageId: "missing", text: "/unavailable", command: { provider: "codex" } })
  await failed("missing")
  assert.equal(f.sessions.size, 0)
  const raw = { messageId: "new", text: "/plan  check this", command: { provider: "codex" } }
  await sendCommand(raw); await sent("new")
  await sendCommand(raw)
  const first = (await f.snap(service)).tickets[0]!
  const target = { provider: "codex", sessionId: first.sessionId, ticketId: first.id }
  assert.deepEqual(submits()[0]!.args.content, [{ type: "text", text: raw.text, _meta: { "deskfleet/composerProvider": "codex" } }])
  assert.deepEqual(f.routeCalls, [])
  await f.send(service, "path", "/work/projects")
  await sent("path")
  assert.equal(f.routeCalls.length, 1)
  // The quote selects the first Session even though a new ticket owns the focus.
  const again = { messageId: "again", text: "/status", replyTo: "new", command: target }
  await sendCommand(again); await sent("again")
  assert.equal(submits().at(-1)!.args.sessionId, first.sessionId)
  assert.equal(submits().at(-1)!.args.delivery, "backlog")
  assert.deepEqual(submits().at(-1)!.args.content, [{ type: "text", text: "/status", _meta: { "deskfleet/composerProvider": "codex" } }])
  await assert.rejects(sendCommand({ ...again, command: { provider: "codex" } }), /already used/)
  await assert.rejects(sendCommand({ ...again, messageId: "stale", command: { provider: "codex" } }), /target has changed/)
  const session = f.sessions.get(first.sessionId!)!
  session.session.provider = "claude-code"
  await sendCommand({ ...again, messageId: "changed" }); await failed("changed")
  assert.equal(submits().length, 3)
  f.route(async ctx => ({ reason: "continue", actions: [{ kind: "continue", ticketId: first.id, prompt: ctx.text }] }))
  await f.send(service, "continue", "Continue", workspaceId, "new"); await sent("continue")
  assert.equal(submits().at(-1)!.args.sessionId, first.sessionId)
  assert.equal((await f.snap(service)).tickets[0]!.provider, "claude-code")
  const skill = { kind: "skill", id: "scan", name: "audit", invocation: "/audit", providerId: "claude-code" }
  const mention = { id: "selected", start: 0, end: 6, token: "$audit", reference: skill }
  const selected = { messageId: "skill", text: "$audit report", mentions: [mention], command: { ...target, provider: "claude-code" } }
  await sendCommand(selected); await sent("skill")
  assert.deepEqual(submits().at(-1)!.args.content, [{ type: "text", text: "/audit report", _meta: { "deskfleet/composerProvider": "claude-code" } }])
  assert.equal(f.routeCalls.length, 2)
  assert.deepEqual((await f.snap(service)).messages.find(m => m.id === "skill")?.mentions, [mention])
  const forged = { ...mention, reference: { ...skill, invocation: "/other" } }
  await sendCommand({ ...selected, messageId: "forged", mentions: [forged] }); await failed("forged")
  assert.equal(submits().length, 5)
  await assert.rejects(sendCommand({ ...selected, messageId: "edited", text: "$other report" }), /selected reference has changed/)
})

test("selected @ references supply bounded read evidence and resolve again in the receiving Worker", async t => {
  const project = "20", f = fixture(undefined, project), service = f.service()
  await service.init(); t.after(() => service.close())
  const history = f.create("21", project)
  f.emit(history.session.id, "acp", { sessionId: history.session.providerSessionId!, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier findings" } } }, "22")
  const handle = f.workers.handle
  const scopes: { workspaceId?: string; sessionId?: string }[] = []
  f.workers.handle = async (method, value, actor) => {
    if (method !== "_deskfleet/composer/resolve") return handle(method, value, actor)
    const scope = value as { workspaceId?: string; sessionId?: string }
    scopes.push(scope)
    return [{ type: "text", text: "Read the referenced session with the authorized MCP server." }]
  }
  const reference = { kind: "session", originId: "catalog", workspaceId: project, sessionId: history.session.id }
  const mention = { id: "selection", start: 8, end: 14, token: "@notes", reference }
  const request = { workspaceId: project, messageId: "first", text: "Inspect @notes", mentions: [mention] }
  await service.handle("_deskfleet/super-agent/send", request, actor)
  await until(() => f.store.get("user")?.intents[0]?.phase === "sent")
  const ticket = (await f.snap(service, project)).tickets[0]!
  assert.notEqual(ticket.sessionId, history.session.id)
  assert.ok(f.routeCalls[0]!.attachments?.previews[0]?.excerpt?.includes("Earlier findings"))
  assert.deepEqual((await f.snap(service, project)).messages.find(m => m.id === "first")?.historySources, [{ sessionId: "21", afterSeq: "0", throughSeq: "1" }])
  assert.deepEqual(scopes.map(s => [s.workspaceId, s.sessionId]), [[project, undefined], [undefined, ticket.sessionId]])
  assert.deepEqual(f.calls.find(call => call.method === "_deskfleet/input/submit")?.args.content, [
    { type: "text", text: "Inspect @notes" }, { type: "text", text: "Read the referenced session with the authorized MCP server." },
  ])
  await service.handle("_deskfleet/super-agent/send", { ...request, workspaceId: null, messageId: "foreign" }, actor)
  await until(async () => (await f.snap(service, null)).messages.some(m => m.id === "foreign" && m.state === "failed"))
  assert.equal(scopes.length, 2)
  assert.equal(f.routeCalls.length, 1)
})

test("@file reads the selected project file for a direct answer without allocating a Worker", async t => {
  const project = "20", f = fixture(undefined, project), service = f.service()
  await service.init(); t.after(() => service.close())
  const root = await mkdtemp(join(tmpdir(), "deskfleet-selected-reference-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "notes.txt")
  await writeFile(path, "Scoped project evidence")
  const reference = { kind: "file", directoryIndex: 0, sourceDirectory: root, relativePath: "notes.txt", originId: "catalog", workspaceId: project }
  const original = f.workers.handle
  f.workers.handle = async (method, value, actor) => {
    if (method !== "_deskfleet/composer/resolve") return original(method, value, actor)
    assert.deepEqual(value, { workspaceId: project, sessionId: undefined, references: [reference] })
    return [{ type: "resource_link", uri: pathToFileURL(path).href, name: "notes.txt" }]
  }
  f.route(async ctx => {
    assert.deepEqual(ctx.attachments?.previews[0], { type: "resource_link", name: "notes.txt", excerpt: "Scoped project evidence", truncated: false })
    return { reason: "answer", actions: [{ kind: "answer", text: "Found the notes" }] }
  })
  await service.handle("_deskfleet/super-agent/send", { workspaceId: project, messageId: "file", text: "Read @notes.txt",
    mentions: [{ id: "file", start: 5, end: 15, token: "@notes.txt", reference }] }, actor)
  await until(async () => (await f.snap(service, project)).messages.some(m => m.text === "Found the notes"))
  assert.equal(f.sessions.size, 0)
})
