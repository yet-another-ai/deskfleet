import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export type McpConnection =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { transport: "http" | "sse"; url: string; headers: Record<string, string> }
export type McpInvocation = { kind: "list"; cursor?: string } | { kind: "call"; name: string; arguments: Record<string, unknown> }

/** A fresh connection belongs to one request and never inherits the invoking Agent's credentials. */
export async function invokeMcp(
  connection: McpConnection, request: McpInvocation, signal: AbortSignal, authorize: () => Promise<void>,
): Promise<unknown> {
  await authorize()
  signal.throwIfAborted()
  const client = new Client({ name: "deskfleet-remote", version: "0.15.1" })
  const networkFetch: typeof fetch = (input, init) => fetch(input, {
    ...init,
    // Session deletion must still reach the server after the call or transport was aborted.
    signal: init?.method === "DELETE" ? AbortSignal.timeout(5_000)
      : AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
  })
  const transport = connection.transport === "stdio"
    ? new StdioClientTransport({ ...connection, stderr: "ignore" })
    : connection.transport === "http"
      ? new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers }, fetch: networkFetch })
      : new SSEClientTransport(new URL(connection.url), {
        requestInit: { headers: connection.headers }, fetch: networkFetch,
      })
  const options = { signal, timeout: 45_000 }
  try {
    await client.connect(transport, options)
    // Settings can change while an MCP server is starting or authenticating.
    await authorize()
    signal.throwIfAborted()
    return request.kind === "list"
      ? await client.listTools(request.cursor === undefined ? {} : { cursor: request.cursor }, options)
      : await client.callTool({ name: request.name, arguments: request.arguments }, undefined, options)
  } finally {
    try {
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) await transport.terminateSession()
    } catch (error) {
      // Cleanup failure must not replace the tool outcome and invite a duplicate execution.
      console.error("Remote MCP session cleanup failed:", error)
    } finally { await client.close() }
  }
}
