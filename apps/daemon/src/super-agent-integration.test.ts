import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { BackendAgent } from "../../../scripts/fixtures/backend-agent.ts"
import { AgentChannel } from "./agent-channel.ts"
import { AgentProviders } from "./agent-providers.ts"
import type { AgentActor, AgentPermission, AgentSnapshot } from "./agent-protocol.ts"
import { AgentSessions } from "./agent-sessions.ts"
import { DaemonCatalog } from "./catalog.ts"
import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import type { routeSuperMessage } from "./super-agent-router.ts"
import type { SuperHistory, SuperSnapshot } from "./super-agent-protocol.ts"
import { organizeHistory } from "./super-agent-history.ts"
import { SuperAgentService, type SuperUserState } from "./super-agent-service.ts"
import { LocalSuperStore } from "./super-agent-store.ts"
import { superWorkspaces } from "./super-agent-workspaces.ts"

const actor: AgentActor = { kind: "user", userId: "member", deviceId: "login" }
async function eventually<T>(read: () => Promise<T>, ready: (result: T) => boolean) {
  const deadline = Date.now() + 12_000
  for (;;) {
    const value = await read()
    if (ready(value)) return value
    assert.ok(Date.now() < deadline, "Timed out waiting for the fixture worker")
    await delay(10)
  }
}

