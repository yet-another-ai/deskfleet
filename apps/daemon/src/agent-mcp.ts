import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { McpServer } from "@agentclientprotocol/sdk/unstable"
import { DESKFLEET_TOOLS } from "@deskfleet/mcp/tools"
import { adapterProcess, DESKFLEET_MCP_ARGUMENT } from "./agents/adapter-host.ts"
import type { AgentActor } from "./agent-protocol.ts"

export interface AgentMcpScope { sessionId: string; workspaceId?: string }
export interface AgentMcpLease { servers: McpServer[]; close(): void }
export interface AgentMcpOptions {
  servers?(): McpServer[]
  authorize(actor: AgentActor, scope: AgentMcpScope): Promise<void>
  dispatch(method: string, params: Record<string, unknown>, actor: AgentActor, scope: AgentMcpScope): Promise<unknown>
}
interface Grant { actor: AgentActor; scope: AgentMcpScope }
const MAX_BODY_BYTES = 1024 * 1024

/** A provider receives only its own revocable delegation, never host discovery or account credentials. */
export class AgentMcp {
  readonly #options: AgentMcpOptions
  readonly #grants = new Map<string, Grant>()
  readonly #requests = new Set<Promise<void>>()
  #server?: Server
  #endpoint?: string

  constructor(options: AgentMcpOptions) { this.#options = options }

  async init(): Promise<void> {
    if (this.#server) throw new Error("Agent MCP is already initialized")
    const server = createServer((request, response) => {
      const pending = this.#handle(request, response).catch(error => {
        if (!response.headersSent) this.#reply(response, 400, { error: error instanceof Error ? error.message : String(error) })
        else response.destroy()
      }).finally(() => this.#requests.delete(pending))
      this.#requests.add(pending)
    })
    this.#server = server
    server.requestTimeout = 30_000
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
    })
    this.#endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  }

  lease(sessionId: string, workspaceId: string | undefined, actor: AgentActor): AgentMcpLease {
    // Local development fixtures have no centrally authenticated user to delegate.
    if (actor.kind !== "user" || !actor.userId || !actor.deviceId) return { servers: [], close() {} }
    if (!this.#endpoint) throw new Error("Agent MCP is unavailable")
    const token = randomBytes(32).toString("hex")
    this.#grants.set(token, { actor: structuredClone(actor), scope: { sessionId, ...(workspaceId ? { workspaceId } : {}) } })
    const launch = adapterProcess(DESKFLEET_MCP_ARGUMENT)
    const env = Object.entries(launch.env ?? {}).flatMap(([name, value]) => value === undefined ? [] : [{ name, value }])
    return {
      servers: [{ name: "deskfleet", command: launch.command, args: launch.args ?? [], env: [
        ...env, { name: "DESKFLEET_MCP_ENDPOINT", value: this.#endpoint }, { name: "DESKFLEET_MCP_TOKEN", value: token },
      ] }, ...this.#options.servers?.() ?? []],
      close: () => { this.#grants.delete(token) },
    }
  }

  #reply(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    response.end(JSON.stringify(value))
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/mcp") { this.#reply(response, 404, { error: "Unknown MCP endpoint" }); return }
    // This private bridge is called by the stdio child, never by browser scripts.
    if (request.headers.origin) { this.#reply(response, 403, { error: "Browser requests are not allowed" }); return }
    const authorization = request.headers.authorization ?? ""
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
    const grant = this.#grants.get(token)
    if (!grant) { this.#reply(response, 401, { error: "Agent MCP delegation is unavailable or expired" }); return }
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Buffer)
      length += bytes.length
      if (length > MAX_BODY_BYTES) throw new Error("MCP request is too large")
      chunks.push(bytes)
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected MCP tool request")
    const value = body as Record<string, unknown>
    if (Object.keys(value).some(key => key !== "name" && key !== "arguments")) throw new Error("MCP request cannot supply authority")
    const tool = DESKFLEET_TOOLS.find(tool => tool.name === value.name)
    if (!tool) throw new Error("Unknown deskfleet tool")
    const args = value.arguments ?? {}
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected tool arguments")
    // Central authorization is intentionally repeated for each operation.
    await this.#options.authorize(grant.actor, grant.scope)
    if (this.#grants.get(token) !== grant) { this.#reply(response, 401, { error: "Agent MCP delegation has ended" }); return }
    const result = await this.#options.dispatch(tool.method, args as Record<string, unknown>, grant.actor, grant.scope)
    this.#reply(response, 200, { result: result ?? null })
  }

  async close(): Promise<void> {
    this.#grants.clear()
    this.#endpoint = undefined
    const server = this.#server
    this.#server = undefined
    if (!server) return
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
    await Promise.allSettled([...this.#requests])
  }
}
