import type * as acp from "@agentclientprotocol/sdk"
import { validateProviderId } from "./provider-protocol.ts"

export interface AgentChoice {
  id: string
  name: string
}

export interface AgentConfigOption {
  id: string
  currentValue: string
  options: AgentChoice[]
}

/** Configuration reported by the installed agent for a draft or live Session. */
export interface AgentConfiguration {
  provider: AgentChoice
  models: AgentConfigOption | null
  reasoningEfforts: AgentConfigOption | null
}

export interface AgentConfigurationSelection {
  model?: string
  reasoningEffort?: string
}

export interface AgentConfigurationParams extends AgentConfigurationSelection {
  provider: string
  workspaceId?: string
}

export function validateAgentConfigurationParams(params: Record<string, unknown>): void {
  validateProviderId(params.provider)
  if (params.workspaceId !== undefined && (typeof params.workspaceId !== "string"
    || !/^[1-9][0-9]{0,18}$/u.test(params.workspaceId) || BigInt(params.workspaceId) > 9_223_372_036_854_775_807n)) {
    throw new Error("Invalid catalog workspace ID")
  }
  validateAgentConfigurationSelection(params)
}

export function validateAgentConfigurationSelection(params: Record<string, unknown>): void {
  for (const key of ["model", "reasoningEffort"]) {
    const value = params[key]
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 256 || value.includes("\0"))) {
      throw new Error(`Invalid agent ${key}`)
    }
  }
}

export function selectAgentOption(options: acp.SessionConfigOption[], category: string, id: string): AgentConfigOption | null {
  const option = options.find(option => option.category === category && option.type === "select")
    ?? options.find(option => option.id === id && option.type === "select")
  if (!option || option.type !== "select") return null
  return {
    id: option.id,
    currentValue: option.currentValue,
    options: option.options.flatMap(value => "group" in value ? value.options : [value])
      .map(value => ({ id: value.value, name: value.name })),
  }
}

export function agentConfiguration(options: acp.SessionConfigOption[], provider: AgentChoice = { id: "codex", name: "Codex" }): AgentConfiguration {
  return {
    provider,
    models: selectAgentOption(options, "model", "model"),
    reasoningEfforts: selectAgentOption(options, "thought_level", "reasoning_effort"),
  }
}
