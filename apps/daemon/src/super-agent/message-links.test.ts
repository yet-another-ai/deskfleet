import assert from "node:assert/strict"
import { test } from "node:test"
import type { AgentActor, AgentEvent, AgentSessionRecord, AgentSnapshot } from "@deskfleet/protocol/agent"
import {
  isValidAccentSlot,
  messageMatchesTicketFocus,
  resolveCanonicalMessageTicketIds,
  type SuperSnapshot,
} from "@deskfleet/protocol/super-agent"
import { routeSuperMessage, type SuperRouteAction, type SuperRouteContext, type SuperRouteResult } from "./router.ts"
import { SuperAgentService } from "./service.ts"
import { emptyState, type SuperStateStore, type SuperUserState } from "./state.ts"
import type { SuperWorkers } from "./worker.ts"

const actor: AgentActor = { kind: "user", userId: "user-1", deviceId: "dev-1" }
const workspaceId = "ws-focus"
const now = () => "2026-11-27T12:00:00.000Z"

class MemorySuperStore implements SuperStateStore {
  readonly #rows = new Map<string, SuperUserState>()
  get(userId: string) {
    const value = this.#rows.get(userId)
    return value ? structuredClone(value) : undefined
  }
  async update<R>(userId: string, initial: () => SuperUserState, edit: (state: SuperUserState) => R): Promise<R> {
    const state = this.get(userId) ?? initial()
    const result = edit(state)
    this.#rows.set(userId, structuredClone(state))
    return structuredClone(result)
  }
  users() { return [...this.#rows.keys()] }
}

function createFakeWorkers() {
  let seqCounter = 0
  let sessionCounter = 0
  const sessions = new Map<string, AgentSnapshot>()
  const events = new Map<string, AgentEvent[]>()
  const listeners = new Set<(event: AgentEvent) => void>()

  const emit = (sessionId: string, kind: AgentEvent["kind"], payload: AgentEvent["payload"], extra: Partial<AgentEvent> = {}) => {
    const seq = String(++seqCounter)
    const event: AgentEvent = {
      seq,
      sessionId,
      kind,
      payload,
      createdAt: now(),
      ...extra,
    } as AgentEvent
    const list = events.get(sessionId) ?? []
    list.push(event)
    events.set(sessionId, list)
    const snap = sessions.get(sessionId)
    if (snap) snap.session.lastEventSeq = seq
    for (const listener of listeners) listener(event)
    return event
  }

  const workers: SuperWorkers = {
    handle: (async (method: string, params: Record<string, unknown>) => {
      if (method === "_deskfleet/session/create") {
        const id = `sess-${++sessionCounter}`
        const session: AgentSessionRecord = {
          id,
          workspaceId: String(params.workspaceId),
          provider: String(params.provider),
          title: String(params.title ?? "Worker"),
          context: (params.context as "directory" | "worktree") ?? "directory",
          lifecycle: "ready",
          archiveState: "active",
          lastEventSeq: "0",
          createdAt: now(),
          updatedAt: now(),
        }
        const snap: AgentSnapshot = { session, runs: [], inputs: [], turns: [], permissions: [], elicitations: [] }
        sessions.set(id, snap)
        events.set(id, [])
        return structuredClone(snap)
      }
      if (method === "_deskfleet/input/submit") {
        const sessionId = String(params.sessionId)
        const snap = sessions.get(sessionId)!
        const inputId = `in-${++seqCounter}`
        const turnId = `turn-${seqCounter}`
        const input: AgentSnapshot["inputs"][number] = {
          id: inputId,
          sessionId,
          submissionCommandId: String(params.operationId),
          author: actor,
          content: params.content as AgentSnapshot["inputs"][number]["content"],
          acceptedSeq: String(seqCounter),
          state: "delivered",
          requestedDelivery: "backlog",
          actualDelivery: "turn_start",
          turnId,
          createdAt: now(),
        }
        snap.inputs.push(input)
        snap.turns.push({
          id: turnId,
          sessionId,
          initialInputId: inputId,
          dispatchCommandId: String(params.operationId),
          runGeneration: 1,
          state: "running",
          startedAt: now(),
        })
        emit(sessionId, "input", input, { inputId, turnId })
        emit(sessionId, "turn", snap.turns.at(-1)!, { inputId, turnId })
        return { sessionId, inputId, turnId }
      }
      throw new Error(`Unsupported worker method: ${method}`)
    }) as SuperWorkers["handle"],
    onEvent: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    journal: {
      list: async () => [...sessions.values()].map(s => structuredClone(s.session)),
      read: async id => structuredClone(sessions.get(id)!),
      command: async () => null,
      commands: async () => [],
      history: async (id, afterSeq, limit = 200) => {
        const after = BigInt(afterSeq || "0")
        return (events.get(id) ?? []).filter(ev => BigInt(ev.seq) > after).slice(0, limit).map(ev => structuredClone(ev))
      },
    },
  }

  const completeTurn = (sessionId: string, finalText: string) => {
    const snap = sessions.get(sessionId)!
    const turn = snap.turns.at(-1)!
    const acpPayload = {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: finalText },
        _meta: { "deskfleet/phase": "final_answer" },
      },
    }
    emit(sessionId, "acp", acpPayload as unknown as AgentEvent["payload"], { turnId: turn.id, inputId: turn.initialInputId })
    turn.state = "completed"
    turn.endedAt = now()
    emit(sessionId, "turn", structuredClone(turn), { turnId: turn.id, inputId: turn.initialInputId })
  }

