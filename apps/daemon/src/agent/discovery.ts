import { homedir } from "node:os"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { validateAgentConfigurationParams, type AgentConfiguration, type AgentConfigurationParams, type AgentQuotaItem } from "@deskfleet/protocol/agent-configuration"
import { validateProviderId } from "@deskfleet/protocol/provider"
import type { DaemonCatalog } from "../machine/catalog.ts"
import { readAgentConfiguration } from "./configuration.ts"
import { AgentConfigurationCache } from "./configuration-cache.ts"
import { AgentConfigurationProbes } from "./configuration-probes.ts"
import { canonicalJson } from "./params.ts"
import type { ResolveAgentProvider } from "./runtime.ts"
import { AgentUsageCache } from "./usage.ts"

/** What a configured Agent offers before any Session uses it: configuration choices and usage quotas. */
export class AgentDiscovery {
  readonly #catalog: DaemonCatalog
  readonly #resolveProvider: ResolveAgentProvider
  readonly #configuredProviderIds: () => string[]
  readonly #signal: AbortSignal
  readonly #probes = new AgentConfigurationProbes()
  readonly #cache = new AgentConfigurationCache()
  readonly #usage = new AgentUsageCache()
  #started = false
  #generation = 0
  #unsubscribeCatalog?: () => void
  #closed = false

  constructor(catalog: DaemonCatalog, resolveProvider: ResolveAgentProvider, configuredProviderIds: () => string[], signal: AbortSignal) {
    this.#catalog = catalog
    this.#resolveProvider = resolveProvider
    this.#configuredProviderIds = configuredProviderIds
    this.#signal = signal
  }

  /** Startup and settings changes prewarm metadata without delaying machine readiness. */
  start(): void {
    if (this.#closed || this.#started) return
    this.#started = true
    this.#unsubscribeCatalog = this.#catalog.onChange(() => this.#warm())
    this.#warm()
  }

  /** Results read with earlier provider settings no longer describe the Agent. */
  providersChanged(): void {
    this.#usage.clear()
    void this.#probes.invalidate().catch(error => console.error("Could not close Agent configuration probes", error))
    this.#generation++
    void this.#cache.invalidate().catch(error => console.error("Could not close old Agent configuration cache", error)).then(() => {
      if (this.#started) this.#warm()
    })
  }

  /** Stops probe processes so a provider executable can be replaced. */
  invalidateProbes(): Promise<void> { return this.#probes.invalidate() }

  /** Reads, or releases, choices for a new Session in a Workspace or the home directory. */
  async configuration(params: Record<string, unknown>, actor: AgentActor): Promise<AgentConfiguration | null> {
    validateAgentConfigurationParams(params)
    const request = params as unknown as AgentConfigurationParams
    const scope = canonicalJson(actor)
    if (request.release) {
      await this.#probes.release(scope, request.probeId!)
      return null
    }
    let cwd = homedir()
    if (params.workspaceId !== undefined) {
      const workspace = (await this.#catalog.native.snapshot()).workspaces.find(workspace => workspace.id === params.workspaceId)
      const directory = workspace?.worktrees.find(worktree => !worktree.sessionId)?.directories[0]
      if (!directory) throw new Error("Unknown local workspace")
      cwd = directory.path
    }
    const launch = this.#resolveProvider(request.provider)
    if (request.cache) return this.#cache.read(request, cwd, launch)
    if (request.probeId) return this.#probes.read(scope, request, cwd, launch)
    return readAgentConfiguration(request, cwd, { ...launch, signal: this.#signal })
  }

  usage(params: Record<string, unknown>): Promise<AgentQuotaItem[]> {
    validateProviderId(params.provider)
    return this.#usage.read(params.provider, this.#resolveProvider(params.provider), this.#signal)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#unsubscribeCatalog?.()
    this.#usage.clear()
    const results = await Promise.allSettled([this.#probes.close(), this.#cache.close()])
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Could not close Agent configuration discovery")
  }

  #warm(): void {
    const generation = this.#generation
    void this.#catalog.native.snapshot().then(snapshot => {
      if (this.#closed || generation !== this.#generation) return
      const contexts: { workspaceId?: string; cwd: string }[] = [{ cwd: homedir() }]
      for (const workspace of snapshot.workspaces) {
        const directory = workspace.worktrees.find(worktree => !worktree.sessionId)?.directories[0]
        if (directory) contexts.push({ workspaceId: workspace.id, cwd: directory.path })
      }
      for (const provider of this.#configuredProviderIds()) {
        const launch = this.#resolveProvider(provider)
        for (const { workspaceId, cwd } of contexts) this.#cache.warm({ provider, workspaceId }, cwd, launch)
      }
    }).catch(error => { if (!this.#closed) console.error("Could not warm Agent configurations", error) })
  }
}
