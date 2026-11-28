import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { ForkSessionRequest, InitializeResponse, NewSessionRequest, PromptResponse, ResumeSessionRequest, Usage } from "@agentclientprotocol/sdk/unstable"
import {
  connectAcpProcess, jsonVersionParser, launchProviderCommand, resolveBashScriptInstaller,
  resolvePowerShellScriptInstaller, supportsAutoInstallPlatform,
  UNSUPPORTED_INSTALL_PLATFORM_MESSAGE,
  type AgentConnection, type AgentProvider, type AgentProviderPlugin,
} from "@deskfleet/agent-core"
import { LEGACY_ANTIGRAVITY_BINARY, normalizeAntigravityBinaryPath } from "@deskfleet/protocol/agents/antigravity"

export { LEGACY_ANTIGRAVITY_BINARY, normalizeAntigravityBinaryPath }

function mergeUsage(a?: Usage | null, b?: Usage | null): Usage | undefined {
  if (!a || !b) return a ?? b ?? undefined
  const add = (x?: number | null, y?: number | null) => (x != null || y != null ? (x ?? 0) + (y ?? 0) : undefined)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedReadTokens: add(a.cachedReadTokens, b.cachedReadTokens),
    cachedWriteTokens: add(a.cachedWriteTokens, b.cachedWriteTokens),
    thoughtTokens: add(a.thoughtTokens, b.thoughtTokens),
  }
}

interface Turn {
  steered: Promise<PromptResponse>[]
  cancelled: boolean
}

function supportsAntigravitySystemPromptAppend(initialization: InitializeResponse): boolean {
  const meta = initialization.agentCapabilities?._meta
  if (!meta || typeof meta !== "object") return false
  const antigravity = (meta as Record<string, unknown>).antigravity
  if (!antigravity || typeof antigravity !== "object") return false
  const systemPrompt = (antigravity as Record<string, unknown>).systemPrompt
  return Boolean(systemPrompt && typeof systemPrompt === "object" && (systemPrompt as Record<string, unknown>).append === true)
}

function withAntigravitySystemPrompt<T extends NewSessionRequest | ResumeSessionRequest | ForkSessionRequest>(params: T): T {
  const { systemPrompt, ...rest } = params
  if (!systemPrompt || systemPrompt.mode !== "append") return params
  const text = systemPrompt.content
    .flatMap(block => block.type === "text" && block.text.trim() ? [block.text.trim()] : [])
    .join("\n\n")
  if (!text) return rest as unknown as T
  const existingMeta = params._meta && typeof params._meta === "object" ? params._meta as Record<string, unknown> : {}
  const existingAntigravity = existingMeta.antigravity && typeof existingMeta.antigravity === "object"
    ? existingMeta.antigravity as Record<string, unknown>
    : {}
  return {
    ...rest,
    _meta: {
      ...existingMeta,
      antigravity: {
        ...existingAntigravity,
        systemPrompt: { append: text },
      },
    },
  } as unknown as T
}

/**
 * Bridges turn steering for `agy acp` by chaining active `session/prompt` legs
 * and merging usage, and maps appended system prompts to Antigravity's `_meta`
 * extension when supported.
 */
