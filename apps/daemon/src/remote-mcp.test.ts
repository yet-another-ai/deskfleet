import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test, { type TestContext } from "node:test"
import type { MachineOperations } from "./machine-operations.ts"
import { McpServers } from "./mcp-servers.ts"
import { RemoteMcp } from "./remote-mcp.ts"
import { readRemoteAgentSettings, writeRemoteAgentSettings } from "./remote-agent-settings.ts"

const target = { teamId: "team", machineId: "target" }
const source = { teamId: "team", machineId: "source", sessionId: "source-session" }
const actor = { kind: "user" as const, userId: "user", deviceId: "login", sourceMachine: { id: "source", originId: "origin" } }

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "df-remote-mcp-"))
  const servers = new McpServers(directory)
  await servers.init()
  const output = join(directory, "result.json")
  const config = await servers.create({ name: "fixture", enabled: true, transport: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("../../../packages/mcp/src/fixtures/remote-server.ts", import.meta.url))], env: { DESKFLEET_TEST_OUTPUT: output, PRIVATE_SECRET: "never-disclose" } })
  const calls: unknown[] = []
  const operations = {
    mcpServers: servers,
    catalog: { native: { snapshot: async () => ({ machineId: "local-target", workspaces: [{ id: "workspace" }] }) } },
    providers: { metadata: () => ({ providers: [{ id: "agent", name: "Agent" }] }) },
    agents: {
      journal: { list: async () => [{ id: "session", workspaceId: "workspace" }, { id: "standalone" }] },
      handle: async (method: string, params: Record<string, unknown>, ...args: unknown[]) => {
        calls.push([method, params, ...args])
        if (method === "_deskfleet/session/create") return { session: { id: "created-session", workspaceId: params.workspaceId, lifecycle: "ready" } }
        if (method === "_deskfleet/input/submit") return { operationId: params.operationId, commandId: "cmd-1", sessionId: params.sessionId, inputId: "in-1" }
        return { conversation: "hello" }
      },
    },
  } as unknown as MachineOperations
  const service = new RemoteMcp(directory, operations)
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }) })
  const call = (operation: string, args: Record<string, unknown> = {}) => service.handle("remoteMcp", { source, operation, arguments: args }, actor, target)
  return { directory, output, service, operations, servers, config, calls, call }
}

test("remote access defaults off, persists across readers, and disabling immediately blocks requests", async t => {
  const f = await fixture(t)
  assert.deepEqual(await readRemoteAgentSettings(f.directory), { allowRead: false, allowOperate: false, allowSessions: false })
  assert.deepEqual(await f.service.handle("remoteMcpDiscover", source, actor, target), { allowRead: false, allowOperate: false, allowSessions: false })
  for (const method of ["machine", "sessions", "session", "history", "sessionCreate", "sessionSend", "mcpServers", "mcpTools", "mcpCall", "filesRead", "filesWrite"]) await assert.rejects(f.call(method), /does not allow/)
  await writeRemoteAgentSettings(f.directory, { allowRead: true, allowOperate: false })
  await assert.rejects(f.call("sessionCreate", { provider: "agent" }), /start or message Sessions/)
  await assert.rejects(f.call("sessionSend", { sessionId: "session", prompt: "hello" }), /start or message Sessions/)
  assert.deepEqual(await f.call("sessions", { workspaceId: "workspace" }), [{ id: "session", workspaceId: "workspace" }])
  assert.deepEqual(await f.call("session", { sessionId: "session" }), { conversation: "hello" })
  await f.call("history", { sessionId: "session", afterSeq: "17", limit: 10 })
  assert.deepEqual(f.calls[1], ["_deskfleet/session/history", { sessionId: "session", afterSeq: "17", limit: 10 }, actor])
  assert.deepEqual(await f.call("mcpServers"), [{ id: f.config.id, name: "fixture", transport: "stdio" }])
  assert.doesNotMatch(JSON.stringify(await f.call("machine")), /never-disclose|PRIVATE_SECRET/)
  await writeRemoteAgentSettings(f.directory, { allowRead: false, allowOperate: false })
  await assert.rejects(f.call("sessions"), /does not allow/)
  await writeFile(join(f.directory, "remote-agent-settings.json"), '{"allowRead":"true","allowOperate":false}')
  await assert.rejects(f.call("sessions"), /boolean/)
})

