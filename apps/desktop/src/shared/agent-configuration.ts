import type { AgentConfiguration, AgentConfigurationParams } from "../../../daemon/src/agent-configuration-protocol.ts"

export type { AgentChoice, AgentConfigOption, AgentConfiguration, AgentConfigurationParams } from "../../../daemon/src/agent-configuration-protocol.ts"

/** Discover and update the configuration offered by an agent on the local daemon. */
export interface AgentConfigurationApi {
  configuration(params: AgentConfigurationParams): Promise<AgentConfiguration>
}
