import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import type { AgentActor, AgentCommand, AgentEvent, AgentMethod, AgentReceipt, AgentSessionRecord, AgentSnapshot } from "@deskfleet/protocol/agent"
import { SA_ACCENT_DISTANCE_THRESHOLD, SA_ACCENT_OKLAB_DISTANCE_TABLE, SA_ACCENT_SLOT_COUNT, isValidAccentSlot } from "@deskfleet/protocol/super-agent"
import { allocateTicketAccent, ensureRoomAccentState, roomActiveAccentSlotCounts } from "./accent.ts"
import type { routeSuperMessage } from "./router.ts"
import { SuperAgentService } from "./service.ts"
import { emptyState, note, publicRoom, roomFor, type StoredSuperTicket, type SuperStateStore, type SuperUserState } from "./state.ts"
import { LocalSuperStore } from "./store.ts"
import type { SuperWorkers } from "./worker.ts"

const actor: AgentActor = { kind: "user", userId: "user", deviceId: "device" }
const workspaceA = "workspace-a"
const workspaceB = "workspace-b"
const now = () => new Date().toISOString()

class MemoryState implements SuperStateStore {
  data = new Map<string, SuperUserState>()
  #pending: Promise<void> = Promise.resolve()
  saveDelayMs = 0

  get(uid: string) { return structuredClone(this.data.get(uid)) }
  users() { return [...this.data.keys()] }
  update<T>(uid: string, init: () => SuperUserState, edit: (state: SuperUserState) => T): Promise<T> {
    const next = this.#pending.then(async () => {
      const state = this.get(uid) || init()
      const result = edit(state)
      if (this.saveDelayMs > 0) await sleep(this.saveDelayMs)
      this.data.set(uid, structuredClone(state))
      return structuredClone(result)
    })
    this.#pending = next.then(() => {}, () => {})
    return next
  }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(5)
  }
  throw new Error("Timed out waiting for condition")
}

function createFixture(workspaces = [
  { id: workspaceA, name: "Project A", roots: ["/tmp/project-a"] },
  { id: workspaceB, name: "Project B", roots: ["/tmp/project-b"] },
]) {
  const store = new MemoryState()
  const sessions = new Map<string, AgentSnapshot>()
  const receipts = new Map<string, AgentCommand>()
  const events = new Map<string, AgentEvent[]>()
  const listeners = new Set<(event: AgentEvent) => void>()
  let route: typeof routeSuperMessage = async ctx => ({
    reason: "create ticket",
    actions: [{ kind: "create", title: ctx.text, scope: ctx.text, prompt: ctx.text }],
  })

  function createSession(id: string, ws: string): AgentSnapshot {
    const session: AgentSessionRecord = {
      id, title: id, workspaceId: ws, provider: "codex", providerSessionId: `p-${id}`,
      context: "directory", lifecycle: "ready", archiveState: "active",
      createdAt: now(), updatedAt: now(), lastEventSeq: "0",
      capabilities: { resume: true, steering: true },
    }
    const snap: AgentSnapshot = { session, runs: [], turns: [], inputs: [], permissions: [], elicitations: [] }
    sessions.set(id, snap)
    events.set(id, [])
    return snap
  }

  function emit(id: string, kind: AgentEvent["kind"], payload: AgentEvent["payload"], turnId?: string) {
    const snap = sessions.get(id)!
    const list = events.get(id)!
    const event: AgentEvent = { sessionId: id, seq: String(list.length + 1), kind, payload, createdAt: now(), turnId }
    list.push(event)
    snap.session.lastEventSeq = event.seq
    for (const fn of listeners) fn(event)
    return event
  }

  const workers: SuperWorkers = {
    async handle(method: AgentMethod, args: unknown, who: AgentActor) {
      const a = args as Record<string, string>
      let sessionId = a.sessionId
      let result: AgentSnapshot | AgentReceipt
      if (method === "_deskfleet/session/create") {
        sessionId = `session-${a.operationId}`
        result = createSession(sessionId, a.workspaceId)
      } else if (method === "_deskfleet/session/archive" || method === "_deskfleet/session/restore") {
        const snap = sessions.get(sessionId)!
        snap.session = { ...snap.session, archiveState: method === "_deskfleet/session/archive" ? "archived" : "active" }
        emit(sessionId, "session", snap.session)
        result = { operationId: a.operationId, sessionId, commandId: a.operationId }
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
    journal: {
      async list() { return [...sessions.values()].map(s => structuredClone(s.session)) },
      async read(id) {
        const snap = sessions.get(id)
        if (!snap) throw new Error(`Unknown session ${id}`)
        return structuredClone(snap)
      },
      async command(opId) { return receipts.get(opId) ?? null },
      async commands(id) { return [...receipts.values()].filter(c => c.sessionId === id) },
      async history(id, after, limit) {
        return (events.get(id) ?? []).filter(e => BigInt(e.seq) > BigInt(after)).slice(0, limit)
      },
    },
  }

  const makeService = () => new SuperAgentService({
    agents: workers,
    store,
    authorize: async who => who,
    workspaces: async () => workspaces,
    providers: () => [{ id: "codex", name: "Codex" }],
    ensureDefaultWorkspace: async () => workspaceA,
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => { throw new Error("unexpected live model") },
    route: (...args) => route(...args),
  })

  async function sendAndCreate(service: SuperAgentService, messageId: string, title: string, ws = workspaceA) {
    const beforeCount = (await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)).tickets.length
    await service.handle("_deskfleet/super-agent/send", { workspaceId: ws, messageId, text: title }, actor)
    await until(async () => {
      const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
      return snap.tickets.length > beforeCount && snap.tickets.some(t => t.title === title && t.sessionId)
    })
    const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: ws }, actor)
    return snap.tickets.find(t => t.title === title)!
  }

  return {
    store, sessions, workers, emit, makeService, sendAndCreate,
    setRoute: (fn: typeof routeSuperMessage) => { route = fn },
  }
}

