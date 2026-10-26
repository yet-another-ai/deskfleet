import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { McpServer } from "@agentclientprotocol/sdk/unstable"
import { mcpServerInput, validateMcpServerId, type McpServerConfig, type McpServerInput, type McpServerSnapshot } from "./mcp-server-protocol.ts"

/** Additional MCP settings are machine-local; credentials never enter catalog or conversation replication. */
export class McpServers {
  readonly #directory: string
  readonly #path: string
  readonly #listeners = new Set<() => void>()
  #servers: McpServerConfig[] = []
  #revision = randomUUID()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(directory: string) { this.#directory = directory; this.#path = join(directory, "mcp-servers.json") }

  async init(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    let data: string
    try { data = await readFile(this.#path, "utf8") }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await this.#save([])
      return
    }
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== "object" || !("servers" in value) || !Array.isArray(value.servers)) throw new Error("Invalid MCP server configuration")
    const ids = new Set<string>()
    const names = new Set<string>()
    this.#servers = value.servers.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid MCP server configuration")
      const { id, ...input } = entry as Record<string, unknown>
      validateMcpServerId(id)
      const server = mcpServerInput(input)
      if (ids.has(id) || names.has(server.name.toLowerCase())) throw new Error("Duplicate MCP server")
      ids.add(id); names.add(server.name.toLowerCase())
      return { id, ...server }
    })
    this.#revision = randomUUID()
  }

  snapshot(): McpServerSnapshot { return { revision: this.#revision, servers: structuredClone(this.#servers) } }

  resolve(): McpServer[] {
    return this.#servers.filter(server => server.enabled).map(server => server.transport === "stdio"
      ? { name: server.name, command: server.command, args: [...server.args], env: Object.entries(server.env).map(([name, value]) => ({ name, value })) }
      : { name: server.name, type: server.transport, url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) })
  }

  onChanged(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  create(value: McpServerInput): Promise<McpServerConfig> {
    const input = mcpServerInput(value)
    return this.#mutate(async () => {
      this.#uniqueName(input.name)
      const server = { id: randomUUID(), ...input }
      await this.#commit([...this.#servers, server])
      return structuredClone(server)
    })
  }

  update(id: string, value: McpServerInput): Promise<McpServerConfig> {
    const input = mcpServerInput(value)
    return this.#mutate(async () => {
      this.#get(id); this.#uniqueName(input.name, id)
      const server = { id, ...input }
      await this.#commit(this.#servers.map(previous => previous.id === id ? server : previous))
      return structuredClone(server)
    })
  }

  remove(id: string): Promise<void> {
    return this.#mutate(async () => {
      this.#get(id)
      await this.#commit(this.#servers.filter(server => server.id !== id))
    })
  }

  #get(id: string): McpServerConfig {
    validateMcpServerId(id)
    const server = this.#servers.find(server => server.id === id)
    if (!server) throw new Error("MCP server was not found")
    return server
  }
  #uniqueName(name: string, id?: string): void {
    if (this.#servers.some(server => server.id !== id && server.name.toLowerCase() === name.toLowerCase())) throw new Error("An MCP server with this name already exists")
  }
  #mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#queue.then(action)
    this.#queue = operation.catch(() => {})
    return operation
  }
  async #commit(servers: McpServerConfig[]): Promise<void> {
    await this.#save(servers)
    this.#servers = servers
    this.#revision = randomUUID()
    for (const listener of this.#listeners) listener()
  }
  async #save(servers: McpServerConfig[]): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ servers }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
      await rename(temporary, this.#path)
    } finally { await rm(temporary, { force: true }) }
  }
}
