import assert from "node:assert/strict"
import test from "node:test"
import * as acp from "@agentclientprotocol/sdk/unstable"
import { answerGrokQuestion, GROK_ASK_USER_QUESTION_ALIAS, GROK_ASK_USER_QUESTION_METHOD } from "./questions.ts"

const signal = new AbortController().signal
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

async function ask(params: unknown, response: acp.CreateElicitationResponse) {
  const requests: acp.CreateElicitationRequest[] = []
  const result = await answerGrokQuestion(params, async request => {
    requests.push(request)
    return response
  }, signal)
  return { requests, result }
}

test("Grok questions use question text and labels, including the legacy method name", async () => {
  assert.equal(GROK_ASK_USER_QUESTION_METHOD, "x.ai/ask_user_question")
  assert.equal(GROK_ASK_USER_QUESTION_ALIAS, "_x.ai/ask_user_question")
  const { requests, result } = await ask(grokParams, {
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
})

test("Grok decline and cancel both dismiss the question", async () => {
  for (const action of ["decline", "cancel"] as const) {
    const { result } = await ask(grokParams, { action })
    assert.deepEqual(result, { outcome: "cancelled" })
  }
})

test("Grok plan interviews expose discussion and skip actions without fake answers", async () => {
  for (const outcome of ["chat_about_this", "skip_interview"] as const) {
    const response: acp.CreateElicitationResponse = { action: "accept", _meta: { deskfleet: { grokOutcome: outcome } } }
    const plan = await ask(grokParams, response)
    assert.deepEqual(plan.requests[0]?._meta, { deskfleet: { grokPlanInterview: true } })
    assert.deepEqual(plan.result, { outcome })
    const ordinary = await ask({ ...grokParams, mode: "default" }, response)
    assert.equal(ordinary.requests[0]?._meta, undefined)
    assert.deepEqual(ordinary.result, { outcome: "cancelled" })
  }
})
