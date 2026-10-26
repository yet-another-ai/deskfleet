import assert from "node:assert/strict"
import test from "node:test"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { elicitationUrl, validateElicitationResponse } from "./agent-elicitation-protocol.ts"

const request: acp.CreateElicitationRequest = {
  mode: "form", sessionId: "provider", message: "Answer the questions", requestedSchema: {
    type: "object", required: ["choice", "confirmed", "count"], properties: {
      choice: { type: "string", oneOf: [{ const: "a", title: "Option A" }, { const: "Other", title: "Other" }] },
      note: { type: "string", minLength: 2, maxLength: 10, _meta: { codex: { role: "user_note", questionId: "choice" } } },
      confirmed: { type: "boolean" },
      count: { type: "integer", minimum: 0, maximum: 4 },
      ratio: { type: "number", minimum: 0, maximum: 1 },
      formats: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "json", title: "JSON" }, { const: "text", title: "Text" }] } },
      days: { type: "array", items: { type: "string", enum: ["Monday", "Tuesday"] } },
      color: { type: "string", enum: ["red", "blue"] },
      code: { type: "string", pattern: "^[A-Z]{2}$" },
      date: { type: "string", format: "date" },
      url: { type: "string", format: "uri" },
      email: { type: "string", format: "email" },
    },
  },
}
const content = { choice: "Other", note: "custom", confirmed: false, count: 0, ratio: 0.5, formats: ["json"], days: ["Monday"], color: "blue", code: "OK", date: "2026-10-25", url: "https://example.invalid", email: "person@example.invalid" }

test("URL elicitation accepts consent without form content and permits only HTTP(S) links", () => {
  const url: acp.CreateElicitationRequest = { mode: "url", sessionId: "provider", elicitationId: "login", message: "Sign in", url: "https://example.invalid/login" }
  assert.equal(elicitationUrl(url)?.host, "example.invalid")
  assert.deepEqual(validateElicitationResponse(url, { action: "accept" }), { action: "accept" })
  assert.throws(() => validateElicitationResponse(url, { action: "accept", content: { token: "secret" } }))
  for (const target of ["javascript:alert(1)", "file:///tmp/private", "data:text/html,hello", "custom://login", "/relative"]) {
    const unsafe: acp.CreateElicitationRequest = { ...url, url: target }
    assert.equal(elicitationUrl(unsafe), undefined)
    assert.throws(() => validateElicitationResponse(unsafe, { action: "accept" }))
    assert.deepEqual(validateElicitationResponse(unsafe, { action: "decline" }), { action: "decline" })
  }
})

test("form answers preserve typed values, free text notes, required false, and zero", () => {
  const response = { action: "accept", content }
  assert.deepEqual(validateElicitationResponse(request, response), response)
  assert.deepEqual(validateElicitationResponse(request, { action: "decline", content: { secret: "ignored" } }), { action: "decline" })
  assert.deepEqual(validateElicitationResponse(request, { action: "cancel" }), { action: "cancel" })
})

test("invalid choices, types, bounds, formats, and missing required answers leave forms unresolved", () => {
  const invalid = [
    { choice: "unknown" }, { note: "x" }, { note: "much too long" }, { confirmed: "false" },
    { count: 0.5 }, { count: -1 }, { count: 5 }, { ratio: 2 }, { ratio: Number.NaN },
    { formats: [] }, { formats: ["xml"] }, { formats: ["json", "json"] }, { days: ["Sunday"] },
    { color: "green" }, { code: "no" }, { date: "2026-02-30" }, { url: "relative" }, { email: "no-at-sign" },
    { unexpected: "not declared" },
  ]
  for (const patch of invalid) assert.throws(() => validateElicitationResponse(request, { action: "accept", content: { ...content, ...patch } }))
  assert.throws(() => validateElicitationResponse(request, { action: "accept", content: { choice: "a", count: 0 } }), /required/)
  assert.throws(() => validateElicitationResponse(request, { action: "unknown" }), /Invalid question response/)
})
