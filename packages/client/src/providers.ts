export { supportsProviderUsage } from "@deskfleet/protocol/provider"
import type {
  AgentProviderConfig,
  AgentProviderInput,
  AgentProviderSettings,
  ProviderSnapshot,
  ProviderTemplateUpdates,
  ProviderTestResult,
  ProviderProbeResult,
  ProviderUpdate,
  ProviderWorkspaceDiscovery,
  ProviderMcpServerDiscovery,
} from "@deskfleet/protocol/provider"
import type { TerminalSummary } from "@deskfleet/protocol/terminal"

export type { ProviderTemplateUpdates, ProviderUpdate, ProviderMcpServerDiscovery }
export type { ProviderMcpServerCandidate } from "@deskfleet/protocol/provider"
export type ProviderDisplay = Pick<AgentProviderConfig, "id" | "name" | "icon" | "template">
export interface ProviderDisplaySnapshot {
  revision?: string
  providers: ProviderDisplay[]
  updates?: ProviderTemplateUpdates
}

export const PROVIDERS_CHANGED_EVENT = "deskfleet:providers-changed"

/** Provider settings belong to the executing machine's daemon. */
export interface ProvidersApi {
  list(options?: { background?: boolean }): Promise<ProviderSnapshot>
  display?(options?: { background?: boolean }): Promise<ProviderDisplaySnapshot>
  create(provider: AgentProviderInput): Promise<AgentProviderConfig>
  update(providerId: string, changes: AgentProviderSettings): Promise<AgentProviderConfig>
  remove(providerId: string): Promise<void>
  /** Starts unsaved settings on the daemon's machine without sending a prompt. */
  test(provider: AgentProviderInput): Promise<ProviderTestResult>
  probe(provider: AgentProviderInput): Promise<ProviderProbeResult>
  /** Read existing projects without creating Workspaces or changing provider settings. */
  discoverWorkspaces(providerId: string): Promise<ProviderWorkspaceDiscovery>
  /** Read existing MCP settings without starting their servers or importing them. */
  discoverMcpServers(providerId: string): Promise<ProviderMcpServerDiscovery>
  /** Explicit setup actions run in a machine terminal with live output and input. */
  install(provider: AgentProviderInput): Promise<TerminalSummary>
  login(provider: AgentProviderInput): Promise<TerminalSummary>
  onChanged(listener: () => void): () => void
}
