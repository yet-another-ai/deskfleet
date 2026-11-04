import { invokeMcp, type McpConnection, type McpInvocation } from "@deskfleet/mcp/client"
import type { RemoteMcpOperation } from "../../../crates/protocol/control.ts"
import type { AgentActor } from "./agent-protocol.ts"
import type { MachineOperations } from "./machine-operations.ts"
import { readRemoteAgentSettings } from "./remote-agent-settings.ts"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected remote MCP parameters")
  return value as Record<string, unknown>
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`)
  return value
}
function only(params: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(params).some(key => !keys.includes(key))) throw new Error("Unknown remote MCP argument")
}

/** This service is reached only through the authenticated backend control socket. */
export class RemoteMcp {
  readonly #directory: string
  readonly #operations: MachineOperations
  readonly #closing = new AbortController()
  readonly #invoke: typeof invokeMcp

  constructor(directory: string, operations: MachineOperations, invoke: typeof invokeMcp = invokeMcp) {
    this.#directory = directory; this.#operations = operations; this.#invoke = invoke
  }

  close(): void { this.#closing.abort(new Error("Remote MCP service is stopping")) }

  async handle(method: "remoteMcpDiscover" | "remoteMcp", value: unknown, actor: AgentActor | undefined, target: { teamId: string; machineId: string }): Promise<unknown> {
    this.#closing.signal.throwIfAborted()
    const envelope = object(value)
    const source = method === "remoteMcpDiscover" ? envelope : object(envelope.source)
    if (actor?.kind !== "user" || !actor.userId || !actor.deviceId
      || source.teamId !== target.teamId || source.machineId === target.machineId
      || source.machineId !== actor.sourceMachine?.id || !actor.sourceMachine?.originId) {
      throw new Error("Remote MCP requires a delegated user from another machine in this Team")
    }
    text(source.sessionId, "Source Session ID")
    const settings = await readRemoteAgentSettings(this.#directory)
    if (method === "remoteMcpDiscover") return settings
    const operation = envelope.operation as RemoteMcpOperation
    const params = object(envelope.arguments)
    const authorize = async () => {
      this.#closing.signal.throwIfAborted()
      const current = await readRemoteAgentSettings(this.#directory)
      if (operation === "mcpCall") {
        if (!current.allowOperate) throw new Error("This machine does not allow other machines' Agents to operate it")
      } else if (operation === "mcpServers" || operation === "mcpTools") {
        if (!current.allowRead && !current.allowOperate) throw new Error("This machine does not allow remote Agent access")
      } else if (!current.allowRead) throw new Error("This machine does not allow other machines' Agents to read it")
    }
    await authorize()
    switch (operation) {
      case "machine":
        only(params, [])
        return { catalog: await this.#operations.catalog.native.snapshot(), providers: this.#operations.providers.metadata(), access: settings }
      case "sessions":
        only(params, ["workspaceId"])
        return (await this.#operations.agents.journal.list()).filter(session => params.workspaceId === undefined || session.workspaceId === text(params.workspaceId, "Workspace ID"))
      case "session":
        only(params, ["sessionId"])
        return this.#operations.agents.handle("_deskfleet/session/subscribe", { sessionId: text(params.sessionId, "Session ID") }, actor)
      case "history":
        only(params, ["sessionId", "afterSeq", "limit"])
        if (typeof params.afterSeq !== "string" || !/^[0-9]+$/u.test(params.afterSeq)) throw new Error("afterSeq must be a nonnegative sequence string")
        if (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200)) throw new Error("History limit must be between 1 and 200")
        return this.#operations.agents.handle("_deskfleet/session/history", { ...params, sessionId: text(params.sessionId, "Session ID") }, actor)
      case "mcpServers":
        only(params, [])
        return this.#operations.mcpServers?.snapshot().servers.filter(server => server.enabled).map(({ id, name, transport }) => ({ id, name, transport })) ?? []
      case "mcpTools":
      case "mcpCall": {
        only(params, operation === "mcpTools" ? ["serverId", "cursor"] : ["serverId", "name", "arguments"])
        const serverId = text(params.serverId, "MCP server ID")
        const request: McpInvocation = operation === "mcpTools"
          ? { kind: "list", ...(params.cursor === undefined ? {} : { cursor: text(params.cursor, "Cursor") }) }
          : { kind: "call", name: text(params.name, "Tool name"), arguments: object(params.arguments ?? {}) }
        const servers = this.#operations.mcpServers
        const config = servers?.snapshot().servers.find(server => server.id === serverId && server.enabled)
        if (!config || !servers) throw new Error("Enabled MCP server was not found")
        const revision = servers.snapshot().revision
        const resolved = servers.resolve().find(server => server.name === config.name)!
        if ("type" in resolved && resolved.type === "acp") throw new Error("Unsupported remote MCP transport")
        const connection: McpConnection = "type" in resolved
          ? { transport: resolved.type, url: resolved.url, headers: Object.fromEntries(resolved.headers.map(({ name, value }) => [name, value])) }
          : { transport: "stdio", command: resolved.command, args: resolved.args, env: Object.fromEntries(resolved.env.map(({ name, value }) => [name, value])), cwd: this.#directory }
        return this.#invoke(connection, request, AbortSignal.any([this.#closing.signal, AbortSignal.timeout(45_000)]), async () => {
          await authorize()
          if (servers.snapshot().revision !== revision) throw new Error("MCP server settings changed; discover its tools again")
        })
      }
      default: throw new Error("Unsupported remote MCP operation")
    }
  }
}
