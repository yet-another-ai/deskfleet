import { stripVTControlCharacters } from "node:util"
import { compareSemverVersions, extractSemverVersion } from "@deskfleet/agent-core"
import type { AgentProviders } from "./agent-providers.ts"
import { getAgentPlugin } from "./agents/registry.ts"
import type { AgentProviderConfig, AgentProviderInput, AgentProviderTemplateId, ProviderTemplateUpdates, ProviderUpdate } from "./provider-protocol.ts"
import { probeProvider, resolveProviderInstaller, type ProbeDependencies } from "./provider-setup.ts"
import { runProbeCommand } from "./provider-setup-process.ts"

const CHECK_INTERVAL_MS = 60 * 60 * 1_000
const PROVIDER_CHANGE_DEBOUNCE_MS = 500
const UPSTREAM_FETCH_TIMEOUT_MS = 10_000
const UPGRADE_COMMAND_TIMEOUT_MS = 300_000
const UPGRADE_MAX_BUFFER_BYTES = 4 * 1024 * 1024

type UpdatableProviderTemplateId = Exclude<AgentProviderTemplateId, "deepseek-harness" | "acp">

function isUpdatableProviderTemplate(template: AgentProviderTemplateId): template is UpdatableProviderTemplateId {
  return Boolean(getAgentPlugin(template)?.update)
}

export function extractProviderVersion(template: AgentProviderTemplateId, raw: string): string | undefined {
  const cleaned = stripVTControlCharacters(raw).trim()
  if (!cleaned) return undefined
  const custom = getAgentPlugin(template)?.update?.extractVersion
  return custom ? custom(cleaned) : extractSemverVersion(cleaned)
}

function compareVersionOrder(template: AgentProviderTemplateId, current: string, latest: string): number {
  const custom = getAgentPlugin(template)?.update?.compareVersions
  return custom ? custom(current, latest) : compareSemverVersions(current, latest)
}

/** Compares versions already normalized by `extractProviderVersion`. */
export function isProviderVersionNewer(template: AgentProviderTemplateId, current: string, latest: string): boolean {
  if (current === latest) return false
  const custom = getAgentPlugin(template)?.update?.isVersionNewer
  return custom ? custom(current, latest) : compareVersionOrder(template, current, latest) < 0
}

interface FetchLatestVersionOptions {
  platform?: NodeJS.Platform
  arch?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export async function fetchLatestProviderVersion(
  template: UpdatableProviderTemplateId,
  options: FetchLatestVersionOptions = {},
): Promise<string | undefined> {
  const update = getAgentPlugin(template)?.update
  if (!update) return undefined
  const source = update.versionSource(options.platform ?? process.platform, options.arch ?? process.arch)
  const timeout = AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS)
  const response = await (options.fetchImpl ?? fetch)(source.url, {
    headers: { "user-agent": "deskfleet" },
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`${source.url} returned HTTP ${response.status}`)
  return source.parse((await response.text()).trim())
}

function installerFailureMessage(stdout: string, stderr: string, code: number | null): string {
  const lines = stripVTControlCharacters(`${stderr}\n${stdout}`).split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  return lines.at(-1)?.slice(0, 240) || `Installer exited with code ${code ?? "unknown"}`
}

function toDefaultProviderInput(provider: AgentProviderConfig): AgentProviderInput {
  const { id: _id, binaryPath: _binaryPath, ...input } = provider
  return input
}

interface ProviderUpdatesDependencies {
  stopProviders: (providerIds: string[]) => Promise<void>
  peers?: () => Iterable<Pick<ProviderUpdates, "stopTemplate" | "check">>
  probe?: ProbeDependencies
  fetch?: typeof fetch
}

/** Tracks one update per CLI template: provider entries of a template share its official installation. */
export class ProviderUpdates {
  readonly #providers: AgentProviders
  readonly #dependencies: ProviderUpdatesDependencies
  readonly #updates = new Map<AgentProviderTemplateId, ProviderUpdate>()
  readonly #listeners = new Set<() => void>()
  readonly #upgrades = new Set<Promise<void>>()
  readonly #closing = new AbortController()
  #unsubscribeProviders?: () => void
  #interval?: ReturnType<typeof setInterval>
  #debounce?: ReturnType<typeof setTimeout>
  #checking?: Promise<void>

