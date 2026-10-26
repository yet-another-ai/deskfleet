import type * as acp from "@agentclientprotocol/sdk/unstable"
import { validateProviderId } from "./provider-protocol.ts"

export interface AgentChoice {
  id: string
  name: string
  description?: string
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
  modes: AgentConfigOption | null
}

export interface AgentConfigurationSelection {
  model?: string
  reasoningEffort?: string
  mode?: string
}

export interface AgentConfigurationParams extends AgentConfigurationSelection {
  provider: string
  workspaceId?: string
  /** One draft composer's temporary ACP session; scoped to the verified caller. */
  probeId?: string
  /** Last confirmed draft choices, applied only when its temporary session must reopen. */
  restore?: AgentConfigurationSelection
  /** Close a draft probe without looking up its possibly deleted provider/workspace. */
  release?: boolean
}

export function validateAgentConfigurationParams(params: Record<string, unknown>): void {
  validateProviderId(params.provider)
  if (params.probeId !== undefined && (typeof params.probeId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(params.probeId))) {
    throw new Error("Invalid Agent configuration probe ID")
  }
  if (params.release !== undefined && typeof params.release !== "boolean") throw new Error("Invalid Agent configuration release")
  if (params.release && !params.probeId) throw new Error("Agent configuration release requires a probe ID")
  if (params.restore !== undefined) {
    if (!params.probeId || !params.restore || typeof params.restore !== "object" || Array.isArray(params.restore)) {
      throw new Error("Invalid Agent configuration restore selection")
    }
    validateAgentConfigurationSelection(params.restore as Record<string, unknown>)
  }
  if (params.workspaceId !== undefined && (typeof params.workspaceId !== "string"
    || !/^[1-9][0-9]{0,18}$/u.test(params.workspaceId) || BigInt(params.workspaceId) > 9_223_372_036_854_775_807n)) {
    throw new Error("Invalid catalog workspace ID")
  }
  validateAgentConfigurationSelection(params)
}

export function validateAgentConfigurationSelection(params: Record<string, unknown>): void {
  for (const key of ["model", "reasoningEffort", "mode"]) {
    const value = params[key]
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 256 || value.includes("\0"))) {
      throw new Error(`Invalid agent ${key}`)
    }
  }
}

/** Select ids agents use for reasoning effort when they omit `thought_level`. */
export const REASONING_CONFIG_IDS = ["reasoning_effort", "effort", "thinking_intensity", "thinking_level"] as const

function selectChoices(option: acp.SessionConfigOption & { type: "select" }): Array<{ value: string; name: string; description?: string | null }> {
  return option.options.flatMap(value => "group" in value ? value.options : [value])
}

function toAgentOption(option: acp.SessionConfigOption & { type: "select" }): AgentConfigOption {
  return {
    id: option.id,
    currentValue: option.currentValue,
    options: selectChoices(option).map(value => ({ id: value.value, name: value.name,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    })),
  }
}

export function selectAgentOption(options: acp.SessionConfigOption[], category: string, id: string): AgentConfigOption | null {
  const option = options.find(option => option.category === category && option.type === "select")
    ?? options.find(option => option.id === id && option.type === "select")
  if (!option || option.type !== "select") return null
  return toAgentOption(option)
}

/** A reasoning control with at least one choice. Empty placeholders do not hide model metadata. */
export function selectReasoningEffort(options: acp.SessionConfigOption[]): AgentConfigOption | null {
  const usable = options.filter((option): option is acp.SessionConfigOption & { type: "select" } =>
    option.type === "select" && selectChoices(option).length > 0)
  const option = usable.find(option => option.category === "thought_level")
    ?? REASONING_CONFIG_IDS.map(id => usable.find(option => option.id === id)).find(option => option !== undefined)
  return option ? toAgentOption(option) : null
}

export function agentConfiguration(options: acp.SessionConfigOption[], provider: AgentChoice = { id: "codex", name: "Codex" }): AgentConfiguration {
  return {
    provider,
    models: selectAgentOption(options, "model", "model"),
    reasoningEfforts: selectReasoningEffort(options),
    modes: selectAgentOption(options, "mode", "mode"),
  }
}
