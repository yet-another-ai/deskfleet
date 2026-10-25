import type { AgentProviderConfig, AgentProviderInput, AgentProviderSettings, ProviderSnapshot, ProviderTestResult } from "../../../apps/daemon/src/provider-protocol.ts"

export type ProviderDisplay = Pick<AgentProviderConfig, "id" | "name" | "icon" | "template">
export interface ProviderDisplaySnapshot { revision?: string; providers: ProviderDisplay[] }

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
  onChanged(listener: () => void): () => void
}