async function open(directory: string, backend: BackendAgent, choose?: typeof routeSuperMessage, quotas = new TestAgentQuotas()) {
  const catalog = new DaemonCatalog(directory)
  await catalog.init()
  const store = new LocalSuperStore<SuperUserState>(catalog.native)
  await store.init()
  const providers = new AgentProviders(directory, backend); await providers.init()
  const workers = new AgentSessions(catalog, catalog.native, backend, providers, undefined, undefined, quotas)
  await workers.init()
  const createService = () => new SuperAgentService({
    registration: () => ({ teamId: "team", machineId: "machine" }),
    supportsCoordinator: () => true, coordinatorOptions: async () => ({ models: [], defaultReasoningEfforts: [] }),
    agents: workers, store, providers: () => providers.metadata().providers, ...superWorkspaces(catalog, directory),
    authorize: async who => { assert.deepEqual(who, actor); return who },
    route: choose || (async ctx => ({ reason: "fixture assignment", actions: ctx.focusTicketId ? [{kind: "continue", ticketId:ctx.focusTicketId, prompt:ctx.text}] : [{kind: "create", title: "Read README", scope: "Read only", prompt: ctx.text}] })),
  })
  let service = createService()
  await service.init()
  const replies = new Map<number, {result?: unknown; error?: {message: string}}>()
  let buffer = "", sequence = 0
  const channel = new AgentChannel({ journal: workers.journal, onEvent: fn => workers.onEvent(fn),
    handle: (method, params, who) => workers.handle(method, params, who), superAgent: (method, params, who) => service.handle(method, params, who) },
  actor, async bytes => {
    buffer += Buffer.from(bytes).toString()
    let index
    while ((index = buffer.indexOf("\n")) >= 0) {
      const reply = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
      if (typeof reply.id === "number") replies.set(reply.id, reply)
    }
  }, error => { throw error })
  async function call<T>(method: string, params: object): Promise<T> {
    const id = ++sequence
    channel.receive(Buffer.from(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n"))
    const response = await eventually(async () => replies.get(id), Boolean)
    replies.delete(id)
    if (response!.error) throw new Error(response!.error.message)
    return response!.result as T
  }
  await call("initialize", {protocolVersion: 1})
  return { catalog, providers, workers, store, call, async restartFront() {
    await service.close()
    service = createService()
    await service.init()
  }, async close() {
    channel.close()
    try { await Promise.all([service.close(), workers.close()]); await store.close() } finally { await catalog.close() }
  } }
}

test("Agent channel, SQLite, real AgentSessions permissions and result projection survive reopening", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-super-agent-"))
  const project = join(directory, "project"); await mkdir(project)
  const backend = new BackendAgent()
  let machine = await open(directory, backend)
  t.after(async () => { try { await machine.close() } finally { await rm(directory, {recursive:true, force:true}) } })
  const workspaceId = (await machine.catalog.native.createWorkspace("Project", [{path: project}])).id
  await machine.providers.create({template: "codex", name: "Fixture Codex", env: {}, inheritShellEnvironment: false})
  const snap = () => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", {workspaceId})
  const request = {workspaceId, messageId: randomUUID(), text: "Read README"}
  await machine.call("_deskfleet/super-agent/send", request)
  const waiting = await eventually(snap, value => value.tickets[0]?.status === "attention")
  const sessionId = waiting.tickets[0]!.sessionId!
  assert.equal(waiting.messages.find(m => m.role === "worker")?.sessionId, sessionId)
  const session = await machine.workers.journal.read(sessionId)
  assert.equal(session.inputs.length, 1); assert.deepEqual(session.inputs[0]!.author, actor)
  const permission = waiting.pendingRequests?.[0]
  assert.ok(permission?.kind === "permission")
  assert.equal(permission.ticketId, waiting.tickets[0]!.id)
  assert.deepEqual(permission.item, session.permissions[0])
  assert.deepEqual((await machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", {workspaceId:null})).pendingRequests, [])
  const command = {sessionId: permission.item.sessionId, operationId: randomUUID(), permissionId: permission.item.id, optionId: "allow"}
  const winning = await machine.call<AgentPermission>("_deskfleet/permission/respond", command)
  assert.deepEqual(winning.actor, actor)
  const late = await machine.call<AgentPermission>("_deskfleet/permission/respond", {...command, operationId: randomUUID(), optionId: "deny"})
  assert.equal(late.decisionCommandId, winning.decisionCommandId)
  assert.equal(late.optionId, "allow")
  const done = await eventually(snap, value => value.messages.some(m => m.workerEvent === "result" && m.sourceMessageId === request.messageId) && value.tickets[0]?.status === undefined)
  const completion = done.messages.at(-1)!
  assert.deepEqual(done.pendingRequests, [])
  assert.match(done.messages.find(m => m.workerEvent === "permission")!.text, /^Allow ·/u)
  assert.match(completion.text, /Fixture Agent is waiting for approval for Read README/)
  assert.equal(completion.workerEvent, "result")
  assert.equal(completion.sourceMessageId, request.messageId)
  assert.ok(completion.inputId && completion.turnId)
  const follow = {workspaceId, messageId:randomUUID(), text:"Read the second file"}
  await machine.call("_deskfleet/super-agent/send", follow)
  const next = await eventually(snap, value => !!value.pendingRequests?.length)
  const secondPermission = next.pendingRequests![0]!.item
  assert.notEqual(secondPermission.id, permission.item.id)
  await machine.call("_deskfleet/permission/respond", {sessionId, operationId:randomUUID(), permissionId:secondPermission.id, optionId:"deny"})
  const second = await eventually(snap, value => value.messages.some(m => m.workerEvent === "result" && m.sourceMessageId === follow.messageId))
  const result = second.messages.find(m => m.workerEvent === "result" && m.sourceMessageId === follow.messageId)!
  assert.deepEqual(second.pendingRequests, [])
  assert.match(second.messages.find(m => m.workerEvent === "permission" && m.sourceMessageId === follow.messageId)!.text, /^Reject ·/u)
  assert.equal(result.sessionId, completion.sessionId)
  assert.notEqual(result.turnId, completion.turnId); assert.notEqual(result.inputId, completion.inputId)
  assert.match(result.text, /second file/)
  assert.equal(second.tickets.length,1); assert.equal(second.tickets[0]!.status, undefined)
  const focus = done.focusTicketId
  await machine.close()
  machine = await open(directory, backend)
  const restored = await machine.call<SuperSnapshot>("_deskfleet/super-agent/send", request)
  assert.equal(restored.focusTicketId, focus)
  assert.equal(restored.messages.filter(m => m.id === completion.id).length, 1)
  assert.equal((await machine.workers.journal.read(sessionId)).inputs.length, 2)
  assert.deepEqual(backend.prompts, ["Read README\n\nTicket scope:\nRead only", "Read the second file"])
})

test("project stop withdraws only the queued input, ignores a late click and cancels the next turn's outstanding permission", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-stop-"))
  const backend = new BackendAgent()
  const machine = await open(directory, backend)
  t.after(async () => { try { await machine.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const workspaceId = (await machine.catalog.native.createWorkspace("Project", [{ path: directory }])).id
  await machine.providers.create({ template: "codex", name: "Fixture", env: {}, inheritShellEnvironment: false })
  const snap = () => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId })
  const send = (messageId: string) => machine.call("_deskfleet/super-agent/send", { workspaceId, messageId, text: messageId })
  const stop = (messageId: string) => machine.call("_deskfleet/super-agent/stop", { workspaceId, messageId, revision: 0 })
  await send("A")
  const first = await eventually(snap, room => !!room.pendingRequests?.length)
  const permission = first.pendingRequests![0]!.item
  const sessionId = permission.sessionId
  const journal = () => machine.workers.journal.read(sessionId)
  await send("B")
  await eventually(journal, session => session.inputs.length === 2 && session.inputs[1]?.state === "pending")
  await Promise.all([stop("B"), stop("B")])
  const withdrawn = await eventually(snap, room => room.messages.some(m => m.kind === "dispatch" && m.sourceMessageId === "B" && m.stopState === "stopped"))
  assert.equal(withdrawn.pendingRequests?.[0]?.item.id, permission.id)
  assert.equal((await journal()).inputs[1]?.state, "withdrawn")
  await machine.restartFront()
  await machine.call("_deskfleet/permission/respond", { sessionId, permissionId: permission.id, optionId: "allow", operationId: randomUUID() })
  await eventually(snap, room => room.messages.some(m => m.workerEvent === "result" && m.sourceMessageId === "A"))
  await send("C")
  const third = await eventually(snap, room => !!room.pendingRequests?.length)
  await stop("A")
  await eventually(snap, room => room.messages.some(m => m.kind === "dispatch" && m.sourceMessageId === "A" && m.stopState === "finished"))
  assert.equal((await snap()).pendingRequests?.[0]?.item.id, third.pendingRequests![0]!.item.id)
  await stop("C")
  const stopped = await eventually(snap, room => !room.pendingRequests?.length && room.messages.some(m => m.workerEvent === "result" && m.sourceMessageId === "C" && m.stopState === "stopped"))
  assert.match(stopped.messages.find(m => m.sourceMessageId === "C" && m.workerEvent === "result")!.text, /waiting for approval/)
  const state = await journal()
  assert.deepEqual(state.turns.map(turn => turn.state), ["completed", "cancelled"])
  assert.deepEqual(state.permissions.map(p => p.state), ["resolved", "cancelled"])
  assert.deepEqual(state.inputs.map(i => i.state), ["delivered", "withdrawn", "delivered"])
  assert.equal(backend.prompts.length, 2)
})

test("stopping one branch and then its whole request leaves an independent Worker's approval intact", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-stop-split-"))
  const machine = await open(directory, new BackendAgent(), async ctx => ({
    reason: "independent tasks",
    actions: (ctx.text === "split" ? ["left", "right"] : [ctx.text]).map(title => ({ kind: "create", title, prompt: title, scope: title })),
  }))
  t.after(async () => { try { await machine.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const workspaceId = (await machine.catalog.native.createWorkspace("Project", [{ path: directory }])).id
  await machine.providers.create({ template: "codex", name: "Fixture", env: {}, inheritShellEnvironment: false })
  const snap = () => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId })
  for (const messageId of ["split", "independent"]) await machine.call("_deskfleet/super-agent/send", { workspaceId, messageId, text: messageId })
  const active = await eventually(snap, room => room.pendingRequests?.length === 3)
  const left = active.tickets.find(ticket => ticket.title === "left")!
  const independent = active.tickets.find(ticket => ticket.title === "independent")!
  const remainingApproval = active.pendingRequests!.find(request => request.ticketId === independent.id)!.item.id
  const stop = { workspaceId, messageId: "split", revision: 0 }
  await assert.rejects(machine.call("_deskfleet/super-agent/stop", { ...stop, ticketId: independent.id }), /does not belong/)
  await machine.call("_deskfleet/super-agent/stop", { ...stop, ticketId: left.id })
  const partial = await eventually(snap, room => room.pendingRequests?.length === 2)
  assert.ok(partial.pendingRequests!.every(request => request.ticketId !== left.id))
  await machine.call("_deskfleet/super-agent/stop", stop)
  const done = await eventually(snap, room => room.pendingRequests?.length === 1 && room.messages.filter(m =>
    m.sourceMessageId === "split" && m.workerEvent === "result" && m.stopState === "stopped").length === 2)
  assert.equal(done.pendingRequests![0]!.item.id, remainingApproval)
})

test("stopping after a Worker claims an input but before provider dispatch withdraws it without consuming a turn", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-stop-admission-"))
  const backend = new BackendAgent(), quotas = new TestAgentQuotas()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  quotas.turnLimit = async () => { await gate; return null }
  const machine = await open(directory, backend, undefined, quotas)
  t.after(async () => { release(); try { await machine.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const workspaceId = (await machine.catalog.native.createWorkspace("Project", [{ path: directory }])).id
  await machine.providers.create({ template: "codex", name: "Fixture", env: {}, inheritShellEnvironment: false })
  const snap = () => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId })
  await machine.call("_deskfleet/super-agent/send", { workspaceId, messageId: "claim", text: "claim" })
  const active = await eventually(snap, room => !!room.tickets[0]?.sessionId)
  const journal = () => machine.workers.journal.read(active.tickets[0]!.sessionId!)
  await eventually(journal, session => session.turns[0]?.state === "running" && session.turns[0]?.consumed === false)
  await machine.call("_deskfleet/super-agent/stop", { workspaceId, messageId: "claim", revision: 0 })
  await eventually(journal, session => session.turns[0]?.state === "cancelling" || session.turns[0]?.state === "cancelled")
  release()
  const done = await eventually(journal, session => !["running", "cancelling"].includes(session.turns[0]!.state))
  assert.equal(done.turns[0]?.state, "cancelled")
  assert.equal(done.turns[0]?.consumed, false)
  assert.equal(done.inputs[0]?.state, "withdrawn")
  assert.equal(backend.prompts.length, 0)
})

test("an outstanding default-workspace question survives a front desk restart and answers the original Worker", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-super-question-"))
  const backend = new BackendAgent()
  const connect = backend.connect.bind(backend)
  let providerAnswer: unknown
  backend.connect = async (config, client) => {
    const connection = await connect(config, client)
    connection.prompt = async params => {
      providerAnswer = await client.requestElicitation!({
        sessionId: params.sessionId, toolCallId: "question", mode: "form", message: "Supply a temporary test value",
        requestedSchema: { type: "object", required: ["value"], properties: { value: { type: "string", _meta: { codex: { isSecret: true } } } } },
      }, new AbortController().signal)
      return { stopReason: "end_turn" }
    }
    return connection
  }
  const machine = await open(directory, backend)
  t.after(async () => { try { await machine.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  await machine.providers.create({ template: "codex", name: "Fixture", env: {}, inheritShellEnvironment: false })
  const snap = () => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId: null })
  await machine.call("_deskfleet/super-agent/send", { workspaceId: null, messageId: "ask", text: "Ask me for a temporary test value" })
  const waiting = await eventually(snap, state => state.pendingRequests?.length === 1 && state.tickets[0]?.status === "attention")
  const question = waiting.pendingRequests![0]!
  assert.equal(question.kind, "elicitation")
  // The older release had recorded this event but had no request ID on its project message.
  await machine.store.update(actor.userId!, () => { throw new Error("Missing front desk") }, state => {
    const notice = state.rooms.find(room => room.workspaceId === null)!.messages.find(message => message.workerEvent === "question")!
    delete notice.workerRequestId
    notice.text += "\nOpen the worker session to respond."
  })
  await machine.restartFront()
  const recovered = await eventually(snap, state => state.pendingRequests?.length === 1)
  assert.deepEqual(recovered.pendingRequests, waiting.pendingRequests)
  assert.ok(!recovered.messages.some(message => message.text.includes("Open the worker session")))
  const { sessionId, id: elicitationId } = question.item
  const response = { action: "accept", content: { value: "synthetic-private-answer" } }
  await machine.call("_deskfleet/elicitation/respond", { sessionId, operationId: randomUUID(), elicitationId, response })
  const done = await eventually(snap, state => state.messages.some(message => message.workerEvent === "result"))
  assert.deepEqual(providerAnswer, response)
  assert.deepEqual(done.pendingRequests, [])
  assert.match(done.messages.find(message => message.workerEvent === "question")!.text, /^Answered ·/u)
  assert.ok(!JSON.stringify(done).includes(response.content.value))
  assert.ok(!JSON.stringify(machine.store.get(actor.userId!)).includes(response.content.value))
})

test("new Workers inherit this project's native mode and tool approval while existing Workers retain their settings", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-worker-defaults-"))
  const root = join(directory, "project"); await mkdir(root)
  const backend = new BackendAgent()
  const connect = backend.connect.bind(backend)
  const modesAtPrompt: string[] = []
  backend.connect = async (config, client) => {
    const connection = await connect(config, client)
    let mode = "read-only"
    const options = () => [{ id: "mode", name: "Mode", type: "select" as const, category: "mode", currentValue: mode,
      options: [{ value: "read-only", name: "Read only" }, { value: "test-workspace", name: "Workspace access" }] }]
    const create = connection.newSession.bind(connection)
    connection.newSession = async params => ({ ...await create(params), configOptions: options() })
    connection.resume = async () => ({ configOptions: options() })
    connection.setConfigOption = async params => { mode = String(params.value); return { configOptions: options() } }
    const prompt = connection.prompt.bind(connection)
    connection.prompt = params => { modesAtPrompt.push(mode); return prompt(params) }
    return connection
  }
  const machine = await open(directory, backend, async ctx => ({ reason: "separate task",
    actions: [{ kind: "create", title: ctx.text, scope: "Test only", prompt: ctx.text, context: "directory" }] }))
  t.after(async () => { try { await machine.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const workspaceId = (await machine.catalog.native.createWorkspace("Project", [{path:root}])).id
  const other = (await machine.catalog.native.createWorkspace("Project copy", [{path:root}])).id
  const { id: provider } = await machine.providers.create({ template: "codex", name: "Fixture", env: {}, inheritShellEnvironment: false })
  const snap = (id: string | null = workspaceId) => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId: id })
  const save = (settings: object) => machine.call<SuperSnapshot>("_deskfleet/super-agent/settings", { workspaceId, ...settings })
  const send = (text: string) => machine.call("_deskfleet/super-agent/send", { workspaceId, messageId: randomUUID(), text })
  assert.equal((await snap()).workerAutoApprove, false)
  await send("First")
  const waiting = await eventually(snap, state => !!state.pendingRequests?.length)
  const first = waiting.pendingRequests![0]!.item
  await assert.rejects(save({ workerAutoApprove: "true" }), /Invalid Worker/)
  await assert.rejects(save({ workerMode: { provider, mode: "not-advertised" } }), /does not offer/)
  await save({ workerMode: { provider, mode: "test-workspace" }, workerAutoApprove: true })
  await save({ workerSelection: { provider } }) // A model edit from an older client preserves the native mode.
  await machine.restartFront()
  assert.equal((await snap()).workerAutoApprove, true)
  assert.equal((await snap()).workerSelection?.mode, "test-workspace")
  for (const id of [null, other]) {
    assert.equal((await snap(id)).workerAutoApprove, false)
    assert.equal((await snap(id)).workerSelection?.mode, undefined)
  }
  await send("Second")
  const done = await eventually(snap, state => state.tickets.some(t => t.title === "Second" && t.sessionId && !t.status))
  const second = done.tickets.find(t => t.title === "Second")!.sessionId!
  const worker = await machine.workers.journal.read(second)
  assert.equal(worker.session.yolo, true)
  assert.deepEqual(worker.session.yoloActor, actor)
  assert.equal(worker.permissions[0]!.optionId, "allow")
  assert.deepEqual(done.pendingRequests?.map(r => r.item.id), [first.id])
  await save({ workerAutoApprove: false, workerMode: { provider, mode: null } })
  await send("Third")
  await eventually(snap, state => state.pendingRequests?.length === 2)
  assert.deepEqual(modesAtPrompt, ["read-only", "test-workspace", "read-only"])
  assert.equal((await machine.workers.journal.read(second)).session.yolo, true)
  assert.equal((await machine.workers.journal.read(first.sessionId)).permissions[0]!.state, "pending")
})

test("two projects bound to the same folder retain independent conversations, tickets and workers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-super-agent-projects-"))
  const project = join(directory, "team", "editor")
  await mkdir(project, { recursive: true })
  const machine = await open(directory, new BackendAgent(), async ctx => {
    assert.deepEqual(ctx.workspaces.map(item => item.folderHint), ["team/editor", "team/editor"])
    assert.equal(ctx.tickets.length, 0)
    assert.equal(ctx.history?.length, 0)
    return { reason: "User assigned work in this project", actions: [{ kind: "create", title: ctx.text, scope: "Read only", prompt: ctx.text }] }
  })
  t.after(async () => { try { await machine.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const create = () => machine.catalog.handle({ method: "workspaceCreate", params: { name: "editor", directories: [{ path: project }] } })
  await create()
  await create()
  const { workspaces } = await machine.catalog.native.snapshot()
  assert.equal(workspaces.length, 2)
  const [first, second] = workspaces
  assert.notEqual(first!.id, second!.id)
  await machine.providers.create({ template: "codex", name: "Fixture Codex", env: {}, inheritShellEnvironment: false })
  const snap = (workspaceId: string) => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId })
  async function assign(workspaceId: string, text: string) {
    await machine.call("_deskfleet/super-agent/send", { workspaceId, messageId: randomUUID(), text })
    const room = await eventually(() => snap(workspaceId), value => value.tickets[0]?.status === "attention")
    assert.deepEqual(room.messages.filter(message => message.role === "user").map(message => message.text), [text])
    assert.equal(room.tickets.length, 1)
    const ticket = room.tickets[0]!
    assert.equal(room.focusTicketId, ticket.id)
    assert.equal((await machine.workers.journal.read(ticket.sessionId!)).session.workspaceId, workspaceId)
    return ticket
  }
  const firstTicket = await assign(first!.id, "Inspect the project notes")
  assert.deepEqual((await snap(second!.id)).messages, [])
  const secondTicket = await assign(second!.id, "Review the settings")
  assert.notEqual(secondTicket.id, firstTicket.id)
  assert.notEqual(secondTicket.sessionId, firstTicket.sessionId)
  assert.deepEqual((await snap(first!.id)).tickets.map(ticket => ticket.id), [firstTicket.id])
  for (const [id,ticket] of [[first!.id,firstTicket],[second!.id,secondTicket]] as const) {
    assert.deepEqual((await snap(id)).pendingRequests?.map(({ticketId,item}) => [ticketId,item.sessionId]), [[ticket.id,ticket.sessionId]])
  }
})

test("historical lookup records exact journal ranges; a dirty or archived old checkout stays intact", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-super-agent-history-"))
  const project = join(directory, "project")
  await mkdir(project)
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", project, ...args])
  await git("init")
  await writeFile(join(project, "README.md"), "initial\n")
  await git("add", "README.md"); await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial")
  const backend = new BackendAgent()
  let legacyId = ""
  const machine = await open(directory, backend, async (ctx, options) => {
    const result = await options?.evidence?.({kind:"history", sessionId:legacyId, afterSeq:"0"})
    assert.match(result || "", /Review original work/)
    return ctx.text === "Look up prior work" ? {reason:"cited history", actions:[{kind:"answer", text:"Read the original review."}]} :
      { reason:"resume historical checkout", actions:[{kind:"create", title:"Review", scope:"Review only", sessionId:legacyId, prompt:ctx.text}] }
  })
  t.after(async () => { try { await machine.close() } finally { await rm(directory, {recursive:true, force:true}) } })
  const workspaceId = (await machine.catalog.native.createWorkspace("History", [{path:project}])).id
  const provider = (await machine.providers.create({template: "codex", name: "Fixture", env: {}, inheritShellEnvironment:false})).id
  const prior = await machine.call<AgentSnapshot>("_deskfleet/session/create", {workspaceId, operationId:randomUUID(), provider, context:"directory"})
  legacyId = prior.session.id
  await machine.call("_deskfleet/input/submit", {sessionId:legacyId, operationId:randomUUID(), delivery:"backlog", content:[{type:"text", text:"Review original work"}]})
  const original = await eventually(() => machine.workers.journal.read(legacyId), value => value.permissions.some(p => p.state === "pending"))
  await machine.call("_deskfleet/permission/respond", {sessionId:legacyId, operationId:randomUUID(), permissionId:original.permissions[0]!.id, optionId:"allow"})
  await eventually(() => machine.workers.journal.read(legacyId), value => value.turns[0]?.state === "completed")
  const snap = () => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", {workspaceId})
  async function send(messageId: string, text: string) {
    await machine.call("_deskfleet/super-agent/send", {workspaceId,messageId,text})
    return eventually(snap, value => value.messages.some(m => m.id === messageId && m.state !== "routing"))
  }
  const looked = await send("lookup","Look up prior work")
  const answer = looked.messages.find(m => m.role === "assistant")!
  assert.equal(answer.historySources?.[0]?.sessionId, legacyId)
  assert.equal(answer.historySources?.[0]?.afterSeq, "0")
  assert.ok(BigInt(answer.historySources![0]!.throughSeq) > 0n)
  assert.equal(looked.tickets.length, 0)
  await writeFile(join(project, "README.md"), "local change\n")
  const blocked = (await send("dirty","Continue this review")).messages.find(m => m.id === "dirty")!
  assert.equal(blocked.state,"failed"); assert.equal(blocked.sessionId,legacyId)
  assert.match(blocked.reason!, /checkout has changes/)
  assert.equal((await machine.workers.journal.read(legacyId)).inputs.length,1)
  await machine.call("_deskfleet/session/archive", {sessionId:legacyId, operationId:randomUUID()})
  const archived = (await send("archived","Continue once more")).messages.find(m => m.id === "archived")!
  assert.equal(archived.sessionId,legacyId); assert.match(archived.reason!, /archived/)
  assert.equal((await machine.workers.journal.read(legacyId)).inputs.length,1)
  await machine.call("_deskfleet/session/restore", {sessionId:legacyId, operationId:randomUUID()})
  await writeFile(join(project, "README.md"), "initial\n")
  const reused = await send("restore","Continue the review")
  assert.equal(reused.tickets[0]?.sessionId, legacyId)
  await eventually(() => machine.workers.journal.read(legacyId), value => value.inputs.length === 2)
  assert.equal((await machine.workers.journal.list()).length,1)
})