  return { workers, completeTurn }
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await fn()
  while (!predicate(last)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for expected state")
    await new Promise(resolve => setTimeout(resolve, 15))
    last = await fn()
  }
  return last
}

function createFixture() {
  const store = new MemorySuperStore()
  const { workers, completeTurn } = createFakeWorkers()
  const routeCalls: SuperRouteContext[] = []
  let routerFn: (ctx: SuperRouteContext) => Promise<SuperRouteResult> = async () => ({
    reason: "default direct reply",
    actions: [{ kind: "answer", text: "Direct answer" }],
  })
  const makeService = () => new SuperAgentService({
    agents: workers,
    store,
    authorize: async a => a,
    workspaces: async () => [{ id: workspaceId, name: "DeskFleet Workspace", roots: ["/tmp/nonexistent-root"] }],
    providers: () => [{ id: "codex", name: "Codex" }],
    ensureDefaultWorkspace: async () => workspaceId,
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({ reason: "unused", actions: [] }),
    route: async ctx => {
      routeCalls.push(ctx)
      return routerFn(ctx)
    },
  })
  const setRoute = (fn: (ctx: SuperRouteContext) => Promise<SuperRouteResult>) => { routerFn = fn }
  const snap = (service: SuperAgentService) => service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor)
  return { store, workers, completeTurn, makeService, setRoute, snap, routeCalls }
}

