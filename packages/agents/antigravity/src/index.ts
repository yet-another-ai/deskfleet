import type { PromptResponse, Usage } from "@agentclientprotocol/sdk/unstable"
import {
  clampQuota, connectAcpProcess, jsonVersionParser, launchProviderCommand, resolveBashScriptInstaller,
  resolvePowerShellScriptInstaller, runUsageJsonCommand, supportsAutoInstallPlatform,
  UNSUPPORTED_INSTALL_PLATFORM_MESSAGE,
  type AgentConnection, type AgentProvider, type AgentProviderPlugin, type AgentQuotaItem,
} from "@deskfleet/agent-core"
import { LEGACY_ANTIGRAVITY_BINARY, normalizeAntigravityBinaryPath } from "./protocol.ts"

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

/** Bridges turn steering for `agy acp` by chaining active `session/prompt` legs and merging usage. */
export function wrapAntigravityConnection(
  connection: AgentConnection,
  signal?: AbortSignal,
): AgentConnection {
  const turns = new Map<string, { steered: Promise<PromptResponse>[]; cancelled: boolean }>()
  const initialization = {
    ...connection.initialization,
    _meta: {
      ...connection.initialization._meta,
      steering: { supported: true, supportsPromptRequired: true },
    },
  }

  return {
    ...connection,
    initialization,
    async prompt(params) {
      const { sessionId } = params
      const turn: { steered: Promise<PromptResponse>[]; cancelled: boolean } = {
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
        for (
          let next: Promise<PromptResponse> | undefined = connection.prompt(params);
          next;
          next = turn.steered.shift()
        ) {
          const res = await next
          usage = mergeUsage(usage, res.usage)
          stopReason = res.stopReason
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

/** Parses `agy -p "/usage" --output-format json` output into quota buckets. */
export function parseAntigravityUsage(stdout: string): AgentQuotaItem[] {
  const payload = JSON.parse(stdout.trim()) as {
    status?: string
    error?: string
    command?: { data?: { groups?: { name?: string; buckets?: { id?: string; name?: string; remaining_fraction?: number; reset_time?: string }[] }[] } }
  }
  if (payload.status !== "SUCCESS") throw new Error(payload.error?.trim() || "Could not read Antigravity usage")
  const items: AgentQuotaItem[] = []
  for (const group of payload.command?.data?.groups ?? []) {
    const groupName = group.name?.trim() || undefined
    for (const bucket of group.buckets ?? []) {
      const label = bucket.name?.trim() || bucket.id?.trim()
      if (typeof bucket.remaining_fraction !== "number" || !label) continue
      items.push({
        id: bucket.id?.trim() || label,
        label,
        ...(groupName ? { group: groupName } : {}),
        remaining: clampQuota(bucket.remaining_fraction),
        ...(bucket.reset_time ? { resetsAt: bucket.reset_time } : {}),
      })
    }
  }
  return items
}

/** Antigravity CLI serves ACP directly and uses its existing local credentials. */
export const antigravityProvider: AgentProvider = {
  id: "antigravity",
  async connect(config, client) {
    const geminiDir = config.env?.GEMINI_HOME ?? process.env.GEMINI_HOME
    const args = geminiDir ? ["acp", "--gemini-dir", geminiDir] : ["acp"]
    const connection = await connectAcpProcess(
      launchProviderCommand(config.binaryPath || "agy", args, config.env),
      client,
    )
    return wrapAntigravityConnection(connection, client.signal)
  },
  async readUsage(config, signal) {
    return parseAntigravityUsage(await runUsageJsonCommand(config.binaryPath || "agy", ["-p", "/usage", "--output-format", "json"], config.env, signal))
  },
}

export const antigravityPlugin: AgentProviderPlugin<"antigravity"> = {
  id: "antigravity",
  template: { id: "antigravity", name: "Antigravity", defaultBinaryPath: "agy", supportsUsage: true },
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
