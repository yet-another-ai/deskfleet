import type * as acp from "@agentclientprotocol/sdk/unstable"

export type AcpAvailableCommand = acp.AvailableCommand
export type AcpCreateElicitationRequest = acp.CreateElicitationRequest
export type AcpCreateElicitationResponse = acp.CreateElicitationResponse

export interface AgentAuthStatus {
  kind: "account" | "api_key" | "gateway" | "external" | "none"
  label: string
  detail?: string
  account?: { email?: string; organization?: string; plan?: string }
}

/** One remaining quota bucket reported by a provider CLI or API. */
export interface AgentQuotaItem {
  id: string
  label: string
  group?: string
  remaining: number
  resetsAt?: string
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

/** Classifies a provider-advertised ACP command as a skill when provider metadata or spelling confirms it. */
export type AgentComposerSkillParser = (command: acp.AvailableCommand) => AgentComposerSkill | undefined

export interface AgentProviderTemplateMetadata<Id extends string = string> {
  id: Id
  name: string
  defaultBinaryPath: string
  supportsUsage?: boolean
}

export interface ProviderWorkspaceCandidate {
  name: string
  path: string
  source: string
}

/** Existing project directories discovered on the configured provider's machine. */
export interface ProviderWorkspaceDiscovery {
  supported: boolean
  candidates: ProviderWorkspaceCandidate[]
  warnings: string[]
}

/** Executable discovery and read-only credential status, independent of ACP sessions. */
export interface ProviderProbeResult {
  status: "found" | "missing" | "invalid"
  binaryPath?: string
  version?: string
  message?: string
  auth: "authenticated" | "unauthenticated" | "unknown"
  installable: boolean
  loginAvailable: boolean
  installMessage?: string
}

export interface McpServerSettings {
  name: string
  enabled: boolean
}

export type McpServerInput = McpServerSettings & (
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http" | "sse"; url: string; headers: Record<string, string> }
)

export interface ProviderMcpServerCandidate {
  id: string
  name: string
  source: string
  scope: "user" | "project"
  projectPath?: string
  /** Exactly one of server and unsupportedReason is present. */
  server?: McpServerInput
  unsupportedReason?: string
}

export interface ProviderMcpServerDiscovery {
  supported: boolean
  candidates: ProviderMcpServerCandidate[]
  warnings: string[]
}

/** Select ids agents use for reasoning effort when they omit `thought_level`. */
export const REASONING_CONFIG_IDS = ["reasoning_effort", "effort", "thinking_intensity", "thinking_level"] as const

export function selectChoiceValues(option: acp.SessionConfigOption & { type: "select" }): Array<{ value: string; name: string; description?: string | null }> {
  return option.options.flatMap(value => "group" in value ? value.options : [value])
}

/** Finds a usable reasoning select option with at least one choice. */
export function findReasoningEffortOption(options: acp.SessionConfigOption[]): (acp.SessionConfigOption & { type: "select" }) | undefined {
  const usable = options.filter((option): option is acp.SessionConfigOption & { type: "select" } =>
    option.type === "select" && selectChoiceValues(option).length > 0)
  return usable.find(option => option.category === "thought_level")
    ?? REASONING_CONFIG_IDS.map(id => usable.find(option => option.id === id)).find(option => option !== undefined)
}
