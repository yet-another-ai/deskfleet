import assert from "node:assert/strict"
import test from "node:test"
import * as acp from "@agentclientprotocol/sdk/unstable"
import { answerCursorQuestion, CURSOR_ASK_QUESTION_METHOD } from "./questions.ts"

const signal = new AbortController().signal
const cursorParams = {
  toolCallId: "call_123",
  title: "Need input",
  questions: [
    { id: "q1", prompt: "Which mode should I use?", options: [{ id: "agent", label: "Agent" }, { id: "plan", label: "Plan" }] },
    { id: "q2", prompt: "Which checks?", allowMultiple: true, options: [{ id: "lint", label: "Lint" }, { id: "test", label: "Test" }] },
  ],
}

async function ask(params: unknown, sessionId: string | undefined, response: acp.CreateElicitationResponse) {
  const requests: acp.CreateElicitationRequest[] = []
  const result = await answerCursorQuestion(params, sessionId, async request => {
    requests.push(request)
    return response
  }, signal)
  return { requests, result }
}

test("Cursor questions become a session form and a nested answered outcome", async () => {
  assert.equal(CURSOR_ASK_QUESTION_METHOD, "cursor/ask_question")
  const { requests, result } = await ask(cursorParams, "fixture-session-1", {
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
  assert.deepEqual(result, {
    outcome: {
      outcome: "answered",
      answers: [
        { questionId: "q1", selectedOptionIds: ["plan"] },
        { questionId: "q2", selectedOptionIds: ["test", "lint"] },
      ],
    },
  })
})

test("Cursor decline and cancel keep their documented outcomes", async () => {
  const declined = await ask(cursorParams, "fixture-session-1", { action: "decline" })
  assert.deepEqual(declined.result, { outcome: { outcome: "skipped" } })
  const cancelled = await ask(cursorParams, "fixture-session-1", { action: "cancel" })
  assert.deepEqual(cancelled.result, { outcome: { outcome: "cancelled" } })
})

test("a Cursor question without a session is cancelled before the form is shown", async () => {
  let asked = false
  const result = await answerCursorQuestion(cursorParams, undefined, async () => {
    asked = true
    return { action: "cancel" }
  }, signal)
  assert.equal(asked, false)
  assert.deepEqual(result, { outcome: { outcome: "cancelled" } })
})
