import "./adapter-host.ts"
import { antigravityPlugin } from "@deskfleet/agent-antigravity"
import { claudeCodePlugin } from "@deskfleet/agent-claude-code"
import { codebuddyPlugin } from "@deskfleet/agent-codebuddy"
import { codexPlugin } from "@deskfleet/agent-codex"
import { standardAcpProvider, type AgentProviderPlugin } from "@deskfleet/agent-core"
import { cursorPlugin } from "@deskfleet/agent-cursor"
import { deepseekHarnessPlugin } from "@deskfleet/agent-deepseek-harness"
import { grokPlugin } from "@deskfleet/agent-grok"
import { ompPlugin } from "@deskfleet/agent-omp"
import { piPlugin } from "@deskfleet/agent-pi"
import type { AgentProviderTemplateId } from "../provider-protocol.ts"
import { adaptProvider, type AgentProvider } from "./acp.ts"

/** All built-in vendor agent plugins, each owned by its own workspace package. */
export const AGENT_PLUGINS: readonly AgentProviderPlugin<Exclude<AgentProviderTemplateId, "acp">>[] = [
  codexPlugin,
  claudeCodePlugin,
  cursorPlugin,
  grokPlugin,
  piPlugin,
  ompPlugin,
  deepseekHarnessPlugin,
  antigravityPlugin,
  codebuddyPlugin,
]

const pluginById = new Map<AgentProviderTemplateId, AgentProviderPlugin>(
  AGENT_PLUGINS.map(plugin => [plugin.id, plugin]),
)

const daemonStandardAcpProvider = adaptProvider(standardAcpProvider)
const daemonProviderById = new Map<AgentProviderTemplateId, AgentProvider>([
  ...AGENT_PLUGINS.map(plugin => [plugin.id, adaptProvider(plugin.provider)] as const),
  ["acp", daemonStandardAcpProvider],
])

export function getAgentPlugin(template: AgentProviderTemplateId): AgentProviderPlugin | undefined {
  return pluginById.get(template)
}

export function getDaemonAgentProvider(template: AgentProviderTemplateId): AgentProvider {
  return daemonProviderById.get(template) ?? daemonStandardAcpProvider
}

export const defaultAgentProvider: AgentProvider = getDaemonAgentProvider("codex")
