import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { openInMemoryCatalog } from "@deskfleet/native"
import { gatewayInvoker } from "@deskfleet/mcp"
import { AgentMcp, type AgentMcpLease } from "./agent-mcp.ts"
import { AgentSessions } from "./agent-sessions.ts"
import type { AgentActor, AgentSnapshot } from "./agent-protocol.ts"
import type { ComposerReferenceResult } from "./composer-reference-protocol.ts"
import type { AgentClient, AgentConnection, AgentProvider } from "./agents/acp.ts"
import { DaemonCatalog } from "./catalog.ts"

const actor: AgentActor = { kind: "user", userId: "u1", deviceId: "login1" }
function credentials(lease: AgentMcpLease) {
  const server = lease.servers[0]!
  assert.ok("env" in server)
  const env = Object.fromEntries(server.env.map(value => [value.name, value.value]))
  return { endpoint: env.DESKFLEET_MCP_ENDPOINT!, token: env.DESKFLEET_MCP_TOKEN! }
}
function invoke(lease: AgentMcpLease) {
  const { endpoint, token } = credentials(lease)
  return gatewayInvoker(endpoint, token)
}

test("delegation is reauthorized per call, bound to its originating scope and revoked with the lease", async t => {
  const accepted: unknown[] = []
  let authorized = true
  let checks = 0
  const gateway = new AgentMcp({
    async authorize(requestActor, scope) { checks++; assert.deepEqual(requestActor, actor); assert.deepEqual(scope, { sessionId: "2", workspaceId: "3" }); if (!authorized) throw new Error("Membership revoked") },
    async dispatch(method, params, requestActor, scope) { accepted.push({ method, params, actor: requestActor, scope }); return "ok" },
  })
  await gateway.init()
  t.after(() => gateway.close())
  assert.deepEqual(gateway.lease("2", "3", { kind: "local_token" }).servers, [])
  const lease = gateway.lease("2", "3", actor)
  const call = invoke(lease)
  assert.equal(await call("deskfleet_context", {}), "ok")
  assert.equal(checks, 1)
  assert.deepEqual(accepted, [{ method: "catalogList", params: {}, actor, scope: { sessionId: "2", workspaceId: "3" } }])
  authorized = false
  await assert.rejects(call("deskfleet_context", {}), /Membership revoked/)
  assert.equal(accepted.length, 1)
  lease.close()
  await assert.rejects(call("deskfleet_context", {}), /expired/)
})

test("a lease revoked during central authorization cannot dispatch, and callers cannot inject authority", async t => {
  let entered!: () => void
  const checking = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let dispatched = false
  const gateway = new AgentMcp({ async authorize() { entered(); await barrier }, async dispatch() { dispatched = true } })
  await gateway.init()
  t.after(() => gateway.close())
  const lease = gateway.lease("2", "3", actor)
  const { endpoint, token } = credentials(lease)
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "deskfleet_context", actor: { kind: "user", userId: "other" } }) })
  assert.equal(response.status, 400)
  const pending = invoke(lease)("deskfleet_context", {})
  await checking
  lease.close(); release()
  await assert.rejects(pending, /delegation has ended/)
  assert.equal(dispatched, false)
})

class Provider implements AgentProvider {
  id = "codex"
  client?: AgentClient
  servers: acp.McpServer[][] = []
  httpSupported = false
  async connect(_config: unknown, client: AgentClient): Promise<AgentConnection> {
    this.client = client
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} }, mcpCapabilities: { http: this.httpSupported } } },
      newSession: async params => { this.servers.push(params.mcpServers); return { sessionId: "provider-session" } },
      resume: async params => { this.servers.push(params.mcpServers ?? []); return {} },
      setConfigOption: async () => ({ configOptions: [] }), prompt: async () => ({ stopReason: "end_turn" }),
      steer: async () => ({ outcome: "inactive" }), cancel: async () => {}, close: async () => {},
    }
  }
}

