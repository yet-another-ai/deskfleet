import { expect, test, vi } from "vitest"
import type { AgentEvent, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"
import { agentElicitation, agentEvent, agentInput, agentPermission, agentSnapshot } from "../test/agent.ts"
import { groupTranscript, projectConversation } from "./agent-conversation.ts"
import { createConversationProjector } from "./conversation-projector.ts"

const update = (seq: number, value: Record<string, unknown>) => agentEvent(seq, "acp", { sessionId: "provider", update: value } as AgentEvent["payload"])
const text = (seq: number, value: string, extra: Record<string, unknown> = {}) => update(seq, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value }, ...extra })

test("incremental messages, plans and provider terminals match a fresh reconstruction after every append", () => {
  const snapshot = agentSnapshot()
  const input = agentInput({ state: "delivered" })
  snapshot.inputs = [input]
  const source = [
    agentEvent(1, "input", input),
    text(2, "Before ", { messageId: "m" }),
    update(3, { sessionUpdate: "tool_call", toolCallId: "tool", content: [{ type: "terminal", terminalId: "terminal" }], _meta: { terminal_info: { terminal_id: "terminal", cwd: "/workspace" } } }),
    update(4, { sessionUpdate: "tool_call_update", toolCallId: "tool", _meta: { terminal_output_delta: { terminal_id: "terminal", data: "first\n" } } }),
    text(5, "after", { messageId: "m" }),
    update(6, { sessionUpdate: "plan", entries: [{ content: "Check", status: "pending" }] }),
    update(7, { sessionUpdate: "plan", entries: [{ content: "Check", status: "completed" }] }),
    update(8, { sessionUpdate: "tool_call_update", toolCallId: "tool", content: null, status: "completed", _meta: { terminal_output: { terminal_id: "terminal", data: "last\n" }, terminal_exit: { terminal_id: "terminal", exit_code: 0 } } }),
    { ...text(9, "New run", { messageId: "m" }), runGeneration: 2 },
    { ...update(10, { sessionUpdate: "tool_call", toolCallId: "tool", title: "New tool" }), runGeneration: 2 },
  ]
  const before = structuredClone(source)
  const events: AgentEvent[] = []
  const project = createConversationProjector()
  for (const event of source) {
    const previous = project(events, snapshot)
    const saved = structuredClone(previous)
    events.push(event)
    expect(project(events, snapshot)).toEqual(projectConversation(events, snapshot))
    expect(previous).toEqual(saved)
  }
  expect(source).toEqual(before)
})

test("appending tokens reads only new journal payloads and retains completed entry identities", () => {
  const snapshot = agentSnapshot()
  const first = text(1, "Completed answer")
  const payload = first.payload
  Object.defineProperty(first, "payload", { configurable: true, get: () => payload })
  const read = vi.spyOn(first, "payload", "get")
  const events = [first]
  const project = createConversationProjector()
  const initial = project(events, snapshot)
  read.mockImplementation(() => { throw new Error("Historical payload was replayed") })
  events.push(update(2, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } }))
  const second = project(events, snapshot)
  expect(second[0]).toBe(initial[0])
  events.push(update(3, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " more" } }))
  const third = project(events, snapshot)
  expect(third[0]).toBe(initial[0])
  expect(third[1]).toMatchObject({ content: [{ text: "Thinking more" }] })
  expect(second[1]).toMatchObject({ content: [{ text: "Thinking" }] })
  expect(project(events, snapshot)).toBe(third)
})

test("replacing, inserting late history, clearing and switching Sessions rebuild the committed order", () => {
  const snapshot = agentSnapshot()
  const project = createConversationProjector()
  const events = [text(2, "B")]
  expect(project(events, snapshot)[0]).toMatchObject({ content: [{ text: "B" }] })
  events.unshift(text(1, "A"))
  expect(project(events, snapshot)).toEqual(projectConversation(events, snapshot))
  expect(project([text(1, "Replacement")], snapshot)[0]).toMatchObject({ content: [{ text: "Replacement" }] })
  expect(project([], snapshot)).toEqual([])
  const other = { ...snapshot, session: { ...snapshot.session, id: "other" } }
  expect(project(events, other)).toEqual(projectConversation(events, other))
})

test("snapshot decisions and restored questions reconcile even without another journal event", () => {
  const input = agentInput({ state: "delivered" })
  const permission = agentPermission()
  const question = agentElicitation()
  const snapshot = { ...agentSnapshot(), inputs: [input], permissions: [permission], elicitations: [question] }
  const events = [agentEvent(1, "input", input), agentEvent(2, "permission", permission)]
  const project = createConversationProjector()
  expect(project(events, snapshot)).toEqual(projectConversation(events, snapshot))
  snapshot.inputs[0] = { ...input, state: "failed" }
  snapshot.permissions[0] = { ...permission, state: "resolved", optionId: "allow" }
  snapshot.elicitations[0] = { ...question, state: "resolved", response: { action: "accept", content: { target: "staging" } } }
  const updated = project(events, snapshot)
  expect(updated).toEqual(projectConversation(events, snapshot))
  expect(updated.map(entry => entry.kind)).toEqual(["tool", "elicitation"])
  expect(updated[0]).toMatchObject({ permission: { state: "resolved", optionId: "allow" } })
  snapshot.inputs[0]!.state = "delivered"
  expect(project(events, snapshot)[0]).toMatchObject({ kind: "input" })
  // When its journal arrives, the restored question moves to its original place.
  const restored = [events[0]!, agentEvent(2, "elicitation", question), { ...events[1]!, seq: "3" }]
  expect(project(restored, snapshot)).toEqual(projectConversation(restored, snapshot))
  expect(project(restored, snapshot).map(entry => entry.kind)).toEqual(["input", "elicitation", "tool"])
})

test("unchanged transcript responses retain identity while steering and turn completion update bounds", () => {
  const input = agentInput({ state: "delivered", turnId: "70", deliveredAt: "start" })
  const steer = agentInput({ id: "41", state: "delivered", turnId: "70", actualDelivery: "steer", deliveredAt: "steer" })
  const turn: AgentTurn = { id: "70", sessionId: "30", initialInputId: input.id, dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: "start" }
  const snapshot = { ...agentSnapshot(), inputs: [input, steer], turns: [turn] }
  const events = [agentEvent(1, "input", input), text(2, "First"), agentEvent(3, "input", steer), text(4, "Second")]
  const project = createConversationProjector()
  const initial = groupTranscript(project(events, snapshot), snapshot)
  events.push(text(5, " tail"))
  const next = groupTranscript(project(events, snapshot), snapshot, initial)
  expect(next[0]).toBe(initial[0])
  expect(next[1]).toBe(initial[1])
  expect(next[3]).not.toBe(initial[3])
  expect(next[1]).toMatchObject({ live: false, last: false, endedAt: "steer" })
  snapshot.turns[0] = { ...turn, state: "completed", endedAt: "end" }
  const completed = groupTranscript(project(events, snapshot), snapshot, next)
  expect(completed).toEqual(groupTranscript(projectConversation(events, snapshot), snapshot))
  expect(completed[3]).toMatchObject({ live: false, last: true, startedAt: "steer", endedAt: "end" })
})