test("a confirmed Team capacity refusal preserves the ticket and a later explicit retry can start it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-super-agent-capacity-"))
  const project = join(directory, "project"); await mkdir(project)
  const quotas = new TestAgentQuotas(); quotas.capacity = 0
  const backend = new BackendAgent()
  const machine = await open(directory, backend, async ctx => ({
    reason: "fixture", actions: ctx.tickets.length ? [{ kind:"continue", ticketId:ctx.tickets[0]!.id, prompt:ctx.text }]
      : [{kind:"create", title:"Review ticket", scope:"Read only", prompt:ctx.text}],
  }), quotas)
  t.after(async () => { try { await machine.close() } finally { await rm(directory, {recursive:true, force:true}) } })
  const workspaceId = (await machine.catalog.native.createWorkspace("Quota", [{path:project}])).id
  await machine.providers.create({template:"codex", name:"Fixture", env:{}})
  const snap = () => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", {workspaceId})
  await machine.call("_deskfleet/super-agent/send", {workspaceId, messageId:"initial", text:"Review the file"})
  const blocked = await eventually(snap, v => v.tickets[0]?.status === "blocked")
  assert.equal(blocked.messages[0]!.state, "failed"); assert.match(blocked.messages[0]!.reason!, /allowance/)
  assert.deepEqual(await machine.workers.journal.list(), [])
  quotas.capacity = 3
  await machine.call("_deskfleet/super-agent/send", {workspaceId, messageId:"later", text:"Please retry the review"})
  const delivered = await eventually(snap, v => v.tickets[0]?.status === "attention")
  assert.equal(delivered.tickets.length, 1)
  assert.equal(delivered.tickets[0]!.id, blocked.tickets[0]!.id)
  assert.equal((await machine.workers.journal.list()).length, 1)
})

