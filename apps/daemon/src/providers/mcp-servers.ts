import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import { invalidMcpConfigError, type McpServerInput } from "@deskfleet/agent-core"
import { getAgentPlugin } from "../acp/registry.ts"
import { mcpServerInput } from "../mcp/server-input.ts"
import { providerInput, type AgentProviderInput } from "@deskfleet/protocol/provider"
import type { ProviderMcpServerDiscovery } from "@deskfleet/protocol/mcp-servers"
import type { ProviderWorkspaceDependencies } from "./workspaces.ts"
import { loadShellEnvironment, shellEnvironmentEnabled } from "./shell-environment.ts"

export interface ProviderMcpServerDependencies extends ProviderWorkspaceDependencies {
  executable?: (path: string) => Promise<boolean>
}

function validateImportedServer(server: McpServerInput): McpServerInput {
  try {
    // Users can rename duplicate or reserved names in the import picker.
    return { ...mcpServerInput({ ...server, name: "imported-mcp" }), name: server.name }
  } catch { throw invalidMcpConfigError() }
}

/** Read configuration only: never start MCP servers, provider CLIs, or authentication helpers. */
export async function discoverProviderMcpServers(
  input: AgentProviderInput,
  dependencies: ProviderMcpServerDependencies = {},
): Promise<ProviderMcpServerDiscovery> {
  const { id: _providerId, ...settings } = input as AgentProviderInput & { id?: string }
  const provider = providerInput(settings)
  const discover = getAgentPlugin(provider.template)?.discoverMcpServers
  if (!discover) return { supported: false, candidates: [], warnings: [] }
  const platform = dependencies.platform ?? process.platform
  const path = platform === "win32" ? win32 : posix
  let shell: Record<string, string> = {}
  if (shellEnvironmentEnabled(provider.inheritShellEnvironment, platform)) {
    try { shell = await (dependencies.shellEnvironment?.() ?? loadShellEnvironment()) }
    catch {
      return { supported: true, candidates: [], warnings: ["Could not load the Agent's shell environment to discover MCP servers."] }
    }
  }
  const env = Object.fromEntries([...Object.entries(dependencies.env ?? process.env), ...Object.entries(shell), ...Object.entries(provider.env)]
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value]))
  const home = dependencies.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir()
  return discover({
    platform,
    path,
    env,
    home,
    cwd: dependencies.cwd ?? process.cwd(),
    executable: dependencies.executable,
    validateServer: validateImportedServer,
  })
}
