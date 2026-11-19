import assert from "node:assert/strict"
import test from "node:test"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { findReasoningEffortOption } from "./protocol.ts"
import { AcpModelReasoning, projectModelReasoning } from "./reasoning-effort.ts"

const SESSION_CONFIG = ["x.ai/sessionConfig"] as const

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

function selectOption(options: acp.SessionConfigOption[], category: string, id: string) {
  const found = options.find(option => option.category === category && option.type === "select")
    ?? options.find(option => option.id === id && option.type === "select")
  if (!found || found.type !== "select") return null
  return {
    id: found.id,
    currentValue: found.currentValue,
    options: found.options.flatMap(value => "group" in value ? value.options : [value]).map(value => ({
      id: value.value,
      name: value.name,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    })),
  }
}

function reasoningOption(options: acp.SessionConfigOption[]) {
  const found = findReasoningEffortOption(options)
  if (!found) return null
  return {
    id: found.id,
    currentValue: found.currentValue,
    options: found.options.flatMap(value => "group" in value ? value.options : [value]).map(value => ({
      id: value.value,
      name: value.name,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    })),
  }
}

test("model metadata projects reasoning without turning session config modes into permission modes", () => {
  const projected = projectModelReasoning(undefined, source, undefined, SESSION_CONFIG) ?? []
  assert.equal(selectOption(projected, "mode", "mode"), null)
  assert.equal(selectOption(projected, "model", "model")?.currentValue, "grok-4.5")
  assert.deepEqual(selectOption(projected, "model", "model")?.options.map(option => option.id), ["grok-4.5", "grok-fast"])
  assert.equal(reasoningOption(projected)?.id, "reasoning_effort")
  assert.equal(reasoningOption(projected)?.currentValue, "high")
  assert.deepEqual(reasoningOption(projected)?.options, [
    { id: "low", name: "Low", description: "Faster replies" },
    { id: "high", name: "High" },
  ])
  const empty: acp.SessionConfigOption[] = []
  assert.equal(projectModelReasoning(empty, source, undefined, SESSION_CONFIG), empty)
  assert.equal(projectModelReasoning(undefined, {}), undefined)
  assert.equal(projectModelReasoning(null, source, undefined, SESSION_CONFIG), null)
})

test("an advertised reasoning select is kept, including effort and thinking aliases", () => {
  const advertised: acp.SessionConfigOption[] = [{
    id: "effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: "low",
    options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
  }]
  assert.equal(projectModelReasoning(advertised, source, undefined, SESSION_CONFIG), advertised)
  assert.equal(reasoningOption([{
    id: "effort", name: "Reasoning", type: "select", currentValue: "medium",
    options: [{ value: "medium", name: "Medium" }],
  }])?.id, "effort")
  assert.equal(reasoningOption([{
    id: "thinking_intensity", name: "Thinking", type: "select", currentValue: "high",
    options: [{ value: "high", name: "High" }],
  }])?.currentValue, "high")
  assert.equal(reasoningOption([
    { id: "model", category: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] },
    { id: "fast", category: "model_config", name: "Fast", type: "boolean", currentValue: true },
  ]), null)
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
  const projected = projectModelReasoning(options, source, undefined, SESSION_CONFIG)
  assert.notEqual(projected, options)
  assert.deepEqual(reasoningOption(projected ?? [])?.options.map(option => [option.id, option.name]), [
    ["minimal", "Minimal"], ["max", "Max"],
  ])
  assert.equal(reasoningOption(projected ?? [])?.currentValue, "minimal")
  const denied: acp.SessionConfigOption[] = [{
    id: "model", category: "model", name: "Model", type: "select", currentValue: "grok-fast",
    options: [{ value: "grok-fast", name: "Grok Fast", _meta: { supportsReasoningEffort: false, reasoningEfforts: [] } }],
  }]
  assert.equal(projectModelReasoning(denied, source, undefined, SESSION_CONFIG), denied)
  const placeholder: acp.SessionConfigOption[] = [...options, {
    id: "reasoning_effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: "", options: [],
  }]
  assert.equal(reasoningOption(projectModelReasoning(placeholder, {}) ?? [])?.currentValue, "minimal")
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
  const projected = projectModelReasoning(options, {}) ?? []
  assert.equal(reasoningOption(projected)?.id, "reasoning_effort")
  assert.equal(reasoningOption(projected)?.currentValue, "high")
  assert.deepEqual(reasoningOption(projected)?.options.map(option => option.id), ["low", "high"])
  assert.equal(selectOption(projected, "mode", "mode")?.id, "permission")
  assert.equal(selectOption(projected, "mode", "mode")?.currentValue, "agent")
  assert.equal(new AcpModelReasoning().kind("reasoning_effort", projected), undefined)
})

test("session config reasoning stays distinct from an advertised permission mode", () => {
  const options: acp.SessionConfigOption[] = [
    { id: "model", category: "model", name: "Model", type: "select", currentValue: "grok-4.5", options: [{ value: "grok-4.5", name: "Grok 4.5" }] },
    { id: "permission", category: "mode", name: "Mode", type: "select", currentValue: "agent", options: [{ value: "agent", name: "Agent" }, { value: "plan", name: "Plan" }] },
  ]
  const projected = projectModelReasoning(options, { _meta: source._meta }, undefined, SESSION_CONFIG) ?? []
  assert.equal(selectOption(projected, "mode", "mode")?.currentValue, "agent")
  assert.deepEqual(selectOption(projected, "mode", "mode")?.options.map(option => option.id), ["agent", "plan"])
  assert.deepEqual(reasoningOption(projected)?.options.map(option => option.id), ["xhigh"])
})

test("a model change drops a stored effort override when the new model cannot adjust it", () => {
  const reasoning = new AcpModelReasoning(SESSION_CONFIG)
  reasoning.remember(source)
  const initial: { configOptions?: acp.SessionConfigOption[] | null } = {}
  const first = reasoning.project(initial)
  reasoning.noteEffort("low")
  const second = reasoning.project({ configOptions: first.configOptions })
  assert.equal(reasoningOption(second.configOptions ?? [])?.currentValue, "low")
  const patched = (second.configOptions ?? []).map(option =>
    option.type === "select" && option.category === "model" ? { ...option, currentValue: "grok-fast" } : option)
  const third = reasoning.project({ configOptions: patched })
  assert.equal(selectOption(third.configOptions ?? [], "model", "model")?.currentValue, "grok-fast")
  assert.equal(reasoningOption(third.configOptions ?? []), null)
  assert.equal(selectOption(third.configOptions ?? [], "mode", "mode"), null)
  assert.equal(reasoning.kind("reasoning_effort", second.configOptions ?? undefined), "effort")
  assert.equal(reasoning.kind("model", third.configOptions ?? undefined), "model")
})