test("an explicit request for uncommitted local work uses its current directory; other work gets an isolated Git checkout", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-super-agent-directory-"))
  const project = join(directory, "project"); await mkdir(project)
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", project, ...args])
  await git("init"); await writeFile(join(project, "README.md"), "committed\n")
  await git("add","README.md"); await git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","initial")
  await writeFile(join(project, "README.md"), "uncommitted\n")
  const machine = await open(directory, new BackendAgent(), async ctx => ({ reason:"fixture", actions:[{
    kind:"create", title:ctx.text, scope:"Review only", prompt:ctx.text,
    ...(ctx.text === "Read my working copy" ? {context:"directory" as const} : {}),
  }] }))
  t.after(async () => { try { await machine.close() } finally { await rm(directory, {recursive:true, force:true}) } })
  const workspaceId = (await machine.catalog.native.createWorkspace("Git", [{path:project}])).id
  await machine.providers.create({template:"codex",name:"Fixture",env:{}})
  async function run(text: string) {
    const messageId = randomUUID()
    await machine.call("_deskfleet/super-agent/send", {workspaceId,messageId,text})
    const snap = await eventually(() => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", {workspaceId}), value =>
      value.messages.some(m => m.id === messageId && m.sessionId))
    const id = snap.messages.find(m => m.id === messageId)!.sessionId!
    return (await machine.workers.journal.read(id)).session
  }
  const local = await run("Read my working copy")
  const isolated = await run("Review the committed project independently")
  assert.equal(local.context,"directory")
  assert.equal(isolated.context,"worktree")
  const root = async (id: string) => (await machine.catalog.sessionWorktree(id))!.directories[0]!.path
  const {readFile} = await import("node:fs/promises")
  assert.equal(await readFile(join(await root(local.id),"README.md"),"utf8"),"uncommitted\n")
  assert.equal(await readFile(join(await root(isolated.id),"README.md"),"utf8"),"committed\n")
})


