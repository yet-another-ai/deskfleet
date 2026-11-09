import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer, gatewayInvoker } from "./server.ts"

test("MCP clients discover scheduling tools and receive operation failures as tool errors", async t => {
  const calls: unknown[] = []
  const server = createMcpServer(async (name, args) => {
    calls.push({ name, args })
    if (name === "deskfleet_schedule_run") throw new Error("The task is already running")
    return [{ id: "12" }]
  })
  const client = new Client({ name: "independent-agent", version: "1.0.0" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  t.after(async () => { await client.close(); await server.close() })
  const listed = await client.listTools()
  assert.ok(listed.tools.some(tool => tool.name === "deskfleet_schedule_create"))
  assert.ok(listed.tools.some(tool => tool.name === "deskfleet_providers"))
  assert.ok(listed.tools.every(tool => !("method" in tool)))
  const schedules = await client.callTool({ name: "deskfleet_schedules", arguments: {} })
  assert.deepEqual(schedules.content, [{ type: "text", text: '[{"id":"12"}]' }])
  const failed = await client.callTool({ name: "deskfleet_schedule_run", arguments: { scheduleId: "12" } })
  assert.equal(failed.isError, true)
  assert.deepEqual(calls, [{ name: "deskfleet_schedules", args: {} }, { name: "deskfleet_schedule_run", args: { scheduleId: "12" } }])
})

for (const [label, path, args] of [
  ["standalone", "./main.ts", []],
  ["daemon child command", "../../../apps/daemon/src/main.ts", ["--deskfleet-mcp"]],
] as const) test(`${label} runs under an ordinary MCP host and forwards its delegated credential`, async t => {
  const requests: unknown[] = []
  const gateway = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, "Bearer fixture-secret")
      let body = ""
      for await (const chunk of request) body += String(chunk)
      requests.push(JSON.parse(body))
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ result: { workspaceId: "7" } }))
    })().catch(error => { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })) })
  })
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/mcp`
  const client = new Client({ name: "external-mcp-host", version: "1" })
  t.after(async () => { await client.close(); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())) })
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL(path, import.meta.url)), ...args],
    env: { DESKFLEET_MCP_ENDPOINT: endpoint, DESKFLEET_MCP_TOKEN: "fixture-secret" },
  }))
  const result = await client.callTool({ name: "deskfleet_context", arguments: {} })
  assert.deepEqual(result.content, [{ type: "text", text: '{"workspaceId":"7"}' }])
  assert.deepEqual(requests, [{ name: "deskfleet_context", arguments: {} }])
})

test("the bridge refuses non-loopback credential destinations and redirects", async () => {
  for (const endpoint of ["https://example.com/mcp", "http://localhost:123/mcp", "http://127.0.0.1:123/other", "http://u:p@127.0.0.1:123/mcp"]) {
    assert.throws(() => gatewayInvoker(endpoint, "secret"))
  }
  const invoke = gatewayInvoker("http://127.0.0.1:123/mcp", "secret", async input => {
    assert.ok(input instanceof Request)
    assert.equal(input.redirect, "error")
    return Response.json({ error: "Access revoked" }, { status: 403 })
  })
  await assert.rejects(invoke("deskfleet_context", {}), /Access revoked/)
})

test("the gateway never repeats tool calls after a transport or server failure", async () => {
  for (const failure of ["network", "server"] as const) {
    let calls = 0
    const invoke = gatewayInvoker("http://127.0.0.1:123/mcp", "secret", async input => {
      calls++
      assert.ok(input instanceof Request)
      assert.equal(input.headers.get("authorization"), "Bearer secret")
      assert.deepEqual(await input.json(), { name: "deskfleet_schedule_run", arguments: { scheduleId: "12" } })
      if (failure === "network") throw new TypeError("fetch failed")
      return Response.json({ error: "Temporarily unavailable" }, { status: 503 })
    })
    await assert.rejects(invoke("deskfleet_schedule_run", { scheduleId: "12" }), failure === "network" ? /fetch failed/ : /Temporarily unavailable/)
    assert.equal(calls, 1)
  }
})

test("remote tools are discoverable and retain the remote MCP result, including isError", async t => {
  const result = { isError: true, content: [{ type: "text" as const, text: "remote failure" }], structuredContent: { code: "denied" } }
  const server = createMcpServer(async () => result)
  const client = new Client({ name: "agent", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  t.after(async () => { await client.close(); await server.close() })
  const tools = (await client.listTools()).tools.map(tool => tool.name)
  assert.ok(tools.includes("deskfleet_remote_machines"))
  assert.ok(tools.includes("deskfleet_remote_session_history"))
  assert.ok(tools.includes("deskfleet_remote_session_create"))
  assert.ok(tools.includes("deskfleet_remote_session_send"))
  assert.ok(tools.includes("deskfleet_session_create"))
  assert.ok(tools.includes("deskfleet_session_send"))
  assert.ok(tools.includes("deskfleet_remote_files"))
  assert.ok(tools.includes("deskfleet_remote_file_upload"))
  assert.ok(tools.includes("deskfleet_remote_file_download"))
  assert.deepEqual(await client.callTool({ name: "deskfleet_remote_mcp_call", arguments: { machineId: "target", serverId: "server", name: "tool", arguments: {} } }), result)
})
