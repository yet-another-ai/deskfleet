import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { McpServer } from "@agentclientprotocol/sdk/unstable"
import { adapterProcess, AUV_MCP_ARGUMENT } from "./agents/adapter-host.ts"
import { mcpServerInput, validateMcpServerId, type McpServerConfig, type McpServerInput, type McpServerSnapshot } from "./mcp-server-protocol.ts"

/** Additional MCP settings are machine-local; credentials never enter catalog or conversation replication. */
export class McpServers {
  readonly #directory: string
  readonly #path: string
  readonly #auvPath?: string
  readonly #listeners = new Set<() => void>()
  #servers: McpServerConfig[] = []
  #auvSeeded = false
  #revision = randomUUID()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(directory: string, auvPath?: string) {
    this.#directory = directory
    this.#path = join(directory, "mcp-servers.json")
    this.#auvPath = auvPath
  }

  #defaultAuv(): McpServerConfig {
    return {
      id: randomUUID(),
      name: "auv",
      enabled: true,
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
      if (this.#auvPath) {
        this.#auvSeeded = true
        this.#servers = [this.#defaultAuv()]
      }
      await this.#save(this.#servers)
      return
    }
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== "object" || !("servers" in value) || !Array.isArray(value.servers)) throw new Error("Invalid MCP server configuration")
    this.#auvSeeded = "auvSeeded" in value && value.auvSeeded === true
    const ids = new Set<string>()
    const names = new Set<string>()
    this.#servers = value.servers.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid MCP server configuration")
      const { id, ...input } = entry as Record<string, unknown>
      validateMcpServerId(id)
      const server = mcpServerInput(input)
      if (ids.has(id) || names.has(server.name.toLowerCase())) throw new Error("Duplicate MCP server")
      ids.add(id); names.add(server.name.toLowerCase())
      if (this.#auvPath && server.transport === "stdio" && server.name.toLowerCase() === "auv"
        && server.args.length === 2 && server.args[0] === "mcp" && server.args[1] === "serve") {
        return { id, ...server, command: this.#auvPath }
      }
      return { id, ...server }
    })
    if (this.#auvPath && !this.#auvSeeded) {
      this.#auvSeeded = true
      if (!names.has("auv")) this.#servers.unshift(this.#defaultAuv())
      await this.#save(this.#servers)
    }
    this.#revision = randomUUID()
  }

  snapshot(): McpServerSnapshot { return { revision: this.#revision, servers: structuredClone(this.#servers) } }

  resolve(): McpServer[] {
    return this.#servers.filter(server => server.enabled).map(server => {
      if (server.transport !== "stdio") {
        return { name: server.name, type: server.transport, url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) }
      }
      if (this.#auvPath && server.name.toLowerCase() === "auv" && server.args.length === 2 && server.args[0] === "mcp" && server.args[1] === "serve") {
        const launch = adapterProcess(AUV_MCP_ARGUMENT)
        const env = Object.entries({ ...launch.env, ...server.env, DESKFLEET_AUV_PATH: this.#auvPath })
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
      await writeFile(temporary, JSON.stringify({ servers, ...(this.#auvSeeded ? { auvSeeded: true } : {}) }, null, 2) + "\n", { mode: 0o600, flag: "wx" })
      await rename(temporary, this.#path)
    } finally { await rm(temporary, { force: true }) }
  }
}