test("a copied historical Worker ID adopts the correct real session among two projects with the same root", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-super-target-"))
  const project = join(directory, "project"); await mkdir(project)
  const backend = new BackendAgent()
  let routes = 0
  const machine = await open(directory, backend, async () => { routes++; throw new Error("Unexpected coordinator call") })
  t.after(async () => { try { await machine.close() } finally { await rm(directory, { recursive:true, force:true }) } })
  const original = (await machine.catalog.native.createWorkspace("First", [{ path: project }])).id
  const duplicate = (await machine.catalog.native.createWorkspace("Second", [{ path: project }])).id
  const provider = (await machine.providers.create({template:"codex", name:"Fixture", env:{}, inheritShellEnvironment:false})).id
  const { session } = await machine.call<AgentSnapshot>("_deskfleet/session/create", {
    workspaceId: original, operationId: randomUUID(), provider, context:"directory",
  })
  const text = `@worker[team/machine/${session.id}] Check the README`
  const wrong = { messageId: randomUUID(), text, workspaceId: duplicate }
  await machine.call("_deskfleet/super-agent/send", wrong)
  const denied = await eventually(() => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", {workspaceId: duplicate}),
    result => result.messages.some(m => m.id === wrong.messageId && m.state === "failed"))
  assert.equal(denied.tickets.length, 0)
  assert.equal((await machine.workers.journal.read(session.id)).inputs.length, 0)
  const right = { messageId: randomUUID(), text, workspaceId: original }
  await machine.call("_deskfleet/super-agent/send", right)
  await machine.call("_deskfleet/super-agent/send", right)
  const target = await eventually(() => machine.workers.journal.read(session.id), result => result.inputs.length === 1)
  assert.deepEqual(target.inputs[0]!.content, [{type:"text", text:"Check the README"}])
  const adopted = await machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", {workspaceId: original})
  assert.deepEqual(adopted.tickets.map(ticket => ticket.sessionId), [session.id])
  assert.equal(routes, 0)
  assert.equal((await machine.workers.journal.list()).length, 1)
})

