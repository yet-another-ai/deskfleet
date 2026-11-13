export { supportsProviderUsage } from "../../../apps/daemon/src/provider-protocol.ts"
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
} from "../../../apps/daemon/src/provider-protocol.ts"
import type { TerminalSummary } from "../../../apps/daemon/src/terminal-protocol.ts"

export type { ProviderTemplateUpdates, ProviderUpdate }
export type ProviderDisplay = Pick<AgentProviderConfig, "id" | "name" | "icon" | "template">
export interface ProviderDisplaySnapshot {
  revision?: string
  providers: ProviderDisplay[]
  updates?: ProviderTemplateUpdates
}

export const PROVIDERS_CHANGED_EVENT = "deskfleet:providers-changed"

/** Provider settings belong to the executing machine's daemon. */
export interface ProvidersApi {
  list(): Promise<ProviderSnapshot>
  display?(): Promise<ProviderDisplaySnapshot>
  create(provider: AgentProviderInput): Promise<AgentProviderConfig>
  update(providerId: string, changes: AgentProviderSettings): Promise<AgentProviderConfig>
  remove(providerId: string): Promise<void>
  /** Starts unsaved settings on the daemon's machine without sending a prompt. */
  test(provider: AgentProviderInput): Promise<ProviderTestResult>
  probe(provider: AgentProviderInput): Promise<ProviderProbeResult>
  /** Read existing projects without creating Workspaces or changing provider settings. */
  discoverWorkspaces(providerId: string): Promise<ProviderWorkspaceDiscovery>
  /** Explicit setup actions run in a machine terminal with live output and input. */
  install(provider: AgentProviderInput): Promise<TerminalSummary>
  login(provider: AgentProviderInput): Promise<TerminalSummary>
  onChanged(listener: () => void): () => void
}
