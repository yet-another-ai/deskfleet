import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { connectAcpProcess, type AgentConfig, type AgentProvider } from "./agents/acp.ts"
import { codexProvider } from "./agents/codex.ts"
import {
  AGENT_PROVIDER_TEMPLATES, providerInput, providerSettings, validateProviderId,
  type AgentProviderConfig, type AgentProviderInput, type AgentProviderSettings, type ProviderSnapshot,
} from "./provider-protocol.ts"

const acpProvider: AgentProvider = {
  id: "acp",
  connect: (config, client) => connectAcpProcess({ command: config.binaryPath || "acp-agent", env: config.env }, client),
}

/** Machine-local launch settings stay outside the synchronized conversation journal. */
export class AgentProviders {
  readonly #directory: string
  readonly #path: string
  readonly #codex: AgentProvider
  readonly #listeners = new Set<() => void>()
  #providers: AgentProviderConfig[] = []
  #queue: Promise<unknown> = Promise.resolve()

  constructor(directory: string, codexOverride: AgentProvider = codexProvider) {
    this.#directory = directory
    this.#path = join(directory, "agent-providers.json")
    this.#codex = codexOverride
  }

  async init(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    let data: string
    try { data = await readFile(this.#path, "utf8") }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const providers: AgentProviderConfig[] = [{ id: "codex", template: "codex", name: "Codex", env: {} }]
      await this.#save(providers)
      this.#providers = providers
      return
    }
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== "object" || !("providers" in value) || !Array.isArray(value.providers)) {
      throw new Error("Invalid Agent provider configuration")
    }
    const ids = new Set<string>()
    this.#providers = value.providers.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Agent provider configuration")
      const { id, ...input } = entry as Record<string, unknown>
      validateProviderId(id)
      if (ids.has(id)) throw new Error("Duplicate Agent provider ID")
      ids.add(id)
      return { id, ...providerInput(input) }
    })
  }

  snapshot(): ProviderSnapshot {
    return { templates: structuredClone(AGENT_PROVIDER_TEMPLATES) as ProviderSnapshot["templates"], providers: structuredClone(this.#providers) }
  }

  get(id: string): AgentProviderConfig {
    validateProviderId(id)
    const provider = this.#providers.find(provider => provider.id === id)
    if (!provider) throw new Error("Agent provider is unavailable; configure it in Settings")
    return structuredClone(provider)
  }

  resolve(id: string): { provider: AgentProvider; config: AgentConfig } {
    const record = this.get(id)
    const template = AGENT_PROVIDER_TEMPLATES.find(template => template.id === record.template)!
    return {
      provider: record.template === "codex" ? this.#codex : acpProvider,
      config: { name: record.name, binaryPath: record.binaryPath ?? template.defaultBinaryPath, env: record.env },
    }
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  create(input: AgentProviderInput): Promise<AgentProviderConfig> {
    const provider = { id: randomUUID(), ...providerInput(input) }
    return this.#mutate(async () => {
      await this.#commit([...this.#providers, provider])
      return structuredClone(provider)
    })
  }

  update(id: string, changes: AgentProviderSettings): Promise<AgentProviderConfig> {
    const settings = providerSettings(changes)
    return this.#mutate(async () => {
      const previous = this.get(id)
      const provider = { id, template: previous.template, ...settings }
      await this.#commit(this.#providers.map(current => current.id === id ? provider : current))
      return structuredClone(provider)
    })
  }

  remove(id: string): Promise<void> {
    return this.#mutate(async () => {
      this.get(id)
      await this.#commit(this.#providers.filter(provider => provider.id !== id))
    })
  }

  #mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#queue.then(action)
    this.#queue = operation.catch(() => {})
    return operation
  }

  async #commit(providers: AgentProviderConfig[]): Promise<void> {
    await this.#save(providers)
    this.#providers = providers
    for (const listener of this.#listeners) listener()
  }

  async #save(providers: AgentProviderConfig[]): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ providers }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
      await rename(temporary, this.#path)
    } finally { await rm(temporary, { force: true }) }
  }
}
