import assert from "node:assert/strict"
import test from "node:test"
import type * as acp from "@agentclientprotocol/sdk"
import { agentConfiguration } from "../agent-configuration-protocol.ts"
import { AcpModelReasoning, projectModelReasoning } from "./reasoning-effort.ts"

const source = {
  models: {
    currentModelId: "grok-4.5",
    availableModels: [
      {
        modelId: "grok-4.5", name: "Grok 4.5",
        _meta: {
          supportsReasoningEffort: true,
          reasoningEffort: "high",
          reasoningEfforts: [
            { id: "low", label: "Low", description: "Faster replies" },
            { id: "high", label: "High", default: true },
          ],
        },
      },
      { modelId: "grok-fast", name: "Grok Fast", _meta: { supportsReasoningEffort: false, reasoningEfforts: [] } },
    ],
  },
  _meta: {
    "x.ai/sessionConfig": {
      options: [
        {
          id: "model", name: "Model", category: "model", type: "select", currentValue: "grok-4.5",
          options: [{ value: "grok-4.5", name: "Grok 4.5" }, { value: "grok-fast", name: "Grok Fast" }],
        },
        {
          id: "reasoning_effort", name: "Reasoning", category: "mode", type: "select", currentValue: "xhigh",
          options: [{ value: "xhigh", name: "Stale extra high" }],
        },
      ],
    },
  },
}

test("model metadata projects reasoning without turning session config modes into permission modes", () => {
  const projected = projectModelReasoning(undefined, source)
  const configuration = agentConfiguration(projected ?? [], { id: "grok", name: "Grok" })
  assert.equal(configuration.modes, null)
  assert.equal(configuration.models?.currentValue, "grok-4.5")
  assert.deepEqual(configuration.models?.options.map(option => option.id), ["grok-4.5", "grok-fast"])
  assert.equal(configuration.reasoningEfforts?.id, "reasoning_effort")
  assert.equal(configuration.reasoningEfforts?.currentValue, "high")
  assert.deepEqual(configuration.reasoningEfforts?.options, [
    { id: "low", name: "Low", description: "Faster replies" },
    { id: "high", name: "High" },
  ])
  const empty: acp.SessionConfigOption[] = []
  assert.equal(projectModelReasoning(empty, source), empty)
  assert.equal(projectModelReasoning(undefined, {}), undefined)
  assert.equal(projectModelReasoning(null, source), null)
})

test("an advertised reasoning select is kept, including effort and thinking aliases", () => {
  const advertised: acp.SessionConfigOption[] = [{
    id: "effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: "low",
    options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
  }]
  assert.equal(projectModelReasoning(advertised, source), advertised)
  assert.equal(agentConfiguration([{
    id: "effort", name: "Reasoning", type: "select", currentValue: "medium",
    options: [{ value: "medium", name: "Medium" }],
  }]).reasoningEfforts?.id, "effort")
  assert.equal(agentConfiguration([{
    id: "thinking_intensity", name: "Thinking", type: "select", currentValue: "high",
    options: [{ value: "high", name: "High" }],
  }]).reasoningEfforts?.currentValue, "high")
  assert.equal(agentConfiguration([
    { id: "model", category: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] },
    { id: "fast", category: "model_config", name: "Fast", type: "boolean", currentValue: true },
  ]).reasoningEfforts, null)
})

