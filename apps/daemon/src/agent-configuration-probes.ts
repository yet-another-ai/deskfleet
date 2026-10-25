import type * as acp from "@agentclientprotocol/sdk"
import { applyAgentConfiguration } from "./agent-configuration.ts"
import { agentConfiguration, type AgentConfiguration, type AgentConfigurationParams } from "./agent-configuration-protocol.ts"
import type { AgentConfig, AgentConnection, AgentProvider } from "./agents/acp.ts"

interface Launch { provider: AgentProvider; config: AgentConfig }
interface Probe {
  key: string
  identity: string
  provider: AgentProvider
  controller: AbortController
  createdAt: number
  lastUsed: number
  pending: number
  queue: Promise<unknown>
  connecting?: Promise<AgentConnection>
  connection?: AgentConnection
  sessionId?: string
  options: acp.SessionConfigOption[]
  notifiedOptions?: acp.SessionConfigOption[]
  configuring: boolean
  idleTimer?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
  retired: boolean
}

function launchIdentity(params: AgentConfigurationParams, cwd: string, config: AgentConfig): string {
  return JSON.stringify([params.provider, params.workspaceId, cwd, config.name, config.binaryPath,
    Object.entries(config.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ])
}

/** Short-lived, caller-scoped ACP sessions for draft choices. These never prompt or own worktrees. */
export class AgentConfigurationProbes {
  readonly #idleMs: number
  readonly #maxAgeMs: number
  readonly #maxProbes: number
  readonly #timeoutMs: number
  readonly #probes = new Map<string, Probe>()
  // Retiring processes still occupy capacity until their close promise settles.
  readonly #live = new Set<Probe>()
  readonly #requests = new Set<Promise<AgentConfiguration>>()
  readonly #waitingKeys = new Map<string, number>()
  #admission: Promise<unknown> = Promise.resolve()
  #invalidating = 0
  #closed = false

  constructor(options: { idleMs?: number; maxAgeMs?: number; maxProbes?: number; timeoutMs?: number } = {}) {
    this.#idleMs = options.idleMs ?? 60_000
    this.#maxAgeMs = options.maxAgeMs ?? 300_000
    this.#maxProbes = options.maxProbes ?? 8
    this.#timeoutMs = options.timeoutMs ?? 45_000
  }

  read(scope: string, params: AgentConfigurationParams, cwd: string, launch: Launch): Promise<AgentConfiguration> {
    const reading = this.#read(scope, params, cwd, launch)
    this.#requests.add(reading)
    void reading.finally(() => this.#requests.delete(reading)).catch(() => {})
    return reading
  }

  async #read(scope: string, params: AgentConfigurationParams, cwd: string, launch: Launch): Promise<AgentConfiguration> {
    const probeId = params.probeId
    if (!probeId) throw new Error("Agent configuration probe ID is required")
    const key = JSON.stringify([scope, probeId])
    const identity = launchIdentity(params, cwd, launch.config)
    const existing = this.#probes.get(key)
    // Reusing an admitted process needs no capacity decision. A different
    // provider's slow shutdown must not hold up this probe's next setter.
    // Pending release/replacement/settings invalidation still takes precedence.
    if (!this.#closed && !this.#invalidating && !this.#waitingKeys.has(key) && existing && !existing.retired
      && existing.identity === identity && existing.provider === launch.provider && Date.now() - existing.createdAt < this.#maxAgeMs) {
      return this.#enqueue(existing, params, cwd, launch)
    }
    const admitted = await this.#serializeKey(key, async () => {
      if (this.#closed) throw new Error("Agent configuration service is stopping")
      let current = this.#probes.get(key)
      if (current && (current.identity !== identity || current.provider !== launch.provider || Date.now() - current.createdAt >= this.#maxAgeMs)) {
        // An age refresh does not interrupt an already admitted selection.
        if (current.identity === identity && current.provider === launch.provider) await current.queue.catch(() => {})
        await this.#retire(current, new Error("Agent configuration probe was replaced"))
        current = undefined
      }
      if (!current) {
        await this.#makeRoom()
        if (this.#closed) throw new Error("Agent configuration service is stopping")
        current = {
          key, identity, provider: launch.provider, controller: new AbortController(),
          createdAt: Date.now(), lastUsed: Date.now(), pending: 0, queue: Promise.resolve(),
          options: [], configuring: false, retired: false,
        }
        this.#probes.set(key, current)
        this.#live.add(current)
      }
      // Enqueue before releasing admission, so a warm fast-path request cannot
      // overtake the cold request that created this process.
      return { reading: this.#enqueue(current, params, cwd, launch) }
    })
    return admitted.reading
  }

  async #enqueue(probe: Probe, params: AgentConfigurationParams, cwd: string, launch: Launch): Promise<AgentConfiguration> {
    clearTimeout(probe.idleTimer)
    probe.idleTimer = undefined
    probe.pending++
    probe.lastUsed = Date.now()
    const operation = probe.queue.then(() => this.#configure(probe, params, cwd, launch))
    probe.queue = operation.catch(() => {})
    try { return await operation }
    finally {
      probe.pending--
      probe.lastUsed = Date.now()
      if (!probe.retired && probe.pending === 0) {
        probe.idleTimer = setTimeout(() => {
          void this.#retire(probe, new Error("Agent configuration probe expired")).catch(() => {})
        }, this.#idleMs)
        probe.idleTimer.unref()
      }
    }
  }

  async #configure(probe: Probe, params: AgentConfigurationParams, cwd: string, launch: Launch): Promise<AgentConfiguration> {
    const signal = probe.controller.signal
    signal.throwIfAborted()
    const timer = setTimeout(() => probe.controller.abort(new Error("Agent configuration request timed out")), this.#timeoutMs)
    let aborted!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      aborted = () => reject(signal.reason)
      signal.addEventListener("abort", aborted, { once: true })
    })
    const discovery = (async () => {
      if (!probe.connection) {
        probe.connecting = Promise.resolve().then(() => launch.provider.connect(launch.config, {
          signal,
          onUpdate({ update }) {
            if (probe.retired || update.sessionUpdate !== "config_option_update") return
            if (!probe.sessionId) probe.notifiedOptions = update.configOptions
            else if (!probe.configuring) probe.options = update.configOptions
          },
          onClose: reason => { void this.#retire(probe, reason).catch(() => {}) },
        }))
        probe.connection = await probe.connecting
        signal.throwIfAborted()
        const session = await probe.connection.newSession({ cwd, mcpServers: [] })
        signal.throwIfAborted()
        probe.sessionId = session.sessionId
        probe.options = session.configOptions ?? probe.notifiedOptions ?? []
        // A retained picker can outlive this process's idle/capacity lease.
        // Restore only on a new process; warm state already includes confirmed
        // provider changes and must not be overwritten by an older UI snapshot.
        if (params.restore) {
          probe.configuring = true
          probe.options = await applyAgentConfiguration(probe.connection, probe.sessionId, probe.options, params.restore,
            options => { probe.options = options })
          signal.throwIfAborted()
        }
      }
      probe.configuring = true
      probe.options = await applyAgentConfiguration(probe.connection, probe.sessionId!, probe.options, params,
        options => { probe.options = options })
      signal.throwIfAborted()
      return agentConfiguration(probe.options, { id: params.provider, name: launch.config.name })
    })()
    try {
      return await Promise.race([discovery, cancelled])
    } catch (error) {
      await this.#retire(probe, error).catch(() => {})
      throw error
    } finally {
      probe.configuring = false
      clearTimeout(timer)
      signal.removeEventListener("abort", aborted)
    }
  }

  #serializeAdmission<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#admission.then(action)
    this.#admission = operation.catch(() => {})
    return operation
  }

  #serializeKey<T>(key: string, action: () => Promise<T>): Promise<T> {
    this.#waitingKeys.set(key, (this.#waitingKeys.get(key) ?? 0) + 1)
    return this.#serializeAdmission(action).finally(() => {
      const remaining = this.#waitingKeys.get(key)! - 1
      if (remaining) this.#waitingKeys.set(key, remaining)
      else this.#waitingKeys.delete(key)
    })
  }

  async #makeRoom(): Promise<void> {
    while (this.#live.size >= this.#maxProbes) {
      const closing = [...this.#live].find(probe => probe.retired)
      if (closing) { await closing.closing; continue }
      const oldest = [...this.#live].filter(probe => probe.pending === 0).sort((left, right) => left.lastUsed - right.lastUsed)[0]
      if (!oldest) throw new Error("Too many active Agent configuration probes")
      await this.#retire(oldest, new Error("Agent configuration probe was evicted"))
    }
  }

  #retire(probe: Probe, reason: unknown): Promise<void> {
    if (probe.closing) return probe.closing
    probe.retired = true
    if (this.#probes.get(probe.key) === probe) this.#probes.delete(probe.key)
    clearTimeout(probe.idleTimer)
    probe.closing = Promise.resolve().then(async () => {
      const connection = probe.connection ?? await probe.connecting?.catch(() => undefined)
      await connection?.close()
      this.#live.delete(probe)
    })
    probe.controller.abort(reason)
    return probe.closing
  }

  release(scope: string, probeId: string): Promise<void> {
    const key = JSON.stringify([scope, probeId])
    return this.#serializeKey(key, async () => {
      const probe = this.#probes.get(key)
      if (probe) await this.#retire(probe, new Error("Agent configuration probe was released"))
    })
  }

  invalidate(): Promise<void> {
    this.#invalidating++
    return this.#serializeAdmission(async () => {
      await Promise.all([...this.#live].map(probe => this.#retire(probe, new Error("Agent provider settings changed"))))
    }).finally(() => { this.#invalidating-- })
  }

  async close(): Promise<void> {
    this.#closed = true
    // Abort first: an admission may be waiting for an old probe's active read.
    const closing = [...this.#live].map(probe => this.#retire(probe, new Error("Agent configuration service is stopping")))
    await this.#admission
    const stopped = await Promise.allSettled(closing)
    await Promise.allSettled(this.#requests)
    const errors = stopped.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Could not close Agent configuration probes")
  }
}
