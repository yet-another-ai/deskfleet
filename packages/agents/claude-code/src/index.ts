import { stat } from "node:fs/promises"
import {
  assertSupportedMcpFields, buildStdioMcpServer, clampQuota, connectAcpProcess, discoverProjectTableWorkspaces,
  extractSemverVersion, hostedProcess, invalidMcpConfigError, isRecord, launchProviderCommand, mcpEnvVariable,
  McpImportError, parseMcpString, parseMcpStringMap, parseMcpStrings, providerProcessEnv, readStructuredConfig,
  resolveStandardUrlInstaller, runJsonLineExchange,
  type AgentProvider, type AgentProviderPlugin, type AgentQuotaItem, type McpImportContext, type McpServerInput,
  type ProviderMcpDiscoveryContext, type ProviderMcpServerCandidate, type ProviderMcpServerDiscovery,
  type ProviderWorkspaceDiscovery, type ProviderWorkspaceDiscoveryContext,
} from "@deskfleet/agent-core"
import { parseClaudeCodeComposerSkill } from "@deskfleet/protocol/agents/claude-code"

export { parseClaudeCodeComposerSkill }

export const CLAUDE_AGENT_ACP_ARGUMENT = "--claude-agent-acp"

interface ClaudeWindow { utilization?: number | null; resets_at?: string | null; display_name?: string | null }

/** Parses Claude Code `get_usage` control responses into quota buckets. */
export function parseClaudeCodeUsage(payload: unknown): AgentQuotaItem[] {
  if (!payload || typeof payload !== "object") throw new Error("Claude Code did not return usage data")
  const { rate_limits_available, rate_limits: limits } = payload as {
    rate_limits_available?: boolean
    rate_limits?: {
      five_hour?: ClaudeWindow | null
      seven_day?: ClaudeWindow | null
      model_scoped?: ClaudeWindow[] | null
      seven_day_opus?: ClaudeWindow | null
      seven_day_sonnet?: ClaudeWindow | null
      extra_usage?: { is_enabled?: boolean; utilization?: number | null } | null
    } | null
  }
  if (!rate_limits_available || !limits) return []

  const items: AgentQuotaItem[] = []
  const push = (id: string, label: string, window?: ClaudeWindow | null) => {
    if (typeof window?.utilization !== "number") return
    const resetsAt = window.resets_at?.trim()
    items.push({ id, label, remaining: clampQuota((100 - window.utilization) / 100), ...(resetsAt ? { resetsAt } : {}) })
  }

  push("five_hour", "5-hour limit", limits.five_hour)
  push("seven_day", "Weekly · all models", limits.seven_day)
  if (limits.model_scoped?.length) {
    for (const scoped of limits.model_scoped) {
      const name = scoped?.display_name?.trim()
      if (name) push(`model:${name}`, `Weekly · ${name}`, scoped)
    }
  } else {
    push("seven_day_opus", "Weekly · Opus", limits.seven_day_opus)
    push("seven_day_sonnet", "Weekly · Sonnet", limits.seven_day_sonnet)
  }
  if (limits.extra_usage?.is_enabled) push("extra_usage", "Extra usage", limits.extra_usage)
  return items
}

/**
 * Shared by the standalone CLI and Electron's Node-mode adapter host.
 * Starts the stdio server through the adapter's exported modules.
 */
export async function runClaudeCodeAdapter(): Promise<void> {
  if (process.argv.includes("--version")) {
    const { default: manifest } = await import("@agentclientprotocol/claude-agent-acp/package.json", { with: { type: "json" } })
    console.log(manifest.version)
    return
  }
  process.env.CLAUDE_CODE_EXECUTABLE ||= "claude"
  const [{ applyManagedPolicyEnv }, { serveAcp }] = await Promise.all([
    import("@agentclientprotocol/claude-agent-acp/dist/managed-policy.js"),
    import("@agentclientprotocol/claude-agent-acp/dist/serve.js"),
  ])
  // Managed-policy variables must be in place before the SDK starts Claude Code.
  await applyManagedPolicyEnv()
  // stdout carries ACP messages; diagnostics go to stderr.
  console.log = console.info = console.warn = console.debug = console.error
  process.on("unhandledRejection", reason => console.error("Unhandled rejection:", reason))
  const acp = serveAcp(undefined, { protocols: "v1" })
  const shutdown = () => {
    void acp.dispose().catch(error => console.error("Error during cleanup:", error)).finally(() => process.exit(0))
  }
  void acp.closed.then(shutdown)
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  process.stdin.resume()
}