test("acceptance scenario: discussion A -> interjection B -> quote A plan to execute retroactively links A Q&A, skips B, and shares links with coloring", async t => {
  const f = createFixture()
  const service = f.makeService()
  await service.init()
  t.after(() => service.close())

  // 1. Discussion A (no ticket created prematurely)
  f.setRoute(async () => ({
    reason: "direct design discussion",
    actions: [{ kind: "answer", text: "建议采用 48 色 OKLab 方案并由聚焦视图共用关联记录。" }],
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-disc-a", text: "怎么设计配色和聚焦方案？" }, actor)
  const afterDiscA = await waitFor(() => f.snap(service), s => s.messages.some(m => m.id === "u-disc-a" && m.state === "answered"))
  assert.equal(afterDiscA.tickets.length, 0)
  const ansA = afterDiscA.messages.find(m => m.role === "assistant" && m.sourceMessageId === "u-disc-a")!
  assert.equal(afterDiscA.messageTicketLinks, undefined)

  // 2. Interjection B (also direct Q&A, no ticket created)
  f.setRoute(async () => ({
    reason: "direct answer for unrelated question B",
    actions: [{ kind: "answer", text: "配置 B 位于 settings.json。" }],
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-interject-b", text: "顺便问一下 B 怎么配置？" }, actor)
  const afterB = await waitFor(() => f.snap(service), s => s.messages.some(m => m.id === "u-interject-b" && m.state === "answered"))
  assert.equal(afterB.tickets.length, 0)
  const ansB = afterB.messages.find(m => m.role === "assistant" && m.sourceMessageId === "u-interject-b")!

  // 3. Execute A by quoting A's design reply (omitting explicit sourceDiscussionMessageIds to test quote fallback too)
  f.setRoute(async ctx => {
    assert.equal(ctx.quote?.messageId, ansA.id)
    assert.equal(ctx.quote?.sourceMessageId, "u-disc-a")
    return {
      reason: "user approved A plan and requested execution",
      actions: [{
        kind: "create",
        title: "SA 事项配色与聚焦",
        scope: "实现配色与聚焦视图",
        prompt: "按方案开发",
        quoteRole: "source",
      }],
    }
  })
  await service.handle("_deskfleet/super-agent/send", {
    workspaceId,
    messageId: "u-exec-a",
    text: "认可，按照这个方案开发",
    replyTo: ansA.id,
  }, actor)
  const afterDispatch = await waitFor(() => f.snap(service), s => !!s.tickets[0]?.sessionId)
  const ticketA = afterDispatch.tickets[0]!
  assert.ok(isValidAccentSlot(ticketA.accentSlot))

  // Complete Worker A turn so Worker report enters SA transcript
  f.completeTurn(ticketA.sessionId!, "已完成配色与聚焦功能开发。")
  const finalSnap = await waitFor(() => f.snap(service), s => s.messages.some(m => m.role === "worker" && m.workerEvent === "result"))
  const workerA = finalSnap.messages.find(m => m.role === "worker" && m.workerEvent === "result")!

  // Original chronological order preserved without moving or duplicating any message
  const visibleIds = finalSnap.messages.filter(m => m.kind !== "dispatch" && m.kind !== "delivery").map(m => m.id)
  assert.deepEqual(visibleIds, ["u-disc-a", ansA.id, "u-interject-b", ansB.id, "u-exec-a", workerA.id])
  assert.equal(finalSnap.messages.filter(m => m.id === "u-disc-a").length, 1)
  assert.equal(finalSnap.messages.filter(m => m.id === ansA.id).length, 1)

  // Shared canonical association links include A's discussion Q&A + execution + report, and SKIP B!
  const known = new Set(finalSnap.tickets.map(item => item.id))
  const linksOf = (id: string) => resolveCanonicalMessageTicketIds({
    message: finalSnap.messages.find(m => m.id === id)!,
    snapshotLinks: finalSnap.messageTicketLinks,
    knownTicketIds: known,
  })
  assert.deepEqual(linksOf("u-disc-a"), [ticketA.id])
  assert.deepEqual(linksOf(ansA.id), [ticketA.id])
  assert.deepEqual(linksOf("u-exec-a"), [ticketA.id])
  assert.deepEqual(linksOf(workerA.id), [ticketA.id])
  assert.deepEqual(linksOf("u-interject-b"), [])
  assert.deepEqual(linksOf(ansB.id), [])

  // Focus filtering over the exact same canonical links yields A's full chain and excludes B
  const focusedIds = visibleIds.filter(id => messageMatchesTicketFocus(linksOf(id), ticketA.id))
  assert.deepEqual(focusedIds, ["u-disc-a", ansA.id, "u-exec-a", workerA.id])
})

test("background reference quote does not transfer discussion ownership to new ticket B", async t => {
  const f = createFixture()
  const service = f.makeService()
  await service.init()
  t.after(() => service.close())

  // Discussion A -> Execute A
  f.setRoute(async () => ({ reason: "disc", actions: [{ kind: "answer", text: "方案 A 内容" }] }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-a", text: "讨论 A 方案" }, actor)
  const snap1 = await waitFor(() => f.snap(service), s => s.messages.some(m => m.id === "u-a" && m.state === "answered"))
  const ansA = snap1.messages.find(m => m.sourceMessageId === "u-a")!

  f.setRoute(async () => ({
    reason: "exec A",
    actions: [{ kind: "create", title: "事项 A", scope: "开发 A", prompt: "开发 A" }],
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-exec-a", text: "按这个方案开发", replyTo: ansA.id }, actor)
  const snapA = await waitFor(() => f.snap(service), s => s.tickets.length === 1)
  const ticketA = snapA.tickets[0]!

  // Create B quoting A's plan strictly as background reference (explicit quoteRole: "background")
  f.setRoute(async () => ({
    reason: "new ticket B with A as background only",
    actions: [{ kind: "create", title: "事项 B 说明", scope: "写 B 的文档", prompt: "写 B 说明", quoteRole: "background" }],
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-exec-b", text: "参考 A 的方案，给 B 写说明", replyTo: ansA.id }, actor)
  const snapB = await waitFor(() => f.snap(service), s => s.tickets.length === 2)
  const ticketB = snapB.tickets[1]!

  // Create C quoting A's plan with omitted quoteRole but background-reference phrasing
  f.setRoute(async () => ({
    reason: "new ticket C with background phrasing and omitted quoteRole",
    actions: [{ kind: "create", title: "事项 C 文档", scope: "写 C 的文档", prompt: "写 C 说明" }],
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-exec-c", text: "参考 A 的方案，给 C 写说明", replyTo: ansA.id }, actor)
  const snapC = await waitFor(() => f.snap(service), s => s.tickets.length === 3)
  const ticketC = snapC.tickets[2]!

  // A's discussion stays strictly on A — NEVER leaked to B or C!
  assert.deepEqual(snapC.messageTicketLinks?.["u-a"], [ticketA.id])
  assert.deepEqual(snapC.messageTicketLinks?.[ansA.id], [ticketA.id])
  assert.deepEqual(snapC.messageTicketLinks?.["u-exec-b"], [ticketB.id])
  assert.deepEqual(snapC.messageTicketLinks?.["u-exec-c"], [ticketC.id])
})

test("unquoted clear continuation links specified discussion, uncertain leaves empty, and split discussion links multiple tickets with one copy", async t => {
  const f = createFixture()
  const service = f.makeService()
  await service.init()
  t.after(() => service.close())

  // Round 1: shared design discussion
  f.setRoute(async () => ({ reason: "design", actions: [{ kind: "answer", text: "包含前端与后端两部分的完整方案" }] }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-plan", text: "请给出前后端整体方案" }, actor)
  const s1 = await waitFor(() => f.snap(service), s => s.messages.some(m => m.id === "u-plan" && m.state === "answered"))
  const ansPlan = s1.messages.find(m => m.sourceMessageId === "u-plan")!

  // Round 2: unrelated discussion (will remain unlinked on uncertain create)
  f.setRoute(async () => ({ reason: "side chat", actions: [{ kind: "answer", text: "闲聊回复" }] }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-side", text: "顺便聊下性能" }, actor)
  await waitFor(() => f.snap(service), s => s.messages.some(m => m.id === "u-side" && m.state === "answered"))

  // Round 3: unquoted instruction clearly continuing Round 1 and splitting into Ticket A + Ticket B
  f.setRoute(async ctx => {
    assert.ok(ctx.recent.some(item => item.id === "u-plan"))
    assert.ok(ctx.recent.some(item => item.id === ansPlan.id))
    return {
      reason: "split Round 1 discussion into frontend and backend tickets",
      actions: [
        { kind: "create", title: "前端任务", scope: "前端", prompt: "做前端", sourceDiscussionMessageIds: [ansPlan.id] },
        { kind: "create", title: "后端任务", scope: "后端", prompt: "做后端", sourceDiscussionMessageIds: [ansPlan.id] },
      ],
    }
  })
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-split", text: "按刚才的方案拆成前端和后端两个事项开发" }, actor)
  const sSplit = await waitFor(() => f.snap(service), s => s.tickets.length === 2)
  const [ticketFe, ticketBe] = sSplit.tickets as [SuperSnapshot["tickets"][number], SuperSnapshot["tickets"][number]]

  // Round 1 Q&A linked to BOTH tickets with only ONE stored copy of each message; Round 2 skipped!
  assert.deepEqual(sSplit.messageTicketLinks?.["u-plan"], [ticketFe.id, ticketBe.id])
  assert.deepEqual(sSplit.messageTicketLinks?.[ansPlan.id], [ticketFe.id, ticketBe.id])
  assert.deepEqual(sSplit.messageTicketLinks?.["u-split"], [ticketFe.id, ticketBe.id])
  assert.equal(sSplit.messageTicketLinks?.["u-side"], undefined)
  assert.equal(sSplit.messages.filter(m => m.id === "u-plan").length, 1)
  assert.equal(sSplit.messages.filter(m => m.id === ansPlan.id).length, 1)

  // Round 4: unquoted uncertain create leaves u-side unlinked
  f.setRoute(async () => ({
    reason: "standalone new task",
    actions: [{ kind: "create", title: "独立新任务", scope: "独立任务", prompt: "处理独立任务" }],
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-uncertain", text: "新建一个独立巡检任务" }, actor)
  const sUncertain = await waitFor(() => f.snap(service), s => s.tickets.length === 3)
  assert.equal(sUncertain.messageTicketLinks?.["u-side"], undefined)
})

test("manual linkMessage and createTicket update canonical links without re-routing or spawning Workers, and persist across restarts", async t => {
  const f = createFixture()
  let service = f.makeService()
  await service.init()

  // Unattributed discussion Q&A
  f.setRoute(async () => ({ reason: "direct", actions: [{ kind: "answer", text: "这是一段值得跟踪的讨论结论。" }] }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId, messageId: "u-note", text: "帮我梳理下发布检查项" }, actor)
  const snapBefore = await waitFor(() => f.snap(service), s => s.messages.some(m => m.id === "u-note" && m.state === "answered"))
  const ansNote = snapBefore.messages.find(m => m.sourceMessageId === "u-note")!
  assert.equal(snapBefore.tickets.length, 0)
  assert.equal(snapBefore.supportsTicketLinks, true)
  const routesBefore = f.routeCalls.length

  // Explicitly create a standalone tracked ticket (NO Worker!)
  const snapCreated = await service.handle("_deskfleet/super-agent/createTicket", {
    workspaceId,
    messageId: ansNote.id,
    title: "发布检查项跟踪",
  }, actor)
  assert.equal(f.routeCalls.length, routesBefore, "createTicket must not re-run coordinator")
  assert.equal(snapCreated.tickets.length, 1)
  const manualTicket = snapCreated.tickets[0]!
  assert.equal(manualTicket.title, "发布检查项跟踪")
  assert.equal(manualTicket.sessionId, undefined)
  assert.equal(manualTicket.status, undefined)
  assert.ok(isValidAccentSlot(manualTicket.accentSlot))
  assert.deepEqual(snapCreated.messageTicketLinks?.["u-note"], [manualTicket.id])
  assert.deepEqual(snapCreated.messageTicketLinks?.[ansNote.id], [manualTicket.id])

  // Create a second ticket manually from another message and test linkMessage multi-link & clear
  const snapSecond = await service.handle("_deskfleet/super-agent/createTicket", {
    workspaceId,
    messageId: "u-note",
    title: "上线前复核",
  }, actor)
  assert.equal(snapSecond.tickets.length, 2)
  const secondTicket = snapSecond.tickets[1]!
  assert.deepEqual(snapSecond.messageTicketLinks?.["u-note"], [manualTicket.id, secondTicket.id])
  assert.deepEqual(snapSecond.messageTicketLinks?.[ansNote.id], [manualTicket.id, secondTicket.id])

  // Reassign manually to only secondTicket via linkMessage
  const snapRelinked = await service.handle("_deskfleet/super-agent/linkMessage", {
    workspaceId,
    messageId: "u-note",
    ticketIds: [secondTicket.id],
  }, actor)
  assert.equal(f.routeCalls.length, routesBefore, "linkMessage must not re-run coordinator")
  assert.deepEqual(snapRelinked.messageTicketLinks?.["u-note"], [secondTicket.id])
  assert.deepEqual(snapRelinked.messageTicketLinks?.[ansNote.id], [secondTicket.id])

  // Restart service and verify links & manual ticket accentSlot persist
  await service.close()
  service = f.makeService()
  await service.init()
  t.after(() => service.close())
  const snapRestarted = await f.snap(service)
  assert.deepEqual(snapRestarted.messageTicketLinks?.["u-note"], [secondTicket.id])
  assert.deepEqual(snapRestarted.messageTicketLinks?.[ansNote.id], [secondTicket.id])
  assert.equal(snapRestarted.tickets.find(item => item.id === manualTicket.id)?.accentSlot, manualTicket.accentSlot)

  // Clear attribution cleanly via empty ticketIds
  const snapCleared = await service.handle("_deskfleet/super-agent/linkMessage", {
    workspaceId,
    messageId: ansNote.id,
    ticketIds: [],
  }, actor)
  assert.deepEqual(snapCleared.messageTicketLinks?.["u-note"], [])
  assert.deepEqual(snapCleared.messageTicketLinks?.[ansNote.id], [])
})

test("routeSuperMessage validates sourceDiscussionMessageIds and quoteRole strictly against context IDs", async () => {
  const baseCtx: SuperRouteContext = {
    workspaceId,
    text: "按刚才的方案开发",
    quote: { messageId: "a1", sourceMessageId: "u1", text: "方案详情" },
    recent: [
      { id: "u1", role: "user", text: "怎么配色？" },
      { id: "a1", role: "assistant", text: "方案详情", sourceMessageId: "u1" },
    ],
    tickets: [],
    workspaces: [{ id: workspaceId, name: "SA" }],
  }

  const valid = await routeSuperMessage(baseCtx, {
    model: async () => ({
      reason: "source discussion",
      actions: [{
        kind: "create",
        title: "配色实现",
        scope: "实现配色",
        prompt: "开发配色",
        quoteRole: "source",
        sourceDiscussionMessageIds: ["u1", "a1"],
      } satisfies SuperRouteAction],
    }),
  })
  assert.equal(valid.actions[0]?.kind, "create")
  if (valid.actions[0]?.kind === "create") {
    assert.equal(valid.actions[0].quoteRole, "source")
    assert.deepEqual(valid.actions[0].sourceDiscussionMessageIds, ["u1", "a1"])
  }

  await assert.rejects(
    routeSuperMessage(baseCtx, {
      model: async () => ({
        reason: "hallucinated id",
        actions: [{
          kind: "create",
          title: "配色实现",
          scope: "实现配色",
          prompt: "开发配色",
          sourceDiscussionMessageIds: ["nonexistent-id"],
        }],
      }),
    }),
    /Unknown source discussion message/,
  )
})
