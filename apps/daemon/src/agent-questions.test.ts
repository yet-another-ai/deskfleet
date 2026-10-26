import assert from "node:assert/strict"
import test from "node:test"
import * as acp from "@agentclientprotocol/sdk/unstable"
import { answerVendorQuestion, CURSOR_ASK_QUESTION_METHOD, GROK_ASK_USER_QUESTION_ALIAS, GROK_ASK_USER_QUESTION_METHOD } from "./agents/questions.ts"

const signal = new AbortController().signal
const cursorParams = {
  toolCallId: "call_123",
  title: "Need input",
  questions: [
    { id: "q1", prompt: "Which mode should I use?", options: [{ id: "agent", label: "Agent" }, { id: "plan", label: "Plan" }] },
    { id: "q2", prompt: "Which checks?", allowMultiple: true, options: [{ id: "lint", label: "Lint" }, { id: "test", label: "Test" }] },
  ],
}
const grokParams = {
  sessionId: "sess-1",
  toolCallId: "tc-1",
  mode: "plan",
  questions: [{
    question: "Which database?",
    multi_select: false,
    options: [
      { label: "Redis", description: "In-memory store", preview: " redis preview " },
      { label: "Postgres", description: "Relational DB" },
    ],
  }, {
    question: "Which libraries?",
    multiSelect: true,
    options: [{ label: "Zod", description: "Schemas" }, { label: "Vitest", description: "Tests" }],
  }],
}

async function ask(params: unknown, method: string, sessionId: string | undefined, response: acp.CreateElicitationResponse) {
  const requests: acp.CreateElicitationRequest[] = []
  const result = await answerVendorQuestion(method, params, sessionId, async request => {
    requests.push(request)
    return response
  }, signal)
  return { requests, result }
}

test("Cursor questions become a session form and a nested answered outcome", async () => {
  const { requests, result } = await ask(cursorParams, CURSOR_ASK_QUESTION_METHOD, "fixture-session-1", {
    action: "accept", content: { q1: "plan", q2: ["test", "lint"] },
  })
  assert.equal(requests.length, 1)
  const request = requests[0]!
  assert.equal(request.mode, "form")
  assert.ok("sessionId" in request)
  assert.equal(request.sessionId, "fixture-session-1")
  assert.equal(request.toolCallId, "call_123")
  assert.equal(request.message, "Need input")
  assert.ok(acp.CreateElicitationRequest.isForm(request))
  assert.deepEqual(request.requestedSchema.required, ["q1", "q2"])
  assert.deepEqual(request.requestedSchema.properties?.q1, {
    type: "string", title: "Which mode should I use?", oneOf: [{ const: "agent", title: "Agent" }, { const: "plan", title: "Plan" }],
  })
  assert.deepEqual(request.requestedSchema.properties?.q2, {
    type: "array", title: "Which checks?", minItems: 1, items: { anyOf: [{ const: "lint", title: "Lint" }, { const: "test", title: "Test" }] },
  })
  assert.deepEqual(result, { outcome: { outcome: "answered", answers: [
    { questionId: "q1", selectedOptionIds: ["plan"] },
    { questionId: "q2", selectedOptionIds: ["test", "lint"] },
  ] } })
})

test("Cursor decline and cancel keep their documented outcomes", async () => {
  const declined = await ask(cursorParams, CURSOR_ASK_QUESTION_METHOD, "fixture-session-1", { action: "decline" })
  assert.deepEqual(declined.result, { outcome: { outcome: "skipped" } })
  const cancelled = await ask(cursorParams, CURSOR_ASK_QUESTION_METHOD, "fixture-session-1", { action: "cancel" })
  assert.deepEqual(cancelled.result, { outcome: { outcome: "cancelled" } })
})

test("a Cursor question without a session is cancelled before the form is shown", async () => {
  let asked = false
  const result = await answerVendorQuestion(CURSOR_ASK_QUESTION_METHOD, cursorParams, undefined, async () => {
    asked = true
    return { action: "cancel" }
  }, signal)
  assert.equal(asked, false)
  assert.deepEqual(result, { outcome: { outcome: "cancelled" } })
})

test("Grok questions use question text and labels, including the legacy method name", async () => {
  for (const method of [GROK_ASK_USER_QUESTION_METHOD, GROK_ASK_USER_QUESTION_ALIAS]) {
    const { requests, result } = await ask(grokParams, method, undefined, {
      action: "accept", content: { "Which database?": "Redis", "Which libraries?": ["Vitest"] },
    })
    const request = requests[0]!
    assert.equal(request.mode, "form")
    assert.ok("sessionId" in request)
    assert.equal(request.sessionId, "sess-1")
    assert.equal(request.message, "Which database?")
    assert.ok(acp.CreateElicitationRequest.isForm(request))
    assert.deepEqual(request.requestedSchema.properties?.["Which database?"], {
      type: "string", title: "Which database?", oneOf: [
        { const: "Redis", title: "Redis", description: "In-memory store\n redis preview " },
        { const: "Postgres", title: "Postgres", description: "Relational DB" },
      ],
    })
    assert.equal(request.requestedSchema.properties?.["Which libraries?"]?.type, "array")
    assert.deepEqual(result, {
      outcome: "accepted",
      answers: { "Which database?": ["Redis"], "Which libraries?": ["Vitest"] },
      annotations: { "Which database?": { preview: " redis preview " } },
    })
  }
})

test("Grok decline and cancel both dismiss the question", async () => {
  for (const action of ["decline", "cancel"] as const) {
    const { result } = await ask(grokParams, GROK_ASK_USER_QUESTION_METHOD, "other-session", { action })
    assert.deepEqual(result, { outcome: "cancelled" })
  }
})
