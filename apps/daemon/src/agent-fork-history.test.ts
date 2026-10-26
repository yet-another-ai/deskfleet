import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test, { type TestContext } from "node:test"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { SessionNotification } from "@agentclientprotocol/sdk/unstable"
import { groupTranscript, projectConversation } from "../../../packages/components/src/services/agent-conversation.ts"
import { copyForkHistory } from "./agent-fork-history.ts"
import type { AgentCommand, AgentElicitation, AgentEvent, AgentInput, AgentPermission, AgentRun, AgentSnapshot, AgentTurn } from "./agent-protocol.ts"
import { AgentJournal, timestamp } from "./agent-store.ts"

async function fixture(context: TestContext) {
  const native = await openInMemoryCatalog("fork-history")
  context.after(() => native.close())
  const workspace = await native.createWorkspace("History", [{ path: process.cwd() }])
  const journal = new AgentJournal(native)
  await journal.init()
  async function command(method: string, sessionId?: string): Promise<AgentCommand> {
    return {
      id: await journal.id(), operationId: randomUUID(), actor: journal.actor(),
      sessionId, workspaceId: workspace.id, method, params: {}, isCanonical: true,
      status: "completed", receivedAt: timestamp(), completedAt: timestamp(),
    }
  }
  async function create(title: string): Promise<AgentSnapshot> {
    const creation = await command("_deskfleet/session/create")
    creation.status = "accepted"
    const session = await journal.create(creation, workspace.id, title, "directory", "codex")
    return journal.read(session.id)
  }
  const source = await create("Source")
  const child = await create("Fork")
  const sourceId = source.session.id
  const childId = child.session.id
  async function history(id: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    let cursor = "0"
    while (true) {
      const page = await journal.history(id, cursor, 200)
      if (!page.length) return events
      events.push(...page)
      cursor = page.at(-1)!.seq
    }
  }
  const acp = (update: SessionNotification["update"], generation = 1, turnId?: string) =>
    journal.event(sourceId, "acp", { sessionId: "provider-source", update }, { runGeneration: generation, turnId })
  return { journal, command, create, sourceId, childId, history, acp }
}

