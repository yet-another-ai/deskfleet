import type * as acp from "@agentclientprotocol/sdk/unstable"
import { REASONING_CONFIG_IDS, selectReasoningEffort } from "../agent-configuration-protocol.ts"

const MODEL_REASONING = "deskfleet/modelReasoningEffort"
const SESSION_CONFIG_MODEL = "deskfleet/sessionConfigModel"
const SESSION_CONFIG = "x.ai/sessionConfig"
const EFFORT_LIST_KEYS = ["reasoningEfforts", "thinkingIntensities", "thinkingLevels"] as const
const CURRENT_KEYS = ["reasoningEffort", "thinkingIntensity", "thinkingLevel"] as const
const SUPPORT_KEYS = ["supportsReasoningEffort", "supportsThinkingIntensity"] as const

interface EffortChoice {
  id: string
  name: string
  description?: string
  isDefault: boolean
}

interface EffortLevels {
  choices: EffortChoice[]
  current?: string
  name: string
}

type EffortResolution = EffortLevels | "unsupported" | undefined

interface CatalogModel {
  id: string
  name: string
  description?: string
  meta?: Record<string, unknown>
}

interface ReasoningSource {
  models?: unknown
  _meta?: { [key: string]: unknown } | null
}

type SelectOption = acp.SessionConfigOption & { type: "select" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isReasoningId(id: string): boolean {
  return (REASONING_CONFIG_IDS as readonly string[]).includes(id)
}

function selectValues(option: SelectOption): acp.SessionConfigSelectOption[] {
  return option.options.flatMap(value => "group" in value ? value.options : [value])
}

function modelSelect(options: acp.SessionConfigOption[] | undefined): SelectOption | undefined {
  return options?.find((option): option is SelectOption =>
    option.type === "select" && (option.category === "model" || option.id === "model"))
}

function choiceFromUnknown(value: unknown): EffortChoice | undefined {
  if (!isRecord(value)) return undefined
  const id = typeof value.id === "string" && value.id ? value.id
    : typeof value.value === "string" && value.value ? value.value : undefined
  if (!id) return undefined
  const name = typeof value.label === "string" && value.label ? value.label
    : typeof value.name === "string" && value.name ? value.name : id
  const description = typeof value.description === "string" ? value.description : undefined
  return { id, name, ...(description ? { description } : {}), isDefault: value.default === true }
}

function currentFromMeta(meta: Record<string, unknown>, choices: EffortChoice[]): string | undefined {
  for (const key of CURRENT_KEYS) {
    const value = meta[key]
    if (typeof value === "string" && choices.some(choice => choice.id === value)) return value
    if (!isRecord(value)) continue
    const id = typeof value.id === "string" ? value.id : typeof value.value === "string" ? value.value : undefined
    if (id && choices.some(choice => choice.id === id)) return id
  }
  return undefined
}

function effortsFromMeta(meta: Record<string, unknown> | undefined): EffortResolution {
  if (!meta) return undefined
  const support = SUPPORT_KEYS.map(key => meta[key]).find((value): value is boolean => typeof value === "boolean")
  const list = EFFORT_LIST_KEYS.map(key => meta[key]).find((value): value is unknown[] => Array.isArray(value))
  if (support === false || (list !== undefined && list.length === 0)) return "unsupported"
  if (!list) return undefined
  const choices = list.flatMap(value => {
    const choice = choiceFromUnknown(value)
    return choice ? [choice] : []
  })
  if (choices.length === 0) return "unsupported"
  return { choices, current: currentFromMeta(meta, choices), name: "Reasoning" }
}

function modelMeta(model: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = isRecord(model._meta) ? model._meta : undefined
  const picked: Record<string, unknown> = {}
  for (const key of [...SUPPORT_KEYS, ...EFFORT_LIST_KEYS, ...CURRENT_KEYS]) {
    if (nested && key in nested) picked[key] = nested[key]
    else if (key in model) picked[key] = model[key]
  }
  return Object.keys(picked).length > 0 ? picked : undefined
}

function catalog(source: ReasoningSource): { current?: string; models: CatalogModel[] } {
  const advertised = isRecord(source.models) ? source.models : isRecord(source._meta?.models) ? source._meta.models : undefined
  if (!advertised || !Array.isArray(advertised.availableModels)) return { models: [] }
  const current = typeof advertised.currentModelId === "string" ? advertised.currentModelId : undefined
  const models = advertised.availableModels.flatMap(model => {
    if (!isRecord(model)) return []
    const id = typeof model.modelId === "string" ? model.modelId : typeof model.id === "string" ? model.id : undefined
    if (!id) return []
    const name = typeof model.name === "string" && model.name ? model.name : id
    const description = typeof model.description === "string" ? model.description : undefined
    const meta = modelMeta(model)
    return [{ id, name, ...(description ? { description } : {}), ...(meta ? { meta } : {}) }]
  })
  return { current, models }
}

function asSelect(value: unknown): SelectOption | undefined {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "select")) return undefined
  if (typeof value.id !== "string" || typeof value.name !== "string" || !Array.isArray(value.options)) return undefined
  const options = value.options.flatMap(choice => {
    if (!isRecord(choice) || typeof choice.value !== "string" || typeof choice.name !== "string") return []
    const description = typeof choice.description === "string" ? choice.description : undefined
    const meta = isRecord(choice._meta) ? choice._meta : undefined
    return [{ value: choice.value, name: choice.name, ...(description ? { description } : {}), ...(meta ? { _meta: meta } : {}) }]
  })
  const currentValue = typeof value.currentValue === "string" ? value.currentValue : options[0]?.value ?? ""
  const category = typeof value.category === "string" ? value.category : undefined
  return {
    id: value.id, name: value.name, type: "select", currentValue, options,
    ...(category ? { category } : {}),
  }
}

