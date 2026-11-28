import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import type { AgentActor, AgentEvent, AgentInput, AgentSessionRecord, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { SuperSnapshot } from "@deskfleet/protocol/super-agent"
import { SessionAttachments } from "../agent/attachments.ts"
import { SuperAttachmentStore } from "./attachments.ts"
import type { SuperRouteContext, SuperRouteResult } from "./router.ts"
import { SuperAgentService } from "./service.ts"
import { emptyState, type SuperStateStore, type SuperUserState } from "./state.ts"
import type { SuperWorkers } from "./worker.ts"

const actor: AgentActor = { kind: "user", userId: "user-reedit", deviceId: "dev-reedit" }
const workspaceId = "ws-reedit"
const now = () => "2026-11-28T00:00:00.000Z"

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

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error("Timed out waiting for condition")
}

function createHarness(rootDir: string, options: {
  routeHandler?: (ctx: SuperRouteContext, signal?: AbortSignal) => Promise<SuperRouteResult>
} = {}) {
  const store = new MemorySuperStore()
  const sessionAttachments = new SessionAttachments(rootDir)
  const attachments = new SuperAttachmentStore(rootDir, (uid, path) => sessionAttachments.fileGrant(uid, path))
  const routeCalls: SuperRouteContext[] = []
  const submittedContent: AgentInput["content"][] = []

  let seqCounter = 0
  let sessionCounter = 0
  const sessions = new Map<string, AgentSnapshot>()
  const events = new Map<string, AgentEvent[]>()
  const listeners = new Set<(event: AgentEvent) => void>()

  const emit = (sessionId: string, kind: AgentEvent["kind"], payload: AgentEvent["payload"], extra: Partial<AgentEvent> = {}) => {
    const seq = String(++seqCounter)
    const event = { seq, sessionId, kind, payload, createdAt: now(), ...extra } as AgentEvent
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
        const content = params.content as AgentInput["content"]
        submittedContent.push(structuredClone(content))
        const input: AgentSnapshot["inputs"][number] = {
          id: inputId,
          sessionId,
          submissionCommandId: String(params.operationId),
          author: actor,
          content,
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
      if (method === "_deskfleet/turn/cancel") {
        const sessionId = String(params.sessionId)
        const turnId = String(params.turnId)
        const snap = sessions.get(sessionId)!
        const turn = snap.turns.find(item => item.id === turnId)!
        turn.state = "cancelled"
        emit(sessionId, "turn", { ...turn }, { turnId, inputId: turn.initialInputId })
        return { sessionId, turnId }
      }
      throw new Error(`Unsupported method: ${method}`)
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
      history: async (id, afterSeq, limit) =>
        (events.get(id) ?? []).filter(e => BigInt(e.seq) > BigInt(afterSeq)).slice(0, limit),
    },
  }

  let routeHandler = options.routeHandler ?? (async ctx => ({
    reason: "direct answer",
    actions: [{ kind: "answer", text: `ok:${ctx.text}` }],
  }))

  const service = new SuperAgentService({
    agents: workers,
    attachments,
    defaultCoordinator: "claude",
    coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    coordinatorModel: () => async () => ({ reason: "unused", actions: [] }),
    store,
    authorize: async who => who,
    workspaces: async () => [{ id: workspaceId, name: "Demo", roots: [rootDir] }],
    providers: () => [{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }],
    ensureDefaultWorkspace: async () => workspaceId,
    route: async (ctx, opts) => {
      routeCalls.push(structuredClone(ctx))
      return routeHandler(ctx, opts.signal)
    },
  })

  return {
    service,
    store,
    attachments,
    sessionAttachments,
    routeCalls,
    submittedContent,
    setRouteHandler(fn: (ctx: SuperRouteContext, signal?: AbortSignal) => Promise<SuperRouteResult>) {
      routeHandler = fn
    },
    snap: () => service.handle("_deskfleet/super-agent/snapshot", { workspaceId }, actor) as Promise<SuperSnapshot>,
    send: (params: Record<string, unknown>) => service.handle("_deskfleet/super-agent/send", { workspaceId, ...params }, actor) as Promise<SuperSnapshot>,
    stop: (params: Record<string, unknown>) => service.handle("_deskfleet/super-agent/stop", { workspaceId, ...params }, actor) as Promise<SuperSnapshot>,
  }
}

