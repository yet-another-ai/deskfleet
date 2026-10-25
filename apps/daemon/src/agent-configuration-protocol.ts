import type * as acp from "@agentclientprotocol/sdk"
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

export function selectAgentOption(options: acp.SessionConfigOption[], category: string, id: string): AgentConfigOption | null {
  const option = options.find(option => option.category === category && option.type === "select")
    ?? options.find(option => option.id === id && option.type === "select")
  if (!option || option.type !== "select") return null
  return {
    id: option.id,
    currentValue: option.currentValue,
    options: option.options.flatMap(value => "group" in value ? value.options : [value])
      .map(value => ({ id: value.value, name: value.name,
        ...(typeof value.description === "string" ? { description: value.description } : {}),
      })),
  }
}

export function agentConfiguration(options: acp.SessionConfigOption[], provider: AgentChoice = { id: "codex", name: "Codex" }): AgentConfiguration {
  return {
    provider,
    models: selectAgentOption(options, "model", "model"),
    reasoningEfforts: selectAgentOption(options, "thought_level", "reasoning_effort"),
    modes: selectAgentOption(options, "mode", "mode"),
  }
}