function sessionSelects(source: ReasoningSource): SelectOption[] {
  const config = source._meta?.[SESSION_CONFIG]
  if (!isRecord(config) || !Array.isArray(config.options)) return []
  return config.options.flatMap(option => {
    const select = asSelect(option)
    return select ? [select] : []
  })
}

function sessionEffort(source: ReasoningSource): SelectOption | undefined {
  const selects = sessionSelects(source).filter(option => option.category !== "model" && option.id !== "model")
  return selects.find(option => option.category === "thought_level")
    ?? selects.find(option => isReasoningId(option.id))
    ?? selects.find(option => option.category === "mode")
}

function effortsFromSelect(option: SelectOption): EffortResolution {
  const choices = selectValues(option).map(choice => ({
    id: choice.value,
    name: choice.name,
    ...(typeof choice.description === "string" ? { description: choice.description } : {}),
    isDefault: false,
  }))
  if (choices.length === 0) return "unsupported"
  const current = choices.some(choice => choice.id === option.currentValue) ? option.currentValue : undefined
  return { choices, current, name: option.name || "Reasoning" }
}

function selectedEffort(levels: EffortLevels, override?: string): string {
  if (override && levels.choices.some(choice => choice.id === override)) return override
  if (levels.current && levels.choices.some(choice => choice.id === levels.current)) return levels.current
  return levels.choices.find(choice => choice.isDefault)?.id ?? levels.choices[0]!.id
}

function reasoningOption(id: string, levels: EffortLevels, override?: string): SelectOption {
  return {
    id: isReasoningId(id) ? id : "reasoning_effort",
    name: levels.name || "Reasoning",
    category: "thought_level", type: "select",
    currentValue: selectedEffort(levels, override),
    options: levels.choices.map(choice => ({
      value: choice.id, name: choice.name,
      ...(choice.description ? { description: choice.description } : {}),
    })),
    _meta: { [MODEL_REASONING]: true },
  }
}

function synthesizeModel(source: ReasoningSource): SelectOption | undefined {
  const advertised = sessionSelects(source).find(option => option.category === "model" || option.id === "model")
  if (advertised && selectValues(advertised).length > 0) {
    return { ...advertised, id: "model", category: "model", _meta: { ...advertised._meta, [SESSION_CONFIG_MODEL]: true } }
  }
  const available = catalog(source)
  if (available.models.length === 0) return undefined
  const current = available.current && available.models.some(model => model.id === available.current)
    ? available.current : available.models[0]!.id
  return {
    id: "model", name: "Model", category: "model", type: "select", currentValue: current,
    options: available.models.map(model => ({
      value: model.id, name: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.meta ? { _meta: model.meta } : {}),
    })),
    _meta: { [SESSION_CONFIG_MODEL]: true },
  }
}

function resolveEfforts(options: acp.SessionConfigOption[], source: ReasoningSource, override?: string): SelectOption | undefined {
  const model = modelSelect(options)
  const selected = model ? selectValues(model).find(choice => choice.value === model.currentValue) : undefined
  const fromChoice = effortsFromMeta(selected?._meta ?? undefined)
  if (fromChoice === "unsupported") return undefined
  if (fromChoice) return reasoningOption("reasoning_effort", fromChoice, override)
  const selectedId = model?.currentValue || catalog(source).current
  const fromCatalog = effortsFromMeta(catalog(source).models.find(entry => entry.id === selectedId)?.meta)
  if (fromCatalog === "unsupported") return undefined
  if (fromCatalog) return reasoningOption("reasoning_effort", fromCatalog, override)
  const session = sessionEffort(source)
  if (!session) return undefined
  const fromSession = effortsFromSelect(session)
  if (fromSession === "unsupported" || !fromSession) return undefined
  return reasoningOption(session.id, fromSession, override)
}

