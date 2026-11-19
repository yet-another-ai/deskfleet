/// <reference path="./codex-acp.d.ts" />
import { stat } from "node:fs/promises"
import { parse as parseToml } from "smol-toml"
import {
  assertSupportedMcpFields, buildStdioMcpServer, clampQuota, connectAcpProcess, discoverProjectTableWorkspaces,
  hostedProcess, invalidMcpConfigError, isRecord, jsonVersionParser, launchProviderCommand, mcpEnvVariable,
  McpImportError, mergeConfigTables, parseMcpString, parseMcpStringMap, parseMcpStrings, providerProcessEnv,
  readStructuredConfig, requiredMcpEnvVariable, resolveStandardUrlInstaller, runJsonLineExchange,
  setCaseInsensitiveHeader, stripAnsiText,
  type AgentProvider, type AgentProviderPlugin, type AgentQuotaItem, type McpImportContext, type McpServerInput,
  type ProviderMcpDiscoveryContext, type ProviderMcpServerCandidate, type ProviderMcpServerDiscovery,
  type ProviderWorkspaceDiscovery, type ProviderWorkspaceDiscoveryContext,
} from "@deskfleet/agent-core"
import { parseCodexComposerSkill } from "./protocol.ts"

export { parseCodexComposerSkill }

export const CODEX_ACP_ARGUMENT = "--codex-acp"

interface CodexWindow { usedPercent?: number | null; windowDurationMins?: number | null; resetsAt?: number | null }
interface CodexSnapshot {
  limitId?: string | null
  limitName?: string | null
  primary?: CodexWindow | null
  secondary?: CodexWindow | null
  individualLimit?: { remainingPercent?: number | null; resetsAt?: number | null } | null
}

function codexWindowLabel(mins?: number | null): string {
  if (typeof mins !== "number" || mins <= 0) return "Limit"
  if (mins < 60) return `${Math.round(mins)}m limit`
  if (mins < 1_440) return `${Math.round(mins / 60)}h limit`
  if (mins < 10_080) return `${Math.round(mins / 1_440)}d limit`
  return "Weekly limit"
}

/** Parses `codex app-server` `account/rateLimits/read` responses into quota buckets. */
export function parseCodexUsage(payload: unknown): AgentQuotaItem[] {
  if (!payload || typeof payload !== "object") throw new Error("Codex did not return usage data")
  const data = payload as { rateLimits?: CodexSnapshot | null; rateLimitsByLimitId?: Record<string, CodexSnapshot | null | undefined> | null }
  const byId = Object.entries(data.rateLimitsByLimitId ?? {}).filter((entry): entry is [string, CodexSnapshot] => entry[1] != null)
  const entries: [string, CodexSnapshot][] = byId.length
    ? byId
    : data.rateLimits ? [[data.rateLimits.limitId?.trim() || "codex", data.rateLimits]] : []

  const items: AgentQuotaItem[] = []
  for (const [limitId, snapshot] of entries) {
    const group = snapshot.limitName?.trim() || (entries.length > 1 ? limitId : undefined)
    const push = (slot: string, label: string, remainingPercent?: number | null, resetsAt?: number | null) => {
      if (typeof remainingPercent !== "number") return
      items.push({
        id: `${limitId}:${slot}`,
        label,
        ...(group ? { group } : {}),
        remaining: clampQuota(remainingPercent / 100),
        ...(typeof resetsAt === "number" ? { resetsAt: new Date(resetsAt * 1000).toISOString() } : {}),
      })
    }
    if (typeof snapshot.primary?.usedPercent === "number") {
      push("primary", codexWindowLabel(snapshot.primary.windowDurationMins), 100 - snapshot.primary.usedPercent, snapshot.primary.resetsAt)
    }
    if (typeof snapshot.secondary?.usedPercent === "number") {
      push("secondary", codexWindowLabel(snapshot.secondary.windowDurationMins), 100 - snapshot.secondary.usedPercent, snapshot.secondary.resetsAt)
    }
    if (snapshot.individualLimit) {
      push("spend", "Spend limit", snapshot.individualLimit.remainingPercent, snapshot.individualLimit.resetsAt)
    }
  }
  return items
}

/** Shared by source, SEA, and Electron's Node-mode adapter host. */
export async function runCodexAdapter(): Promise<void> {
  process.env.CODEX_PATH ||= "codex"
  await import("@agentclientprotocol/codex-acp")
}