test("Session reference capability follows the initiating actor's MCP delegation while drafts use the current viewer", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-mcp-references-"))
  const workspace = join(directory, "workspace")
  await mkdir(workspace)
  const catalog = new DaemonCatalog(join(directory, "daemon"))
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const resource = await catalog.native.createWorkspace("MCP fixture", [{ path: workspace }])
  const gateway = new AgentMcp({ async authorize() {}, async dispatch() {} })
  await gateway.init()
  const provider = new Provider()
  const sessions = new AgentSessions(catalog, catalog.native, provider, undefined, gateway)
  await sessions.init()
  t.after(async () => { await sessions.close(); await gateway.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const create = (initiator: AgentActor) => sessions.handle("_deskfleet/session/create", {
    workspaceId: resource.id, operationId: randomUUID(), provider: "codex", context: "directory",
  }, initiator) as Promise<AgentSnapshot>
  const local = await create(sessions.actor())
  const delegated = await create(actor)
  assert.deepEqual(provider.servers.map(servers => servers.length), [0, 1])
  const search = (scope: { sessionId?: string; workspaceId?: string }) => sessions.handle("_deskfleet/composer/references", {
    ...scope, kind: "session", query: "",
  }, actor) as Promise<ComposerReferenceResult>
  assert.deepEqual(await search({ sessionId: local.session.id }), { items: [], truncated: false })
  const candidate = (await search({ sessionId: delegated.session.id })).items[0]!
  assert.equal(candidate.reference.kind, "session")
  assert.equal(candidate.reference.kind === "session" && candidate.reference.sessionId, local.session.id)
  assert.equal((await search({ workspaceId: resource.id })).items.length, 2)
  await assert.rejects(sessions.handle("_deskfleet/composer/resolve", {
    sessionId: local.session.id, references: [candidate.reference],
  }, actor), /require the built-in MCP server and an authenticated user/u)
  const resolved = await sessions.handle("_deskfleet/composer/resolve", {
    sessionId: delegated.session.id, references: [candidate.reference],
  }, actor) as acp.ContentBlock[]
  assert.equal(resolved[0]?.type, "text")
})

test("ACP creation and resume get fresh grants and stop or connection loss revokes the old grant", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-mcp-"))
  const workspace = join(directory, "workspace")
  await mkdir(workspace)
  const catalog = new DaemonCatalog(join(directory, "daemon"))
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const resource = await catalog.native.createWorkspace("MCP fixture", [{ path: workspace }])
  let additionalServers: acp.McpServer[] = []
  const gateway = new AgentMcp({ servers: () => additionalServers, async authorize() {}, async dispatch() { return "authorized" } })
  await gateway.init()
  const provider = new Provider()
  const sessions = new AgentSessions(catalog, catalog.native, provider, undefined, gateway)
  await sessions.init()
  t.after(async () => { await sessions.close(); await gateway.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const session = await sessions.handle("_deskfleet/session/create", { workspaceId: resource.id, operationId: randomUUID(), provider: "codex", context: "directory" }, actor) as AgentSnapshot
  assert.equal(session.session.error, undefined)
  assert.equal(provider.servers[0]?.length, 1)
  const first = invoke({ servers: provider.servers[0]!, close() {} })
  assert.equal(await first("deskfleet_context", {}), "authorized")
  await sessions.handle("_deskfleet/session/stop", { sessionId: session.session.id, operationId: randomUUID() }, actor)
  await assert.rejects(first("deskfleet_context", {}), /expired/)
  await sessions.handle("_deskfleet/session/resume", { sessionId: session.session.id, operationId: randomUUID() }, actor)
  const second = invoke({ servers: provider.servers[1]!, close() {} })
  assert.equal(await second("deskfleet_context", {}), "authorized")
  assert.notDeepEqual(provider.servers[1], provider.servers[0])
  provider.client?.onClose?.(new Error("fixture exit"))
  await assert.rejects(second("deskfleet_context", {}), /expired/)
  additionalServers = [{ name: "search", type: "http", url: "https://example.com/mcp", headers: [] }]
  await assert.rejects(sessions.handle("_deskfleet/session/resume", { sessionId: session.session.id, operationId: randomUUID() }, actor), /does not support the HTTP transport/)
  assert.equal(provider.servers.length, 2)
  provider.httpSupported = true
  await sessions.handle("_deskfleet/session/resume", { sessionId: session.session.id, operationId: randomUUID() }, actor)
  assert.deepEqual(provider.servers[2]?.map(server => server.name), ["deskfleet", "search"])
  const third = invoke({ servers: provider.servers[2]!, close() {} })
  await sessions.handle("_deskfleet/session/archive", { sessionId: session.session.id, operationId: randomUUID() }, actor)
  await assert.rejects(third("deskfleet_context", {}), /expired/)
})
