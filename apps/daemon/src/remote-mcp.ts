import { invokeMcp, type McpConnection, type McpInvocation } from "@deskfleet/mcp/client"
import { z } from "zod"
import type { RemoteMcpOperation } from "../../../crates/protocol/control.ts"
import type { AgentActor } from "./agent-protocol.ts"
import { FilesService } from "./files-service.ts"
import type { MachineOperations } from "./machine-operations.ts"
import { createMcpSession, sendMcpSession } from "./mcp-dispatch.ts"
import { readRemoteAgentSettings } from "./remote-agent-settings.ts"

const nonEmpty = z.string().refine(v => v.trim().length > 0)
const record = z.record(z.string(), z.unknown())
const sourceSchema = z.object({ teamId: nonEmpty, machineId: nonEmpty, sessionId: nonEmpty })

/** This service is reached only through the authenticated backend control socket. */
export class RemoteMcp {
  readonly #directory: string
  readonly #operations: MachineOperations
  readonly #closing = new AbortController()
  readonly #invoke: typeof invokeMcp
  readonly #files = new FilesService()
  readonly #reads = new Set<string>()
  readonly #transfers = new Set<string>()

  constructor(directory: string, operations: MachineOperations, invoke: typeof invokeMcp = invokeMcp) {
    this.#directory = directory; this.#operations = operations; this.#invoke = invoke
  }

  close(): void {
    this.#closing.abort(new Error("Remote MCP service is stopping"))
    void this.#files.close()
  }

  async handle(method: "remoteMcpDiscover" | "remoteMcp", value: unknown, actor: AgentActor | undefined, target: { teamId: string; machineId: string }): Promise<unknown> {
    this.#closing.signal.throwIfAborted()
    const envelope = record.parse(value)
    const parsedSource = sourceSchema.safeParse(method === "remoteMcpDiscover" ? envelope : record.parse(envelope.source))
    if (!parsedSource.success || actor?.kind !== "user" || !actor.userId || !actor.deviceId
      || parsedSource.data.teamId !== target.teamId || parsedSource.data.machineId === target.machineId
      || parsedSource.data.machineId !== actor.sourceMachine?.id || !actor.sourceMachine?.originId) {
      throw new Error("Remote MCP requires a delegated user from another machine in this Team")
    }
    const settings = await readRemoteAgentSettings(this.#directory)
    if (method === "remoteMcpDiscover") return settings
    const operation = envelope.operation as RemoteMcpOperation
    const params = record.parse(envelope.arguments)
    const rawFileParams = record.safeParse(params.params).data
    const isFileCleanup = (operation === "filesRead" && params.method === "closeRead" && typeof rawFileParams?.readId === "string" && this.#reads.has(rawFileParams.readId))
      || (operation === "filesWrite" && params.method === "abort" && typeof rawFileParams?.transferId === "string" && this.#transfers.has(rawFileParams.transferId))
    const authorize = async () => {
      this.#closing.signal.throwIfAborted()
      const current = await readRemoteAgentSettings(this.#directory)
      if (operation === "sessionCreate" || operation === "sessionSend" || operation === "mcpCall" || operation === "filesWrite") {
        if (!current.allowOperate) throw new Error("This machine does not allow other machines' Agents to operate it")
      } else if (operation === "mcpServers" || operation === "mcpTools" || operation === "filesRead") {
        if (!current.allowRead && !current.allowOperate) throw new Error("This machine does not allow remote Agent access")
      } else if (!current.allowRead) throw new Error("This machine does not allow other machines' Agents to read it")
    }
    if (!isFileCleanup) await authorize()
    switch (operation) {
      case "machine":
        z.strictObject({}).parse(params)
        return { catalog: await this.#operations.catalog.native.snapshot(), providers: this.#operations.providers.metadata(), access: settings }
      case "sessions": {
        const { workspaceId } = z.strictObject({ workspaceId: nonEmpty.optional() }).parse(params)
        return (await this.#operations.agents.journal.list()).filter(session => workspaceId === undefined || session.workspaceId === workspaceId)
      }
      case "session":
        return this.#operations.agents.handle("_deskfleet/session/subscribe", z.strictObject({ sessionId: nonEmpty }).parse(params), actor)
      case "history":
        return this.#operations.agents.handle("_deskfleet/session/history", z.strictObject({
          sessionId: nonEmpty,
          afterSeq: z.string().regex(/^[0-9]+$/u, "afterSeq must be a nonnegative sequence string"),
          limit: z.number().int().min(1).max(200).optional(),
        }).parse(params), actor)
      case "sessionCreate":
        return createMcpSession(this.#operations.agents, params, actor)
      case "sessionSend":
        return sendMcpSession(this.#operations.agents, params, actor)
      case "mcpServers":
        z.strictObject({}).parse(params)
        return this.#operations.mcpServers?.snapshot().servers.filter(server => server.enabled).map(({ id, name, transport }) => ({ id, name, transport })) ?? []
      case "mcpTools":
      case "mcpCall": {
        const parsed = operation === "mcpTools"
          ? z.strictObject({ serverId: nonEmpty, cursor: nonEmpty.optional() }).parse(params)
          : z.strictObject({ serverId: nonEmpty, name: nonEmpty, arguments: record.default({}) }).parse(params)
        const request: McpInvocation = "name" in parsed
          ? { kind: "call", name: parsed.name, arguments: parsed.arguments }
          : { kind: "list", ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}) }
        const servers = this.#operations.mcpServers
        const config = servers?.snapshot().servers.find(server => server.id === parsed.serverId && server.enabled)
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
      case "filesRead": {
        const { method: fileMethod, params: fileParams } = z.strictObject({
          method: z.enum(["list", "stat", "openRead", "read", "closeRead"]),
          params: record.default({}),
        }).parse(params)
        const reply = await this.#files.call(fileMethod, fileParams as never)
        if (fileMethod === "openRead") this.#reads.add((reply.value as { readId: string }).readId)
        if (fileMethod === "closeRead" && typeof fileParams.readId === "string") this.#reads.delete(fileParams.readId)
        return reply.data ? { value: reply.value, data: Buffer.from(reply.data).toString("base64") } : { value: reply.value }
      }
      case "filesWrite": {
        const { method: fileMethod, params: fileParams, data } = z.strictObject({
          method: z.enum(["begin", "mkdir", "write", "finish", "commit", "abort"]),
          params: record.default({}),
          data: z.string().optional(),
        }).parse(params)
        if (fileMethod === "begin" && "sessionId" in fileParams) throw new Error("Session attachment uploads are not supported over remote MCP")
        const reply = await this.#files.call(fileMethod, fileParams as never, data !== undefined ? Buffer.from(data, "base64") : undefined)
        if (fileMethod === "begin" && (reply.value as { transferId: string }).transferId) this.#transfers.add((reply.value as { transferId: string }).transferId)
        if ((fileMethod === "commit" || fileMethod === "abort") && typeof fileParams.transferId === "string") this.#transfers.delete(fileParams.transferId)
        return { value: reply.value }
      }
      default: throw new Error("Unsupported remote MCP operation")
    }
  }
}
