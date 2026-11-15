import { agentConfigurationSelection, normalizeAgentConfigurationSelection, type AgentConfiguration, type AgentConfigurationMatrix, type AgentConfigurationSelection, type AgentConfigurationSnapshot } from "./agent-configuration-protocol.ts"

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

/** Include dependent catalogs, not just selected values. Commands do not define config state. */
export function agentConfigurationIdentity(configuration: AgentConfigurationSnapshot): string {
  return canonical([configuration.provider.id, configuration.models, configuration.reasoningEfforts,
    configuration.modes, configuration.configOptions])
}

/** Follow only provider-confirmed edges; missing or dynamic combinations require discovery. */
export function cachedAgentConfiguration(
  matrix: AgentConfigurationMatrix, current: AgentConfiguration | undefined, selection: AgentConfigurationSelection,
): AgentConfigurationSnapshot | undefined {
  let configuration = current ?? matrix.configurations[0]
  if (!configuration) return undefined
  let normalized: AgentConfigurationSelection
  try { normalized = normalizeAgentConfigurationSelection(selection, configuration.configOptions ?? []) }
  catch { return undefined }
  const steps: AgentConfigurationSelection[] = []
  for (const key of ["model", "reasoningEffort", "mode"] as const) {
    if (normalized[key] !== undefined) steps.push({ [key]: normalized[key] })
  }
  for (const [id, value] of Object.entries(normalized.configValues ?? {})) steps.push({ configValues: { [id]: value } })
  for (const step of steps) {
    for (const key of ["model", "reasoningEffort", "mode"] as const) {
      if (step[key] === undefined) continue
      const option = key === "model" ? configuration.models : key === "reasoningEffort" ? configuration.reasoningEfforts : configuration.modes
      if (!option?.options.some(choice => choice.id === step[key])) return undefined
    }
    for (const [id, value] of Object.entries(step.configValues ?? {})) {
      const option = configuration.configOptions?.find(option => option.id === id)
      if (!option || (option.type === "boolean" ? typeof value !== "boolean"
        : !option.options.flatMap(row => "group" in row ? row.options : [row]).some(choice => choice.value === value))) return undefined
    }
    const selected = agentConfigurationSelection(configuration)
    const unchanged = Object.entries(step).every(([key, value]) => key === "configValues"
      ? Object.entries(value as Record<string, string | boolean>).every(([id, choice]) => selected.configValues?.[id] === choice)
      : selected[key as "model" | "reasoningEffort" | "mode"] === value)
    if (unchanged) continue
    const identity = agentConfigurationIdentity(configuration)
    const from = matrix.configurations.findIndex(value => agentConfigurationIdentity(value) === identity)
    if (from < 0) return undefined
    const transition = matrix.transitions.find(value => value.from === from && canonical(value.selection) === canonical(step))
    const next = transition && matrix.configurations[transition.to]
    if (!next) return undefined
    configuration = next
  }
  const snapshot: AgentConfiguration = { ...configuration }
  delete snapshot.matrix
  return structuredClone(snapshot)
}
