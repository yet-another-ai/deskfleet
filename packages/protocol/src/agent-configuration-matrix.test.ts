import assert from "node:assert/strict"
import test from "node:test"
import { agentConfiguration, type AgentConfigurationMatrix } from "./agent-configuration.ts"
import { cachedAgentConfiguration } from "./agent-configuration-matrix.ts"

const configuration = (model: string, effort: string, fast: boolean) => agentConfiguration([
  { id: "model", category: "model", name: "Model", type: "select", currentValue: model, options: ["first", "second"].map(value => ({ value, name: value })) },
  { id: "effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: effort, options: ["low", "high"].map(value => ({ value, name: value })) },
  { id: "fast", name: "Fast", type: "boolean", currentValue: fast },
])

test("matrix lookup follows confirmed dependent defaults and boolean choices in setter order", () => {
  const matrix: AgentConfigurationMatrix = {
    configurations: [configuration("first", "high", false), configuration("second", "low", false), configuration("second", "high", false), configuration("second", "high", true)],
    transitions: [
      { from: 0, selection: { model: "second" }, to: 1 },
      { from: 1, selection: { reasoningEffort: "high" }, to: 2 },
      { from: 2, selection: { configValues: { fast: true } }, to: 3 },
    ], complete: false,
  }
  assert.deepEqual(cachedAgentConfiguration(matrix, undefined, { model: "second" }), matrix.configurations[1])
  assert.deepEqual(cachedAgentConfiguration(matrix, undefined, { configValues: { model: "second", effort: "high", fast: true } }), matrix.configurations[3])
  assert.equal(cachedAgentConfiguration(matrix, matrix.configurations[1], { configValues: { fast: true } }), undefined,
    "An advertised option alone does not establish its dependent effects")
  assert.equal(cachedAgentConfiguration(matrix, matrix.configurations[2], { model: "first" }), undefined)
  const copy = cachedAgentConfiguration(matrix, undefined, {})!
  copy.models!.currentValue = "changed-locally"
  assert.equal(matrix.configurations[0]!.models!.currentValue, "first")
})

test("unchanged cached selections still require an advertised value and type", () => {
  const current = configuration("retired-model", "high", false)
  const matrix: AgentConfigurationMatrix = { configurations: [current], transitions: [], complete: true }
  assert.equal(cachedAgentConfiguration(matrix, current, { model: "retired-model" }), undefined)
  assert.equal(cachedAgentConfiguration(matrix, current, { configValues: { fast: "false" } }), undefined)
  assert.deepEqual(cachedAgentConfiguration(matrix, current, { configValues: { fast: false } }), current)
})
