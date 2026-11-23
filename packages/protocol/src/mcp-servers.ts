export interface McpServerSettings { name: string; enabled: boolean }
export type McpServerInput = McpServerSettings & (
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http" | "sse"; url: string; headers: Record<string, string> }
)
export type McpServerConfig = McpServerInput & { id: string; builtIn?: boolean }
export interface McpServerSnapshot { revision: string; servers: McpServerConfig[] }
export interface McpServerMethods {
  mcpServerList: { params: Record<string, never>; result: McpServerSnapshot }
  mcpServerCreate: { params: { server: McpServerInput }; result: McpServerConfig }
  mcpServerUpdate: { params: { serverId: string; changes: McpServerInput }; result: McpServerConfig }
  mcpServerRemove: { params: { serverId: string }; result: null }
}

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