export const claudeCodeProvider: AgentProvider = {
  id: "claude-code",
  connect(config, client) {
    const host = hostedProcess(CLAUDE_AGENT_ACP_ARGUMENT)
    return connectAcpProcess({
      ...host,
      env: {
        ...config.env,
        ...host.env,
        // Always select the installed CLI rather than the SDK's optional native binary.
        CLAUDE_CODE_EXECUTABLE: config.binaryPath || "claude",
      },
    }, client)
  },
  readUsage(config, signal) {
    const env = providerProcessEnv({ ...config.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" })
    delete env.NODE_OPTIONS
    delete env.CLAUDECODE
    return runJsonLineExchange({
      command: config.binaryPath || "claude",
      args: ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--no-session-persistence"],
      env,
      signal,
      start: send => send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } }),
      onFrame(frame, send) {
        if (frame.type !== "control_response") return undefined
        const res = frame.response as { subtype?: string; request_id?: string; error?: string; response?: unknown } | undefined
        if (res?.request_id !== "init" && res?.request_id !== "usage") return undefined
        if (res.subtype === "error") throw new Error(res.error?.trim() || "Could not read Claude Code usage")
        if (res.request_id === "init") {
          send({ type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } })
          return undefined
        }
        return parseClaudeCodeUsage(res.response)
      },
    })
  },
}

// Claude deliberately excludes its own and cloud-provider credentials from remote
// substitutions. Do not turn those references into credentials during migration.
const protectedRemoteVariable = /^(?:ANTHROPIC_.*(?:KEY|TOKEN|AUTH)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK)|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS|(?:HTTPS?|ALL)_PROXY|NPM_TOKEN)$/iu

function expandClaudeVariable(value: string, context: McpImportContext, remote = false): string {
  const reference = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu
  if (value.replace(reference, "").includes("${")) {
    throw new McpImportError("This server uses a provider-specific variable reference that DeskFleet cannot resolve.")
  }
  return value.replace(reference, (_match, name: string, fallback?: string) => {
    if (remote && protectedRemoteVariable.test(name)) {
      throw new McpImportError("This server references provider credentials that Claude does not expand for remote MCP servers. Configure its authentication manually.")
    }
    const resolved = mcpEnvVariable(name, context) ?? fallback
    if (resolved === undefined) throw new McpImportError("A referenced environment variable is unavailable in this Agent's environment.")
    if (remote && name.toUpperCase() === "ANTHROPIC_BASE_URL" && URL.canParse(resolved)) {
      const url = new URL(resolved)
      if (url.username || url.password) {
        throw new McpImportError("This server references a provider base URL containing credentials that Claude does not expand for remote MCP servers. Configure its authentication manually.")
      }
    }
    return resolved
  })
}

export async function importClaudeCodeMcpServer(name: string, value: Record<string, unknown>, context: McpImportContext): Promise<McpServerInput> {
  const transport = value.type === "streamable-http" ? "http" : value.type ?? "stdio"
  if (transport === "stdio") {
    assertSupportedMcpFields(value, ["type", "command", "args", "env"])
    const env = Object.fromEntries(Object.entries(parseMcpStringMap(value.env)).map(([key, item]) => [key, expandClaudeVariable(item, context)]))
    return buildStdioMcpServer(
      name,
      true,
      expandClaudeVariable(parseMcpString(value.command), context),
      parseMcpStrings(value.args).map(arg => expandClaudeVariable(arg, context)),
      env,
      context,
    )
  }
  if (transport !== "http" && transport !== "sse") throw new McpImportError("This MCP transport is not supported by DeskFleet.")
  assertSupportedMcpFields(value, ["type", "url", "headers"])
  return {
    name,
    enabled: true,
    transport,
    url: expandClaudeVariable(parseMcpString(value.url), context, true),
    headers: Object.fromEntries(Object.entries(parseMcpStringMap(value.headers)).map(([key, item]) => [key, expandClaudeVariable(item, context, true)])),
  }
}

export async function discoverClaudeCodeWorkspaces(ctx: ProviderWorkspaceDiscoveryContext): Promise<ProviderWorkspaceDiscovery> {
  // Claude puts its global JSON inside CLAUDE_CONFIG_DIR when set, but directly in the home directory otherwise.
  const directory = ctx.env.CLAUDE_CONFIG_DIR || ctx.home
  const source = ctx.path.resolve(ctx.cwd, directory, ".claude.json")
  return discoverProjectTableWorkspaces(ctx, source, ".claude.json", JSON.parse)
}

