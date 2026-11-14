import type { McpServerInput } from "./mcp-server-protocol.ts"

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
