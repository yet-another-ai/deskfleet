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

export interface AgentPromptCapabilities {
  image?: boolean
  embeddedContext?: boolean
}

export interface AgentComposerCommand {
  name: string
  description: string
  inputHint?: string
}

export interface AgentComposerSkill {
  id: string
  name: string
  description: string
  /** The spelling understood by the selected provider, including its prefix. */
  invocation: string
}

export interface AgentComposerCatalog {
  commands: AgentComposerCommand[]
  skills: AgentComposerSkill[]
}

/** One remaining quota bucket reported by a provider CLI or API. */
export interface AgentQuotaItem {
  id: string
  label: string
  group?: string
  remaining: number
  resetsAt?: string
}

/** Configuration reported by the installed agent for a draft or live Session. */
export interface AgentConfiguration {
  provider: AgentChoice
  models: AgentConfigOption | null
  reasoningEfforts: AgentConfigOption | null
  modes: AgentConfigOption | null
  /** Complete provider catalog, including options outside the three common selectors. */
  configOptions?: acp.SessionConfigOption[]
  promptCapabilities?: AgentPromptCapabilities
  commands?: AgentComposerCommand[]
  skills?: AgentComposerSkill[]
}

export interface AgentConfigurationSelection {
  model?: string
  reasoningEffort?: string
  mode?: string
  configValues?: Record<string, string | boolean>
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
  /** Wait briefly for the provider's initial command notification. */
  composer?: boolean
}

export function validateAgentConfigurationParams(params: Record<string, unknown>): void {
  validateProviderId(params.provider)
  if (params.probeId !== undefined && (typeof params.probeId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(params.probeId))) {
    throw new Error("Invalid Agent configuration probe ID")
  }
  if (params.release !== undefined && typeof params.release !== "boolean") throw new Error("Invalid Agent configuration release")
  if (params.composer !== undefined && typeof params.composer !== "boolean") throw new Error("Invalid Agent composer discovery")
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
  if (params.configValues !== undefined) {
    if (!params.configValues || typeof params.configValues !== "object" || Array.isArray(params.configValues)) throw new Error("Invalid agent configuration values")
    for (const [id, value] of Object.entries(params.configValues)) {
      if (!id || id.length > 256 || id.includes("\0") || typeof value !== "boolean" && (typeof value !== "string" || !value || value.length > 256 || value.includes("\0"))) {
        throw new Error("Invalid agent configuration value")
      }
    }
  }
}

/** Retain provider selections without duplicating the common controls by config ID. */
export function agentConfigurationSelection(configuration: AgentConfiguration): AgentConfigurationSelection {
  const primary = new Set([configuration.models?.id, configuration.reasoningEfforts?.id, configuration.modes?.id])
  const entries = (configuration.configOptions ?? []).filter(option => !primary.has(option.id))
    .map(option => [option.id, option.currentValue] as const)
  return {
    model: configuration.models?.currentValue,
    reasoningEffort: configuration.reasoningEfforts?.currentValue,
    mode: configuration.modes?.currentValue,
    ...(entries.length ? { configValues: Object.fromEntries(entries) } : {}),
  }
}

/** Treat a common control addressed by config ID like the same explicit alias edit. */
export function normalizeAgentConfigurationSelection(selection: AgentConfigurationSelection, options: acp.SessionConfigOption[]): AgentConfigurationSelection {
  if (!selection.configValues) return selection
  const configuration = agentConfiguration(options)
  const configValues = { ...selection.configValues }
  const normalized = { ...selection, configValues }
  for (const [key, option] of [
    ["model", configuration.models], ["reasoningEffort", configuration.reasoningEfforts], ["mode", configuration.modes],
  ] as const) {
    if (!option || !Object.hasOwn(configValues, option.id)) continue
    if (selection[key] !== undefined) throw new Error(`Agent configuration specified twice: ${option.id}`)
    const value = configValues[option.id]
    if (typeof value !== "string") throw new Error(`Unsupported agent configuration: ${option.id}`)
    normalized[key] = value
    delete configValues[option.id]
  }
  return normalized
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

export function agentPromptCapabilities(capabilities?: acp.PromptCapabilities | null): AgentPromptCapabilities | undefined {
  if (!capabilities) return undefined
  const result: AgentPromptCapabilities = {
    ...(typeof capabilities.image === "boolean" ? { image: capabilities.image } : {}),
    ...(typeof capabilities.embeddedContext === "boolean" ? { embeddedContext: capabilities.embeddedContext } : {}),
  }
  return Object.keys(result).length ? result : undefined
}

/** Only adapter-defined spellings or explicit skill metadata identify a skill. */
export function agentComposerCatalog(available: acp.AvailableCommand[], providerKind: string): AgentComposerCatalog {
  const commands: AgentComposerCommand[] = []
  const skills: AgentComposerSkill[] = []
  const seen = new Set<string>()
  for (const command of available) {
    if (!command.name || seen.has(command.name)) continue
    seen.add(command.name)
    const { name, description } = command
    // codex-acp advertises skills with a literal "$" prefix; Pi and Oh My Pi
    // advertise "skill:" commands.
    if (providerKind === "codex" && name.startsWith("$") && name.length > 1) {
      skills.push({ id: name, name: name.slice(1), description, invocation: name })
    } else if ((providerKind === "pi" || providerKind === "omp") && name.startsWith("skill:") && name.length > 6) {
      skills.push({ id: name, name: name.slice(6), description, invocation: `/${name}` })
    } else {
      const jetbrains = command._meta?.jetbrains
      const air = typeof jetbrains === "object" && jetbrains !== null && "air" in jetbrains ? jetbrains.air : undefined
      const confirmedClaudeSkill = providerKind === "claude-code" && typeof air === "object" && air !== null
        && "kind" in air && air.kind === "skill" && "skillPath" in air && typeof air.skillPath === "string"
      if (confirmedClaudeSkill) skills.push({ id: name, name, description, invocation: `/${name}` })
      else commands.push({ name, description, ...(command.input?.hint ? { inputHint: command.input.hint } : {}) })
    }
  }
  return { commands, skills }
}

export function agentConfiguration(
  options: acp.SessionConfigOption[],
  provider: AgentChoice = { id: "codex", name: "Codex" },
  promptCapabilities?: AgentPromptCapabilities,
  composer?: AgentComposerCatalog,
): AgentConfiguration {
  return {
    provider,
    models: selectAgentOption(options, "model", "model"),
    reasoningEfforts: selectReasoningEffort(options),
    modes: selectAgentOption(options, "mode", "mode"),
    configOptions: options,
    ...(promptCapabilities ? { promptCapabilities } : {}),
    ...composer,
  }
}
