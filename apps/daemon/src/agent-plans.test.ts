import assert from "node:assert/strict"
import test from "node:test"
import * as acp from "@agentclientprotocol/sdk/unstable"
import { answerCursorCreatePlan, CURSOR_CREATE_PLAN_METHOD, cursorPlanApproval } from "./agents/plans.ts"

const signal = new AbortController().signal
const cursorPlan = {
  toolCallId: "call_124",
  name: "Refactor tabs layout",
  overview: "Tighten layout behavior and preserve existing UX.",
  plan: "1. Inspect current tab sizing logic.\n2. Update layout calculations.\n3. Verify editor behavior.",
  todos: [
    { id: "todo-1", content: "Inspect current tab sizing logic", status: "completed" },
    { id: "todo-2", content: "Update layout calculations", status: "in_progress" },
    { id: "todo-3", content: "Verify editor behavior", status: "pending" },
  ],
  isProject: false,
  phases: [{
    name: "Layout",
    todos: [
      { id: "todo-1", content: "Inspect current tab sizing logic", status: "completed" },
      { id: "todo-2", content: "Update layout calculations", status: "in_progress" },
    ],
  }],
}

async function ask(params: unknown, sessionId: string | undefined, response: acp.CreateElicitationResponse) {
  const requests: acp.CreateElicitationRequest[] = []
  const result = await answerCursorCreatePlan(params, sessionId, async request => {
    requests.push(request)
    return response
  }, signal)
  return { requests, result }
}

test("Cursor create_plan becomes a session form with plan meta and a nested accepted outcome", async () => {
  const { requests, result } = await ask(cursorPlan, "fixture-session-1", { action: "accept", content: {} })
  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request.mode, "form")
  assert.ok("sessionId" in request)
  assert.equal(request.sessionId, "fixture-session-1")
  assert.equal(request.toolCallId, "call_124")
  assert.equal(request.message, "Tighten layout behavior and preserve existing UX.")
  assert.ok(acp.CreateElicitationRequest.isForm(request))
  assert.deepEqual(request.requestedSchema, { type: "object", properties: {} })
  assert.deepEqual(cursorPlanApproval(request), {
    name: "Refactor tabs layout",
    overview: "Tighten layout behavior and preserve existing UX.",
    plan: cursorPlan.plan,
    todos: cursorPlan.todos,
    isProject: false,
    phases: cursorPlan.phases,
  })
  assert.deepEqual(result, { outcome: { outcome: "accepted" } })
})

test("Cursor plan decline and cancel keep their documented nested outcomes", async () => {
  const rejected = await ask(cursorPlan, "fixture-session-1", { action: "decline" })
  assert.deepEqual(rejected.result, { outcome: { outcome: "rejected" } })
  const cancelled = await ask(cursorPlan, "fixture-session-1", { action: "cancel" })
  assert.deepEqual(cancelled.result, { outcome: { outcome: "cancelled" } })
})

test("a Cursor plan without a session is cancelled before the form is shown", async () => {
  let asked = false
  const result = await answerCursorCreatePlan(cursorPlan, undefined, async () => {
    asked = true
    return { action: "cancel" }
  }, signal)
  assert.equal(asked, false)
  assert.deepEqual(result, { outcome: { outcome: "cancelled" } })
})

test("malformed Cursor plans cancel without showing a form", async () => {
  for (const params of [
    { toolCallId: "call_124", plan: "", todos: [] },
    { toolCallId: "call_124", plan: "steps", todos: [{ id: "todo-1", content: "Work", status: "unknown" }] },
    { toolCallId: "call_124", plan: "steps", todos: [{ id: "dup", content: "One", status: "pending" }, { id: "dup", content: "Two", status: "pending" }] },
  ]) {
    let asked = false
    const result = await answerCursorCreatePlan(params, "fixture-session-1", async () => {
      asked = true
      return { action: "accept", content: {} }
    }, signal)
    assert.equal(asked, false)
    assert.deepEqual(result, { outcome: { outcome: "cancelled" } })
  }
})

test("CURSOR_CREATE_PLAN_METHOD matches the Cursor ACP extension name", () => {
  assert.equal(CURSOR_CREATE_PLAN_METHOD, "cursor/create_plan")
})