test("fork history preserves resolved conversation without copying live domain records or source references", async context => {
  const f = await fixture(context)
  const submission = await f.command("_deskfleet/input/submit", f.sourceId)
  const inputId = await f.journal.id()
  const turnId = await f.journal.id()
  const now = timestamp()
  const run: AgentRun = { sessionId: f.sourceId, generation: 1, state: "running", startedAt: now }
  const input: AgentInput = {
    id: inputId, sessionId: f.sourceId, submissionCommandId: submission.id, author: submission.actor,
    content: [{ type: "text", text: "Explain the code" }], acceptedSeq: "1", state: "delivered",
    requestedDelivery: "backlog", actualDelivery: "turn_start", dispatchCommandId: submission.id,
    turnId, createdAt: now, deliveredAt: now,
  }
  const turn: AgentTurn = {
    id: turnId, sessionId: f.sourceId, initialInputId: inputId, dispatchCommandId: submission.id,
    runGeneration: 1, state: "completed", startedAt: now, endedAt: now,
  }
  const permission: AgentPermission = {
    id: await f.journal.id(), sessionId: f.sourceId, runGeneration: 1, turnId,
    request: { sessionId: "provider-source", toolCall: { toolCallId: "tool", title: "Read source" }, options: [] },
    state: "resolved", optionId: "allow", decisionCommandId: submission.id, createdAt: now, resolvedAt: now,
  }
  const elicitation: AgentElicitation = {
    id: await f.journal.id(), sessionId: f.sourceId, runGeneration: 1, turnId,
    request: { sessionId: "provider-source", toolCallId: "question", mode: "form", message: "Scope?", requestedSchema: { type: "object", properties: {} } },
    state: "resolved", response: { action: "decline" }, decisionCommandId: submission.id, createdAt: now, resolvedAt: now,
  }
  await f.journal.commit(await f.journal.read(f.sourceId), {
    runs: [run], command: submission, inputs: [input], turns: [turn], permissions: [permission], elicitations: [elicitation], events: [
      f.journal.event(f.sourceId, "input", { ...input, state: "dispatching" }, { inputId, turnId, commandId: submission.id }),
      f.acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading" } }, 1, turnId),
      f.journal.event(f.sourceId, "permission", { ...permission, state: "pending" }, { runGeneration: 1, turnId }),
      f.acp({ sessionUpdate: "tool_call", toolCallId: "tool", title: "Read source", status: "completed" }, 1, turnId),
      f.journal.event(f.sourceId, "elicitation", { ...elicitation, state: "pending" }, { runGeneration: 1, turnId }),
      f.journal.event(f.sourceId, "input", input, { inputId, turnId, commandId: submission.id }),
      f.journal.event(f.sourceId, "permission", permission, { runGeneration: 1, turnId }),
      f.journal.event(f.sourceId, "elicitation", elicitation, { runGeneration: 1, turnId }),
      f.acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Explanation" } }, 1, turnId),
      f.acp({ sessionUpdate: "config_option_update", configOptions: [] }, 1, turnId),
      f.acp({ sessionUpdate: "session_info_update", title: "Source title" }, 1, turnId),
      f.journal.event(f.sourceId, "run", run), f.journal.event(f.sourceId, "turn", turn),
      f.journal.event(f.sourceId, "command", submission),
    ],
  })
  const source = await f.journal.read(f.sourceId)
  const before = structuredClone(source)
  const sourceEvents = await f.history(f.sourceId)
  await copyForkHistory(f.journal, source, f.childId)
  const child = await f.journal.read(f.childId)
  assert.deepEqual(await f.journal.read(f.sourceId), before)
  assert.deepEqual(source, before)
  assert.deepEqual(await f.history(f.sourceId), sourceEvents)
  assert.deepEqual([child.inputs, child.turns, child.permissions, child.elicitations], [[], [], [], []])
  assert.deepEqual((await f.journal.commands(f.childId)).map(command => command.method), ["_deskfleet/session/create"])
  assert.equal(child.runs[0]?.generation, 1)
  assert.equal(child.runs[0]?.state, "stopped")
  assert.equal(child.runs[0]?.sessionId, f.childId)
  const events = await f.history(f.childId)
  assert.deepEqual(events.map(event => event.kind), ["input", "acp", "permission", "acp", "elicitation", "acp"])
  assert.ok(events.every(event => event.sessionId === f.childId && !event.commandId && !event.inputId && !event.turnId))
  assert.ok(events.every(event => "sessionId" in event.payload && event.payload.sessionId === f.childId))
  const entries = projectConversation(events, child)
  assert.deepEqual(entries.map(entry => entry.kind), ["input", "message", "tool", "elicitation", "message"])
  assert.equal(entries[2]?.kind === "tool" ? entries[2].permission?.state : undefined, "resolved")
  assert.equal(entries[3]?.kind === "elicitation" ? entries[3].elicitation.state : undefined, "resolved")
  assert.ok(groupTranscript(entries, child).every(entry => entry.kind !== "response" || !entry.live && !entry.turn))
})

