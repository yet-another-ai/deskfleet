import { getAgentPlugin } from "./agents/registry.ts"
import type { AgentProviderInput } from "./provider-protocol.ts"

/** Apply provider-owned environment scoping before launching or probing an Agent. */
export function providerEnvironment(provider: AgentProviderInput, directory?: string, platform = process.platform): Record<string, string> {
  return getAgentPlugin(provider.template)?.resolveEnvironment?.(provider, directory, platform) ?? { ...provider.env }
}
