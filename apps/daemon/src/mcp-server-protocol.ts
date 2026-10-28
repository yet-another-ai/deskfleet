import { isAbsolute } from "node:path"

interface McpServerSettings { name: string; enabled: boolean }
export type McpServerInput = McpServerSettings & (
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { transport: "http" | "sse"; url: string; headers: Record<string, string> }
)
export type McpServerConfig = McpServerInput & { id: string }
export interface McpServerSnapshot { revision: string; servers: McpServerConfig[] }
export interface McpServerMethods {
  mcpServerList: { params: Record<string, never>; result: McpServerSnapshot }
  mcpServerCreate: { params: { server: McpServerInput }; result: McpServerConfig }
  mcpServerUpdate: { params: { serverId: string; changes: McpServerInput }; result: McpServerConfig }
  mcpServerRemove: { params: { serverId: string }; result: null }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected MCP server settings")
  return value as Record<string, unknown>
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Invalid MCP ${field}`)
  return value.trim()
}
function strings(value: unknown, header = false): Record<string, string> {
  const entries = Object.entries(object(value))
  for (const [key, value] of entries) {
    if (!(header ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u : /^[A-Za-z_][A-Za-z0-9_]*$/u).test(key)) throw new Error(header ? "Invalid MCP header name" : "Invalid MCP environment variable name")
    if (typeof value !== "string" || value.includes("\0") || (header && /[\r\n]/u.test(value))) throw new Error("Invalid MCP setting value")
  }
  return Object.fromEntries(entries) as Record<string, string>
}
export function validateMcpServerId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("Invalid MCP server ID")
}

export function mcpServerInput(value: unknown): McpServerInput {
  const input = object(value)
  const name = text(input.name, "server name")
  if (name.length > 128) throw new Error("MCP server names must have at most 128 characters")
  if (name.toLowerCase() === "deskfleet") throw new Error("The built-in DeskFleet MCP server is always enabled and cannot be replaced")
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("Invalid MCP enabled setting")
  const enabled = input.enabled !== false
  if (input.transport === "stdio") {
    if (Object.keys(input).some(key => !["name", "enabled", "transport", "command", "args", "env"].includes(key))) throw new Error("Unknown stdio MCP setting")
    const command = text(input.command, "command")
    if (!isAbsolute(command)) throw new Error("Use an absolute executable path for a stdio MCP server")
    if (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("MCP arguments must be a list of strings")
    return { name, enabled, transport: "stdio", command, args: [...input.args] as string[], env: strings(input.env) }
  }
  if (input.transport !== "http" && input.transport !== "sse") throw new Error("Unknown MCP transport")
  if (Object.keys(input).some(key => !["name", "enabled", "transport", "url", "headers"].includes(key))) throw new Error("Unknown HTTP MCP setting")
  const url = new URL(text(input.url, "URL"))
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Use an HTTP or HTTPS MCP URL, with credentials in headers")
  return { name, enabled, transport: input.transport, url: url.toString(), headers: strings(input.headers, true) }
}