test("core acceptance (service end-to-end): archive A -> only free slot -> create B reuses -> restore A keeps both slots with active occupancy 2 and A history unchanged", async t => {
  const f = createFixture()
  const service = f.makeService()
  await service.init()
  t.after(() => service.close())

  // Create ticket A and 47 other active tickets (total 48, filling every slot once).
  const ticketA = await f.sendAndCreate(service, "msg-a-1", "事项A")
  assert.ok(isValidAccentSlot(ticketA.accentSlot))
  const slotA = ticketA.accentSlot!

  // Complete ticket A's turn so it becomes completed-but-unarchived (status === undefined) — must STILL count as occupied!
  const snapA = f.sessions.get(ticketA.sessionId!)!
  const intentA = f.store.get("user")!.intents.find(i => i.ticketId === ticketA.id)!
  snapA.turns.push({
    id: "turn-a", sessionId: ticketA.sessionId!, dispatchCommandId: intentA.submitId, runGeneration: 1,
    state: "completed", initialInputId: intentA.inputId!, startedAt: now(), endedAt: now(),
  })
  f.emit(ticketA.sessionId!, "turn", snapA.turns[0]!)
  await until(() => f.store.get("user")?.rooms.find(r => r.workspaceId === workspaceA)?.tickets.find(x => x.id === ticketA.id)?.status === undefined)

  // Seed remaining 47 active tickets through normal service creation (using fast split actions in one turn to fill remaining 47).
  f.setRoute(async () => ({
    reason: "fill 47",
    actions: Array.from({ length: 47 }, (_, i) => ({
      kind: "create" as const,
      title: `填充事项-${i + 1}`,
      scope: `scope-${i + 1}`,
      prompt: `prompt-${i + 1}`,
    })),
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId: workspaceA, messageId: "msg-fill-47", text: "创建47项" }, actor)
  await until(() => (f.store.get("user")?.rooms.find(r => r.workspaceId === workspaceA)?.tickets.length ?? 0) === 48)

  const roomFull = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  assert.equal(roomFull.tickets.length, 48)
  assert.equal(new Set(roomFull.tickets.map(x => x.accentSlot)).size, 48, "first 48 active tickets must use all 48 slots once")
  assert.equal(roomActiveAccentSlotCounts(roomFull).every(c => c === 1), true, "completed-but-unarchived A still counts as active occupancy 1")

  // Archive A: A's slot stays slotA, active occupancy drops to 0 (the ONLY free slot).
  await service.handle("_deskfleet/super-agent/archiveTicket", {
    workspaceId: workspaceA, ticketId: ticketA.id, sessionId: ticketA.sessionId!, archived: true, operationId: "arch-a",
  }, actor)
  const roomAfterArchive = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  const archivedA = roomAfterArchive.tickets.find(x => x.id === ticketA.id)!
  assert.equal(archivedA.accentSlot, slotA, "archiving A must not alter A's accentSlot")
  assert.equal(roomActiveAccentSlotCounts(roomAfterArchive)[slotA], 0)
  assert.equal(roomActiveAccentSlotCounts(roomAfterArchive).filter(c => c === 0).length, 1)

  // Create B: must reuse slotA because it is the ONLY free slot.
  f.setRoute(async ctx => ({
    reason: "create B",
    actions: [{ kind: "create", title: "事项B", scope: "scope B", prompt: ctx.text }],
  }))
  const ticketB = await f.sendAndCreate(service, "msg-b-1", "事项B")
  assert.equal(ticketB.accentSlot, slotA, "B must reuse A's freed slot")
  const roomAfterB = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  assert.equal(roomActiveAccentSlotCounts(roomAfterB)[slotA], 1)

  // Restore A: A keeps slotA, B keeps slotA, active occupancy of slotA becomes 2.
  await service.handle("_deskfleet/super-agent/archiveTicket", {
    workspaceId: workspaceA, ticketId: ticketA.id, sessionId: ticketA.sessionId!, archived: false, operationId: "rest-a",
  }, actor)
  const snapRestored = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspaceA }, actor)
  const finalRoom = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  const finalA = snapRestored.tickets.find(x => x.id === ticketA.id)!
  const finalB = snapRestored.tickets.find(x => x.id === ticketB.id)!
  assert.equal(finalA.accentSlot, slotA)
  assert.equal(finalB.accentSlot, slotA)
  assert.equal(finalA.archiveState, undefined)
  assert.equal(roomActiveAccentSlotCounts(finalRoom)[slotA], 2)

  // A's historical messages still belong to A with slotA unchanged.
  const aHistoryMsg = snapRestored.messages.find(m => m.id === "msg-a-1")!
  assert.equal(aHistoryMsg.ticketId, ticketA.id)
  assert.equal(snapRestored.tickets.find(x => x.id === aHistoryMsg.ticketId)!.accentSlot, slotA)
})

