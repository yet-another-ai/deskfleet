import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import { parse as parseToml } from "smol-toml"
import { providerInput, shellEnvironmentEnabled, type AgentProviderInput, type ProviderWorkspaceDiscovery } from "./provider-protocol.ts"
import { loadShellEnvironment } from "./shell-environment.ts"

export interface ProviderWorkspaceDependencies {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
  cwd?: string
  shellEnvironment?: () => Promise<Record<string, string>>
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** Read project paths on the provider's machine without starting the Agent or changing its configuration. */
export async function discoverProviderWorkspaces(
  input: AgentProviderInput,
  dependencies: ProviderWorkspaceDependencies = {},
): Promise<ProviderWorkspaceDiscovery> {
  // Saved providers carry a registry ID alongside the same launch settings.
  const { id: _providerId, ...settings } = input as AgentProviderInput & { id?: string }
  const provider = providerInput(settings)
  if (provider.template !== "codex" && provider.template !== "claude-code") return { supported: false, candidates: [], warnings: [] }
  const result: ProviderWorkspaceDiscovery = { supported: true, candidates: [], warnings: [] }
  const platform = dependencies.platform ?? process.platform
  const path = platform === "win32" ? win32 : posix
  let shell: Record<string, string> = {}
  if (shellEnvironmentEnabled(provider.inheritShellEnvironment, platform)) {
    try { shell = await (dependencies.shellEnvironment?.() ?? loadShellEnvironment()) }
    catch {
      result.warnings.push("Could not load the Agent's shell environment to discover workspaces.")
      return result
    }
  }
  const env = Object.fromEntries([...Object.entries(dependencies.env ?? process.env), ...Object.entries(shell), ...Object.entries(provider.env)]
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value]))
  const home = dependencies.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir()
  const filename = provider.template === "codex" ? "config.toml" : ".claude.json"
  // Claude puts its global JSON inside CLAUDE_CONFIG_DIR when set, but directly
  // in the home directory otherwise. Codex keeps its config inside CODEX_HOME.
  const directory = provider.template === "codex" ? env.CODEX_HOME || path.join(home, ".codex") : env.CLAUDE_CONFIG_DIR || home
  const source = path.resolve(dependencies.cwd ?? process.cwd(), directory, filename)
  let contents: string
  try { contents = await readFile(source, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push(`Could not read ${filename} to discover workspaces.`)
    return result
  }
  let config: unknown
  try { config = provider.template === "codex" ? parseToml(contents) : JSON.parse(contents) }
  catch {
    // Parser errors can quote credentials or other unrelated configuration values.
    result.warnings.push(`Could not parse ${filename} to discover workspaces.`)
    return result
  }
  if (!object(config) || (config.projects !== undefined && !object(config.projects))) {
    result.warnings.push(`Invalid project configuration in ${filename}.`)
    return result
  }
  const seen = new Set<string>()
  let inaccessible = false
  for (const project of Object.keys(config.projects ?? {})) {
    if (!project || project.includes("\0") || project.length > 4096 || !path.isAbsolute(project)) continue
    const normalized = path.resolve(project)
    const identity = platform === "win32" ? normalized.toLowerCase() : normalized
    if (seen.has(identity)) continue
    seen.add(identity)
    try { if (!(await stat(normalized)).isDirectory()) continue }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) inaccessible = true
      continue
    }
    result.candidates.push({ name: (path.basename(normalized) || normalized).slice(0, 256), path: normalized, source })
  }
  if (inaccessible) result.warnings.push("Some project directories could not be accessed.")
  return result
}