test("reEditOf links revised turn to confirmed-stopped turn, hides old turn from coordinator recent, and rejects non-stopped targets", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sa-reedit-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let releaseFirstRoute!: () => void
  const firstRouteStarted = new Promise<void>(resolve => {
    // resolved inside handler
    void resolve
  })
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  void firstRouteStarted

  const h = createHarness(dir, {
    routeHandler: async (ctx, signal) => {
      if (ctx.text.includes("啊啊啊")) {
        markStarted()
        await new Promise<void>(resolve => {
          releaseFirstRoute = resolve
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return { reason: "aborted", actions: [{ kind: "answer", text: "never" }] }
      }
      return { reason: "answered", actions: [{ kind: "answer", text: `reply:${ctx.text}` }] }
    },
  })
  await h.service.init()
  t.after(() => h.service.close())

  // 1) Send a message and stop it while routing
  await h.send({ messageId: "u-bad", text: "增加啊啊啊 给 Super Agent 改名" })
  await started

  // Reject reEditOf while still routing!
  await assert.rejects(
    h.send({ messageId: "u-too-early", text: "太早重编辑", reEditOf: "u-bad" }),
    /confirmed stopped/i,
  )

  await h.stop({ messageId: "u-bad", revision: 0 })
  releaseFirstRoute()
  const afterStop = await h.snap()
  assert.equal(afterStop.supportsStoppedReEdit, true)
  assert.equal(afterStop.messages.find(m => m.id === "u-bad")?.state, "stopped")

  // 2) Send an unrelated message in between (no reEditOf)
  await h.send({ messageId: "u-other", text: "顺便查下构建状态" })
  await until(async () => (await h.snap()).messages.find(m => m.id === "u-other")?.state === "answered")

  // Reject reEditOf pointing to answered message or self
  await assert.rejects(
    h.send({ messageId: "u-bad-target", text: "错误目标", reEditOf: "u-other" }),
    /confirmed stopped/i,
  )
  await assert.rejects(
    h.send({ messageId: "u-self", text: "自指", reEditOf: "u-self" }),
    /same message/i,
  )

  // 3) Send explicit re-edit of u-bad
  const afterRevised = await h.send({
    messageId: "u-revised",
    text: "在设置中增加给 Super Agent 改名的功能",
    reEditOf: "u-bad",
  })
  assert.equal(afterRevised.messages.find(m => m.id === "u-revised")?.reEditOf, "u-bad")
  // Idempotent retry with identical messageId and reEditOf succeeds without duplicating
  await h.send({
    messageId: "u-revised",
    text: "在设置中增加给 Super Agent 改名的功能",
    reEditOf: "u-bad",
  })
  // Mismatched reEditOf on existing messageId is rejected
  await assert.rejects(
    h.send({
      messageId: "u-revised",
      text: "在设置中增加给 Super Agent 改名的功能",
    }),
    /already used for a different request/i,
  )

  await until(async () => (await h.snap()).messages.find(m => m.id === "u-revised")?.state === "answered")

  // Verify coordinator saw u-other, did NOT see superseded u-bad in recent!
  const revisedCtx = h.routeCalls.find(call => call.text === "在设置中增加给 Super Agent 改名的功能")
  assert.ok(revisedCtx)
  assert.equal(revisedCtx.recent.some(item => item.id === "u-bad"), false)
  assert.equal(revisedCtx.recent.some(item => item.id === "u-other"), true)

  // 4) Subsequent turn sees u-revised (not superseded u-bad) in recent
  await h.send({ messageId: "u-followup", text: "再补一个恢复默认名称的说明" })
  await until(async () => (await h.snap()).messages.find(m => m.id === "u-followup")?.state === "answered")
  const followupCtx = h.routeCalls.find(call => call.text === "再补一个恢复默认名称的说明")
  assert.ok(followupCtx)
  assert.equal(followupCtx.recent.some(item => item.id === "u-revised"), true)
  assert.equal(followupCtx.recent.some(item => item.id === "u-bad"), false)

  // Original stopped message remains preserved in room history
  const finalSnap = await h.snap()
  assert.equal(finalSnap.messages.some(m => m.id === "u-bad"), true)
})

test("reEditOf reuses immutable attachments (image, paste, and snapshot file) and delivers them to the Worker", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sa-reedit-att-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const projectDir = join(dir, "project")
  await mkdir(projectDir)
  const specFile = join(projectDir, "spec.txt")
  await writeFile(specFile, "original spec content")

  let blockFirst!: () => void
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })

  const h = createHarness(projectDir, {
    routeHandler: async (ctx, signal) => {
      if (ctx.text === "错误指令带附件") {
        markStarted()
        await new Promise<void>(resolve => {
          blockFirst = resolve
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
        return { reason: "aborted", actions: [{ kind: "answer", text: "aborted" }] }
      }
      return {
        reason: "create worker with reused attachments",
        actions: [{ kind: "create", title: "Spec Task", scope: "Review reused spec", prompt: ctx.text || "Review attachment" }],
      }
    },
  })
  await h.service.init()
  t.after(() => h.service.close())

  // Send original stopped message with image + pasted resource + file resource_link
  const pngBase64 = Buffer.from("fake-png").toString("base64")
  await h.send({
    messageId: "u-att-1",
    text: "错误指令带附件",
    attachments: [
      { type: "image", mimeType: "image/png", data: pngBase64 },
      { type: "resource", resource: { uri: "deskfleet://pasted-text/1.txt", mimeType: "text/plain", text: "pasted logs" } },
      { type: "resource_link", name: "spec.txt", uri: pathToFileURL(specFile).href, mimeType: "text/plain", size: 21 },
    ],
  })
  await started
  await h.stop({ messageId: "u-att-1", revision: 0 })
  blockFirst()

  // Delete original file from project dir to prove reuse copies from immutable attachment store!
  await rm(specFile)

  // Re-edit keeping index 0 (image) and index 2 (spec.txt), dropping index 1, with empty text (attachment-only)
  const revisedSnap = await h.send({
    messageId: "u-att-2",
    text: "",
    reEditOf: "u-att-1",
    reusedAttachments: [
      { messageId: "u-att-1", index: 0 },
      { messageId: "u-att-1", index: 2 },
    ],
  })
  const revisedMsg = revisedSnap.messages.find(m => m.id === "u-att-2")
  assert.ok(revisedMsg)
  assert.equal(revisedMsg.reEditOf, "u-att-1")
  assert.deepEqual(revisedMsg.attachments, [
    { type: "image", name: "image/png" },
    { type: "resource_link", name: "spec.txt" },
  ])

  // Wait for Worker dispatch and verify full original blocks arrived intact
  await until(() => h.submittedContent.length === 1)
  const delivered = h.submittedContent[0]!
  assert.equal(delivered[0]?.type, "image")
  assert.equal(delivered[1]?.type, "resource_link")
  if (delivered[1]?.type === "resource_link") {
    assert.equal(await readFile(fileURLToPath(delivered[1].uri), "utf8"), "original spec content")
  }

  // Preview on the new message's reused file attachment also works
  const previewSnap = await h.service.handle("_deskfleet/super-agent/snapshot", {
    workspaceId,
    attachment: { messageId: "u-att-2", index: 1 },
  }, actor) as SuperSnapshot
  assert.deepEqual(previewSnap.attachmentPreview?.content, {
    type: "resource_link",
    data: Buffer.from("original spec content").toString("base64"),
    mimeType: "text/plain",
  })

  // Out-of-range reused attachment index is rejected
  await assert.rejects(
    h.send({
      messageId: "u-att-bad",
      text: "bad index",
      reusedAttachments: [{ messageId: "u-att-1", index: 9 }],
    }),
    /Attachment unavailable/i,
  )
})

