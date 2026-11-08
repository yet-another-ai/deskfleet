import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk/unstable"
import { expect, test } from "vitest"
import type { AgentEvent } from "../../../../apps/daemon/src/agent-protocol.ts"
import { agentElicitation, agentEvent, agentPermission, agentSnapshot } from "../test/agent.ts"
import { projectConversation } from "./agent-conversation.ts"
import { createConversationProjector } from "./conversation-projector.ts"
import { subagentNotification } from "@deskfleet/client/agent-session-scope"

const update = (seq: number, update: SessionUpdate, sessionId = "parent", runGeneration = 1): AgentEvent => ({
  ...agentEvent(seq, "acp", { sessionId, update }), runGeneration,
})
const text = (text: string) => ({ type: "text" as const, text })

test("ID-addressed plans replace content in place, remove only their ID, and keep legacy plans", () => {
  const source = [
    update(1, { sessionUpdate: "plan_update", plan: { type: "items", planId: "a", entries: [{ content: "Inspect", status: "pending", priority: "high" }] } }),
    update(2, { sessionUpdate: "plan_update", plan: { type: "file", planId: "b", uri: "file:///workspace/PLAN.md" } }),
    update(3, { sessionUpdate: "plan", entries: [{ content: "Legacy task", status: "pending", priority: "medium" }] }),
    update(4, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "a", content: "## Updated plan" } }),
    update(5, { sessionUpdate: "plan_removed", planId: "b" }),
  ]
  const entries = projectConversation(source, agentSnapshot())
  expect(entries).toMatchObject([
    { id: "plan-1", kind: "structured_plan", plan: { planId: "a", type: "markdown", content: "## Updated plan" } },
    { kind: "plan", entries: [{ content: "Legacy task" }] },
  ])
  source.push(update(6, { sessionUpdate: "plan_update", plan: { type: "file", planId: "b", uri: "file:///workspace/NEW-PLAN.md" } }))
  expect(projectConversation(source, agentSnapshot()).at(-1)).toMatchObject({ id: "plan-6", kind: "structured_plan", plan: { planId: "b" } })
})

test("compaction chunks create a timeline item; patch omission preserves fields and null clears them", () => {
  const snapshot = agentSnapshot()
  const events = [update(1, { sessionUpdate: "compaction_summary_chunk", compactionId: "compact", content: text("Retained ") })]
  const project = createConversationProjector()
  const first = project(events, snapshot)
  expect(first).toMatchObject([{ id: "compaction-1", compaction: { status: "in_progress", summary: [text("Retained ")] } }])
  events.push(update(2, { sessionUpdate: "agent_message_chunk", content: text("Continuing") }))
  events.push(update(3, { sessionUpdate: "compaction_summary_chunk", compactionId: "compact", content: text("context") }))
  events.push(update(4, { sessionUpdate: "compaction_update", compactionId: "compact", status: "failed", error: "Retry needed", _meta: { attempt: 1 } }))
  const failed = project(events, snapshot)
  expect(failed[0]).toMatchObject({ id: "compaction-1", compaction: { summary: [text("Retained context")], error: "Retry needed", _meta: { attempt: 1 } } })
  expect(first[0]).toMatchObject({ compaction: { summary: [text("Retained ")] } })
  events.push(update(5, { sessionUpdate: "compaction_update", compactionId: "compact", status: "completed", summary: [text("Replacement")], error: null, _meta: null }))
  expect(project(events, snapshot)[0]).toMatchObject({ compaction: { status: "completed", summary: [text("Replacement")], error: null, _meta: null } })
  events.push(update(6, { sessionUpdate: "compaction_update", compactionId: "compact", status: "completed", summary: null }))
  expect(project(events, snapshot)[0]).toMatchObject({ compaction: { summary: null } })
  expect(failed[0]).toMatchObject({ compaction: { summary: [text("Retained context")] } })
})

test("child messages and tools stay in their own lane, including nested subagents and reused IDs", () => {
  const events = [
    update(1, { sessionUpdate: "subagent_update", sessionId: "child", title: "Reviewer", description: "Check the patch", state: { state: "running" } }),
    update(2, { sessionUpdate: "agent_message_chunk", messageId: "m", content: text("Parent ") }),
    update(3, { sessionUpdate: "agent_message_chunk", messageId: "m", content: text("Child answer") }, "child"),
    update(4, { sessionUpdate: "user_message_chunk", messageId: "task", content: text("Review the change") }, "child"),
    update(5, { sessionUpdate: "tool_call", toolCallId: "tool", title: "Child read", kind: "read" }, "child"),
    update(6, { sessionUpdate: "tool_call", toolCallId: "tool", title: "Parent read", kind: "read" }),
    update(7, { sessionUpdate: "subagent_update", sessionId: "grandchild", title: "Tests", state: { state: "running" } }, "child"),
    update(8, { sessionUpdate: "agent_message_chunk", messageId: "m", content: text("Grandchild answer") }, "grandchild"),
    update(9, { sessionUpdate: "agent_message_chunk", messageId: "m", content: text("answer") }),
    update(10, { sessionUpdate: "subagent_update", sessionId: "child", description: null, state: { state: "idle", stopReason: "end_turn" } }),
  ]
  const before = structuredClone(events)
  const entries = projectConversation(events, agentSnapshot())
  expect(entries).toMatchObject([
    { kind: "subagent", session: { sessionId: "child", title: "Reviewer", description: null, state: { state: "idle" } }, steps: [
      { kind: "message", role: "assistant", messageId: "m", content: [text("Child answer")] },
      { kind: "message", role: "user", content: [text("Review the change")] },
      { kind: "tool", tool: { title: "Child read" } },
      { kind: "subagent", session: { sessionId: "grandchild" }, steps: [{ kind: "message", content: [text("Grandchild answer")] }] },
    ] },
    { kind: "message", role: "assistant", content: [text("Parent answer")] },
    { kind: "tool", tool: { title: "Parent read" } },
  ])
  expect(events).toEqual(before)
})

