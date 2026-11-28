import assert from "node:assert/strict"
import { test } from "node:test"
import { claudeSuperUsage, codexSuperUsage } from "./usage.ts"

test("Codex context counts this final fresh turn once and reads the configured effective window", () => {
  const frame = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 5 } })
  const window = { context_window: 500000, max_context_window: 872000, effective_context_window_percent: 95 }
  assert.deepEqual(codexSuperUsage(frame + "\n" + frame, window), { used: 90, size: 475000 })
  assert.deepEqual(codexSuperUsage(frame, {}), { used: 90 })
  assert.equal(codexSuperUsage('{"type":"turn.completed","usage":{}}', window), undefined)
})

test("Claude reports the final primary inference and exact matching model capacity", () => {
  const message = { type: "assistant", message: { model: "sample", usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 8, cache_creation_input_tokens: 4 } } }
  const result = { type: "result", modelUsage: { sample: { contextWindow: 200000 } }, usage: { input_tokens: 25000, output_tokens: 1200 } }
  assert.deepEqual(claudeSuperUsage([message, message, { ...message, parent_tool_use_id: "child", message: { model: "other", usage: { input_tokens: 900000 } } }, result]), { used: 31, size: 200000 })
  assert.deepEqual(claudeSuperUsage([message, { ...result, modelUsage: { other: { contextWindow: 500 } } }]), { used: 31 })
  assert.equal(claudeSuperUsage([result]), undefined)
})
