import type { ForkSessionRequest, InitializeResponse, NewSessionRequest, PromptResponse, ResumeSessionRequest, SessionNotification, Usage } from "@agentclientprotocol/sdk/unstable"
import {
  clampQuota, connectAcpProcess, jsonVersionParser, launchProviderCommand, resolveBashScriptInstaller,
  resolvePowerShellScriptInstaller, runUsageJsonCommand, supportsAutoInstallPlatform,
  UNSUPPORTED_INSTALL_PLATFORM_MESSAGE,
  type AgentConnection, type AgentProvider, type AgentProviderPlugin, type AgentQuotaItem,
} from "@deskfleet/agent-core"
import { LEGACY_ANTIGRAVITY_BINARY, normalizeAntigravityBinaryPath } from "./protocol.ts"

export { LEGACY_ANTIGRAVITY_BINARY, normalizeAntigravityBinaryPath }

/** Upper bound for keeping a finished foreground turn open while its background work runs. */
const WORK_WAIT_MS = 30 * 60_000

const INACTIVE_TOOL_STATUSES: Readonly<Record<string, true>> = {
  completed: true, failed: true, cancelled: true, paused: true,
}

/**
 * Tracks work that outlives `agy`'s foreground turn: non-daemon tool calls and
 * child sessions. Antigravity answers `session/prompt` before that work settles,
 * so completing the turn immediately would cancel its approvals and let
 * Session cleanup stop the provider while processes still run.
 */
export class AntigravityWork {
  readonly #live = new Map<string, Set<string>>()
  readonly #children = new Map<string, Set<string>>()
  readonly #daemonTools = new Set<string>()
  readonly #waiters = new Set<() => void>()

  observe(notification: SessionNotification): void {
    const { sessionId } = notification
    const update = notification.update
    if (update.sessionUpdate === "subagent_update") {
      if (update.sessionId !== sessionId) {
        const children = this.#children.get(sessionId) ?? new Set<string>()
        children.add(update.sessionId)
        this.#children.set(sessionId, children)
      }
      if (update.state) {
        this.#set(sessionId, `subagent:${update.sessionId}`, update.state.state !== "idle")
      }
    } else if (update.sessionUpdate === "tool_call") {
      const rawInput = update.rawInput
      const daemon = typeof rawInput === "object" && rawInput !== null && "IsDaemon" in rawInput
        && (rawInput.IsDaemon === true || rawInput.IsDaemon === "true")
      const key = `${sessionId}\0${update.toolCallId}`
      if (daemon) this.#daemonTools.add(key)
      this.#set(sessionId, `tool:${update.toolCallId}`, !daemon
        && !INACTIVE_TOOL_STATUSES[update.status ?? "pending"])
    } else if (update.sessionUpdate === "tool_call_update" && update.status !== undefined) {
      const shared = this.#daemonTools.has(`${sessionId}\0${update.toolCallId}`)
      this.#set(sessionId, `tool:${update.toolCallId}`, !shared
        && !INACTIVE_TOOL_STATUSES[update.status ?? "pending"])
    } else return
    for (const resolve of [...this.#waiters]) resolve()
    this.#waiters.clear()
  }

  /** Drops stale work from earlier turns before a new prompt starts. */
  clear(sessionId: string, seen = new Set<string>()): void {
    if (seen.has(sessionId)) return
    seen.add(sessionId)
    this.#live.delete(sessionId)
    for (const child of this.#children.get(sessionId) ?? []) this.clear(child, seen)
  }

  /** Whether this session or any of its descendants still has work running. */
  live(sessionId: string, seen = new Set<string>()): boolean {
    if (seen.has(sessionId)) return false
    seen.add(sessionId)
    if (this.#live.get(sessionId)?.size) return true
    return [...(this.#children.get(sessionId) ?? [])].some(child => this.live(child, seen))
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    let resolve!: () => void
    const promise = new Promise<void>(finish => { resolve = finish })
    const done = () => {
      signal?.removeEventListener("abort", done)
      this.#waiters.delete(done)
      resolve()
    }
    this.#waiters.add(done)
    signal?.addEventListener("abort", done, { once: true })
    return promise
  }

  #set(sessionId: string, key: string, live: boolean): void {
    let keys = this.#live.get(sessionId)
    if (live) {
      if (!keys) this.#live.set(sessionId, keys = new Set())
      keys.add(key)
    } else if (keys) {
      keys.delete(key)
      if (!keys.size) this.#live.delete(sessionId)
    }
  }
}

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
  abort: AbortController
  wake?: () => void
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
 * and merging usage. A normal completion stays open while the provider still
 * reports background tool calls or running subagents, so their approvals and
 * live state are not retired with the foreground turn.
 */
export function wrapAntigravityConnection(
  connection: AgentConnection,
  signal?: AbortSignal,
  work?: AntigravityWork,
  options: { workWaitMs?: number } = {},
): AgentConnection {
  const workWaitMs = options.workWaitMs ?? WORK_WAIT_MS
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
        abort: new AbortController(),
      }
      const onAbort = () => {
        turn.cancelled = true
        turn.abort.abort()
        turn.wake?.()
        if (turns.get(sessionId) === turn) {
          turns.delete(sessionId)
        }
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      if (!turn.cancelled) {
        turns.set(sessionId, turn)
        work?.clear(sessionId)
      }

      let stopReason: PromptResponse["stopReason"] = "end_turn"
      let usage: Usage | undefined
      try {
        let deadline: number | undefined
        let next: Promise<PromptResponse> | undefined = connection.prompt(params)
        while (next || (stopReason === "end_turn" && !turn.cancelled && work?.live(sessionId))) {
          if (!next) {
            deadline ??= Date.now() + workWaitMs
            const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
            while (work!.live(sessionId) && !turn.cancelled && !turn.steered.length && Date.now() < deadline) {
              const wake = new AbortController()
              turn.wake = () => wake.abort()
              await work!.wait(AbortSignal.any([turn.abort.signal, wake.signal, timeout]))
              turn.wake = undefined
            }
            next = turn.cancelled ? undefined : turn.steered.shift()
            if (!next) break
            deadline = undefined
            continue
          }
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
      turn.wake?.()
      return { outcome: "injected" }
    },
    async cancel(sessionId) {
      const turn = turns.get(sessionId)
      if (turn) {
        turn.cancelled = true
        turn.abort.abort()
        turn.wake?.()
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
    const work = new AntigravityWork()
    const connection = await connectAcpProcess(
      launchProviderCommand(config.binaryPath || "agy", args, config.env),
      {
        ...client,
        async onUpdate(notification) {
          work.observe(notification)
          await client.onUpdate(notification)
        },
      },
    )
    return wrapAntigravityConnection(connection, client.signal, work)
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
