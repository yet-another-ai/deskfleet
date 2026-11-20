import { constants } from "node:fs"
import { access, readFile, stat } from "node:fs/promises"
import { posix, win32 } from "node:path"
import { launchProviderCommand } from "./process.ts"
import type { McpServerInput, ProviderWorkspaceCandidate, ProviderWorkspaceDiscovery } from "./protocol.ts"
import type { ProviderWorkspaceDiscoveryContext } from "./types.ts"

export interface McpImportContext {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  projectPath?: string
  executable?: (path: string) => Promise<boolean>
}

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** Only these deliberately authored messages may reach a discovery response. */
export class McpImportError extends Error {}

export const invalidMcpConfigError = () => new McpImportError("This MCP server has invalid configuration. Review its source before importing.")

export function parseMcpString(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw invalidMcpConfigError()
  return value
}

export function parseMcpStringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw invalidMcpConfigError()
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, parseMcpString(value)]))
}

export function parseMcpStrings(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalidMcpConfigError()
  return value.map(parseMcpString)
}

export function mcpEnvVariable(name: string, context: McpImportContext): string | undefined {
  return context.env[context.platform === "win32" ? name.toUpperCase() : name]
}

export function requiredMcpEnvVariable(name: string, context: McpImportContext): string {
  const value = mcpEnvVariable(name, context)
  if (value === undefined) throw new McpImportError("A referenced environment variable is unavailable in this Agent's environment.")
  return value
}

export function assertSupportedMcpFields(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key))
  if (!extra.length) return
  if (extra.some(key => ["cwd", "workingDirectory"].includes(key))) throw new McpImportError("A fixed working directory cannot be preserved by DeskFleet MCP settings.")
  if (extra.some(key => ["headersHelper", "http_headers_helper"].includes(key))) throw new McpImportError("Dynamic authentication helpers cannot be imported. They were not executed.")
  if (extra.some(key => ["oauth", "auth", "oauth_resource", "scopes"].includes(key))) throw new McpImportError("Provider-specific authentication settings cannot be imported. Configure authentication manually.")
  if (extra.some(key => ["enabled_tools", "disabled_tools", "tools", "default_tools_approval_mode", "omit_tools_from"].includes(key))) throw new McpImportError("Tool restrictions or approval settings cannot be preserved by DeskFleet MCP settings.")
  throw new McpImportError("This server uses additional settings that DeskFleet cannot preserve. Configure it manually.")
}

async function resolveMcpExecutable(command: string, context: McpImportContext, env: Record<string, string>): Promise<string> {
  const path = context.platform === "win32" ? win32 : posix
  const effective = { ...context.env, ...env }
  let candidates: string[]
  if (path.isAbsolute(command)) candidates = [path.normalize(command)]
  else if (/[/\\]/u.test(command)) {
    if (!context.projectPath) throw new McpImportError("This relative executable depends on the Agent's working directory. Use an absolute path before importing.")
    candidates = [path.resolve(context.projectPath, command)]
  } else {
    candidates = (effective.PATH ?? "").split(context.platform === "win32" ? ";" : ":")
      .filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, command))
  }
  if (context.platform === "win32" && !path.extname(command)) {
    const suffixes = (effective.PATHEXT || ".EXE;.COM;.CMD;.BAT").split(";").filter(suffix => /^\.[a-z]+$/iu.test(suffix))
    candidates = candidates.flatMap(candidate => [candidate, ...suffixes.map(suffix => candidate + suffix.toLowerCase())])
  }
  const check = context.executable ?? (async (candidate: string) => {
    try {
      if (!(await stat(candidate)).isFile()) return false
      await access(candidate, context.platform === "win32" ? constants.F_OK : constants.X_OK)
      return true
    } catch { return false }
  })
  for (const candidate of candidates) if (await check(candidate)) return candidate
  throw new McpImportError("The MCP executable could not be found in this Agent's environment. Install it or configure an absolute path.")
}

export async function buildStdioMcpServer(
  name: string,
  enabled: boolean,
  command: string,
  args: string[],
  env: Record<string, string>,
  context: McpImportContext,
): Promise<McpServerInput> {
  // Keep the provider's PATH for executable shebangs and subprocesses such as npx.
  const environment = Object.fromEntries(Object.entries({ ...(context.env.PATH === undefined ? {} : { PATH: context.env.PATH }), ...env })
    .map(([key, value]) => [context.platform === "win32" ? key.toUpperCase() : key, value]))
  const resolved = await resolveMcpExecutable(command, context, environment)
  const launchEnv = context.platform === "win32" && /\.(?:cmd|bat|ps1)$/iu.test(resolved) && context.env.SYSTEMROOT !== undefined
    ? { SYSTEMROOT: context.env.SYSTEMROOT, ...environment } : environment
  const launch = launchProviderCommand(resolved, args, launchEnv, context.platform)
  return { name, enabled, transport: "stdio", command: launch.command, args: launch.args ?? [], env: launch.env as Record<string, string> }
}

export function setCaseInsensitiveHeader(headers: Record<string, string>, name: string, value: string): void {
  const old = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())
  if (old !== undefined) delete headers[old]
  headers[name] = value
}

export async function readStructuredConfig(
  source: string,
  parse: (contents: string) => unknown,
  warnings: string[],
): Promise<Record<string, unknown> | undefined> {
  let contents: string
  try { contents = await readFile(source, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not read MCP configuration: ${source}`)
    return
  }
  try {
    const value: unknown = parse(contents)
    if (isRecord(value)) return value
  } catch { /* Parser errors can quote secret configuration values. */ }
  warnings.push(`Could not parse MCP configuration: ${source}`)
}

export function mergeConfigTables(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])]
    .map(key => [key, Object.hasOwn(override, key) ? mergeConfigTables(base[key], override[key]) : base[key]]))
}

/** Shared project-table workspace discovery for providers storing a top-level `projects` map. */
export async function discoverProjectTableWorkspaces(
  ctx: ProviderWorkspaceDiscoveryContext,
  source: string,
  filename: string,
  parse: (contents: string) => unknown,
): Promise<ProviderWorkspaceDiscovery> {
  const result: ProviderWorkspaceDiscovery = { supported: true, candidates: [], warnings: [] }
  let contents: string
  try { contents = await readFile(source, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push(`Could not read ${filename} to discover workspaces.`)
    return result
  }
  let config: unknown
  try { config = parse(contents) }
  catch {
    // Parser errors can quote credentials or other unrelated configuration values.
    result.warnings.push(`Could not parse ${filename} to discover workspaces.`)
    return result
  }
  if (!isRecord(config) || (config.projects !== undefined && !isRecord(config.projects))) {
    result.warnings.push(`Invalid project configuration in ${filename}.`)
    return result
  }
  const seen = new Set<string>()
  let inaccessible = false
  for (const project of Object.keys(config.projects ?? {})) {
    if (!project || project.includes("\0") || project.length > 4096 || !ctx.path.isAbsolute(project)) continue
    const normalized = ctx.path.resolve(project)
    const identity = ctx.platform === "win32" ? normalized.toLowerCase() : normalized
    if (seen.has(identity)) continue
    seen.add(identity)
    try { if (!(await stat(normalized)).isDirectory()) continue }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) inaccessible = true
      continue
    }
    const candidate: ProviderWorkspaceCandidate = {
      name: (ctx.path.basename(normalized) || normalized).slice(0, 256),
      path: normalized,
      source,
    }
    result.candidates.push(candidate)
  }
  if (inaccessible) result.warnings.push("Some project directories could not be accessed.")
  return result
}
