import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RequestError } from "@agentclientprotocol/sdk"
import { connectAcpProcess, type AgentConfig, type AgentProvider } from "./agents/acp.ts"
import { claudeCodeProvider } from "./agents/claude-code.ts"
import { codexProvider } from "./agents/codex.ts"
import { cursorProvider } from "./agents/cursor.ts"
import { grokProvider } from "./agents/grok.ts"
import { launchProviderCommand } from "./provider-setup-process.ts"
import {
  AGENT_PROVIDER_TEMPLATES, PROVIDER_TEST_TIMEOUT_MS, providerInput, providerSettings, validateProviderId,
  type AgentProviderConfig, type AgentProviderInput, type AgentProviderSettings, type ProviderSnapshot, type ProviderTestResult,
} from "./provider-protocol.ts"

const acpProvider: AgentProvider = {
  id: "acp",
  connect: (config, client) => connectAcpProcess(launchProviderCommand(config.binaryPath || "acp-agent", [], config.env), client),
}

/** ACP adapters often put the actual cause in error data behind a generic JSON-RPC message. */
function testFailure(error: unknown): string {
  if ((error as { code?: unknown } | null)?.code === RequestError.authRequired().code) {
    return "Authentication required. Use the Log in button before testing the connection."
  }
  const data = (error as { data?: unknown } | null | undefined)?.data
  const details = data && typeof data === "object" && "details" in data ? data.details : undefined
  if (typeof details === "string" && details.trim()) return details.trim()
  return error instanceof Error ? error.message : String(error)
}

/** Machine-local launch settings stay outside the synchronized conversation journal. */
export class AgentProviders {
  readonly #directory: string
  readonly #path: string
  readonly #codex: AgentProvider
  readonly #listeners = new Set<() => void>()
  #providers: AgentProviderConfig[] = []
  #revision = randomUUID()
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
      this.#revision = randomUUID()
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
    this.#revision = randomUUID()
  }

  snapshot(): ProviderSnapshot {
    return { revision: this.#revision, templates: structuredClone(AGENT_PROVIDER_TEMPLATES) as ProviderSnapshot["templates"], providers: structuredClone(this.#providers) }
  }

  /** Public display fields and an opaque revision may enter the central catalog replica. */
  metadata() {
    return {
      revision: this.#revision,
      templates: AGENT_PROVIDER_TEMPLATES.map(({ id, name }) => ({ id, name })),
      providers: this.#providers.map(({ id, name, template, icon }) => ({ id, name, template, ...(icon ? { icon } : {}) })),
    }
  }

  get(id: string): AgentProviderConfig {
    validateProviderId(id)
    const provider = this.#providers.find(provider => provider.id === id)
    if (!provider) throw new Error("Agent provider is unavailable; configure it in Settings")
    return structuredClone(provider)
  }

  resolve(id: string): { provider: AgentProvider; config: AgentConfig } {
    return this.#launch(this.get(id))
  }

  /**
   * Starts possibly unsaved settings and opens one session in an empty temporary
   * directory without sending a prompt, so a check costs no inference.
   */
  async test(input: AgentProviderInput): Promise<ProviderTestResult> {
    const { provider, config } = this.#launch(providerInput(input))
    config.authentication = "existing"
    const cwd = await mkdtemp(join(tmpdir(), "df-provider-test-"))
    const connecting = provider.connect(config, { onUpdate() {} })
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${config.name} did not open a session within ${PROVIDER_TEST_TIMEOUT_MS / 1000} seconds`)), PROVIDER_TEST_TIMEOUT_MS)
    })
    try {
      const connection = await Promise.race([connecting, deadline])
      await Promise.race([connection.newSession({ cwd, mcpServers: [] }), deadline])
      const agent = connection.initialization.agentInfo
      return { agentName: agent?.title || agent?.name || config.name }
    } catch (error) {
      throw new Error(testFailure(error), { cause: error })
    } finally {
      clearTimeout(timer)
      await connecting.then(connection => connection.close(), () => {})
      await rm(cwd, { recursive: true, force: true })
    }
  }

  #launch(record: AgentProviderInput): { provider: AgentProvider; config: AgentConfig } {
    const template = AGENT_PROVIDER_TEMPLATES.find(template => template.id === record.template)!
    return {
      provider: record.template === "codex" ? this.#codex : record.template === "claude-code" ? claudeCodeProvider : record.template === "cursor" ? cursorProvider : record.template === "grok" ? grokProvider : acpProvider,
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
    this.#revision = randomUUID()
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
