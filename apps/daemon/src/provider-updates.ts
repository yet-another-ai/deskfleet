import { stripVTControlCharacters } from "node:util"
import type { AgentProviders } from "./agent-providers.ts"
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
  return template !== "deepseek-harness" && template !== "acp"
}

const CURSOR_VERSION = /(?:^|[^0-9A-Za-z.])(\d{4}\.\d{1,2}\.\d{1,2}-[0-9A-Za-z._-]+)(?![0-9A-Za-z._-])/u
const SEMVER_VERSION = /(?:^|[^0-9A-Za-z.])(?:rust-v|v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?(?![0-9A-Za-z.])/u
const VERSION_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

export function extractProviderVersion(template: AgentProviderTemplateId, raw: string): string | undefined {
  const cleaned = stripVTControlCharacters(raw).trim()
  if (!cleaned) return undefined
  if (template === "cursor") {
    const cursorMatch = CURSOR_VERSION.exec(cleaned)
    if (cursorMatch?.[1]) return cursorMatch[1]
  }
  return SEMVER_VERSION.exec(cleaned)?.[1]
}

function splitVersion(version: string): [core: string, suffix?: string] {
  const dash = version.indexOf("-")
  return dash < 0 ? [version] : [version.slice(0, dash), version.slice(dash + 1)]
}

function compareVersionOrder(template: AgentProviderTemplateId, current: string, latest: string): number {
  const [currentCore, currentSuffix] = splitVersion(current)
  const [latestCore, latestSuffix] = splitVersion(latest)
  const coreDiff = VERSION_COLLATOR.compare(currentCore, latestCore)
  if (coreDiff !== 0 || template === "cursor") return coreDiff
  if (!currentSuffix || !latestSuffix) return currentSuffix ? -1 : latestSuffix ? 1 : 0
  return VERSION_COLLATOR.compare(currentSuffix, latestSuffix)
}

/** Compares versions already normalized by `extractProviderVersion`. */
export function isProviderVersionNewer(template: AgentProviderTemplateId, current: string, latest: string): boolean {
  if (current === latest) return false
  const diff = compareVersionOrder(template, current, latest)
  // Cursor builds share a date and differ only by commit hash.
  return diff === 0 ? template === "cursor" : diff < 0
}

interface VersionSource {
  url: string
  parse: (body: string) => string | undefined
}

function jsonVersion(template: UpdatableProviderTemplateId): VersionSource["parse"] {
  return body => {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== "object") return undefined
    const { version, tag_name: tag } = parsed as { version?: unknown; tag_name?: unknown }
    const candidate = typeof version === "string" ? version : typeof tag === "string" ? tag : undefined
    return candidate ? extractProviderVersion(template, candidate) : undefined
  }
}

const CURSOR_DOWNLOAD_VERSION = /downloads\.cursor\.com\/(?:lab|versions)\/(\d{4}\.\d{1,2}\.\d{1,2}-[0-9A-Za-z._-]+)/u
const CURSOR_WINDOWS_VERSION = /\$version\s*=\s*['"](\d{4}\.\d{1,2}\.\d{1,2}-[0-9A-Za-z._-]+)['"]/u

/** Probing reports installable only on darwin, linux, and win32 with x64 or arm64. */
const VERSION_SOURCES: Record<UpdatableProviderTemplateId, (platform: NodeJS.Platform, arch: string) => VersionSource> = {
  "codex": () => ({ url: "https://releases.openai.com/codex/channels/latest", parse: jsonVersion("codex") }),
  "claude-code": () => ({ url: "https://downloads.claude.ai/claude-code-releases/latest", parse: body => extractProviderVersion("claude-code", body) }),
  "cursor": platform => ({
    url: platform === "win32" ? "https://cursor.com/install?win32=true" : "https://cursor.com/install",
    parse: body => CURSOR_DOWNLOAD_VERSION.exec(body)?.[1] ?? CURSOR_WINDOWS_VERSION.exec(body)?.[1],
  }),
  "grok": () => ({ url: "https://x.ai/cli/stable", parse: body => extractProviderVersion("grok", body) }),
  "pi": () => ({ url: "https://pi.dev/api/installer/releases/latest", parse: jsonVersion("pi") }),
  "omp": (platform, arch) => ({
    url: `https://build.stencil.so/api/products/omp/latest/${platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux"}-${arch === "x64" ? "x86_64" : "arm64"}?channel=stable`,
    parse: jsonVersion("omp"),
  }),
  "antigravity": (platform, arch) => ({
    url: `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform === "win32" ? "windows" : platform}_${arch === "x64" ? "amd64" : "arm64"}.json`,
    parse: jsonVersion("antigravity"),
  }),
  "codebuddy": () => ({ url: "https://acc-1258344699.cos.accelerate.myqcloud.com/@tencent-ai/codebuddy-code/releases/latest", parse: body => extractProviderVersion("codebuddy", body) }),
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
  const source = VERSION_SOURCES[template](options.platform ?? process.platform, options.arch ?? process.arch)
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
      const outdated = targets.find(({ version }) => isProviderVersionNewer(template, version, update.latestVersion))
      if (!outdated) throw new Error("No update is available for this CLI")
      const probe = { ...this.#dependencies.probe, signal: this.#closing.signal }
      const launch = await resolveProviderInstaller(toDefaultProviderInput(outdated.entry), probe)
      const peers = [...(this.#dependencies.peers?.() ?? [])]
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
