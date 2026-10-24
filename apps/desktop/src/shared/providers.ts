import type { AgentProviderConfig, AgentProviderInput, AgentProviderSettings, ProviderSnapshot } from "../../../daemon/src/provider-protocol.ts"

export const PROVIDERS_CHANGED_EVENT = "deskfleet:providers-changed"

/** Provider settings belong to the executing machine's daemon. */
export interface ProvidersApi {
  list(): Promise<ProviderSnapshot>
  create(provider: AgentProviderInput): Promise<AgentProviderConfig>
  update(providerId: string, changes: AgentProviderSettings): Promise<AgentProviderConfig>
  remove(providerId: string): Promise<void>
  onChanged(listener: () => void): () => void
}