test("directed messages append chunks and patch routing without becoming assistant replies", () => {
  const events = [
    update(1, { sessionUpdate: "session_message_chunk", messageId: "dispatch", content: text("Review ") }),
    update(2, { sessionUpdate: "session_message", messageId: "dispatch", senderSessionId: "parent", recipientSessionId: "child" }),
    update(3, { sessionUpdate: "session_message_chunk", messageId: "dispatch", content: text("the patch") }),
    update(4, { sessionUpdate: "session_message", messageId: "dispatch", recipientMessageId: "incoming", _meta: { delivery: "received" } }),
  ]
  expect(projectConversation(events, agentSnapshot())).toMatchObject([{ kind: "session_message", message: {
    messageId: "dispatch", senderSessionId: "parent", recipientSessionId: "child", recipientMessageId: "incoming", content: [text("Review the patch")], _meta: { delivery: "received" },
  } }])
  events.push(update(5, { sessionUpdate: "session_message", messageId: "dispatch", senderSessionId: null, content: [], _meta: null }))
  expect(projectConversation(events, agentSnapshot())[0]).toMatchObject({ message: { senderSessionId: null, recipientSessionId: "child", content: [], _meta: null } })
})

test("plan, compaction and directed-message IDs are independent across sessions and provider runs", () => {
  const events = [update(1, { sessionUpdate: "subagent_update", sessionId: "child" })]
  let seq = 1
  for (const [sessionId, run] of [["parent", 1], ["child", 1], ["parent", 2]] as const) {
    events.push(update(++seq, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "same", content: `${sessionId}-${run}` } }, sessionId, run))
    events.push(update(++seq, { sessionUpdate: "compaction_summary_chunk", compactionId: "same", content: text(`${sessionId}-${run}`) }, sessionId, run))
    events.push(update(++seq, { sessionUpdate: "session_message_chunk", messageId: "same", content: text(`${sessionId}-${run}`) }, sessionId, run))
  }
  events.push(update(++seq, { sessionUpdate: "plan_removed", planId: "same" }, "child"))
  const entries = projectConversation(events, agentSnapshot())
  expect(entries).toHaveLength(7)
  const child = entries[0]!
  expect(child.kind).toBe("subagent")
  if (child.kind !== "subagent") throw new Error("Missing child")
  expect(child.steps).toHaveLength(2)
  expect(child.steps).toMatchObject([{ compaction: { summary: [text("child-1")] } }, { message: { content: [text("child-1")] } }])
  expect(entries[1]).toMatchObject({ plan: { content: "parent-1" } })
  expect(entries[4]).toMatchObject({ plan: { content: "parent-2" } })
})

test("child permission and restored questions render within the child; notices never replay", () => {
  const snapshot = agentSnapshot()
  const permission = agentPermission({ request: { ...agentPermission().request, sessionId: "child", toolCall: { toolCallId: "call", title: "Write" } } })
  const question = agentElicitation({ request: { ...agentElicitation().request, sessionId: "child" } })
  snapshot.elicitations = [question]
  const events = [
    update(1, { sessionUpdate: "subagent_update", sessionId: "child", state: { state: "requires_action" } }),
    update(2, { sessionUpdate: "tool_call", toolCallId: "call", title: "Write" }, "child"),
    agentEvent(3, "permission", permission),
    update(4, { sessionUpdate: "notice", severity: "warning", title: "Live only" }),
  ]
  const entries = projectConversation(events, snapshot)
  expect(entries).toMatchObject([{ kind: "subagent", steps: [{ kind: "tool", permission }, { kind: "elicitation", elicitation: question }] }])
  expect(entries).toHaveLength(1)
})