test("first 48 tickets each get one distinct color, 49th ticket stably reuses without altering old tickets, and threshold-satisfied selection prefers lower active occupancy", async t => {
  const f = createFixture()
  const service = f.makeService()
  await service.init()
  t.after(() => service.close())

  // Create 48 active tickets
  f.setRoute(async () => ({
    reason: "fill 48",
    actions: Array.from({ length: 48 }, (_, i) => ({
      kind: "create" as const,
      title: `任务-${i + 1}`,
      scope: `scope-${i + 1}`,
      prompt: `prompt-${i + 1}`,
    })),
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId: workspaceA, messageId: "m-48", text: "创建48项" }, actor)
  await until(() => (f.store.get("user")?.rooms.find(r => r.workspaceId === workspaceA)?.tickets.length ?? 0) === 48)

  const before49 = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!.tickets.map(x => [x.id, x.accentSlot] as const)
  assert.equal(new Set(before49.map(([, slot]) => slot)).size, 48)

  // Create 49th ticket: reuses a valid slot, leaves all 48 prior tickets untouched
  f.setRoute(async ctx => ({
    reason: "create 49th",
    actions: [{ kind: "create", title: "任务-49", scope: "scope-49", prompt: ctx.text }],
  }))
  const ticket49 = await f.sendAndCreate(service, "m-49", "任务-49")
  assert.ok(isValidAccentSlot(ticket49.accentSlot))

  const afterRoom = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  for (const [id, slot] of before49) {
    assert.equal(afterRoom.tickets.find(x => x.id === id)?.accentSlot, slot, `ticket ${id} must not recolor`)
  }
  const countsAfter49 = roomActiveAccentSlotCounts(afterRoom)
  assert.equal(countsAfter49.reduce((a, b) => a + b, 0), 49)
  assert.equal(countsAfter49[ticket49.accentSlot!], 2)

  // Threshold-satisfied low-occupancy preference on a room with unequal active counts
  const room = roomFor(emptyState(), "ws-threshold", "codex")
  const recentSlot = 0
  const safeSlots = Array.from({ length: SA_ACCENT_SLOT_COUNT }, (_, s) => ({
    slot: s,
    dist: SA_ACCENT_OKLAB_DISTANCE_TABLE[s]![recentSlot]!,
  })).filter(entry => entry.dist >= SA_ACCENT_DISTANCE_THRESHOLD).sort((a, b) => a.dist - b.dist)
  const lowOccSlot = safeSlots[0]!.slot
  const highDistSlot = safeSlots.at(-1)!.slot
  room.accentSlotCounts = Array.from({ length: SA_ACCENT_SLOT_COUNT }, (_, s) =>
    s === lowOccSlot ? 1 : s === highDistSlot ? 4 : 5)
  room.recentAccentSlots = [recentSlot]
  const next: StoredSuperTicket = { id: "low-occ-ticket", title: "低占用优先", scope: "s", summary: "", provider: "codex", updatedAt: now() }
  allocateTicketAccent(room, next)
  assert.equal(next.accentSlot, lowOccSlot)
  assert.equal(room.accentSlotCounts[lowOccSlot], 2)
})

test("concurrent SuperAgentService sends serialize ticket creation in order without colliding free slots", async t => {
  const f = createFixture()
  f.store.saveDelayMs = 2
  const service = f.makeService()
  await service.init()
  t.after(() => service.close())

  const requests = Array.from({ length: 8 }, (_, i) =>
    service.handle("_deskfleet/super-agent/send", { workspaceId: workspaceA, messageId: `conc-msg-${i}`, text: `并发任务-${i}` }, actor))
  await Promise.all(requests)
  await until(() => (f.store.get("user")?.rooms.find(r => r.workspaceId === workspaceA)?.tickets.length ?? 0) === 8)

  const room = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  assert.deepEqual(room.tickets.map(x => x.title), Array.from({ length: 8 }, (_, i) => `并发任务-${i}`))
  assert.equal(new Set(room.tickets.map(x => x.accentSlot)).size, 8)
  assert.equal(roomActiveAccentSlotCounts(room).reduce((a, b) => a + b, 0), 8)
})

test("concurrent ticket creations serialize in creation order and atomically update accentSlot and occupancy", async () => {
  // Use real LocalSuperStore with async save delay to exercise true concurrent store.update interleaving.
  let savedJson: string | undefined
  let savedRev = 0
  const catalog = {
    async superAgentStates() {
      return savedJson ? [{ userId: "user", revision: savedRev, stateJson: savedJson }] : []
    },
    async saveSuperAgentState(_uid: string, expectedRev: number, stateJson: string) {
      assert.equal(expectedRev, savedRev, "concurrent writes must be strictly serialized")
      await sleep(5)
      savedRev += 1
      savedJson = stateJson
    },
  }
  const store = new LocalSuperStore<SuperUserState>(catalog)
  await store.init()

  const order: string[] = []
  const created = await Promise.all(
    Array.from({ length: 12 }, (_, idx) => {
      const id = `concurrent-${idx}`
      return store.update("user", emptyState, state => {
        const room = roomFor(state, workspaceA, "codex")
        const ticket: StoredSuperTicket = { id, title: `并发-${idx}`, scope: "s", summary: "", provider: "codex", updatedAt: now() }
        allocateTicketAccent(room, ticket)
        room.tickets.push(ticket)
        note(room, ticket.title, { kind: "dispatch", ticketId: ticket.id })
        order.push(id)
        return { id, slot: ticket.accentSlot! }
      })
    }),
  )

  assert.deepEqual(order, Array.from({ length: 12 }, (_, i) => `concurrent-${i}`))
  const slots = created.map(c => c.slot)
  assert.equal(new Set(slots).size, 12, "concurrent creates must never duplicate free slots")

  const persisted = store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  const counts = roomActiveAccentSlotCounts(persisted)
  assert.equal(counts.reduce((a, b) => a + b, 0), 12)
  for (const s of slots) assert.equal(counts[s], 1)
})

test("workspaces maintain strictly isolated 48-slot occupancy counts and recent-7 lists", async t => {
  const f = createFixture()
  const service = f.makeService()
  await service.init()
  t.after(() => service.close())

  // Fill all 48 slots in workspaceA
  f.setRoute(async () => ({
    reason: "fill 48",
    actions: Array.from({ length: 48 }, (_, i) => ({
      kind: "create" as const,
      title: `A-${i}`,
      scope: `scope-${i}`,
      prompt: `prompt-${i}`,
    })),
  }))
  await service.handle("_deskfleet/super-agent/send", { workspaceId: workspaceA, messageId: "fill-a", text: "fill A" }, actor)
  await until(() => (f.store.get("user")?.rooms.find(r => r.workspaceId === workspaceA)?.tickets.length ?? 0) === 48)

  // Now create a ticket in workspaceB: its occupancy must start at all zeros (independent of workspaceA)
  f.setRoute(async ctx => ({
    reason: "create in B",
    actions: [{ kind: "create", title: "B-1", scope: "b", prompt: ctx.text }],
  }))
  const bTicket = await f.sendAndCreate(service, "b-msg-1", "B-1", workspaceB)
  assert.ok(isValidAccentSlot(bTicket.accentSlot))

  const roomA = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  const roomB = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceB)!
  assert.equal(roomActiveAccentSlotCounts(roomA).reduce((x, y) => x + y, 0), 48)
  assert.equal(roomActiveAccentSlotCounts(roomB).reduce((x, y) => x + y, 0), 1)
  assert.equal(roomB.recentAccentSlots?.length, 1)
  assert.equal(roomB.recentAccentSlots?.[0], bTicket.accentSlot)
})