export const codexProvider: AgentProvider = {
  id: "codex",
  connect(config, client) {
    const host = hostedProcess(CODEX_ACP_ARGUMENT)
    const env = Object.fromEntries(Object.entries({ ...config.env, ...host.env })
      .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]))
    return connectAcpProcess({
      ...host,
      env: {
        ...env,
        // Always select the installed CLI rather than the adapter's bundled Codex.
        CODEX_PATH: config.binaryPath || "codex",
        // The bridge otherwise permits an inherited default request to open OAuth.
        ...(config.authentication === "existing" ? { DEFAULT_AUTH_REQUEST: "" } : {}),
      },
    }, client)
  },
  readUsage(config, signal) {
    return runJsonLineExchange({
      command: config.binaryPath || "codex",
      args: ["app-server"],
      env: providerProcessEnv(config.env),
      signal,
      start: send => send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "deskfleet", title: "DeskFleet", version: "0.0.0" }, capabilities: { experimentalApi: true } },
      }),
      onFrame(frame, send) {
        if (frame.id !== 1 && frame.id !== 2) return undefined
        const error = frame.error as { message?: string } | undefined
        if (error) throw new Error(error.message?.trim() || "Could not read Codex usage")
        if (frame.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized" })
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" })
          return undefined
        }
        return parseCodexUsage(frame.result)
      },
    })
  },
}

export async function importCodexMcpServer(name: string, value: Record<string, unknown>, context: McpImportContext): Promise<McpServerInput> {
  const enabled = value.enabled !== false
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw invalidMcpConfigError()
  if (value.environment_id !== undefined && value.environment_id !== "local") {
    throw new McpImportError("MCP servers assigned to a remote execution environment cannot be imported on this machine.")
  }
  if (value.command !== undefined) {
    assertSupportedMcpFields(value, ["command", "args", "env", "env_vars", "enabled", "environment_id"])
    const env: Record<string, string> = {}
    if (value.env_vars !== undefined && !Array.isArray(value.env_vars)) throw invalidMcpConfigError()
    for (const entry of (value.env_vars ?? []) as unknown[]) {
      let variableName: string
      if (typeof entry === "string") variableName = entry
      else {
        if (!isRecord(entry) || Object.keys(entry).some(key => !["name", "source"].includes(key))) throw invalidMcpConfigError()
        if (entry.source !== undefined && entry.source !== "local") {
          throw new McpImportError("Environment variables from a remote executor cannot be imported on this machine.")
        }
        variableName = parseMcpString(entry.name)
      }
      // Codex forwards only variables present in the parent environment; literal
      // env entries below still apply when a forwarded variable is absent.
      const forwarded = mcpEnvVariable(variableName, context)
      if (forwarded !== undefined) env[variableName] = forwarded
    }
    return buildStdioMcpServer(name, enabled, parseMcpString(value.command), parseMcpStrings(value.args), { ...env, ...parseMcpStringMap(value.env) }, context)
  }
  assertSupportedMcpFields(value, ["url", "http_headers", "env_http_headers", "bearer_token_env_var", "enabled", "environment_id"])
  const headers = parseMcpStringMap(value.http_headers)
  for (const [headerName, variableName] of Object.entries(parseMcpStringMap(value.env_http_headers))) {
    setCaseInsensitiveHeader(headers, headerName, requiredMcpEnvVariable(variableName, context))
  }
  if (value.bearer_token_env_var !== undefined) {
    const token = requiredMcpEnvVariable(parseMcpString(value.bearer_token_env_var), context)
    if (!token.trim()) throw new McpImportError("The configured MCP bearer token is empty in this Agent's environment.")
    setCaseInsensitiveHeader(headers, "Authorization", `Bearer ${token}`)
  }
  return { name, enabled, transport: "http", url: parseMcpString(value.url), headers }
}

export async function discoverCodexWorkspaces(ctx: ProviderWorkspaceDiscoveryContext): Promise<ProviderWorkspaceDiscovery> {
  // Codex keeps its config inside CODEX_HOME.
  const directory = ctx.env.CODEX_HOME || ctx.path.join(ctx.home, ".codex")
  const source = ctx.path.resolve(ctx.cwd, directory, "config.toml")
  return discoverProjectTableWorkspaces(ctx, source, "config.toml", parseToml)
}