test("incremental child and compaction patches preserve previous snapshots and match full replay", () => {
  const source = [
    update(1, { sessionUpdate: "subagent_update", sessionId: "child", title: "Worker", state: { state: "running" } }),
    update(2, { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: text("Summary ") }, "child"),
    update(3, { sessionUpdate: "compaction_summary_chunk", compactionId: "c", content: text("continues") }, "child"),
    update(4, { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p", content: "Plan" } }, "child"),
    update(5, { sessionUpdate: "plan_removed", planId: "p" }, "child"),
    update(6, { sessionUpdate: "session_message_chunk", messageId: "m", content: text("Done") }, "child"),
    update(7, { sessionUpdate: "subagent_update", sessionId: "child", state: null, title: null }),
  ]
  const events: AgentEvent[] = []
  const snapshot = agentSnapshot()
  const project = createConversationProjector()
  for (const event of source) {
    const previous = project(events, snapshot)
    const saved = structuredClone(previous)
    events.push(event)
    expect(project(events, snapshot)).toEqual(projectConversation(events, snapshot))
    expect(previous).toEqual(saved)
  }
})

test("paged child output stays separate before association metadata arrives", () => {
  const snapshot = agentSnapshot()
  const childMessage = update(8, { sessionUpdate: "agent_message_chunk", messageId: "m", content: text("Child finding") }, "child")
  childMessage.payload = subagentNotification(childMessage.payload as SessionNotification)
  const events = [childMessage, update(9, { sessionUpdate: "agent_message_chunk", messageId: "m", content: text("Parent answer") })]
  const project = createConversationProjector()
  expect(project(events, snapshot)).toMatchObject([
    { kind: "subagent", session: { sessionId: "child" }, steps: [{ content: [text("Child finding")] }] },
    { kind: "message", content: [text("Parent answer")] },
  ])
  events.unshift(update(1, { sessionUpdate: "subagent_update", sessionId: "child", title: "Reviewer" }))
  const restored = project(events, snapshot)
  expect(restored).toHaveLength(2)
  expect(restored[0]).toMatchObject({ kind: "subagent", session: { title: "Reviewer" }, steps: [{ content: [text("Child finding")] }] })
})

test("marked callback-only pages and restored questions create child lanes without association events", () => {
  const snapshot = agentSnapshot()
  const permission = agentPermission({ request: subagentNotification({ ...agentPermission().request, sessionId: "child" }) })
  const question = agentElicitation({ request: subagentNotification({ ...agentElicitation().request, sessionId: "child" }) })
  snapshot.elicitations = [question]
  expect(projectConversation([], snapshot)).toMatchObject([{ kind: "subagent", session: { sessionId: "child" }, steps: [{ kind: "elicitation", elicitation: question }] }])
  expect(projectConversation([agentEvent(1, "permission", permission)], snapshot)).toMatchObject([
    { kind: "subagent", session: { sessionId: "child" }, steps: [{ kind: "tool", permission }, { kind: "elicitation", elicitation: question }] },
  ])
})

test("Cursor cancelled todo metadata survives the legacy plan projection", () => {
  expect(projectConversation([update(1, { sessionUpdate: "plan", entries: [{ content: "Skipped migration", status: "completed", priority: "medium", _meta: { cursor: { id: "todo", status: "cancelled" } } }] })], agentSnapshot()))
    .toMatchObject([{ kind: "plan", entries: [{ status: "completed", _meta: { cursor: { status: "cancelled" } } }] }])
})

test("permission decisions for reused child and tool IDs stay within their provider generation", () => {
  const snapshot = agentSnapshot()
  const events: AgentEvent[] = []
  let seq = 0
  for (const generation of [1, 2]) {
    const permission = agentPermission({ id: `permission-${generation}`, runGeneration: generation,
      request: subagentNotification({ ...agentPermission().request, sessionId: "child", toolCall: { toolCallId: "same-tool", title: `Run ${generation}` } }),
      state: "resolved", optionId: generation === 1 ? "allow" : "deny",
    })
    snapshot.permissions.push(permission)
    events.push(update(++seq, { sessionUpdate: "subagent_update", sessionId: "child", title: `Child ${generation}` }, "parent", generation))
    events.push(update(++seq, { sessionUpdate: "tool_call", toolCallId: "same-tool", title: `Run ${generation}` }, "child", generation))
    events.push({ ...agentEvent(++seq, "permission", permission), runGeneration: generation })
  }
  const entries = projectConversation(events, snapshot)
  expect(entries).toMatchObject([
    { kind: "subagent", steps: [{ kind: "tool", permission: { id: "permission-1", optionId: "allow" } }] },
    { kind: "subagent", steps: [{ kind: "tool", permission: { id: "permission-2", optionId: "deny" } }] },
  ])
  expect(entries[0]!.id).not.toBe(entries[1]!.id)
})

test("a paged nested association creates independently addressable parent and child cards", () => {
  const event = update(8, { sessionUpdate: "subagent_update", sessionId: "grandchild", title: "Nested reviewer" }, "child")
  event.payload = subagentNotification(event.payload as SessionNotification)
  const [parent] = projectConversation([event], agentSnapshot())
  if (parent?.kind !== "subagent") throw new Error("Missing parent placeholder")
  expect(parent.steps[0]).toMatchObject({ kind: "subagent", session: { sessionId: "grandchild" } })
  expect(parent.id).not.toBe(parent.steps[0]!.id)
})