test("real MCP discovery paginates; even a read-only tool needs operate permission; results preserve errors", async t => {
  const f = await fixture(t)
  await writeRemoteAgentSettings(f.directory, { allowRead: true, allowOperate: false })
  const page = await f.call("mcpTools", { serverId: f.config.id }) as { tools: { name: string }[]; nextCursor: string }
  assert.equal(page.tools[0]?.name, "record")
  const next = await f.call("mcpTools", { serverId: f.config.id, cursor: page.nextCursor }) as { tools: { name: string }[] }
  assert.equal(next.tools[0]?.name, "second")
  await assert.rejects(f.call("mcpCall", { serverId: f.config.id, name: "record", arguments: {} }), /operate/)
  await writeRemoteAgentSettings(f.directory, { allowRead: false, allowOperate: true })
  await assert.rejects(f.call("sessions"), /read it/)
  await assert.rejects(f.call("sessionCreate", { provider: "agent" }), /start or message Sessions/)
  assert.deepEqual(await f.call("mcpCall", { serverId: f.config.id, name: "record", arguments: { text: "from source" } }), {
    content: [{ type: "text", text: "recorded" }], structuredContent: { recorded: true },
  })
  const recorded = JSON.parse(await readFile(f.output, "utf8"))
  assert.deepEqual(recorded.arguments, { text: "from source" })
  // Windows may report the inherited temporary directory using its short path.
  assert.equal(await realpath(recorded.cwd), await realpath(f.directory))
  assert.equal((await f.call("mcpCall", { serverId: f.config.id, name: "fail", arguments: {} }) as { isError: boolean }).isError, true)
  const { id, ...input } = f.config
  await f.servers.update(id, { ...input, enabled: false })
  await assert.rejects(f.call("mcpTools", { serverId: id }), /not found/)
  await f.servers.remove(f.config.id)
  await assert.rejects(f.call("mcpTools", { serverId: f.config.id }), /not found/)
  await writeRemoteAgentSettings(f.directory, { allowRead: false, allowOperate: false, allowSessions: true })
  assert.deepEqual(await f.call("sessionCreate", { workspaceId: "workspace", provider: "agent", context: "worktree", title: "Remote task", prompt: "Build and test" }), { conversation: "hello" })
  assert.deepEqual({ ...(f.calls[0] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    workspaceId: "workspace", operationId: "op", title: "Remote task", provider: "agent", context: "worktree",
  })
  assert.deepEqual({ ...(f.calls[1] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    sessionId: "created-session", operationId: "op", content: [{ type: "text", text: "Build and test" }], delivery: "backlog",
  })
  assert.deepEqual(f.calls[2], ["_deskfleet/session/subscribe", { sessionId: "created-session" }, actor])
  await f.call("sessionCreate", { provider: "agent" })
  assert.deepEqual({ ...(f.calls[3] as [string, Record<string, unknown>])[1], operationId: "op" }, {
    operationId: "op", provider: "agent", context: "directory",
  })
  const sent = await f.call("sessionSend", { sessionId: "created-session", prompt: "Continue" }) as { sessionId: string; inputId: string }
  assert.equal(sent.sessionId, "created-session")
  assert.equal(sent.inputId, "in-1")
  await assert.rejects(f.call("sessionCreate", { provider: "agent", context: "worktree" }), /home directory/)
  await assert.rejects(f.call("sessionSend", { sessionId: "created-session", prompt: "Steer", turnId: "t1" }), /steer/)
})

test("a permission change during MCP startup prevents tool dispatch", async t => {
  const f = await fixture(t)
  await writeRemoteAgentSettings(f.directory, { allowRead: true, allowOperate: true })
  const service = new RemoteMcp(f.directory, f.operations, async (_connection, _request, _signal, authorize) => {
    await authorize()
    await writeRemoteAgentSettings(f.directory, { allowRead: true, allowOperate: false })
    await authorize()
    assert.fail("revoked tool must not execute")
  })
  await assert.rejects(service.handle("remoteMcp", { source, operation: "mcpCall", arguments: { serverId: f.config.id, name: "record" } }, actor, target), /operate/)
})

test("remote requests cannot cross Teams, impersonate the source, or tunnel Agent messaging", async t => {
  const f = await fixture(t)
  await writeRemoteAgentSettings(f.directory, { allowRead: true, allowOperate: true })
  for (const changed of [{ ...source, teamId: "other" }, { ...source, machineId: "target" }, { ...source, machineId: "forged" }]) {
    await assert.rejects(f.service.handle("remoteMcpDiscover", changed, actor, target), /delegated user/)
  }
  await assert.rejects(f.service.handle("remoteMcpDiscover", source, undefined, target), /delegated user/)
  for (const method of ["_deskfleet/input/submit", "scheduleRun", "remoteMcp/mcpCall"]) await assert.rejects(f.call(method), /Unsupported/)
  await assert.rejects(f.call("mcpCall", { serverId: "deskfleet", name: "deskfleet_schedule_run", arguments: {} }), /not found/)
  await assert.rejects(f.call("history", { sessionId: "s", afterSeq: "0", limit: 201 }), /limit/)
  await assert.rejects(f.call("history", { sessionId: "s", afterSeq: "-1" }), /afterSeq/)
  await assert.rejects(f.call("sessions", { userId: "forged" }), /Unrecognized key/i)
  f.service.close()
  await assert.rejects(f.call("sessions"), /stopping/)
})
