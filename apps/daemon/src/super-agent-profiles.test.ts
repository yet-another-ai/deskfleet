import assert from "node:assert/strict"
import { test } from "node:test"
import { superClaudeArgs, superDecisionInstructions } from "./super-agent-model.ts"
import { effectiveCoordinatorProfile, validateCoordinatorProfile } from "./super-agent-profiles.ts"

test("Claude coordinator passes only explicit model and effort overrides while retaining its restricted invocation", () => {
  const defaults = superClaudeArgs()
  assert.equal(defaults.includes("--model"), false)
  assert.equal(defaults.includes("--effort"), false)
  const args = superClaudeArgs({ model: "opus", reasoningEffort: "high" })
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  assert.equal(value("--model"), "opus")
  assert.equal(value("--effort"), "high")
  assert.equal(value("--permission-mode"), "dontAsk")
  assert.equal(value("--tools"), "")
  assert.equal(value("--output-format"), "stream-json")
  assert.equal(value("--system-prompt"), superDecisionInstructions)
  assert.ok(args.includes("--safe-mode") && args.includes("--no-session-persistence") && args.includes("--strict-mcp-config"))
})

test("clearing optional choices still works if CLI discovery is temporarily unavailable", () => {
  const unavailable = { models: [], defaultReasoningEfforts: [] }
  assert.doesNotThrow(() => validateCoordinatorProfile({}, unavailable))
  assert.throws(() => validateCoordinatorProfile({ model: "unavailable" }, unavailable), /does not offer/)
  assert.deepEqual(effectiveCoordinatorProfile("claude-code", {}, unavailable), {})
  assert.deepEqual(effectiveCoordinatorProfile("codex", {}, unavailable), { model: "gpt-6.2-sol", reasoningEffort: "low" })
})
