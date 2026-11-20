import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import { getAgentPlugin } from "./agents/registry.ts"
import { providerInput, shellEnvironmentEnabled, type AgentProviderInput, type ProviderWorkspaceDiscovery } from "./provider-protocol.ts"
import { loadShellEnvironment } from "./shell-environment.ts"

export interface ProviderWorkspaceDependencies {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  cwd?: string
  shellEnvironment?: () => Promise<Record<string, string>>
}

/** Read project paths on the provider's machine without starting the Agent or changing its configuration. */
export async function discoverProviderWorkspaces(
  input: AgentProviderInput,
  dependencies: ProviderWorkspaceDependencies = {},
): Promise<ProviderWorkspaceDiscovery> {
  // Saved providers carry a registry ID alongside the same launch settings.
  const { id: _providerId, ...settings } = input as AgentProviderInput & { id?: string }
  const provider = providerInput(settings)
  const discover = getAgentPlugin(provider.template)?.discoverWorkspaces
  if (!discover) return { supported: false, candidates: [], warnings: [] }
  const platform = dependencies.platform ?? process.platform
  const path = platform === "win32" ? win32 : posix
  let shell: Record<string, string> = {}
  if (shellEnvironmentEnabled(provider.inheritShellEnvironment, platform)) {
    try { shell = await (dependencies.shellEnvironment?.() ?? loadShellEnvironment()) }
    catch {
      return { supported: true, candidates: [], warnings: ["Could not load the Agent's shell environment to discover workspaces."] }
    }
  }
  const env = Object.fromEntries([...Object.entries(dependencies.env ?? process.env), ...Object.entries(shell), ...Object.entries(provider.env)]
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value]))
  const home = dependencies.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir()
  return discover({ platform, path, env, home, cwd: dependencies.cwd ?? process.cwd() })
}