test("reEditOf is accepted for a dispatched worker turn confirmed stopped via cancellation without resuming the old stopped ticket", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sa-reedit-worker-"))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const h = createHarness(dir, {
    routeHandler: async ctx => {
      if (ctx.text === "旧任务指令") {
        return { reason: "new task", actions: [{ kind: "create", title: "Old Task", scope: "Old scope", prompt: "Old prompt" }] }
      }
      return { reason: "fresh task", actions: [{ kind: "answer", text: "已按修正版直接处理" }] }
    },
  })
  await h.service.init()
  t.after(() => h.service.close())

  await h.send({ messageId: "u-work-1", text: "旧任务指令" })
  await until(() => h.submittedContent.length === 1)

  // Stop the active worker turn
  await h.stop({ messageId: "u-work-1", revision: 0 })
  await until(async () => {
    const snap = await h.snap()
    return snap.messages.some(m => m.role === "worker" && m.sourceMessageId === "u-work-1" && m.stopState === "stopped")
  })
  const stoppedSnap = await h.snap()
  const oldTicket = stoppedSnap.tickets[0]!
  assert.equal(oldTicket.status, "stopped")

  // Re-edit the stopped worker turn -> succeeds, old ticket stays stopped (never auto-resumed)
  await h.send({ messageId: "u-work-2", text: "修正版指令", reEditOf: "u-work-1" })
  await until(async () => (await h.snap()).messages.find(m => m.id === "u-work-2")?.state === "answered")
  const finalSnap = await h.snap()
  assert.equal(finalSnap.tickets.find(item => item.id === oldTicket.id)?.status, "stopped")
  assert.equal(h.submittedContent.length, 1, "must not auto-resume old stopped worker")
})
