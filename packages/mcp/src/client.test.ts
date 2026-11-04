import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { invokeMcp } from "./client.ts"

for (const kind of ["http", "sse"] as const) test(`remote ${kind} uses saved headers for discovery and calls, then closes its connection`, async t => {
  const transports = new Map<string, SSEServerTransport | StreamableHTTPServerTransport>()
  const servers: Server[] = []
  const credentials: string[] = []
  let calls = 0
  const attach = async (transport: SSEServerTransport | StreamableHTTPServerTransport) => {
    const server = new Server({ name: "network-fixture", version: "1" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }))
    server.setRequestHandler(CallToolRequestSchema, async request => {
      calls++
      return { content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] }
    })
    servers.push(server)
    await server.connect(transport)
  }
  const http = createServer((req, res) => {
    void (async () => {
      credentials.push(req.headers.authorization ?? "")
      if (req.headers.authorization !== "Bearer saved-secret") { res.writeHead(401).end(); return }
      if (kind === "sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res)
        transports.set(transport.sessionId, transport)
        await attach(transport)
        return
      }
      const id = kind === "sse" ? new URL(req.url!, "http://localhost").searchParams.get("sessionId")! : req.headers["mcp-session-id"] as string | undefined
      let transport = id ? transports.get(id) : undefined
      if (!transport && kind === "http") {
        const created = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: sessionId => { transports.set(sessionId, created) } })
        transport = created
        await attach(transport)
      }
      if (!transport) { res.writeHead(404).end(); return }
      if (transport instanceof SSEServerTransport) await transport.handlePostMessage(req, res)
      else await transport.handleRequest(req, res)
    })().catch(error => { res.writeHead(500).end(String(error)) })
  })
  http.listen(0, "127.0.0.1"); await once(http, "listening")
  t.after(async () => {
    for (const server of servers) await server.close()
    http.closeAllConnections()
    await http[Symbol.asyncDispose]()
  })
  const connection = { transport: kind, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, headers: { Authorization: "Bearer saved-secret" } }
  let checks = 0
  const authorize = async () => { checks++ }
  const listed = await invokeMcp(connection, { kind: "list" }, AbortSignal.timeout(5_000), authorize) as { tools: { name: string }[] }
  assert.equal(listed.tools[0]?.name, "echo")
  const result = await invokeMcp(connection, { kind: "call", name: "echo", arguments: { message: "hello" } }, AbortSignal.timeout(5_000), authorize)
  assert.deepEqual(result, { content: [{ type: "text", text: '{"message":"hello"}' }] })
  assert.equal(calls, 1)
  assert.equal(checks, 4, "consent is checked both before and after each connection initializes")
  assert.ok(credentials.length >= 6)
  assert.ok(credentials.every(header => header === "Bearer saved-secret"))
})