test("fork history pages through the captured watermark and keeps reused tool IDs separate from the child's next run", async context => {
  const f = await fixture(context)
  const now = timestamp()
  const run: AgentRun = { sessionId: f.sourceId, generation: 3, state: "stopped", startedAt: now, endedAt: now }
  await f.journal.commit(await f.journal.read(f.sourceId), {
    runs: [run], events: [
      ...Array.from({ length: 205 }, (_, index) => f.acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${index},` } }, 3)),
      f.acp({ sessionUpdate: "tool_call", toolCallId: "reused", title: "Source tool", status: "completed" }, 3),
    ],
  })
  const source = await f.journal.read(f.sourceId)
  await f.journal.commit(source, { events: [f.acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after watermark" } }, 3)] })
  const calls: string[] = []
  const originalHistory = f.journal.history.bind(f.journal)
  f.journal.history = async (id, cursor, limit) => {
    if (id === f.sourceId) calls.push(cursor)
    return originalHistory(id, cursor, limit)
  }
  await copyForkHistory(f.journal, source, f.childId)
  assert.deepEqual(calls, ["0", "200"])
  const inherited = await f.history(f.childId)
  assert.equal(inherited.length, 206)
  assert.ok(!JSON.stringify(inherited).includes("after watermark"))
  const child = await f.journal.read(f.childId)
  const generation = Math.max(0, ...child.runs.map(run => run.generation)) + 1
  assert.equal(generation, 4)
  await f.journal.commit(child, {
    runs: [{ sessionId: f.childId, generation, state: "running", startedAt: now }],
    events: [f.journal.event(f.childId, "acp", { sessionId: "child-provider", update: { sessionUpdate: "tool_call", toolCallId: "reused", title: "New tool" } }, { runGeneration: generation })],
  })
  const tools = projectConversation(await f.history(f.childId), await f.journal.read(f.childId)).filter(entry => entry.kind === "tool")
  assert.deepEqual(tools.map(entry => entry.tool.title), ["Source tool", "New tool"])
  assert.notEqual(tools[0]?.id, tools[1]?.id)
})

test("fork-of-fork history retains inherited delivered messages while omitting undelivered inputs and pending requests", async context => {
  const f = await fixture(context)
  const now = timestamp()
  const run: AgentRun = { sessionId: f.sourceId, generation: 1, state: "stopped", startedAt: now, endedAt: now }
  const input: AgentInput = {
    id: "old-input", sessionId: f.sourceId, submissionCommandId: "old-command", author: f.journal.actor(),
    content: [{ type: "text", text: "Inherited message" }], acceptedSeq: "1", state: "delivered", requestedDelivery: "backlog", createdAt: now,
  }
  const pending: AgentPermission = {
    id: "old-permission", sessionId: f.sourceId, runGeneration: 1, request: { sessionId: "source", toolCall: { toolCallId: "pending-tool" }, options: [] },
    state: "pending", createdAt: now,
  }
  await f.journal.commit(await f.journal.read(f.sourceId), { runs: [run], events: [
    f.journal.event(f.sourceId, "input", input),
    f.journal.event(f.sourceId, "input", { ...input, id: "pending", state: "pending" }),
    f.journal.event(f.sourceId, "input", { ...input, id: "uncertain", state: "dispatching" }),
    f.journal.event(f.sourceId, "permission", pending, { runGeneration: 1 }),
    f.acp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Inherited answer" } }),
  ] })
  const source = await f.journal.read(f.sourceId)
  source.inputs = [{ ...input, id: "uncertain", state: "uncertain" }]
  await copyForkHistory(f.journal, source, f.childId)
  const child = await f.journal.read(f.childId)
  const grandchild = await f.create("Second fork")
  await copyForkHistory(f.journal, child, grandchild.session.id)
  for (const id of [f.childId, grandchild.session.id]) {
    const snapshot = await f.journal.read(id)
    const entries = projectConversation(await f.history(id), snapshot)
    assert.deepEqual(entries.map(entry => entry.kind), ["input", "message"])
    assert.equal(entries[0]?.kind === "input" ? entries[0].input.content[0]?.type : undefined, "text")
    assert.deepEqual([snapshot.inputs, snapshot.permissions, snapshot.elicitations], [[], [], []])
  }
})

test("fork history excludes accepted URLs still awaiting completion and keeps finished questions", async context => {
  const f = await fixture(context)
  const now = timestamp()
  const run: AgentRun = { sessionId: f.sourceId, generation: 1, state: "stopped", startedAt: now, endedAt: now }
  const accepted: AgentElicitation = {
    id: "awaiting", sessionId: f.sourceId, runGeneration: 1, state: "resolved", response: { action: "accept" },
    request: { mode: "url", sessionId: "provider-source", elicitationId: "external", message: "Connect service", url: "https://example.com/connect" },
    createdAt: now, resolvedAt: now,
  }
  const questions: AgentElicitation[] = [
    accepted,
    { ...accepted, id: "completed" },
    { ...accepted, id: "declined", response: { action: "decline" } },
    { ...accepted, id: "cancelled", state: "cancelled", response: { action: "cancel" } },
    { ...accepted, id: "answered-form", request: {
      mode: "form", sessionId: "provider-source", toolCallId: "form", message: "Confirm", requestedSchema: { type: "object", properties: {} },
    } },
  ]
  await f.journal.commit(await f.journal.read(f.sourceId), {
    runs: [run], events: questions.map(question => f.journal.event(f.sourceId, "elicitation", question, { runGeneration: 1 })),
  })
  const source = await f.journal.read(f.sourceId)
  source.elicitations = questions.map(question => question.id === "completed" ? { ...question, completedAt: now } : question)
  await copyForkHistory(f.journal, source, f.childId)
  const child = await f.journal.read(f.childId)
  const entries = projectConversation(await f.history(f.childId), child).filter(entry => entry.kind === "elicitation")
  assert.deepEqual(entries.map(entry => entry.elicitation.id), ["completed", "declined", "cancelled", "answered-form"])
  assert.equal(entries[0]?.elicitation.completedAt, now)
  assert.deepEqual(child.elicitations, [])
})
