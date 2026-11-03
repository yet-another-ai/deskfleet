import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AgentMcp } from "./agent-mcp.ts"
import { McpServers } from "./mcp-servers.ts"
import { mcpServerInput, type McpServerInput } from "./mcp-server-protocol.ts"

const stdio: McpServerInput = { name: "filesystem", enabled: true, transport: "stdio", command: process.execPath, args: ["server.mjs"], env: { API_KEY: "private" } }

test("additional MCP servers persist independently, seed bundled AUV once, and allow toggling or removing it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-mcp-settings-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const servers = new McpServers(directory, "/opt/auv/auv")
  await servers.init()
  const seeded = servers.snapshot().servers
  assert.equal(seeded.length, 1)
  assert.equal(seeded[0]?.name, "auv")
  assert.equal(seeded[0]?.enabled, true)
  const resolvedAuv = servers.resolve()[0]
  assert.ok(resolvedAuv && !("type" in resolvedAuv))
  assert.ok(resolvedAuv.args.includes("--auv-mcp"))
  assert.deepEqual(resolvedAuv.env, [{ name: "DESKFLEET_AUV_PATH", value: "/opt/auv/auv" }])
  const first = await servers.create(stdio)
  const http = await servers.create({ name: "search", enabled: true, transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer private" } })
  await servers.create({ name: "legacy", enabled: false, transport: "sse", url: "http://localhost:8123/sse", headers: {} })
  const { id: auvId, ...auvInput } = seeded[0]!
  await servers.update(auvId, { ...auvInput, enabled: false })
  assert.deepEqual(servers.resolve(), [
    { name: "filesystem", command: process.execPath, args: ["server.mjs"], env: [{ name: "API_KEY", value: "private" }] },
    { name: "search", type: "http", url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "Bearer private" }] },
  ])
  await servers.update(first.id, { ...stdio, enabled: false })
  assert.equal(servers.resolve().length, 1)
  await servers.remove(auvId)
  const reloaded = new McpServers(directory, "/opt/auv/auv")
  await reloaded.init()
  assert.deepEqual(reloaded.snapshot().servers, servers.snapshot().servers)
  await reloaded.remove(http.id)
  assert.deepEqual(reloaded.resolve(), [])
  const saved = JSON.parse(await readFile(join(directory, "mcp-servers.json"), "utf8")) as { servers: unknown[] }
  assert.equal(saved.servers.length, 2)
})

test("built-in deskfleet MCP server cannot be replaced or disabled by additional-server settings", async t => {
  for (const name of ["deskfleet", " Deskfleet ", "DESKFLEET"]) {
    assert.throws(() => mcpServerInput({ ...stdio, name }), /always enabled/)
  }
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-mcp-built-in-"))
  const servers = new McpServers(directory)
  await servers.init()
  const extra = await servers.create({ ...stdio, enabled: false })
  const mcp = new AgentMcp({ servers: () => servers.resolve(), async authorize() {}, async dispatch() {} })
  await mcp.init()
  t.after(async () => { await mcp.close(); await rm(directory, { recursive: true, force: true }) })
  const actor = { kind: "user" as const, userId: "u1", deviceId: "login1" }
  const original = mcp.lease("2", "3", actor)
  assert.deepEqual(original.servers.map(server => server.name), ["deskfleet"])
  await servers.update(extra.id, stdio)
  const changed = mcp.lease("2", "3", actor)
  assert.deepEqual(changed.servers.map(server => server.name), ["deskfleet", "filesystem"])
  assert.deepEqual(mcp.lease("2", "3", { kind: "local_token" }).servers.map(server => server.name), ["filesystem"])
  assert.deepEqual(original.servers.map(server => server.name), ["deskfleet"])
  assert.throws(() => servers.create({ ...stdio, name: "Deskfleet" }), /always enabled/)
  await assert.rejects(servers.create({ ...stdio, name: "FileSystem" }), /already exists/)
  original.close(); changed.close()
})

test("MCP settings reject malformed process arguments, credentials and URLs", () => {
  assert.throws(() => mcpServerInput({ ...stdio, command: "relative-command" }), /absolute executable/)
  assert.throws(() => mcpServerInput({ ...stdio, args: ["bad\0argument"] }), /arguments/)
  assert.throws(() => mcpServerInput({ name: "web", enabled: true, transport: "http", url: "https://user:secret@example.com/mcp", headers: {} }), /credentials in headers/)
  assert.throws(() => mcpServerInput({ name: "web", enabled: true, transport: "http", url: "https://example.com/mcp", headers: { Authorization: "bad\nheader" } }), /setting value/)
})
