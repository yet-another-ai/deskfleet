import { randomUUID } from "node:crypto"
import { AgentConfigurationProbes } from "./configuration-probes.ts"
import { agentConfigurationIdentity, cachedAgentConfiguration } from "@deskfleet/protocol/agent-configuration-matrix"
import {
  agentConfigurationSelection, normalizeAgentConfigurationSelection,
  type AgentConfiguration, type AgentConfigurationMatrix, type AgentConfigurationParams,
  type AgentConfigurationSelection, type AgentConfigurationSnapshot,
} from "@deskfleet/protocol/agent-configuration"
import type { AgentConfig, AgentProvider } from "../acp/connection.ts"

interface Launch { provider: AgentProvider; config: AgentConfig }
interface Target { provider: string; workspaceId?: string }
interface ReadRequest { signal: AbortSignal; probes: Set<string> }
interface Entry {
  params: Target
  cwd: string
  launch: Launch
  controller: AbortController
  matrix: AgentConfigurationMatrix
  matrixGeneration: number
  identities: Map<string, number>
  initial?: Promise<AgentConfigurationSnapshot>
  initialComposer?: Promise<AgentConfigurationSnapshot>
  probeId: string
  probes: Set<string>
  queued: boolean
  exploring: boolean
  explored: boolean
}

function selectionSteps(selection: AgentConfigurationSelection, configuration: AgentConfigurationSnapshot): AgentConfigurationSelection[] {
  const normalized = normalizeAgentConfigurationSelection(selection, configuration.configOptions ?? [])
  return [
    ...(["model", "reasoningEffort", "mode"] as const).flatMap(key => normalized[key] === undefined ? [] : [{ [key]: normalized[key] }]),
    ...Object.entries(normalized.configValues ?? {}).map(([id, value]) => ({ configValues: { [id]: value } })),
  ]
}

function choices(configuration: AgentConfigurationSnapshot): AgentConfigurationSelection[] {
  const primary = new Set([configuration.models?.id, configuration.reasoningEfforts?.id, configuration.modes?.id])
  return [
    ...(["model", "reasoningEffort", "mode"] as const).flatMap((key, index) => {
      const option = [configuration.models, configuration.reasoningEfforts, configuration.modes][index]
      return option?.options.filter(choice => choice.id !== option.currentValue).map(choice => ({ [key]: choice.id })) ?? []
    }),
    ...(configuration.configOptions ?? []).filter(option => !primary.has(option.id)).flatMap(option => {
      const values = option.type === "boolean" ? [!option.currentValue]
        : option.options.flatMap(row => "group" in row ? row.options : [row]).map(choice => choice.value)
      return values.filter(value => value !== option.currentValue).map(value => ({ configValues: { [option.id]: value } }))
    }),
  ]
}

/** Registration-owned immutable catalogs; background ACP sessions never become user draft sessions. */
export class AgentConfigurationCache {
  readonly #probes = new AgentConfigurationProbes()
  readonly #scope = randomUUID()
  readonly #entries = new Map<string, Entry>()
  readonly #queue: Entry[] = []
  readonly #tasks = new Set<Promise<unknown>>()
  readonly #maxStates: number
  readonly #maxTransitions: number
  readonly #timeoutMs: number
  readonly #requestTimeoutMs: number
  readonly #concurrency: number
  #active = 0
  #closed = false

  constructor(options: { maxStates?: number; maxTransitions?: number; timeoutMs?: number; requestTimeoutMs?: number; concurrency?: number } = {}) {
    this.#maxStates = options.maxStates ?? 256
    this.#maxTransitions = options.maxTransitions ?? 4_096
    this.#timeoutMs = options.timeoutMs ?? 120_000
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 45_000
    this.#concurrency = options.concurrency ?? 2
  }

