import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { DESKFLEET_TOOLS } from "./tools.ts"

export type ToolInvoker = (name: string, args: Record<string, unknown>) => Promise<unknown>

export function createMcpServer(invoke: ToolInvoker): Server {
  const server = new Server({ name: "deskfleet", title: "DeskFleet", version: "0.1.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: DESKFLEET_TOOLS.map(({ method: _method, ...tool }) => tool),
  }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (!DESKFLEET_TOOLS.some(tool => tool.name === request.params.name)) throw new Error("Unknown DeskFleet tool")
      const value = await invoke(request.params.name, request.params.arguments ?? {})
      return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] }
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }
    }
  })
  return server
}

/** Only the host-selected loopback endpoint receives the delegated credential. */
export function gatewayInvoker(endpoint: string, token: string, request: typeof fetch = fetch): ToolInvoker {
  const url = new URL(endpoint)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) {
    throw new Error("DESKFLEET_MCP_ENDPOINT must be the daemon's loopback MCP endpoint")
  }
  if (!token) throw new Error("DESKFLEET_MCP_TOKEN is required")
  return async (name, args) => {
    const response = await request(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    })
    const result = await response.json() as { result?: unknown; error?: string }
    if (!response.ok) throw new Error(result.error ?? `DeskFleet request failed (${response.status})`)
    return result.result
  }
}

/** Usable from any ACP implementation or another stdio MCP host. */
export async function runMcpStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const invoke = gatewayInvoker(env.DESKFLEET_MCP_ENDPOINT ?? "", env.DESKFLEET_MCP_TOKEN ?? "")
  await createMcpServer(invoke).connect(new StdioServerTransport())
}
