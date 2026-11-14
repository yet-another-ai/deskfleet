import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { posix, win32 } from "node:path"
import { mcpServerInput, type McpServerInput } from "./mcp-server-protocol.ts"
import { launchProviderCommand } from "./provider-setup-process.ts"

export interface McpImportContext {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  projectPath?: string
  executable?: (path: string) => Promise<boolean>
}

export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** Only these deliberately authored messages may reach a discovery response. */
export class McpImportError extends Error {}
const invalid = () => new McpImportError("This MCP server has invalid configuration. Review its source before importing.")

function string(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw invalid()
  return value
}
function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!record(value)) throw invalid()
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, string(value)]))
}
function strings(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid()
  return value.map(string)
}
function variable(name: string, context: McpImportContext): string | undefined {
  return context.env[context.platform === "win32" ? name.toUpperCase() : name]
}
function requiredVariable(name: string, context: McpImportContext): string {
  const value = variable(name, context)
  if (value === undefined) throw new McpImportError("A referenced environment variable is unavailable in this Agent's environment.")
  return value
}

// Claude deliberately excludes its own and cloud-provider credentials from remote
// substitutions. Do not turn those references into credentials during migration.
const protectedRemoteVariable = /^(?:ANTHROPIC_.*(?:KEY|TOKEN|AUTH)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK)|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS|(?:HTTPS?|ALL)_PROXY|NPM_TOKEN)$/iu

function expand(value: string, context: McpImportContext, remote = false): string {
  const reference = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu
  if (value.replace(reference, "").includes("${")) throw new McpImportError("This server uses a provider-specific variable reference that DeskFleet cannot resolve.")
  return value.replace(reference, (_match, name: string, fallback?: string) => {
    if (remote && protectedRemoteVariable.test(name)) throw new McpImportError("This server references provider credentials that Claude does not expand for remote MCP servers. Configure its authentication manually.")
    const resolved = variable(name, context) ?? fallback
    if (resolved === undefined) throw new McpImportError("A referenced environment variable is unavailable in this Agent's environment.")
    if (remote && name.toUpperCase() === "ANTHROPIC_BASE_URL" && URL.canParse(resolved)) {
      const url = new URL(resolved)
      if (url.username || url.password) throw new McpImportError("This server references a provider base URL containing credentials that Claude does not expand for remote MCP servers. Configure its authentication manually.")
    }
    return resolved
  })
}

function supportedFields(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key))
  if (!extra.length) return
  if (extra.some(key => ["cwd", "workingDirectory"].includes(key))) throw new McpImportError("A fixed working directory cannot be preserved by DeskFleet MCP settings.")
  if (extra.some(key => ["headersHelper", "http_headers_helper"].includes(key))) throw new McpImportError("Dynamic authentication helpers cannot be imported. They were not executed.")
  if (extra.some(key => ["oauth", "auth", "oauth_resource", "scopes"].includes(key))) throw new McpImportError("Provider-specific authentication settings cannot be imported. Configure authentication manually.")
  if (extra.some(key => ["enabled_tools", "disabled_tools", "tools", "default_tools_approval_mode", "omit_tools_from"].includes(key))) throw new McpImportError("Tool restrictions or approval settings cannot be preserved by DeskFleet MCP settings.")
  throw new McpImportError("This server uses additional settings that DeskFleet cannot preserve. Configure it manually.")
}

async function executable(command: string, context: McpImportContext, env: Record<string, string>): Promise<string> {
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

async function stdio(name: string, enabled: boolean, command: string, args: string[], env: Record<string, string>, context: McpImportContext): Promise<McpServerInput> {
  // Keep the provider's PATH for executable shebangs and subprocesses such as npx.
  const environment = Object.fromEntries(Object.entries({ ...(context.env.PATH === undefined ? {} : { PATH: context.env.PATH }), ...env })
    .map(([key, value]) => [context.platform === "win32" ? key.toUpperCase() : key, value]))
  const resolved = await executable(command, context, environment)
  const launchEnv = context.platform === "win32" && /\.(?:cmd|bat|ps1)$/iu.test(resolved) && context.env.SYSTEMROOT !== undefined
    ? { SYSTEMROOT: context.env.SYSTEMROOT, ...environment } : environment
  const launch = launchProviderCommand(resolved, args, launchEnv, context.platform)
  return { name, enabled, transport: "stdio", command: launch.command, args: launch.args ?? [], env: launch.env as Record<string, string> }
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const old = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase())
  if (old !== undefined) delete headers[old]
  headers[name] = value
}

