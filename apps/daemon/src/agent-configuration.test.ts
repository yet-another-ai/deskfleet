import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { readAgentConfiguration } from "./agent-configuration.ts"
import { connectAcpProcess, type AgentConnection, type AgentProvider } from "./agents/acp.ts"
import { DaemonClient } from "./control-client.ts"
import { validateControlParams } from "./control-request.ts"
import { startControlServer } from "./control-server.ts"

function options(model = "first", effort = "high"): acp.SessionConfigOption[] {
  return [{
    id: "chosen-model", category: "model", name: "Model", type: "select", currentValue: model,
    options: [{ group: "available", name: "Available", options: [
      { value: "first", name: "First model" }, { value: "second", name: "Second model" },
    ] }],
  }, {
    id: "effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: effort,
    options: (model === "first" ? ["low", "high"] : ["low", "medium"]).map(value => ({ value, name: value })),
  }]
}

function fakeProvider(overrides: Partial<AgentConnection> = {}) {
  const changes: acp.SetSessionConfigOptionRequest[] = []
  const sessions: acp.NewSessionRequest[] = []
  let closed = 0
  let connections = 0
  let model = "first"
  let effort = "high"
  const connection: AgentConnection = {
    initialization: { protocolVersion: 1 },
    async newSession(params) { sessions.push(params); return { sessionId: "draft", configOptions: options() } },
    async setConfigOption(params) {
      changes.push(params)
      if (params.configId === "chosen-model") { model = String(params.value); effort = "low" }
      else effort = String(params.value)
      return { configOptions: options(model, effort) }
    },
    async prompt() { assert.fail("Configuration discovery must never prompt") },
    async cancel() {},
    async close() { closed++ },
    ...overrides,
  }
  const provider: AgentProvider = { id: "codex", async connect() { connections++; return connection } }
  return { provider, changes, sessions, get closed() { return closed }, get connections() { return connections } }
}

test("agent configuration comes from ACP, flattens groups, and applies model before effort", async () => {
  const fake = fakeProvider()
  const result = await readAgentConfiguration({ provider: "codex", model: "second", reasoningEffort: "medium" }, process.cwd(), fake)
  assert.deepEqual(fake.sessions, [{ cwd: process.cwd(), mcpServers: [] }])
  assert.deepEqual(fake.changes, [
    { sessionId: "draft", configId: "chosen-model", value: "second" },
    { sessionId: "draft", configId: "effort", value: "medium" },
  ])
  assert.deepEqual(result, {
    provider: { id: "codex", name: "Codex" },
    models: { id: "chosen-model", currentValue: "second", options: [{ id: "first", name: "First model" }, { id: "second", name: "Second model" }] },
    reasoningEfforts: { id: "effort", currentValue: "medium", options: [{ id: "low", name: "low" }, { id: "medium", name: "medium" }] },
  })
  assert.equal(fake.closed, 1)
})

test("model change uses the provider's new effort choices and default", async () => {
  const fake = fakeProvider()
  const result = await readAgentConfiguration({ provider: "codex", model: "second" }, process.cwd(), fake)
  assert.equal(result.reasoningEfforts?.currentValue, "low")
  assert.deepEqual(result.reasoningEfforts?.options.map(option => option.id), ["low", "medium"])
  assert.equal(fake.changes.length, 1)
  assert.equal(fake.closed, 1)
})

test("configuration failures and unsupported options close the connection", async context => {
  await context.test("unsupported effort after model change", async () => {
    const fake = fakeProvider()
    await assert.rejects(readAgentConfiguration({ provider: "codex", model: "second", reasoningEffort: "high" }, process.cwd(), fake), /Unsupported agent reasoning_effort/)
    assert.equal(fake.closed, 1)
  })
  await context.test("provider failure", async () => {
    const fake = fakeProvider({ async newSession() { throw new Error("Agent authentication required") } })
    await assert.rejects(readAgentConfiguration({ provider: "codex" }, process.cwd(), fake), /authentication required/)
    assert.equal(fake.closed, 1)
  })
  await context.test("unsupported configuration", async () => {
    const fake = fakeProvider({ async newSession() { return { sessionId: "draft" } } })
    const result = await readAgentConfiguration({ provider: "codex" }, process.cwd(), fake)
    assert.equal(result.models, null)
    assert.equal(result.reasoningEfforts, null)
    assert.equal(fake.closed, 1)
  })
})

test("a stalled ACP session request times out and closes its process", { timeout: 15_000 }, async () => {
  let closed = false
  const provider: AgentProvider = {
    id: "codex",
    async connect(config, client) {
      const connection = await connectAcpProcess({
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))],
        env: { DESKFLEET_TEST_AGENT_MODE: "wait-session" },
      }, client)
      return { ...connection, async close() { await connection.close(); closed = true } }
    },
  }
  await assert.rejects(readAgentConfiguration({ provider: "codex" }, process.cwd(), { provider, timeoutMs: 500 }), /timed out/)
  assert.equal(closed, true)
})

test("configuration IPC resolves cwd from the catalog and rejects unknown worktrees", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-agent-config-"))
  const fake = fakeProvider()
  const server = await startControlServer({ async create() { assert.fail() }, async close() {} }, directory, undefined, undefined, undefined, fake.provider)
  context.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => client.close())
  const workspace = await client.call("workspaceCreate", { name: "Configuration target", directories: [{ path: directory }, { path: tmpdir() }] })
  await client.call("agentConfiguration", { provider: "codex", worktreeId: workspace.worktrees[0]!.id })
  assert.equal(fake.sessions[0]?.cwd, directory)
  await client.call("agentConfiguration", { provider: "codex" })
  assert.equal(fake.sessions[1]?.cwd, homedir())
  await assert.rejects(client.call("agentConfiguration", { provider: "codex", worktreeId: "99999" }), /Unknown local worktree/)
  assert.equal(fake.connections, 2)
  const snapshot = await client.call("catalogList", {})
  assert.equal(snapshot.workspaces[0]?.worktrees.length, 1)
  assert.equal(fake.closed, 2)
})

test("configuration parameters reject unsupported agents and malformed choices", () => {
  for (const params of [
    { provider: "unknown" }, { provider: "codex", worktreeId: "../file" },
    { provider: "codex", model: 42 }, { provider: "codex", reasoningEffort: "" },
  ]) assert.throws(() => validateControlParams("agentConfiguration", params))
  assert.deepEqual(validateControlParams("agentConfiguration", { provider: "codex", worktreeId: "1", model: "model", reasoningEffort: "high" }), {
    provider: "codex", worktreeId: "1", model: "model", reasoningEffort: "high",
  })
})

test("client disconnect closes a pending configuration process before control stops", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-agent-config-disconnect-"))
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const fake = fakeProvider({ async newSession() { ready(); return new Promise(() => {}) } })
  const server = await startControlServer({ async create() { assert.fail() }, async close() {} }, directory, undefined, undefined, undefined, fake.provider)
  context.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }) })
  const client = await DaemonClient.connect(() => {}, () => {}, directory)
  context.after(() => client.close())
  const pending = assert.rejects(client.call("agentConfiguration", { provider: "codex" }), /connection closed/i)
  await started
  client.close()
  await pending
  await server.stop()
  assert.equal(fake.closed, 1)
})
