import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { createInterface } from "node:readline"
import type { AgentQuotaItem } from "./agent-configuration-protocol.ts"
import type { AgentConfig, AgentProvider } from "./agents/acp.ts"
import { launchProviderCommand, runProbeCommand } from "./provider-setup-process.ts"

const USAGE_TTL_MS = 60_000
const PROVIDER_USAGE_TIMEOUT_MS = 20_000

export const clampQuota = (value: number): number => Math.min(1, Math.max(0, value))

export function providerProcessEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [...Object.entries(process.env), ...Object.entries(overrides ?? {})]
      .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]),
  )
}

/** Runs a one-shot JSON CLI command and returns stdout when it starts with a JSON object. */
export async function runUsageJsonCommand(
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout, stderr, code } = await runProbeCommand(command, args, providerProcessEnv(env), tmpdir(), signal, PROVIDER_USAGE_TIMEOUT_MS)
  if (stdout.trim().startsWith("{")) return stdout
  throw new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? "unknown"}`)
}

/** Runs a bounded newline-delimited JSON request/response exchange with a provider CLI. */
export async function runJsonLineExchange<T>(options: {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  start(send: (frame: Record<string, unknown>) => void): void
  onFrame(frame: Record<string, unknown>, send: (frame: Record<string, unknown>) => void): T | undefined
}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? PROVIDER_USAGE_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  signal.throwIfAborted()

  const launch = launchProviderCommand(options.command, options.args, options.env)
  const child = spawn(launch.command, launch.args ?? [], {
    env: launch.env,
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const closed = new Promise<number | null>(resolve => child.once("close", code => resolve(code)))
  let spawnError: Error | undefined
  let stderr = ""

  child.stdin.on("error", () => {})
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 8_192) stderr += chunk
  })
  const stop = () => {
    lines.close()
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
  }
  child.once("error", error => {
    spawnError = error
    stop()
  })
  signal.addEventListener("abort", stop, { once: true })

  const send = (frame: Record<string, unknown>) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  try {
    options.start(send)
    for await (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line.startsWith("{")) continue
      let frame: Record<string, unknown>
      try { frame = JSON.parse(line) as Record<string, unknown> } catch { continue }
      const result = options.onFrame(frame, send)
      if (result !== undefined) return result
    }
  } finally {
    signal.removeEventListener("abort", stop)
    child.stdin.end()
    stop()
  }

  if (timeout.aborted) throw new Error(`${options.command} timed out after ${timeoutMs}ms`)
  options.signal?.throwIfAborted()
  if (spawnError) throw spawnError
  const code = await closed
  throw new Error(stderr.trim() || `${options.command} exited with code ${code ?? "unknown"}`)
}

/** Deduplicates concurrent provider quota reads and caches recent snapshots briefly. */
export class AgentUsageCache {
  readonly #entries = new Map<string, { value: AgentQuotaItem[]; expiresAt: number }>()
  readonly #pending = new Map<string, Promise<AgentQuotaItem[]>>()
  #generation = 0

  read(
    providerId: string,
    launch: { provider: AgentProvider; config: AgentConfig },
    signal?: AbortSignal,
  ): Promise<AgentQuotaItem[]> {
    if (!launch.provider.readUsage) return Promise.resolve([])
    const cached = this.#entries.get(providerId)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
    const inflight = this.#pending.get(providerId)
    if (inflight) return inflight
    const generation = this.#generation
    const reading = launch.provider.readUsage(launch.config, signal).then(value => {
      if (generation === this.#generation) this.#entries.set(providerId, { value, expiresAt: Date.now() + USAGE_TTL_MS })
      return value
    }).finally(() => {
      if (this.#pending.get(providerId) === reading) this.#pending.delete(providerId)
    })
    this.#pending.set(providerId, reading)
    return reading
  }

  clear(): void {
    this.#generation++
    this.#entries.clear()
    this.#pending.clear()
  }
}