  #key(params: Target, cwd: string, launch: Launch): string {
    return JSON.stringify([params.provider, params.workspaceId, cwd, launch.config.name, launch.config.binaryPath, launch.config.commandDirectory,
      Object.entries(launch.config.env ?? {}).sort(([left], [right]) => left.localeCompare(right))])
  }

  #entry(params: Target, cwd: string, launch: Launch): Entry {
    if (this.#closed) throw new Error("Agent configuration cache is stopping")
    const key = this.#key(params, cwd, launch)
    let entry = this.#entries.get(key)
    if (!entry || entry.launch.provider !== launch.provider) {
      if (entry) void this.#cancel(entry).catch(() => {})
      const probeId = randomUUID()
      entry = {
        params: { provider: params.provider, ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}) }, cwd,
        launch: { provider: launch.provider, config: { ...launch.config, authentication: "existing" } },
        controller: new AbortController(), matrix: { configurations: [], transitions: [], complete: false }, matrixGeneration: 0,
        identities: new Map(), probeId, probes: new Set([probeId]), queued: false, exploring: false, explored: false,
      }
      this.#entries.set(key, entry)
    }
    return entry
  }

  #check(entry: Entry): void {
    entry.controller.signal.throwIfAborted()
    if (this.#closed) throw new Error("Agent configuration cache is stopping")
  }

  #track<T>(task: Promise<T>): Promise<T> {
    this.#tasks.add(task)
    void task.finally(() => this.#tasks.delete(task)).catch(() => {})
    return task
  }

  #remember(entry: Entry, configuration: AgentConfigurationSnapshot): number | undefined {
    this.#check(entry)
    const identity = agentConfigurationIdentity(configuration)
    const existing = entry.identities.get(identity)
    if (existing !== undefined) {
      const previous = entry.matrix.configurations[existing]!
      entry.matrix.configurations[existing] = structuredClone({ ...previous, ...configuration })
      return existing
    }
    if (entry.matrix.configurations.length >= this.#maxStates) {
      entry.matrix.complete = false
      return undefined
    }
    const index = entry.matrix.configurations.push(structuredClone(configuration)) - 1
    entry.identities.set(identity, index)
    entry.matrix.complete = false
    return index
  }

  #transition(entry: Entry, before: AgentConfigurationSnapshot, selection: AgentConfigurationSelection, after: AgentConfigurationSnapshot): void {
    const from = this.#remember(entry, before)
    const to = this.#remember(entry, after)
    if (from === undefined || to === undefined) return
    const encoded = JSON.stringify(selection)
    const existing = entry.matrix.transitions.find(transition => transition.from === from && JSON.stringify(transition.selection) === encoded)
    if (existing) {
      if (existing.to !== to) entry.matrix.complete = false
      existing.to = to
    }
    else if (entry.matrix.transitions.length < this.#maxTransitions) entry.matrix.transitions.push({ from, selection: structuredClone(selection), to })
    else entry.matrix.complete = false
  }

  #observeDefault(entry: Entry, configuration: AgentConfigurationSnapshot, generation: number, warm: boolean): number | undefined {
    this.#check(entry)
    if (generation !== entry.matrixGeneration) return undefined
    const previous = entry.matrix.configurations[0]
    if (previous && agentConfigurationIdentity(previous) !== agentConfigurationIdentity(configuration)) {
      // A fresh ACP session has supplied new defaults, not another selection of
      // the old catalog. Old edges and in-flight traversal belong to that catalog.
      entry.matrixGeneration++
      entry.matrix = { configurations: [], transitions: [], complete: false }
      entry.identities.clear()
      entry.initial = Promise.resolve(structuredClone(configuration))
      entry.initialComposer = entry.initial
      entry.explored = false
    }
    this.#remember(entry, configuration)
    if (warm) this.#queueWarm(entry)
    return entry.matrixGeneration
  }

  #result(entry: Entry, configuration: AgentConfigurationSnapshot, includeMatrix: boolean): AgentConfiguration {
    this.#check(entry)
    return structuredClone(includeMatrix ? { ...configuration, matrix: entry.matrix } : configuration)
  }

  #readProbe(entry: Entry, probeId: string, selection: AgentConfigurationSelection = {}, composer = false, launch = entry.launch): Promise<AgentConfiguration> {
    this.#check(entry)
    return this.#probes.read(this.#scope, { ...entry.params, probeId, ...selection, ...(composer ? { composer: true } : {}) }, entry.cwd, launch)
  }

  #initialize(entry: Entry, composer = true): Promise<AgentConfigurationSnapshot> {
    if (!entry.initial) {
      entry.initial = this.#readProbe(entry, entry.probeId).then(configuration => {
        this.#remember(entry, configuration)
        return configuration
      }).catch(async error => {
        await this.#probes.release(this.#scope, entry.probeId).catch(() => {})
        entry.initial = undefined
        throw error
      })
    }
    if (!composer) return entry.initial
    // The model picker can use session/new immediately. Composer consumers
    // share the same probe while waiting for its optional command notification.
    return entry.initialComposer ??= entry.initial.then(async configuration => {
      if (configuration.commands !== undefined || configuration.skills !== undefined) return configuration
      const generation = entry.matrixGeneration
      const enriched = await this.#readProbe(entry, entry.probeId, {}, true)
      this.#observeDefault(entry, enriched, generation, false)
      return enriched
    }).catch(error => {
      entry.initialComposer = undefined
      throw error
    })
  }

  warm(params: Target, cwd: string, launch: Launch): void {
    if (this.#closed) return
    this.#queueWarm(this.#entry(params, cwd, launch))
  }

  #queueWarm(entry: Entry): void {
    if (entry.queued || entry.exploring || entry.explored || entry.controller.signal.aborted || this.#closed) return
    entry.queued = true
    this.#queue.push(entry)
    this.#drain()
  }

  #drain(): void {
    while (!this.#closed && this.#active < this.#concurrency && this.#queue.length) {
      const entry = this.#queue.shift()!
      entry.queued = false
      if (entry.controller.signal.aborted) continue
      entry.exploring = true
      this.#active++
      this.#track(this.#explore(entry).catch(() => {}).finally(() => {
        entry.exploring = false
        this.#active--
        this.#queueWarm(entry)
        this.#drain()
      }))
    }
  }

  async #explore(entry: Entry): Promise<void> {
    const generation = entry.matrixGeneration
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      void this.#probes.release(this.#scope, entry.probeId).catch(() => {})
    }, this.#timeoutMs)
    timer.unref()
    let complete = true
    let attempts = 0
    try {
      // Catalog notifications may repeat while a CLI is absent or signed out.
      // Retry those failures only for an explicit read/refresh or a new revision.
      entry.explored = true
      await this.#initialize(entry)
      if (generation !== entry.matrixGeneration) return
      // Each new state is appended. Breadth-first traversal visits default model
      // alternatives first without assuming other controls are independent.
      outer: for (let from = 0; from < entry.matrix.configurations.length; from++) {
        const source = entry.matrix.configurations[from]!
        for (const selection of choices(source)) {
          this.#check(entry)
          if (generation !== entry.matrixGeneration) return
          if (expired || attempts >= this.#maxTransitions || entry.matrix.configurations.length >= this.#maxStates) {
            complete = false
            break outer
          }
          if (cachedAgentConfiguration(entry.matrix, source, selection)) continue
          attempts++
          try {
            const restored = await this.#readProbe(entry, entry.probeId, agentConfigurationSelection(source))
            if (generation !== entry.matrixGeneration) return
            if (expired) { complete = false; break outer }
            // A provider may decline a restore or change its catalog. Such a
            // result is not evidence for an edge from the original state.
            if (agentConfigurationIdentity(restored) !== agentConfigurationIdentity(source)) {
              complete = false
              continue
            }
            const changed = await this.#readProbe(entry, entry.probeId, selection)
            if (generation !== entry.matrixGeneration) return
            if (expired) { complete = false; break outer }
            this.#transition(entry, source, selection, changed)
          } catch {
            this.#check(entry)
            if (generation !== entry.matrixGeneration) return
            complete = false
            if (expired) break outer
          }
        }
      }
      this.#check(entry)
      if (generation === entry.matrixGeneration) entry.matrix.complete = complete && !expired
    } finally {
      clearTimeout(timer)
      await this.#probes.release(this.#scope, entry.probeId).catch(() => {})
    }
  }

  read(params: AgentConfigurationParams, cwd: string, launch: Launch): Promise<AgentConfiguration> {
    const controller = new AbortController()
    const request: ReadRequest = { signal: controller.signal, probes: new Set() }
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Agent configuration request timed out")
        controller.abort(error)
        // Shared startup/traversal has its own budget and may serve other readers.
        for (const probeId of request.probes) this.#track(this.#probes.release(this.#scope, probeId).catch(() => {}))
        reject(error)
      }, this.#requestTimeoutMs)
    })
    const reading = this.#track(this.#read(params, cwd, launch, request))
    return this.#track(Promise.race([reading, deadline]).finally(() => clearTimeout(timer)))
  }

  async #read(params: AgentConfigurationParams, cwd: string, launch: Launch, request: ReadRequest): Promise<AgentConfiguration> {
    if (params.refresh) {
      const key = this.#key(params, cwd, launch)
      const old = this.#entries.get(key)
      if (old) { this.#entries.delete(key); await this.#cancel(old) }
    }
    request.signal.throwIfAborted()
    const entry = this.#entry(params, cwd, launch)
    const initialized = entry.matrix.configurations.length > 0
    const includeMatrix = params.includeMatrix !== false
    if (includeMatrix) this.#queueWarm(entry)
    await this.#initialize(entry, includeMatrix || params.composer === true)
    request.signal.throwIfAborted()
    this.#check(entry)
    if (includeMatrix && !initialized && !entry.exploring) {
      entry.explored = false
      this.#queueWarm(entry)
    }
    const source = cachedAgentConfiguration(entry.matrix, undefined, params.restore ?? {})
    const cached = source && cachedAgentConfiguration(entry.matrix, source, params)
    if (cached && (!params.composer || cached.commands !== undefined || cached.skills !== undefined || !initialized)) return this.#result(entry, cached, includeMatrix)
    // Discovery of an uncached transition has its own process, so a foreground
    // click never queues behind background traversal of other configurations.
    const probeId = randomUUID()
    entry.probes.add(probeId)
    request.probes.add(probeId)
    const privateLaunch: Launch = {
      config: entry.launch.config,
      provider: {
        id: entry.launch.provider.id,
        connect: (config, client) => {
          request.signal.throwIfAborted()
          const signal = client.signal ? AbortSignal.any([client.signal, request.signal]) : request.signal
          return entry.launch.provider.connect(config, { ...client, signal })
        },
      },
    }
    try {
      let generation: number | undefined = entry.matrixGeneration
      let current = await this.#readProbe(entry, probeId, {}, params.composer === true, privateLaunch)
      request.signal.throwIfAborted()
      generation = this.#observeDefault(entry, current, generation, includeMatrix)
      for (const selection of [params.restore ?? {}, params]) {
        for (const step of selectionSteps(selection, current)) {
          request.signal.throwIfAborted()
          const next = await this.#readProbe(entry, probeId, step, false, privateLaunch)
          request.signal.throwIfAborted()
          if (generation === entry.matrixGeneration) this.#transition(entry, current, step, next)
          current = next
        }
      }
      this.#check(entry)
      // Keep this private selection, but do not pair an older process's catalog
      // with a matrix replaced by another reader while discovery was pending.
      return generation === entry.matrixGeneration ? this.#result(entry, current, includeMatrix) : structuredClone(current)
    } finally {
      await this.#probes.release(this.#scope, probeId).catch(() => {})
      entry.probes.delete(probeId)
      request.probes.delete(probeId)
    }
  }

  async #cancel(entry: Entry): Promise<void> {
    entry.controller.abort(new Error("Agent configuration cache was invalidated"))
    await Promise.all([...entry.probes].map(probeId => this.#probes.release(this.#scope, probeId)))
  }

  async invalidate(): Promise<void> {
    for (const entry of this.#entries.values()) entry.controller.abort(new Error("Agent provider settings changed"))
    this.#entries.clear()
    this.#queue.length = 0
    await this.#probes.invalidate()
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const entry of this.#entries.values()) entry.controller.abort(new Error("Agent configuration cache is stopping"))
    this.#entries.clear()
    this.#queue.length = 0
    await this.#probes.close()
    await Promise.allSettled(this.#tasks)
  }
}