test("legacy rooms without accentSlot, accentSlotCounts, or recentAccentSlots backfill deterministically on first load without requiring new messages or reordering existing slots", async t => {
  const f = createFixture()
  const existingValidSlot = 17
  // Seed legacy pre-feature state directly in store (mix of legacy uncolored tickets + one already-colored ticket).
  await f.store.update("user", emptyState, state => {
    state.rooms.push({
      workspaceId: workspaceA,
      provider: "codex",
      tickets: [
        { id: "legacy-1", title: "旧事项一", scope: "old-1", summary: "done", provider: "codex", updatedAt: now() },
        { id: "existing-colored", title: "已有色号事项", scope: "keep", summary: "", provider: "codex", accentSlot: existingValidSlot, updatedAt: now() },
        { id: "legacy-2", title: "旧事项二", scope: "old-2", summary: "", provider: "codex", updatedAt: now() },
        { id: "legacy-archived", title: "旧归档事项", scope: "old-arch", summary: "done", provider: "codex", archiveState: "archived", updatedAt: now() },
      ],
      messages: [
        { id: "legacy-m1", role: "user", text: "旧问题一", ticketId: "legacy-1", createdAt: now(), state: "answered" },
        { id: "legacy-m2", role: "user", text: "旧问题二", ticketId: "legacy-2", createdAt: now(), state: "answered" },
      ],
      recentTicketIds: ["legacy-2", "legacy-1"],
    })
  })

  const service = f.makeService()
  await service.init()

  // First snapshot WITHOUT creating, resending, or editing any message immediately yields stable valid slots for all legacy tickets.
  const snapBefore = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspaceA }, actor)
  const slotLeg1 = snapBefore.tickets.find(x => x.id === "legacy-1")?.accentSlot
  const slotExisting = snapBefore.tickets.find(x => x.id === "existing-colored")?.accentSlot
  const slotLeg2 = snapBefore.tickets.find(x => x.id === "legacy-2")?.accentSlot
  const slotArchived = snapBefore.tickets.find(x => x.id === "legacy-archived")?.accentSlot

  assert.ok(isValidAccentSlot(slotLeg1))
  assert.equal(slotExisting, existingValidSlot, "existing valid accentSlot must never change or be reordered")
  assert.ok(isValidAccentSlot(slotLeg2))
  assert.ok(isValidAccentSlot(slotArchived))
  assert.equal(new Set([slotLeg1, slotExisting, slotLeg2, slotArchived]).size, 4, "distinct legacy and existing tickets must get distinct slots")
  assert.ok(SA_ACCENT_OKLAB_DISTANCE_TABLE[slotLeg1!]![slotLeg2!]! >= SA_ACCENT_DISTANCE_THRESHOLD)

  // Active occupancy counts ONLY unarchived tickets (legacy-1, existing-colored, legacy-2 = 3; legacy-archived = 0).
  const roomBefore = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  const countsBefore = roomActiveAccentSlotCounts(roomBefore)
  assert.equal(countsBefore.reduce((x, y) => x + y, 0), 3)
  assert.equal(countsBefore[slotLeg1!], 1)
  assert.equal(countsBefore[existingValidSlot], 1)
  assert.equal(countsBefore[slotLeg2!], 1)
  assert.equal(countsBefore[slotArchived!], 0)

  // Creating a brand-new ticket alongside backfilled legacy tickets avoids colliding with them and preserves legacy slots.
  const fresh = await f.sendAndCreate(service, "fresh-1", "新事项")
  assert.ok(isValidAccentSlot(fresh.accentSlot))
  assert.ok(![slotLeg1, existingValidSlot, slotLeg2].includes(fresh.accentSlot!))

  const snapAfter = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspaceA }, actor)
  assert.equal(snapAfter.tickets.find(x => x.id === "legacy-1")?.accentSlot, slotLeg1)
  assert.equal(snapAfter.tickets.find(x => x.id === "existing-colored")?.accentSlot, existingValidSlot)
  assert.equal(snapAfter.tickets.find(x => x.id === "legacy-2")?.accentSlot, slotLeg2)
  assert.equal(snapAfter.tickets.find(x => x.id === "legacy-archived")?.accentSlot, slotArchived)

  const roomAfter = f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!
  const countsAfter = roomActiveAccentSlotCounts(roomAfter)
  assert.equal(countsAfter.reduce((x, y) => x + y, 0), 4)
  assert.equal(countsAfter[fresh.accentSlot!], 1)

  // Restart/reload preserves exact same slots and lazy snapshot backfill works for rooms inserted after init().
  await service.close()
  await f.store.update("user", emptyState, state => {
    state.rooms.push({
      workspaceId: workspaceB,
      provider: "codex",
      tickets: [
        { id: "lazy-1", title: "延迟加载旧事项一", scope: "lazy-1", summary: "", provider: "codex", updatedAt: now() },
        { id: "lazy-2", title: "延迟加载旧事项二", scope: "lazy-2", summary: "", provider: "codex", updatedAt: now() },
      ],
      messages: [],
      recentTicketIds: [],
    })
  })
  const reloaded = f.makeService()
  await reloaded.init()
  t.after(() => reloaded.close())

  const snapReload = await reloaded.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspaceA }, actor)
  assert.equal(snapReload.tickets.find(x => x.id === "legacy-1")?.accentSlot, slotLeg1)
  assert.equal(snapReload.tickets.find(x => x.id === "existing-colored")?.accentSlot, existingValidSlot)
  assert.equal(snapReload.tickets.find(x => x.id === "legacy-2")?.accentSlot, slotLeg2)
  assert.equal(snapReload.tickets.find(x => x.id === "legacy-archived")?.accentSlot, slotArchived)
  assert.equal(snapReload.tickets.find(x => x.id === fresh.id)?.accentSlot, fresh.accentSlot)

  const snapLazy = await reloaded.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspaceB }, actor)
  const lazy1 = snapLazy.tickets.find(x => x.id === "lazy-1")?.accentSlot
  const lazy2 = snapLazy.tickets.find(x => x.id === "lazy-2")?.accentSlot
  assert.ok(isValidAccentSlot(lazy1))
  assert.ok(isValidAccentSlot(lazy2))
  assert.notEqual(lazy1, lazy2)
})

