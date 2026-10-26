import assert from "node:assert/strict"
import test from "node:test"
import { AcpSessionScope } from "./agents/session-scope.ts"

test("ACP callbacks require an opening or active provider session", () => {
  const scope = new AcpSessionScope()
  assert.throws(() => scope.require("unknown"), { code: -32602 })
  assert.throws(() => scope.begin(""), { code: -32602 })
  scope.begin()
  assert.throws(() => scope.require(""), { code: -32602 })
  scope.complete("first")
  scope.require("first")
  assert.throws(() => scope.require("other"), { code: -32602 })
})

test("ACP new-session callbacks can complete before the agent returns the session ID", async () => {
  const scope = new AcpSessionScope()
  scope.begin()
  const response = await (async () => {
    scope.require("created")
    scope.require("created")
    assert.throws(() => scope.require("unrelated"), { code: -32602 })
    return { sessionId: "created" }
  })()
  scope.complete(response.sessionId)
  scope.require("created")
})

test("ACP session replacement verifies the response and rolls back provisional callback IDs", () => {
  const scope = new AcpSessionScope()
  scope.begin()
  scope.complete("original")
  scope.begin()
  scope.require("provisional")
  assert.throws(() => scope.require("original"), { code: -32602 })
  assert.throws(() => scope.complete("different"), { code: -32602 })
  scope.require("original")
  assert.throws(() => scope.require("provisional"), { code: -32602 })
  assert.throws(() => scope.require("different"), { code: -32602 })
  scope.begin()
  scope.require("failed")
  scope.fail()
  scope.require("original")
  assert.throws(() => scope.require("failed"), { code: -32602 })
})

test("ACP resume and load accept their known session ID before the response", () => {
  const scope = new AcpSessionScope()
  scope.begin("saved")
  scope.require("saved")
  assert.throws(() => scope.require("another"), { code: -32602 })
  scope.complete("saved")
  scope.require("saved")
  scope.begin("replacement")
  assert.throws(() => scope.require("saved"), { code: -32602 })
  scope.fail()
  scope.require("saved")
  assert.throws(() => scope.require("replacement"), { code: -32602 })
})

test("ACP sequential opens replace the active session and closing clears all callback access", () => {
  const scope = new AcpSessionScope()
  scope.begin()
  scope.complete("first")
  scope.begin()
  assert.throws(() => scope.begin("parallel"), /already opening/u)
  scope.complete("second")
  assert.throws(() => scope.require("first"), { code: -32602 })
  scope.require("second")
  scope.begin()
  scope.require("pending")
  scope.clear()
  assert.throws(() => scope.require("second"), { code: -32602 })
  assert.throws(() => scope.require("pending"), { code: -32602 })
  assert.throws(() => scope.complete("pending"), /No ACP session/u)
  assert.throws(() => scope.require("pending"), { code: -32602 })
})