export async function discoverClaudeCodeMcpServers(ctx: ProviderMcpDiscoveryContext): Promise<ProviderMcpServerDiscovery> {
  const result: ProviderMcpServerDiscovery = { supported: true, candidates: [], warnings: [] }
  const directory = ctx.env.CLAUDE_CONFIG_DIR || ctx.home
  const source = ctx.path.resolve(ctx.cwd, directory, ".claude.json")
  const config = await readStructuredConfig(source, JSON.parse, result.warnings)
  if (!config) return result
  const importContext: McpImportContext = { platform: ctx.platform, env: ctx.env, executable: ctx.executable }

  async function collect(entries: unknown, entrySource: string, projectPath?: string, disabled: string[] = []): Promise<void> {
    if (entries === undefined) return
    if (!isRecord(entries)) {
      result.warnings.push(`Invalid MCP server list in ${entrySource}`)
      return
    }
    for (const [name, value] of Object.entries(entries)) {
      const scope = projectPath ? "project" : "user"
      const candidate: ProviderMcpServerCandidate = {
        id: JSON.stringify([entrySource, scope, projectPath ?? null, name]),
        name,
        source: entrySource,
        scope,
        ...(projectPath ? { projectPath } : {}),
      }
      try {
        if (!isRecord(value)) throw invalidMcpConfigError()
        const server = await importClaudeCodeMcpServer(name, value, { ...importContext, projectPath })
        const validated = ctx.validateServer(server)
        if (disabled.includes(name)) validated.enabled = false
        candidate.server = validated
      } catch (error) {
        candidate.unsupportedReason = error instanceof McpImportError
          ? error.message
          : "This MCP configuration could not be imported. Review its source and executable."
      }
      result.candidates.push(candidate)
    }
  }

  await collect(config.mcpServers, source)
  if (config.projects !== undefined && !isRecord(config.projects)) result.warnings.push(`Invalid project list in ${source}`)
  const seen = new Set<string>()
  for (const [project, projectSettings] of Object.entries(isRecord(config.projects) ? config.projects : {})) {
    if (!ctx.path.isAbsolute(project) || project.includes("\0") || project.length > 4096) continue
    const projectPath = ctx.path.resolve(project)
    const identity = ctx.platform === "win32" ? projectPath.toLowerCase() : projectPath
    if (seen.has(identity)) continue
    seen.add(identity)
    try { if (!(await stat(projectPath)).isDirectory()) continue }
    catch { continue }
    const disabled = isRecord(projectSettings) && Array.isArray(projectSettings.disabledMcpServers)
      ? projectSettings.disabledMcpServers.filter((value): value is string => typeof value === "string") : []
    if (isRecord(projectSettings)) await collect(projectSettings.mcpServers, source, projectPath, disabled)
    const projectSource = ctx.path.join(projectPath, ".mcp.json")
    const projectConfig = await readStructuredConfig(projectSource, JSON.parse, result.warnings)
    if (projectConfig) await collect(projectConfig.mcpServers, projectSource, projectPath, disabled)
  }
  return result
}

export const claudeCodePlugin: AgentProviderPlugin<"claude-code"> = {
  id: "claude-code",
  template: { id: "claude-code", name: "Claude Code", defaultBinaryPath: "claude", supportsUsage: true },
  provider: claudeCodeProvider,
  bundledAdapter: {
    argument: CLAUDE_AGENT_ACP_ARGUMENT,
    run: runClaudeCodeAdapter,
  },
  parseComposerSkill: parseClaudeCodeComposerSkill,
  setup: {
    searchDirectories: ctx => [ctx.path.join(ctx.home, ".claude", "local")],
    validateBinary(binary, ctx) {
      // Bundled adapter launches Claude directly; Windows shell shims cannot be CLAUDE_CODE_EXECUTABLE.
      if (ctx.platform === "win32" && /\.(?:cmd|bat|ps1)$/iu.test(binary)) {
        return "Select the native .exe for this provider, or install its official native CLI."
      }
      return undefined
    },
    identityPattern: /\bclaude\b/iu,
    async checkAuth(binary, ctx) {
      try {
        const result = await ctx.run(binary, ["auth", "status"], ctx.env, ctx.home)
        const value: unknown = JSON.parse(result.stdout)
        if (value && typeof value === "object") {
          const status = value as { apiKeySource?: unknown; apiProvider?: unknown; authMethod?: unknown; loggedIn?: unknown }
          if (typeof status.apiKeySource === "string" && status.apiKeySource) return "authenticated"
          // Cloud backends use their own credentials; a missing Claude account does not require login.
          if (typeof status.apiProvider === "string" && status.apiProvider !== "firstParty") return "unknown"
          if (status.authMethod === "third_party") return "unknown"
          if (typeof status.loggedIn === "boolean") return status.loggedIn ? "authenticated" : "unauthenticated"
        }
      } catch { /* Old CLIs and unavailable status endpoints cannot establish authentication. */ }
      return "unknown"
    },
    resolveInstaller: ctx => resolveStandardUrlInstaller(ctx, {
      unixUrl: "https://claude.ai/install.sh",
      unixShell: "bash",
      windowsUrl: "https://claude.ai/install.ps1",
    }),
    resolveLogin(binary, _input, _probeResult, ctx) {
      if (!binary) throw new Error("Install or select the provider executable before signing in.")
      return launchProviderCommand(binary, ["auth", "login"], ctx.env, ctx.platform)
    },
  },
  update: {
    versionSource: () => ({
      url: "https://downloads.claude.ai/claude-code-releases/latest",
      parse: body => extractSemverVersion(body),
    }),
  },
  discoverWorkspaces: discoverClaudeCodeWorkspaces,
  discoverMcpServers: discoverClaudeCodeMcpServers,
}