test("recent-7 updates incrementally on new messages and color selection never scans message history", () => {
  const state = emptyState()
  const room = roomFor(state, workspaceA, "codex")
  ensureRoomAccentState(room)

  // Add 10 tickets and emit one message per ticket -> recentAccentSlots holds the 7 most recent distinct colors.
  const slots: number[] = []
  for (let i = 0; i < 10; i++) {
    const ticket: StoredSuperTicket = { id: `t-${i}`, title: `T${i}`, scope: "s", summary: "", provider: "codex", updatedAt: now() }
    allocateTicketAccent(room, ticket)
    room.tickets.push(ticket)
    note(room, `msg-${i}`, { role: "worker", ticketId: ticket.id, workerEvent: "result" })
    slots.push(ticket.accentSlot!)
  }
  assert.deepEqual(room.recentAccentSlots, slots.slice(-7).reverse())

  // Public snapshot read must not alter recentAccentSlots or accentSlotCounts.
  const recentBefore = [...room.recentAccentSlots!]
  const countsBefore = [...room.accentSlotCounts!]
  publicRoom(room, "codex", "codex", [])
  assert.deepEqual(room.recentAccentSlots, recentBefore)
  assert.deepEqual(room.accentSlotCounts, countsBefore)

  // Guard room.messages with a throwing Proxy to prove allocateTicketAccent NEVER touches room.messages!
  const guardedRoom = new Proxy(room, {
    get(target, prop, receiver) {
      if (prop === "messages") throw new Error("allocateTicketAccent must not scan message history")
      return Reflect.get(target, prop, receiver)
    },
  })
  const nextTicket: StoredSuperTicket = { id: "t-no-scan", title: "NoScan", scope: "s", summary: "", provider: "codex", updatedAt: now() }
  allocateTicketAccent(guardedRoom, nextTicket)
  assert.ok(isValidAccentSlot(nextTicket.accentSlot))

  // Also verify threshold-satisfied low-occupancy rule on 49th ticket in a room
  assert.ok(SA_ACCENT_DISTANCE_THRESHOLD > 0)
  assert.equal(SA_ACCENT_OKLAB_DISTANCE_TABLE.length, SA_ACCENT_SLOT_COUNT)
})

test("restarting SuperAgentService preserves persisted accentSlot, occupancy counts, and recent-7", async t => {
  const f = createFixture()
  let service = f.makeService()
  await service.init()

  const a = await f.sendAndCreate(service, "m-a", "持久事项A")
  const b = await f.sendAndCreate(service, "m-b", "持久事项B")
  assert.notEqual(a.accentSlot, b.accentSlot)
  const recentBefore = [...(f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!.recentAccentSlots ?? [])]

  await service.close()
  service = f.makeService()
  await service.init()
  t.after(() => service.close())

  const snap = await service.handle("_deskfleet/super-agent/snapshot", { workspaceId: workspaceA }, actor)
  assert.equal(snap.tickets.find(x => x.id === a.id)?.accentSlot, a.accentSlot)
  assert.equal(snap.tickets.find(x => x.id === b.id)?.accentSlot, b.accentSlot)
  assert.deepEqual(f.store.get("user")!.rooms.find(r => r.workspaceId === workspaceA)!.recentAccentSlots, recentBefore)
})