test("organizing directory history links only the chosen sessions and reuses the original Worker across restarts", async t => {
  const root = await mkdtemp(join(tmpdir(), "deskfleet-old-history-"))
  const cwd = join(root, "legacy")
  await mkdir(cwd)
  let workerId: string
  const machine = await open(root, new BackendAgent(), async ctx => {
    assert.ok(ctx.history?.some(worker => worker.id === workerId))
    return { reason: "reuse the organized history", actions: [{ kind: "create", title: "Continue", scope: "Read", sessionId: workerId, prompt: ctx.text }] }
  })
  t.after(async () => { try { await machine.close() } finally { await rm(root, { recursive: true, force: true }) } })
  const provider = (await machine.providers.create({ template: "codex", name: "Fixture", env: {}, inheritShellEnvironment: false })).id
  const create = () => machine.call<AgentSnapshot>("_deskfleet/session/create", { cwd, context: "directory", provider, operationId: randomUUID() })
  workerId = (await create()).session.id
  const archived = (await create()).session.id
  await machine.call("_deskfleet/session/archive", { sessionId: archived, operationId: randomUUID() })
  const makeProject = (name: string, path: string) => machine.catalog.handle({ method: "workspaceCreate", params: { name, directories: [{ path }] } })
  await makeProject("One", cwd)
  await makeProject("Two", cwd)
  await makeProject("Other directory", root)
  const history = (assign?: { workspaceId: string; sessionIds: string[] }) => machine.call<SuperHistory>("_deskfleet/super-agent/history", { view: "groups", assign })
  const first = await history()
  assert.deepEqual(first.links, {})
  assert.equal(first.groups?.length, 1)
  const group = first.groups![0]!
  assert.deepEqual(group.paths, [cwd])
  assert.deepEqual(group.sessionIds, [workerId])
  assert.deepEqual(group.projects.map(p => p.name).sort(), ["One", "Two"])
  assert.equal(machine.store.get(actor.userId!), undefined)
  const workspaceId = group.projects.find(p => p.name === "Two")!.id
  const other = (await machine.catalog.native.snapshot()).workspaces.find(p => p.name === "Other directory")!.id
  await assert.rejects(history({ workspaceId: other, sessionIds: [workerId] }), /group has changed/)
  await assert.rejects(history({ workspaceId, sessionIds: [workerId, archived] }), /group has changed/)
  assert.deepEqual((await history()).links, {})
  const assign = { workspaceId, sessionIds: [workerId] }
  const saved = await history(assign)
  assert.deepEqual(saved, { links: { [workerId]: workspaceId }, groups: [] })
  assert.deepEqual(await history(assign), saved)
  const otherUser = { ...actor, userId: "another-member" }
  const source = { agents: machine.workers, store: machine.store, ...superWorkspaces(machine.catalog, root) }
  assert.deepEqual(await organizeHistory(source, otherUser, { view: "groups" }), { groups: [], links: {} })
  await assert.rejects(organizeHistory(source, otherUser, { view: "groups", assign }), /group has changed/)
  await assert.rejects(history({ workspaceId: group.projects.find(p => p.name === "One")!.id, sessionIds: [workerId] }), /group has changed/)
  await machine.restartFront()
  assert.deepEqual(await history(), saved)
  const original = (await machine.workers.journal.read(workerId)).session
  assert.equal(original.workspaceId, undefined)
  assert.equal((await machine.workers.journal.read(archived)).session.archiveState, "archived")
  await machine.call("_deskfleet/super-agent/send", { workspaceId, messageId: "resume-history", text: "Continue this review" })
  const snapshot = await eventually(() => machine.call<SuperSnapshot>("_deskfleet/super-agent/snapshot", { workspaceId }),
    value => value.tickets.some(ticket => ticket.sessionId === workerId))
  assert.equal(snapshot.tickets.length, 1)
  await eventually(() => machine.workers.journal.read(workerId), state => state.inputs.length > 0)
  assert.equal((await machine.workers.journal.read(workerId)).session.workspaceId, undefined)
  assert.equal((await machine.workers.journal.list()).length, 2)
})