export function wrapAntigravityConnection(
  connection: AgentConnection,
  signal?: AbortSignal,
): AgentConnection {
  const turns = new Map<string, Turn>()
  const translateSystemPrompt = !connection.initialization.agentCapabilities?.sessionCapabilities?.systemPrompt
    && supportsAntigravitySystemPromptAppend(connection.initialization)
  const initialization: InitializeResponse = {
    ...connection.initialization,
    ...(translateSystemPrompt ? {
      agentCapabilities: {
        ...connection.initialization.agentCapabilities,
        sessionCapabilities: {
          ...connection.initialization.agentCapabilities?.sessionCapabilities,
          systemPrompt: {},
        },
      },
    } : {}),
    _meta: {
      ...connection.initialization._meta,
      steering: { supported: true, supportsPromptRequired: true },
    },
  }

  return {
    ...connection,
    initialization,
    newSession: params => connection.newSession(translateSystemPrompt ? withAntigravitySystemPrompt(params) : params),
    resume: params => connection.resume(translateSystemPrompt ? withAntigravitySystemPrompt(params) : params),
    ...(connection.forkSession ? {
      forkSession: (params: ForkSessionRequest) => connection.forkSession!(translateSystemPrompt ? withAntigravitySystemPrompt(params) : params),
    } : {}),
    async prompt(params) {
      const { sessionId } = params
      const turn: Turn = {
        steered: [],
        cancelled: Boolean(signal?.aborted),
      }
      const onAbort = () => {
        turn.cancelled = true
        if (turns.get(sessionId) === turn) {
          turns.delete(sessionId)
        }
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (!turn.cancelled) {
        turns.set(sessionId, turn)
      }

      let stopReason: PromptResponse["stopReason"] = "end_turn"
      let usage: Usage | undefined
      try {
        let next: Promise<PromptResponse> | undefined = connection.prompt(params)
        while (next) {
          const res = await next
          usage = mergeUsage(usage, res.usage)
          stopReason = res.stopReason
          next = turn.steered.shift()
        }
      } finally {
        signal?.removeEventListener("abort", onAbort)
        if (turns.get(sessionId) === turn) {
          turns.delete(sessionId)
        }
      }

      return {
        stopReason: turn.cancelled ? "cancelled" : stopReason,
        ...(usage ? { usage } : {}),
      }
    },
    async steer(params) {
      const turn = turns.get(params.sessionId)
      if (!turn) {
        return { outcome: "inactive" }
      }
      const next = connection.prompt(params)
      next.catch(() => {})
      turn.steered.push(next)
      return { outcome: "injected" }
    },
    async cancel(sessionId) {
      const turn = turns.get(sessionId)
      if (turn) {
        turn.cancelled = true
        turns.delete(sessionId)
      }
      await connection.cancel(sessionId)
    },
  }
}

/** Antigravity CLI serves ACP directly and uses its existing local credentials. */
export const antigravityProvider: AgentProvider = {
  id: "antigravity",
  async connect(config, client) {
    const geminiDir = config.env?.GEMINI_HOME ?? process.env.GEMINI_HOME
    const baseArgs = geminiDir ? ["acp", "--gemini-dir", geminiDir] : ["acp"]
    if (client.inferenceOnly) {
      const cwd = client.inferenceOnly.cwd
      const name = basename(cwd).toLowerCase()
      const directory = join(cwd, ".agents", "agents")
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, name + ".md"), [
        "---", "name: " + name, "description: DeskFleet foreground routing", "mainAgent: true", "subagent: false",
        "tools: []", "mcpServers: []", "skills: []", "plugins: []", "commandExecutionPolicy: off", "---",
        "Return the requested routing decision using only the information supplied in the prompt.",
      ].join("\n"), { flag: "wx", mode: 0o600 })
      return connectAcpProcess(launchProviderCommand(config.binaryPath || "agy", [...baseArgs, "--agent", name, "--sandbox"], config.env), client)
    }
    const args = geminiDir
      ? ["acp", "--process-per-session", "--gemini-dir", geminiDir]
      : ["acp", "--process-per-session"]
    const connection = await connectAcpProcess(
      launchProviderCommand(config.binaryPath || "agy", args, config.env),
      client,
    )
    return wrapAntigravityConnection(connection, client.signal)
  },
}

export const antigravityPlugin: AgentProviderPlugin<"antigravity"> = {
  id: "antigravity",
  template: { id: "antigravity", name: "Antigravity", defaultBinaryPath: "agy" },
  provider: antigravityProvider,
  normalizeBinaryPath: normalizeAntigravityBinaryPath,
  setup: {
    searchDirectories(ctx) {
      if (ctx.platform !== "win32") return []
      const local = ctx.env.LOCALAPPDATA ?? ctx.path.join(ctx.home, "AppData", "Local")
      return [ctx.path.join(local, "agy", "bin")]
    },
    identityPattern: /\bagy\b|Antigravity/iu,
    async resolveInstaller(ctx) {
      if (!supportsAutoInstallPlatform(ctx)) return UNSUPPORTED_INSTALL_PLATFORM_MESSAGE
      if (ctx.platform === "win32") {
        return resolvePowerShellScriptInstaller(
          ctx,
          "$ErrorActionPreference = 'Stop'; if (Test-Path \"$env:LOCALAPPDATA\\agy\\bin\\agy.exe\") { & \"$env:LOCALAPPDATA\\agy\\bin\\agy.exe\" update } else { Invoke-RestMethod 'https://antigravity.google/cli/install.ps1' | Invoke-Expression }; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
        )
      }
      return resolveBashScriptInstaller(
        ctx,
        "if [ -x \"$HOME/.local/bin/agy\" ]; then \"$HOME/.local/bin/agy\" update; else curl -fsSL 'https://antigravity.google/cli/install.sh' | bash; fi",
      )
    },
    resolveLogin(binary, _input, _probeResult, ctx) {
      if (!binary) throw new Error("Install or select the provider executable before signing in.")
      const args = ["acp", ...(ctx.env.GEMINI_HOME ? ["--gemini-dir", ctx.env.GEMINI_HOME] : []), "--login"]
      return launchProviderCommand(binary, args, ctx.env, ctx.platform)
    },
  },
  update: {
    versionSource: (platform, arch) => ({
      url: `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform === "win32" ? "windows" : platform}_${arch === "x64" ? "amd64" : "arm64"}.json`,
      parse: jsonVersionParser(),
    }),
  },
}
