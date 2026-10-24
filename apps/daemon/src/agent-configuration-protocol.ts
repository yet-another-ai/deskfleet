export interface AgentChoice {
  id: string
  name: string
}

export interface AgentConfigOption {
  id: string
  currentValue: string
  options: AgentChoice[]
}

/** Configuration for a draft, discovered from the installed agent. */
export interface AgentConfiguration {
  provider: AgentChoice
  models: AgentConfigOption | null
  reasoningEfforts: AgentConfigOption | null
}

export interface AgentConfigurationParams {
  provider: string
  worktreeId?: string
  model?: string
  reasoningEffort?: string
}

export function validateAgentConfigurationParams(params: Record<string, unknown>): void {
  if (params.provider !== "codex") throw new Error("Unsupported agent provider")
  if (params.worktreeId !== undefined && (typeof params.worktreeId !== "string"
    || !/^[1-9][0-9]{0,18}$/u.test(params.worktreeId) || BigInt(params.worktreeId) > 9_223_372_036_854_775_807n)) {
    throw new Error("Invalid catalog worktree ID")
  }
  for (const key of ["model", "reasoningEffort"]) {
    const value = params[key]
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 256 || value.includes("\0"))) {
      throw new Error(`Invalid agent ${key}`)
    }
  }
}