async function codex(name: string, value: Record<string, unknown>, context: McpImportContext): Promise<McpServerInput> {
  const enabled = value.enabled !== false
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw invalid()
  if (value.environment_id !== undefined && value.environment_id !== "local") throw new McpImportError("MCP servers assigned to a remote execution environment cannot be imported on this machine.")
  if (value.command !== undefined) {
    supportedFields(value, ["command", "args", "env", "env_vars", "enabled", "environment_id"])
    const env: Record<string, string> = {}
    if (value.env_vars !== undefined && !Array.isArray(value.env_vars)) throw invalid()
    for (const entry of (value.env_vars ?? []) as unknown[]) {
      let variableName: string
      if (typeof entry === "string") variableName = entry
      else {
        if (!record(entry) || Object.keys(entry).some(key => !["name", "source"].includes(key))) throw invalid()
        if (entry.source !== undefined && entry.source !== "local") throw new McpImportError("Environment variables from a remote executor cannot be imported on this machine.")
        variableName = string(entry.name)
      }
      env[variableName] = requiredVariable(variableName, context)
    }
    return stdio(name, enabled, string(value.command), strings(value.args), { ...env, ...stringMap(value.env) }, context)
  }
  supportedFields(value, ["url", "http_headers", "env_http_headers", "bearer_token_env_var", "enabled", "environment_id"])
  const headers = stringMap(value.http_headers)
  for (const [name, variableName] of Object.entries(stringMap(value.env_http_headers))) setHeader(headers, name, requiredVariable(variableName, context))
  if (value.bearer_token_env_var !== undefined) {
    const token = requiredVariable(string(value.bearer_token_env_var), context)
    if (!token.trim()) throw new McpImportError("The configured MCP bearer token is empty in this Agent's environment.")
    setHeader(headers, "Authorization", `Bearer ${token}`)
  }
  return { name, enabled, transport: "http", url: string(value.url), headers }
}

async function claude(name: string, value: Record<string, unknown>, context: McpImportContext): Promise<McpServerInput> {
  const transport = value.type === "streamable-http" ? "http" : value.type ?? "stdio"
  if (transport === "stdio") {
    supportedFields(value, ["type", "command", "args", "env"])
    const env = Object.fromEntries(Object.entries(stringMap(value.env)).map(([key, value]) => [key, expand(value, context)]))
    return stdio(name, true, expand(string(value.command), context), strings(value.args).map(arg => expand(arg, context)), env, context)
  }
  if (transport !== "http" && transport !== "sse") throw new McpImportError("This MCP transport is not supported by DeskFleet.")
  supportedFields(value, ["type", "url", "headers"])
  return { name, enabled: true, transport, url: expand(string(value.url), context, true),
    headers: Object.fromEntries(Object.entries(stringMap(value.headers)).map(([key, value]) => [key, expand(value, context, true)])) }
}

/** Convert only settings whose behavior the native MCP model can retain. */
export async function importMcpSettings(name: string, value: unknown, template: "codex" | "claude-code", context: McpImportContext): Promise<McpServerInput> {
  if (!record(value)) throw invalid()
  const server = await (template === "codex" ? codex(name, value, context) : claude(name, value, context))
  try {
    // Users can rename duplicate or reserved names in the import picker.
    return { ...mcpServerInput({ ...server, name: "imported-mcp" }), name }
  } catch { throw invalid() }
}
