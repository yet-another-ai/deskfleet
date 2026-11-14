import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import { parse as parseToml } from "smol-toml"
import { providerInput, shellEnvironmentEnabled, type AgentProviderInput } from "./provider-protocol.ts"
import type { ProviderMcpServerCandidate, ProviderMcpServerDiscovery } from "./provider-mcp-server-types.ts"
import { importMcpSettings, McpImportError, record, type McpImportContext } from "./provider-mcp-settings.ts"
import type { ProviderWorkspaceDependencies } from "./provider-workspaces.ts"
import { loadShellEnvironment } from "./shell-environment.ts"

export interface ProviderMcpServerDependencies extends ProviderWorkspaceDependencies {
  executable?: (path: string) => Promise<boolean>
}

async function readConfig(source: string, toml: boolean, warnings: string[]): Promise<Record<string, unknown> | undefined> {
  let contents: string
  try { contents = await readFile(source, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not read MCP configuration: ${source}`)
    return
  }
  try {
    const value: unknown = toml ? parseToml(contents) : JSON.parse(contents)
    if (record(value)) return value
  } catch { /* Parser errors can quote secret configuration values. */ }
  warnings.push(`Could not parse MCP configuration: ${source}`)
}

// Codex merges project config tables over user config tables. Retain inherited
// fields for a project override instead of presenting a misleading partial entry.
function merge(base: unknown, override: unknown): unknown {
  if (!record(base) || !record(override)) return override
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])]
    .map(key => [key, Object.hasOwn(override, key) ? merge(base[key], override[key]) : base[key]]))
}

/** Read configuration only: never start MCP servers, provider CLIs, or authentication helpers. */
export async function discoverProviderMcpServers(
  input: AgentProviderInput,
  dependencies: ProviderMcpServerDependencies = {},
): Promise<ProviderMcpServerDiscovery> {
  const { id: _providerId, ...settings } = input as AgentProviderInput & { id?: string }
  const provider = providerInput(settings)
  if (provider.template !== "codex" && provider.template !== "claude-code") return { supported: false, candidates: [], warnings: [] }
  const template = provider.template
  const result: ProviderMcpServerDiscovery = { supported: true, candidates: [], warnings: [] }
  const platform = dependencies.platform ?? process.platform
  const path = platform === "win32" ? win32 : posix
  let shell: Record<string, string> = {}
  if (shellEnvironmentEnabled(provider.inheritShellEnvironment, platform)) {
    try { shell = await (dependencies.shellEnvironment?.() ?? loadShellEnvironment()) }
    catch {
      result.warnings.push("Could not load the Agent's shell environment to discover MCP servers.")
      return result
    }
  }
  const env = Object.fromEntries([...Object.entries(dependencies.env ?? process.env), ...Object.entries(shell), ...Object.entries(provider.env)]
    .map(([key, value]) => [platform === "win32" ? key.toUpperCase() : key, value]))
  const home = dependencies.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME) ?? homedir()
  const directory = template === "codex" ? env.CODEX_HOME || path.join(home, ".codex") : env.CLAUDE_CONFIG_DIR || home
  const source = path.resolve(dependencies.cwd ?? process.cwd(), directory, template === "codex" ? "config.toml" : ".claude.json")
  const config = await readConfig(source, template === "codex", result.warnings)
  if (!config) return result
  const context: McpImportContext = { platform, env, executable: dependencies.executable }
  const key = template === "codex" ? "mcp_servers" : "mcpServers"

  async function collect(entries: unknown, source: string, projectPath?: string, disabled: string[] = [], inherited?: unknown): Promise<void> {
    if (entries === undefined) return
    if (!record(entries)) {
      result.warnings.push(`Invalid MCP server list in ${source}`)
      return
    }
    for (const [name, value] of Object.entries(entries)) {
      const scope = projectPath ? "project" : "user"
      const candidate: ProviderMcpServerCandidate = {
        id: JSON.stringify([source, scope, projectPath ?? null, name]), name, source, scope, ...(projectPath ? { projectPath } : {}),
      }
      try {
        candidate.server = await importMcpSettings(name, record(inherited) ? merge(inherited[name], value) : value, template, { ...context, projectPath })
        if (disabled.includes(name)) candidate.server.enabled = false
      } catch (error) {
        candidate.unsupportedReason = error instanceof McpImportError ? error.message : "This MCP configuration could not be imported. Review its source and executable."
      }
      result.candidates.push(candidate)
    }
  }

  await collect(config[key], source)
  if (config.projects !== undefined && !record(config.projects)) result.warnings.push(`Invalid project list in ${source}`)
  const seen = new Set<string>()
  for (const [project, projectSettings] of Object.entries(record(config.projects) ? config.projects : {})) {
    if (!path.isAbsolute(project) || project.includes("\0") || project.length > 4096) continue
    if (template === "codex" && (!record(projectSettings) || projectSettings.trust_level !== "trusted")) continue
    const projectPath = path.resolve(project)
    const identity = platform === "win32" ? projectPath.toLowerCase() : projectPath
    if (seen.has(identity)) continue
    seen.add(identity)
    try { if (!(await stat(projectPath)).isDirectory()) continue }
    catch { continue }
    const disabled = template === "claude-code" && record(projectSettings) && Array.isArray(projectSettings.disabledMcpServers)
      ? projectSettings.disabledMcpServers.filter((value): value is string => typeof value === "string") : []
    if (template === "claude-code" && record(projectSettings)) await collect(projectSettings.mcpServers, source, projectPath, disabled)
    const projectSource = path.join(projectPath, ...(template === "codex" ? [".codex", "config.toml"] : [".mcp.json"]))
    const projectConfig = await readConfig(projectSource, template === "codex", result.warnings)
    if (projectConfig) await collect(projectConfig[key], projectSource, projectPath, disabled, template === "codex" ? config[key] : undefined)
  }
  return result
}
