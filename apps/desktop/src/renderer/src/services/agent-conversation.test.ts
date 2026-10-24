import { expect, test } from "vitest"
import type { AgentEvent } from "../../../../../daemon/src/agent-protocol.ts"
import { agentElicitation, agentEvent, agentInput, agentPermission, agentSnapshot } from "../test/agent.ts"
import { groupTranscript, projectConversation, summarizeTools } from "./agent-conversation.ts"
const update = (seq: number, update: Record<string, unknown>) => agentEvent(seq, "acp", { sessionId: "provider-session", update } as AgentEvent["payload"])
test("reconstructs text around tools without user echoes or mutating the durable journal", () => {
  const input = agentInput({ state: "delivered" })
  const events = [agentEvent(1, "input", input), agentEvent(2, "input", input), update(3, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } }), update(4, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } }), update(5, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } }), update(6, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending", rawInput: { path: "a.ts" } }), update(7, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "contents" }), update(8, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } })]
  const before = structuredClone(events)
  const snapshot = agentSnapshot(); snapshot.inputs = [input]
  const result = projectConversation(events, snapshot)
  expect(result.map(entry => entry.kind)).toEqual(["input", "message", "tool", "message"])
  expect(result[1]).toMatchObject({ content: [{ type: "text", text: "Hello world" }] })
  expect(result[2]).toMatchObject({ tool: { title: "Read", status: "completed", rawInput: { path: "a.ts" }, rawOutput: "contents" } })
  expect(events).toEqual(before)
})
test("message IDs group interleaved chunks while run generation isolates reused tool IDs", () => {
  const events = [update(1, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "First " } }), update(2, { sessionUpdate: "tool_call", toolCallId: "t1" }), update(3, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "last" } }), { ...update(4, { sessionUpdate: "tool_call", toolCallId: "t1" }), runGeneration: 2 }]
  const result = projectConversation(events, agentSnapshot())
  expect(result).toHaveLength(3)
  expect(result[0]).toMatchObject({ content: [{ text: "First last" }] })
  expect(result[1]!.id).not.toBe(result[2]!.id)
})
test("a steer splits one turn into responses whose bounds meet at the steer and only the last carries the outcome", () => {
  const first = agentInput({ state: "delivered", turnId: "70", actualDelivery: "turn_start", deliveredAt: "2026-10-06T20:00:00Z" })
  const steer = agentInput({ id: "41", state: "delivered", turnId: "70", actualDelivery: "steer", deliveredAt: "2026-10-06T20:01:00Z" })
  const turn = { id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running" as const, startedAt: "2026-10-06T20:00:00Z" }
  const snapshot = agentSnapshot(); snapshot.inputs = [first, steer]; snapshot.turns = [turn]
  const events = [agentEvent(1, "input", first), update(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } }), agentEvent(3, "input", steer), update(4, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "b" } })]
  const [, before, , after] = groupTranscript(projectConversation(events, snapshot), snapshot)
  expect(before).toMatchObject({ kind: "response", startedAt: "2026-10-06T20:00:00Z", endedAt: "2026-10-06T20:01:00Z", live: false, last: false })
  expect(after).toMatchObject({ kind: "response", startedAt: "2026-10-06T20:01:00Z", endedAt: undefined, live: true, last: true })
  snapshot.turns = [{ ...turn, state: "completed", endedAt: "2026-10-06T20:02:00Z" }]
  expect(groupTranscript(projectConversation(events, snapshot), snapshot)[3]).toMatchObject({ endedAt: "2026-10-06T20:02:00Z", live: false, last: true })
})
test("a permission attaches to its tool call or stands in for one the provider never announced", () => {
  const snapshot = agentSnapshot(); snapshot.permissions = [agentPermission({ state: "resolved", optionId: "allow" }), agentPermission({ id: "61", request: { ...agentPermission().request, toolCall: { toolCallId: "orphan", title: "Write file" } } })]
  const events = [{ ...update(1, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run checks", kind: "execute" }) }, agentEvent(2, "permission", agentPermission()), agentEvent(3, "permission", snapshot.permissions[1]!)]
  const entries = projectConversation(events, snapshot)
  expect(entries).toMatchObject([{ kind: "tool", tool: { title: "Run checks" }, permission: { id: "60", state: "resolved" } }, { kind: "tool", tool: { title: "Write file" }, permission: { id: "61", state: "pending" } }])
  expect(summarizeTools(groupTranscript(entries, snapshot).flatMap(entry => entry.kind === "response" ? entry.steps : []))).toEqual([{ kind: "execute", count: 1 }, { kind: "other", count: 1 }])
})
test("questions retain their original conversation position and use the winning snapshot decision", () => {
  const question = agentElicitation()
  const resolved = agentElicitation({ state: "resolved", response: { action: "accept", content: { target: "staging" } } })
  const snapshot = agentSnapshot(); snapshot.elicitations = [resolved]
  const events = [update(1, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before" } }), agentEvent(2, "elicitation", question), update(3, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After" } }), agentEvent(4, "elicitation", resolved)]
  const entries = projectConversation(events, snapshot)
  expect(entries.map(entry => entry.kind)).toEqual(["message", "elicitation", "message"])
  expect(entries[1]).toMatchObject({ id: "elicitation-80", turnId: "70", elicitation: resolved })
  expect(projectConversation([], snapshot)).toEqual([entries[1]])
})
