import {
  canContinueSession, connectAcpProcess as coreConnectAcpProcess, supportsSteering,
  type AcpConnectOptions, type AcpExtension, type AgentClient as CoreAgentClient, type AgentConfig,
  type AgentConnection, type AgentProcess, type AgentProvider as CoreAgentProvider, type AgentTerminalHandler,
  type SteeringOutcome,
} from "@deskfleet/agent-core"
import { createAgentTerminalHandler, isAgentTerminalHandler, type AgentTerminalContext } from "./terminals.ts"

export { canContinueSession, supportsSteering }
export type { AcpConnectOptions, AcpExtension, AgentConfig, AgentConnection, AgentProcess, SteeringOutcome }

export interface AgentClient extends Omit<CoreAgentClient, "terminals"> {
  terminals?: AgentTerminalContext
}

export interface AgentProvider extends Omit<CoreAgentProvider, "connect"> {
  connect(config: AgentConfig, client: AgentClient): Promise<AgentConnection>
}

export function normalizeAgentClient(client: AgentClient): CoreAgentClient {
  const { terminals, ...rest } = client
  if (!terminals) return rest
  return {
    ...rest,
    terminals: isAgentTerminalHandler(terminals) ? terminals : createAgentTerminalHandler(terminals),
  }
}

export function adaptProvider(provider: CoreAgentProvider): AgentProvider {
  return {
    id: provider.id,
    connect: (config, client) => provider.connect(config, normalizeAgentClient(client)),
    ...(provider.readUsage ? { readUsage: (config, signal) => provider.readUsage!(config, signal) } : {}),
  }
}

export function connectAcpProcess(launch: AgentProcess, client: AgentClient, options: AcpConnectOptions = {}): Promise<AgentConnection> {
  return coreConnectAcpProcess(launch, normalizeAgentClient(client), options)
}