export async function discoverCodexMcpServers(ctx: ProviderMcpDiscoveryContext): Promise<ProviderMcpServerDiscovery> {
  const result: ProviderMcpServerDiscovery = { supported: true, candidates: [], warnings: [] }
  const directory = ctx.env.CODEX_HOME || ctx.path.join(ctx.home, ".codex")
  const source = ctx.path.resolve(ctx.cwd, directory, "config.toml")
  const config = await readStructuredConfig(source, parseToml, result.warnings)
  if (!config) return result
  const importContext: McpImportContext = { platform: ctx.platform, env: ctx.env, executable: ctx.executable }

  async function collect(entries: unknown, entrySource: string, projectPath?: string, inherited?: unknown): Promise<void> {
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
        const merged = isRecord(inherited) ? mergeConfigTables(inherited[name], value) : value
        if (!isRecord(merged)) throw invalidMcpConfigError()
        const server = await importCodexMcpServer(name, merged, { ...importContext, projectPath })
        candidate.server = ctx.validateServer(server)
      } catch (error) {
        candidate.unsupportedReason = error instanceof McpImportError
          ? error.message
          : "This MCP configuration could not be imported. Review its source and executable."
      }
      result.candidates.push(candidate)
    }
  }

  await collect(config.mcp_servers, source)
  if (config.projects !== undefined && !isRecord(config.projects)) result.warnings.push(`Invalid project list in ${source}`)
  const seen = new Set<string>()
  for (const [project, projectSettings] of Object.entries(isRecord(config.projects) ? config.projects : {})) {
    if (!ctx.path.isAbsolute(project) || project.includes("\0") || project.length > 4096) continue
    if (!isRecord(projectSettings) || projectSettings.trust_level !== "trusted") continue
    const projectPath = ctx.path.resolve(project)
    const identity = ctx.platform === "win32" ? projectPath.toLowerCase() : projectPath
    if (seen.has(identity)) continue
    seen.add(identity)
    try { if (!(await stat(projectPath)).isDirectory()) continue }
    catch { continue }
    const projectSource = ctx.path.join(projectPath, ".codex", "config.toml")
    const projectConfig = await readStructuredConfig(projectSource, parseToml, result.warnings)
    if (projectConfig) await collect(projectConfig.mcp_servers, projectSource, projectPath, config.mcp_servers)
  }
  return result
}

export const codexPlugin: AgentProviderPlugin<"codex"> = {
  id: "codex",
  template: { id: "codex", name: "Codex", defaultBinaryPath: "codex", supportsUsage: true },
  provider: codexProvider,
  bundledAdapter: {
    argument: CODEX_ACP_ARGUMENT,
    run: runCodexAdapter,
  },
  parseComposerSkill: parseCodexComposerSkill,
  setup: {
    prioritySearchDirectories: ctx => ctx.env.CODEX_INSTALL_DIR ? [ctx.env.CODEX_INSTALL_DIR] : [],
    searchDirectories(ctx) {
      if (ctx.platform !== "win32") return []
      const local = ctx.env.LOCALAPPDATA ?? ctx.path.join(ctx.home, "AppData", "Local")
      return [ctx.path.join(local, "Programs", "OpenAI", "Codex", "bin")]
    },
    validateBinary(binary, ctx) {
      // Bundled adapter launches Codex directly; Windows shell shims cannot be CODEX_PATH.
      if (ctx.platform === "win32" && /\.(?:cmd|bat|ps1)$/iu.test(binary)) {
        return "Select the native .exe for this provider, or install its official native CLI."
      }
      return undefined
    },
    identityPattern: /\bcodex\b/iu,
    async checkAuth(binary, ctx) {
      try {
        const result = await ctx.run(binary, ["login", "status"], ctx.env, ctx.home)
        const output = stripAnsiText(`${result.stdout}\n${result.stderr}`)
        if (/\bnot (?:logged in|authenticated)\b/iu.test(output)) return "unauthenticated"
        if (result.code === 0 && /\blogged in\b/iu.test(output)) return "authenticated"
      } catch { /* Old CLIs and unavailable status endpoints cannot establish authentication. */ }
      return "unknown"
    },
    resolveInstaller: ctx => resolveStandardUrlInstaller(ctx, {
      unixUrl: "https://chatgpt.com/codex/install.sh",
      unixShell: "sh",
      windowsUrl: "https://chatgpt.com/codex/install.ps1",
    }),
    nonInteractiveInstaller(launch, ctx) {
      // Background upgrades have no terminal for installer prompts. Codex's official
      // installer uses this flag to skip its final "Start Codex now?" question.
      return {
        command: launch.command,
        args: ctx.platform === "win32" ? ["-NonInteractive", ...launch.args] : launch.args,
        env: { ...ctx.env, CODEX_NON_INTERACTIVE: "1" },
      }
    },
    resolveLogin(binary, _input, _probeResult, ctx) {
      if (!binary) throw new Error("Install or select the provider executable before signing in.")
      return launchProviderCommand(binary, ["login", "--device-auth"], ctx.env, ctx.platform)
    },
  },
  update: {
    versionSource: () => ({
      url: "https://releases.openai.com/codex/channels/latest",
      parse: jsonVersionParser(),
    }),
  },
  discoverWorkspaces: discoverCodexWorkspaces,
  discoverMcpServers: discoverCodexMcpServers,
}