  constructor(providers: AgentProviders, dependencies: ProviderUpdatesDependencies) {
    this.#providers = providers
    this.#dependencies = dependencies
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Omits templates whose last provider entry was removed before the next check runs. */
  snapshot(): ProviderTemplateUpdates {
    const templates = new Set(this.#providers.snapshot().providers.map(provider => provider.template))
    return Object.fromEntries([...this.#updates].filter(([template]) => templates.has(template)))
  }

  start(): void {
    this.#unsubscribeProviders = this.#providers.onChanged(() => {
      clearTimeout(this.#debounce)
      this.#debounce = setTimeout(() => { void this.check() }, PROVIDER_CHANGE_DEBOUNCE_MS)
      this.#debounce.unref()
    })
    void this.check()
    this.#interval = setInterval(() => { void this.check() }, CHECK_INTERVAL_MS)
    this.#interval.unref()
  }

  /** Runs one check after any check already in progress. */
  check(): Promise<void> {
    const next = (this.#checking ?? Promise.resolve())
      .then(() => this.#runCheck())
      .finally(() => {
        if (this.#checking === next) this.#checking = undefined
      })
    this.#checking = next
    return next
  }

  async upgrade(template: AgentProviderTemplateId): Promise<null> {
    const update = this.#updates.get(template)
    if (!update || !isUpdatableProviderTemplate(template) || this.#entries(template).length === 0) {
      throw new Error("No update is available for this CLI")
    }
    if (update.status === "updating") return null

    const { currentVersion, latestVersion } = update
    this.#updates.set(template, { currentVersion, latestVersion, status: "updating" })
    this.#notify()
    const task = this.#performUpgrade(template, update).finally(() => this.#upgrades.delete(task))
    this.#upgrades.add(task)
    return null
  }

  /** Stops running sessions on this registration that use the template's default installation. */
  async stopTemplate(template: UpdatableProviderTemplateId): Promise<void> {
    const targets = await this.#defaultEntries(template)
    if (targets.length > 0) await this.#dependencies.stopProviders(targets.map(target => target.entry.id))
  }

  async close(): Promise<void> {
    this.#unsubscribeProviders?.()
    clearInterval(this.#interval)
    clearTimeout(this.#debounce)
    this.#closing.abort(new Error("Provider update service is stopping"))
    await Promise.allSettled([this.#checking, ...this.#upgrades])
  }

  #notify(): void {
    if (this.#closing.signal.aborted) return
    for (const listener of this.#listeners) listener()
  }

  #entries(template: AgentProviderTemplateId): AgentProviderConfig[] {
    return this.#providers.snapshot().providers.filter(provider => provider.template === template)
  }

  /** Entries that resolve to the official default installation rather than a custom executable path. */
  async #defaultEntries(template: UpdatableProviderTemplateId): Promise<{ entry: AgentProviderConfig; version: string }[]> {
    const matched: { entry: AgentProviderConfig; version: string }[] = []
    for (const entry of this.#entries(template)) {
      const probed = await probeProvider(toDefaultProviderInput(entry), { ...this.#dependencies.probe, signal: this.#closing.signal })
      if (probed.status !== "found" || !probed.installable || !probed.version) continue
      if (entry.binaryPath && entry.binaryPath !== probed.binaryPath) continue
      const version = extractProviderVersion(template, probed.version)
      if (version) matched.push({ entry, version })
    }
    return matched
  }

  async #runCheck(): Promise<void> {
    const before = JSON.stringify(this.snapshot())
    const templates = new Set(this.#providers.snapshot().providers.map(provider => provider.template).filter(isUpdatableProviderTemplate))
    for (const [key, current] of this.#updates) {
      if (!templates.has(key as UpdatableProviderTemplateId) && current.status !== "updating") this.#updates.delete(key)
    }

    for (const template of templates) {
      if (this.#closing.signal.aborted) return
      if (this.#updates.get(template)?.status === "updating") continue

      let next: ProviderUpdate | undefined
      try {
        next = await this.#nextUpdate(template)
      } catch {
        // Detection failed (for example, it timed out); keep the last known state.
        continue
      }
      if (this.#closing.signal.aborted) return
      // An upgrade may have started while this check awaited detection.
      if (this.#updates.get(template)?.status === "updating") continue

      if (next) this.#updates.set(template, next)
      else this.#updates.delete(template)
    }

    if (JSON.stringify(this.snapshot()) !== before) this.#notify()
  }

  async #nextUpdate(template: UpdatableProviderTemplateId): Promise<ProviderUpdate | undefined> {
    const installed = await this.#defaultEntries(template)
    if (installed.length === 0) return undefined

    const existing = this.#updates.get(template)
    const latestRequest = fetchLatestProviderVersion(template, {
      platform: this.#dependencies.probe?.platform,
      arch: this.#dependencies.probe?.arch,
      fetchImpl: this.#dependencies.fetch,
      signal: this.#closing.signal,
    })
    // When upstream is unreachable, keep the last known target until the installed version reaches it.
    const latestVersion = await latestRequest.catch(() => undefined) ?? existing?.latestVersion
    if (!latestVersion) return undefined
    const outdated = installed.filter(({ version }) => isProviderVersionNewer(template, version, latestVersion))
    if (outdated.length === 0) return undefined
    const currentVersion = outdated.reduce((oldest, { version }) =>
      compareVersionOrder(template, version, oldest) < 0 ? version : oldest, outdated[0]!.version)
    // Keep an unread failure for the same target version.
    if (existing?.status === "error" && existing.latestVersion === latestVersion) return { ...existing, currentVersion }
    return { currentVersion, latestVersion, status: "available" }
  }

  async #performUpgrade(
    template: UpdatableProviderTemplateId,
    update: ProviderUpdate,
  ): Promise<void> {
    try {
      const targets = await this.#defaultEntries(template)
      if (targets.length === 0) throw new Error("No update is available for this CLI")
      const outdated = targets.find(({ version }) => isProviderVersionNewer(template, version, update.latestVersion))
      const peers = [...(this.#dependencies.peers?.() ?? [])]
      if (!outdated) {
        // A manual installation may have satisfied the notice since its last check.
        // Reconcile it without reinstalling or stopping otherwise healthy sessions.
        this.#updates.delete(template)
        for (const peer of peers) void peer.check()
        this.#notify()
        return
      }
      const probe = { ...this.#dependencies.probe, signal: this.#closing.signal }
      const launch = await resolveProviderInstaller(toDefaultProviderInput(outdated.entry), probe, { nonInteractive: true })
      await Promise.all([
        this.#dependencies.stopProviders(targets.map(target => target.entry.id)),
        ...peers.map(peer => peer.stopTemplate(template)),
      ])

      const run = probe.run ?? runProbeCommand
      const result = await run(launch.command, launch.args, launch.env, launch.cwd, this.#closing.signal, UPGRADE_COMMAND_TIMEOUT_MS, UPGRADE_MAX_BUFFER_BYTES)
      if (result.code !== 0) throw new Error(installerFailureMessage(result.stdout, result.stderr, result.code))

      const installed = await this.#defaultEntries(template)
      if (installed.length === 0) throw new Error("Updated executable could not be found after installation")
      const stale = installed.find(({ version }) => isProviderVersionNewer(template, version, update.latestVersion))
      if (stale) {
        throw new Error(`Installed executable is still ${stale.version} (expected ${update.latestVersion})`)
      }
      this.#updates.delete(template)
      for (const peer of peers) void peer.check()
    } catch (error) {
      if (this.#closing.signal.aborted) return
      this.#updates.set(template, {
        currentVersion: update.currentVersion,
        latestVersion: update.latestVersion,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })
    }
    this.#notify()
  }
}
