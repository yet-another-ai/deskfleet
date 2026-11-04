import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { McpServer } from "@agentclientprotocol/sdk/unstable"
import { adapterProcess, AUV_MCP_ARGUMENT } from "./agents/adapter-host.ts"
import { mcpServerInput, validateMcpServerId, type McpServerConfig, type McpServerInput, type McpServerSnapshot } from "./mcp-server-protocol.ts"

const BUILTIN_AUV_ID = "builtin-auv"

/** Additional MCP settings are machine-local; credentials never enter catalog or conversation replication. */
export class McpServers {
  readonly #directory: string
  readonly #path: string
  readonly #auvPath?: string
  readonly #listeners = new Set<() => void>()
  #servers: McpServerConfig[] = []
  #revision = randomUUID()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(directory: string, auvPath?: string) {
    this.#directory = directory
    this.#path = join(directory, "mcp-servers.json")
    this.#auvPath = auvPath
  }

  #builtInAuv(enabled = true): McpServerConfig {
    return {
      id: BUILTIN_AUV_ID,
      builtIn: true,
      name: "auv",
      enabled,
      transport: "stdio",
      command: this.#auvPath!,
      args: ["mcp", "serve"],
      env: {},
    }
  }

  async init(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    let data: string
    try { data = await readFile(this.#path, "utf8") }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      this.#servers = this.#auvPath ? [this.#builtInAuv()] : []
      await this.#save(this.#servers)
      return
    }
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== "object" || !("servers" in value) || !Array.isArray(value.servers)) throw new Error("Invalid MCP server configuration")
    const ids = new Set<string>()
    const names = new Set<string>()
    const loaded: McpServerConfig[] = []
    for (const entry of value.servers as unknown[]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid MCP server configuration")
      const { id, builtIn: _builtIn, ...input } = entry as Record<string, unknown>
      validateMcpServerId(id)
      const isAuv = typeof input.name === "string" && input.name.trim().toLowerCase() === "auv"
      const server = mcpServerInput(input, isAuv)
      if (isAuv) {
        if (!this.#auvPath || names.has("auv")) continue
        ids.add(BUILTIN_AUV_ID); names.add("auv")
        loaded.push(this.#builtInAuv(server.enabled))
        continue
      }
      if (ids.has(id) || names.has(server.name.toLowerCase())) throw new Error("Duplicate MCP server")
      ids.add(id); names.add(server.name.toLowerCase())
      loaded.push({ id, ...server })
    }
    if (this.#auvPath && !names.has("auv")) {
      loaded.unshift(this.#builtInAuv())
      await this.#save(loaded)
    }
    this.#servers = loaded
    this.#revision = randomUUID()
  }

  snapshot(): McpServerSnapshot { return { revision: this.#revision, servers: structuredClone(this.#servers) } }

  resolve(): McpServer[] {
    return this.#servers.filter(server => server.enabled).map(server => {
      if (server.transport !== "stdio") {
        return { name: server.name, type: server.transport, url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) }
      }
      if (server.builtIn && this.#auvPath) {
        const launch = adapterProcess(AUV_MCP_ARGUMENT)
        const env = Object.entries({ ...launch.env, DESKFLEET_AUV_PATH: this.#auvPath })
          .flatMap(([name, value]) => value === undefined ? [] : [{ name, value }])
        return { name: server.name, command: launch.command, args: [...launch.args ?? []], env }
      }
      return { name: server.name, command: server.command, args: [...server.args], env: Object.entries(server.env).map(([name, value]) => ({ name, value })) }
    })
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
    const input = mcpServerInput(value, id === BUILTIN_AUV_ID)
    return this.#mutate(async () => {
      const existing = this.#get(id)
      if (existing.builtIn) {
        const server = this.#builtInAuv(input.enabled)
        await this.#commit(this.#servers.map(previous => previous.id === id ? server : previous))
        return structuredClone(server)
      }
      this.#uniqueName(input.name, id)
      const server = { id, ...input }
      await this.#commit(this.#servers.map(previous => previous.id === id ? server : previous))
      return structuredClone(server)
    })
  }

  remove(id: string): Promise<void> {
    return this.#mutate(async () => {
      if (this.#get(id).builtIn) throw new Error("Built-in MCP servers cannot be removed")
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