function isEmptyReasoning(option: acp.SessionConfigOption): boolean {
  return option.type === "select"
    && (option.category === "thought_level" || isReasoningId(option.id))
    && selectValues(option).length === 0
}

function withoutEmptyReasoning(options: acp.SessionConfigOption[]): acp.SessionConfigOption[] {
  return options.some(isEmptyReasoning) ? options.filter(option => !isEmptyReasoning(option)) : options
}

function stripProjectedReasoning(options: acp.SessionConfigOption[]): acp.SessionConfigOption[] {
  return options.some(option => option._meta?.[MODEL_REASONING] === true)
    ? options.filter(option => option._meta?.[MODEL_REASONING] !== true)
    : options
}

function sameOptions(left: acp.SessionConfigOption[], right: acp.SessionConfigOption[]): boolean {
  return left.length === right.length && left.every((option, index) => option === right[index])
}

/** Reasoning ids advertised under category `mode` are effort levels, not permission modes. */
function presentReasoningCategory(options: acp.SessionConfigOption[]): acp.SessionConfigOption[] {
  if (!options.some(option => option.type === "select" && option.category === "mode" && isReasoningId(option.id) && selectValues(option).length > 0)) {
    return options
  }
  return options.map(option => option.type === "select" && option.category === "mode" && isReasoningId(option.id) && selectValues(option).length > 0
    ? { ...option, category: "thought_level" } : option)
}

/**
 * Projects model-scoped reasoning into a `thought_level` select.
 * An explicit empty option list stays empty. A usable advertised select is unchanged.
 */
export function projectModelReasoning(
  options: acp.SessionConfigOption[] | null | undefined,
  source: ReasoningSource = {},
  effortOverride?: string,
): acp.SessionConfigOption[] | null | undefined {
  if (options === null) return null
  if (options && options.length === 0) return options
  const stripped = options ? presentReasoningCategory(withoutEmptyReasoning(stripProjectedReasoning(options))) : undefined
  if (stripped && selectReasoningEffort(stripped)) return sameOptions(stripped, options!) ? options : stripped
  let next = stripped
  if (!modelSelect(next)) {
    if (options !== undefined) return sameOptions(next ?? [], options) ? options : next
    const synthesized = synthesizeModel(source)
    if (!synthesized) return options
    next = [synthesized]
  }
  const effort = resolveEfforts(next!, source, effortOverride)
  if (effort) next = [...next!, effort]
  if (options && next && sameOptions(next, options)) return options
  return next
}

function modelIdOf(options: acp.SessionConfigOption[] | null | undefined): string | undefined {
  const current = modelSelect(options ?? undefined)?.currentValue
  return current || undefined
}

/** Remembers model catalogs that older agents omit from config options and reapplies them. */
export class AcpModelReasoning {
  #models: unknown
  #meta: { [key: string]: unknown } | undefined
  #effortOverride: string | undefined
  #modelId: string | undefined
  #projected: acp.SessionConfigOption[] | undefined

  remember(response: unknown): void {
    if (!isRecord(response)) return
    if ("models" in response) this.#models = response.models
    if (isRecord(response._meta)) this.#meta = response._meta
  }

  noteEffort(value: string): void {
    this.#effortOverride = value
  }

  listed(knownOptions?: acp.SessionConfigOption[]): acp.SessionConfigOption[] | undefined {
    return knownOptions ?? this.#projected
  }

  /** `effort` uses `session/set_mode`; `model` uses `session/set_model`. */
  kind(configId: string, knownOptions?: acp.SessionConfigOption[]): "effort" | "model" | undefined {
    const option = this.listed(knownOptions)?.find(option => option.id === configId)
    if (option?._meta?.[MODEL_REASONING] === true) return "effort"
    if (option?._meta?.[SESSION_CONFIG_MODEL] === true) return "model"
    return undefined
  }

  project<T extends { configOptions?: acp.SessionConfigOption[] | null }>(response: T): T {
    const source = { models: this.#models, _meta: this.#meta }
    let projected = projectModelReasoning(response.configOptions, source, this.#effortOverride)
    let modelId = modelIdOf(Array.isArray(projected) ? projected : undefined)
    if (modelId && this.#modelId && modelId !== this.#modelId && this.#effortOverride !== undefined) {
      this.#effortOverride = undefined
      projected = projectModelReasoning(response.configOptions, source)
      modelId = modelIdOf(Array.isArray(projected) ? projected : undefined) ?? modelId
    }
    if (modelId) this.#modelId = modelId
    if (Array.isArray(projected)) this.#projected = projected
    if (projected === response.configOptions) return response
    return { ...response, configOptions: projected }
  }
}