test("selected model metadata supplies thinking levels and blocks a stale session catalog", () => {
  const options: acp.SessionConfigOption[] = [{
    id: "model", category: "model", name: "Model", type: "select", currentValue: "grok-4.5",
    options: [{
      value: "grok-4.5", name: "Grok 4.5",
      _meta: {
        supportsThinkingIntensity: true, thinkingIntensity: "minimal",
        thinkingIntensities: [{ value: "minimal", name: "Minimal" }, { id: "max", label: "Max" }],
      },
    }],
  }]
  const projected = projectModelReasoning(options, source)
  assert.notEqual(projected, options)
  assert.deepEqual(agentConfiguration(projected ?? []).reasoningEfforts?.options.map(option => [option.id, option.name]), [
    ["minimal", "Minimal"], ["max", "Max"],
  ])
  assert.equal(agentConfiguration(projected ?? []).reasoningEfforts?.currentValue, "minimal")
  const denied: acp.SessionConfigOption[] = [{
    id: "model", category: "model", name: "Model", type: "select", currentValue: "grok-fast",
    options: [{ value: "grok-fast", name: "Grok Fast", _meta: { supportsReasoningEffort: false, reasoningEfforts: [] } }],
  }]
  assert.equal(projectModelReasoning(denied, source), denied)
  const placeholder: acp.SessionConfigOption[] = [...options, {
    id: "reasoning_effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: "", options: [],
  }]
  assert.equal(agentConfiguration(projectModelReasoning(placeholder, {}) ?? []).reasoningEfforts?.currentValue, "minimal")
})

test("an advertised reasoning option categorized as mode does not replace permission modes", () => {
  const options: acp.SessionConfigOption[] = [
    {
      id: "reasoning_effort", category: "mode", name: "Reasoning", type: "select", currentValue: "high",
      options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
    },
    {
      id: "permission", category: "mode", name: "Mode", type: "select", currentValue: "agent",
      options: [{ value: "agent", name: "Agent" }],
    },
  ]
  const projected = projectModelReasoning(options, {})
  const configuration = agentConfiguration(projected ?? [])
  assert.equal(configuration.reasoningEfforts?.id, "reasoning_effort")
  assert.equal(configuration.reasoningEfforts?.currentValue, "high")
  assert.deepEqual(configuration.reasoningEfforts?.options.map(option => option.id), ["low", "high"])
  assert.equal(configuration.modes?.id, "permission")
  assert.equal(configuration.modes?.currentValue, "agent")
  assert.equal(new AcpModelReasoning().kind("reasoning_effort", projected ?? undefined), undefined)
})

test("session config reasoning stays distinct from an advertised permission mode", () => {
  const options: acp.SessionConfigOption[] = [
    { id: "model", category: "model", name: "Model", type: "select", currentValue: "grok-4.5", options: [{ value: "grok-4.5", name: "Grok 4.5" }] },
    { id: "permission", category: "mode", name: "Mode", type: "select", currentValue: "agent", options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }] },
  ]
  const configuration = agentConfiguration(projectModelReasoning(options, { _meta: source._meta }) ?? [])
  assert.equal(configuration.modes?.currentValue, "agent")
  assert.deepEqual(configuration.modes?.options.map(option => option.id), ["agent", "plan"])
  assert.deepEqual(configuration.reasoningEfforts?.options.map(option => option.id), ["xhigh"])
})

test("a model change drops a stored effort override when the new model cannot adjust it", () => {
  const reasoning = new AcpModelReasoning()
  reasoning.remember(source)
  const initial: { configOptions?: acp.SessionConfigOption[] | null } = {}
  const first = reasoning.project(initial)
  reasoning.noteEffort("low")
  const second = reasoning.project({ configOptions: first.configOptions })
  assert.equal(agentConfiguration(second.configOptions ?? []).reasoningEfforts?.currentValue, "low")
  const patched = (second.configOptions ?? []).map(option =>
    option.type === "select" && option.category === "model" ? { ...option, currentValue: "grok-fast" } : option)
  const third = reasoning.project({ configOptions: patched })
  const configuration = agentConfiguration(third.configOptions ?? [])
  assert.equal(configuration.models?.currentValue, "grok-fast")
  assert.equal(configuration.reasoningEfforts, null)
  assert.equal(configuration.modes, null)
  assert.equal(reasoning.kind("reasoning_effort", second.configOptions ?? undefined), "effort")
  assert.equal(reasoning.kind("model", third.configOptions ?? undefined), "model")
})
