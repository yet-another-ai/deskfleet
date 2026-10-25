export type AgentProviderTemplateId = "codex" | "claude-code" | "cursor" | "grok" | "acp"

export interface AgentProviderTemplate {
  id: AgentProviderTemplateId
  name: string
  defaultBinaryPath: string
}

export interface AgentProviderSettings {
  name: string
  /** Optional bundled icon slug; omission uses the template's default icon. */
  icon?: string
  binaryPath?: string
  env: Record<string, string>
}

export interface AgentProviderInput extends AgentProviderSettings {
  template: AgentProviderTemplateId
}

export interface AgentProviderConfig extends AgentProviderInput {
  id: string
}

export interface ProviderSnapshot {
  /** Opaque settings revision; contains no launch settings or credential-derived data. */
  revision: string
  templates: AgentProviderTemplate[]
  providers: AgentProviderConfig[]
}

export interface ProviderTestResult {
  /** The ACP agent's reported title or name; bundled bridges report themselves. */
  agentName: string
}

/** Bounds a provider test below the local control client's request timeout. */
export const PROVIDER_TEST_TIMEOUT_MS = 30_000

export interface ProviderMethods {
  providerList: { params: Record<string, never>; result: ProviderSnapshot }
  providerCreate: { params: { provider: AgentProviderInput }; result: AgentProviderConfig }
  providerUpdate: { params: { providerId: string; changes: AgentProviderSettings }; result: AgentProviderConfig }
  providerRemove: { params: { providerId: string }; result: null }
  providerTest: { params: { provider: AgentProviderInput }; result: ProviderTestResult }
}

export type ProviderEvent = { kind: "providersChanged" }

export const AGENT_PROVIDER_TEMPLATES: readonly AgentProviderTemplate[] = [
  { id: "codex", name: "Codex", defaultBinaryPath: "codex" },
  { id: "claude-code", name: "Claude Code", defaultBinaryPath: "claude" },
  { id: "cursor", name: "Cursor", defaultBinaryPath: "agent" },
  { id: "grok", name: "Grok", defaultBinaryPath: "grok" },
  { id: "acp", name: "ACP", defaultBinaryPath: "acp-agent" },
]

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected provider settings")
  return value as Record<string, unknown>
}

export function validateProviderId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("Invalid provider ID")
}

/** Normalize blank binary paths to the template default at the execution boundary. */
export function providerSettings(value: unknown): AgentProviderSettings {
  const settings = object(value)
  if (Object.keys(settings).some(key => !["name", "icon", "binaryPath", "env"].includes(key))) {
    throw new Error("Only provider settings can be edited; the template is fixed")
  }
  if (typeof settings.name !== "string" || !settings.name.trim() || settings.name.length > 256 || settings.name.includes("\0")) {
    throw new Error("Provider names must contain between 1 and 256 characters")
  }
  if (settings.icon !== undefined && (typeof settings.icon !== "string" || settings.icon.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(settings.icon))) {
    throw new Error("Invalid provider icon")
  }
  if (settings.binaryPath !== undefined && (typeof settings.binaryPath !== "string" || settings.binaryPath.length > 4096 || settings.binaryPath.includes("\0"))) {
    throw new Error("Invalid provider binary path")
  }
  const env = object(settings.env)
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error("Invalid environment variable name")
    if (typeof value !== "string" || value.includes("\0")) throw new Error("Environment variable values must be strings without null characters")
  }
  const binaryPath = settings.binaryPath?.trim() as string | undefined
  return {
    name: settings.name.trim(),
    ...(settings.icon !== undefined ? { icon: settings.icon } : {}),
    ...(binaryPath ? { binaryPath } : {}),
    env: Object.fromEntries(Object.entries(env)) as Record<string, string>,
  }
}

export function providerInput(value: unknown): AgentProviderInput {
  const { template, ...settings } = object(value)
  const known = AGENT_PROVIDER_TEMPLATES.find(known => known.id === template)
  if (!known) throw new Error("Unknown Agent provider template")
  return { ...providerSettings(settings), template: known.id }
}

export function validateProviderParams(method: keyof ProviderMethods, params: Record<string, unknown>): void {
  if (method === "providerUpdate" || method === "providerRemove") validateProviderId(params.providerId)
  if (method === "providerCreate" || method === "providerTest") providerInput(params.provider)
  if (method === "providerUpdate") providerSettings(params.changes)
}
