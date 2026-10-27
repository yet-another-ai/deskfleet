import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { openInMemoryCatalog } from "@deskfleet/native"
import { applyAgentConfiguration, readAgentConfiguration } from "./agent-configuration.ts"
import { connectAcpProcess, type AgentConfig, type AgentConnection, type AgentProvider } from "./agents/acp.ts"
import { DaemonCatalog } from "./catalog.ts"
import { AgentSessions } from "./agent-sessions.ts"
import { AgentProviders } from "./agent-providers.ts"
import { agentConfiguration, validateAgentConfigurationParams, type AgentConfiguration } from "./agent-configuration-protocol.ts"

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
  const configs: AgentConfig[] = []
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
    async resume() { assert.fail("Discovery must never resume") },
    async steer() { assert.fail("Discovery must never steer") },
    async prompt() { assert.fail("Configuration discovery must never prompt") },
    async cancel() {},
    async close() { closed++ },
    ...overrides,
  }
  const provider: AgentProvider = { id: "codex", async connect(config) { connections++; configs.push(config); return connection } }
  return { provider, changes, sessions, configs, get closed() { return closed }, get connections() { return connections } }
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
    modes: null,
  })
  assert.equal(fake.closed, 1)
})

test("reasoning effort applies when its option id is effort and it has no category", async () => {
  const choices = (effort = "high"): acp.SessionConfigOption[] => [{
    id: "model", category: "model", name: "Model", type: "select", currentValue: "first",
    options: [{ value: "first", name: "First" }],
  }, {
    id: "effort", name: "Reasoning", type: "select", currentValue: effort,
    options: ["low", "medium", "high"].map(value => ({ value, name: value })),
  }]
  let effort = "high"
  const fake = fakeProvider({
    async newSession() { return { sessionId: "draft", configOptions: choices() } },
    async setConfigOption(params) {
      assert.equal(params.configId, "effort")
      assert.equal(params.value, "low")
      effort = "low"
      return { configOptions: choices(effort) }
    },
  })
  const result = await readAgentConfiguration({ provider: "codex", reasoningEffort: "low" }, process.cwd(), fake)
  assert.equal(result.reasoningEfforts?.id, "effort")
  assert.equal(result.reasoningEfforts?.currentValue, "low")
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

test("native mode choices retain their names and descriptions separately from collaboration mode", async () => {
  const nativeOptions: acp.SessionConfigOption[] = [{
    id: "collaboration_mode", name: "Collaboration", type: "select", currentValue: "plan",
    options: [{ value: "plan", name: "Plan" }],
  }, {
    id: "permission-mode", category: "mode", name: "Mode", type: "select", currentValue: "workspace-write",
    options: [{ group: "permissions", name: "Permissions", options: [
      { value: "workspace-write", name: "Workspace access", description: "Ask before leaving the workspace." },
      { value: "agent", name: "Auto review", description: "Review permission requests automatically." },
      { value: "agent-full-access", name: "Full access" },
    ] }],
  }]
  const fake = fakeProvider({ async newSession() { return { sessionId: "draft", configOptions: nativeOptions } } })
  const configuration = await readAgentConfiguration({ provider: "codex" }, process.cwd(), fake)
  assert.deepEqual(configuration.modes, {
    id: "permission-mode", currentValue: "workspace-write", options: [
      { id: "workspace-write", name: "Workspace access", description: "Ask before leaving the workspace." },
      { id: "agent", name: "Auto review", description: "Review permission requests automatically." },
      { id: "agent-full-access", name: "Full access" },
    ],
  })
  const fallback = nativeOptions[1]!
  assert.deepEqual(agentConfiguration([{ ...fallback, id: "mode", category: undefined }]).modes, {
    ...configuration.modes, id: "mode",
  })
})

test("mode is applied after model and effort and uses the provider's effective mode", async () => {
  const mode = (currentValue: string): acp.SessionConfigOption => ({
    id: "permission-mode", category: "mode", name: "Mode", type: "select", currentValue,
    options: ["manual", "auto"].map(value => ({ value, name: value })),
  })
  const changes: acp.SetSessionConfigOptionRequest[] = []
  const fake = fakeProvider({ async setConfigOption(params) {
    changes.push(params)
    return { configOptions: [...options("second", params.configId === "chosen-model" ? "low" : "medium"), mode("manual")] }
  } })
  const connection = await fake.provider.connect({ name: "Codex" }, { onUpdate() {} })
  const confirmed: acp.SessionConfigOption[][] = []
  const result = await applyAgentConfiguration(connection, "draft", [...options(), mode("manual")], {
    model: "second", reasoningEffort: "medium", mode: "auto",
  }, options => { confirmed.push(options) })
  assert.deepEqual(changes.map(change => [change.configId, change.value]), [
    ["chosen-model", "second"], ["effort", "medium"], ["permission-mode", "auto"],
  ])
  assert.equal(agentConfiguration(result).modes?.currentValue, "manual", "The agent can decline Auto for the selected model")
  assert.equal(confirmed.length, 3)
  await assert.rejects(applyAgentConfiguration(connection, "draft", result, { mode: "invented-mode" }), /Unsupported agent mode/)
  assert.equal(changes.length, 3, "Unavailable modes never reach the provider")
  await connection.close()
})

test("discovery uses opening notifications when the session response omits options", async () => {
  const fake = fakeProvider()
  const provider: AgentProvider = {
    id: "codex",
    async connect(config, client) {
      const connection = await fake.provider.connect(config, client)
      return { ...connection, async newSession() {
        await client.onUpdate({ sessionId: "draft", update: { sessionUpdate: "config_option_update", configOptions: options() } })
        return { sessionId: "draft" }
      } }
    },
  }
  const result = await readAgentConfiguration({ provider: "codex", model: "second", reasoningEffort: "medium" }, process.cwd(), { provider })
  assert.equal(result.models?.currentValue, "second")
  assert.equal(result.reasoningEfforts?.currentValue, "medium")
  assert.deepEqual(fake.changes, [
    { sessionId: "draft", configId: "chosen-model", value: "second" },
    { sessionId: "draft", configId: "effort", value: "medium" },
  ])
  assert.equal(fake.closed, 1)
})

test("discovery honors explicitly empty options over an opening notification", async () => {
  const fake = fakeProvider()
  const provider: AgentProvider = {
    id: "codex",
    async connect(config, client) {
      const connection = await fake.provider.connect(config, client)
      return { ...connection, async newSession() {
        await client.onUpdate({ sessionId: "draft", update: { sessionUpdate: "config_option_update", configOptions: options() } })
        return { sessionId: "draft", configOptions: [] }
      } }
    },
  }
  const result = await readAgentConfiguration({ provider: "codex" }, process.cwd(), { provider })
  assert.equal(result.models, null)
  assert.equal(result.reasoningEfforts, null)
  assert.deepEqual(fake.changes, [])
  assert.equal(fake.closed, 1)
})

test("recovery discovery lists a saved model's efforts without requiring its unavailable effort", async () => {
  const fake = fakeProvider()
  const result = await readAgentConfiguration({ provider: "codex", model: "second", reasoningEffort: "retired" }, process.cwd(), {
    ...fake, recoverSelection: true,
  })
  assert.equal(result.models?.currentValue, "second")
  assert.deepEqual(result.reasoningEfforts?.options.map(option => option.id), ["low", "medium"])
  assert.deepEqual(fake.changes, [{ sessionId: "draft", configId: "chosen-model", value: "second" }])
  assert.equal(fake.closed, 1)
})

test("recovery discovery still offers replacement models when the saved model is rejected", async () => {
  const fake = fakeProvider({ async setConfigOption() { throw new Error("Model no longer available") } })
  const result = await readAgentConfiguration({ provider: "codex", model: "second" }, process.cwd(), {
    ...fake, recoverSelection: true,
  })
  assert.deepEqual(result.models?.options.map(option => option.id), ["first", "second"])
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

test("a stalled ACP session request times out and closes its process", { timeout: 15_000 }, async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  let closed = false
  const provider: AgentProvider = {
    id: "codex",
    async connect(config, client) {
      const connection = await connectAcpProcess({
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/acp-agent.ts", import.meta.url))],
        env: { DESKFLEET_TEST_AGENT_MODE: "wait-session" },
      }, client)
      return {
        ...connection,
        newSession(params) {
          const pending = connection.newSession(params)
          ready()
          return pending
        },
        async close() { await connection.close(); closed = true },
      }
    },
  }
  const pending = assert.rejects(readAgentConfiguration({ provider: "codex" }, process.cwd(), { provider, timeoutMs: 500 }), /timed out/)
  // Advance the deadline only once session/new is pending, regardless of startup speed.
  await started
  context.mock.timers.tick(500)
  await pending
  assert.equal(closed, true)
})

test("configuration discovery uses the target workspace without allocating a Session", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-agent-config-"))
  const fake = fakeProvider()
  const catalog = new DaemonCatalog(directory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const service = new AgentSessions(catalog, catalog.native, fake.provider, undefined, undefined, undefined, new TestAgentQuotas())
  await service.init()
  context.after(async () => { await service.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const workspace = await catalog.native.createWorkspace("Configuration target", [{ path: directory }, { path: tmpdir() }])
  await service.handle("_deskfleet/agent/configuration", { provider: "codex", workspaceId: workspace.id }, service.actor())
  assert.equal(fake.sessions[0]?.cwd, directory)
  await service.handle("_deskfleet/agent/configuration", { provider: "codex" }, service.actor())
  assert.equal(fake.sessions[1]?.cwd, homedir())
  await assert.rejects(service.handle("_deskfleet/agent/configuration", { provider: "codex", workspaceId: "99999" }, service.actor()), /Unknown local workspace/)
  assert.equal(fake.connections, 2)
  assert.equal((await catalog.native.snapshot()).workspaces[0]?.worktrees.length, 1)
  assert.deepEqual(await service.journal.list(), [])
  assert.equal(fake.closed, 2)
})

test("configuration parameters reject invalid provider IDs and malformed choices", () => {
  for (const params of [
    { provider: "../unknown" }, { provider: "codex", workspaceId: "../file" },
    { provider: "codex", model: 42 }, { provider: "codex", reasoningEffort: "" },
    { provider: "codex", mode: "" }, { provider: "codex", mode: "invalid\0mode" },
    { provider: "codex", probeId: "not-a-uuid" }, { provider: "codex", release: true },
    { provider: "codex", release: "true" },
    { provider: "codex", restore: {} },
    { provider: "codex", probeId: "cc8b5b3d-154a-4bf8-89f6-dd2403a646f5", restore: { mode: "" } },
  ]) assert.throws(() => validateAgentConfigurationParams(params))
  assert.doesNotThrow(() => validateAgentConfigurationParams({ provider: "configured-agent", workspaceId: "1", model: "model", reasoningEffort: "high", mode: "auto" }))
})

test("draft probes reuse startup, isolate callers, and invalidate changed launch settings and directories", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-agent-config-probes-"))
  const fake = fakeProvider()
  const catalog = new DaemonCatalog(directory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const providers = new AgentProviders(directory, fake.provider)
  await providers.init()
  const service = new AgentSessions(catalog, catalog.native, fake.provider, providers, undefined, undefined, new TestAgentQuotas())
  await service.init()
  context.after(async () => { await service.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const workspace = await catalog.native.createWorkspace("Draft", [{ path: directory }])
  const params = { provider: "codex", workspaceId: workspace.id, probeId: "cc8b5b3d-154a-4bf8-89f6-dd2403a646f5" }
  const first = { kind: "user" as const, userId: "alice", deviceId: "login-1" }
  const second = { ...first, deviceId: "login-2" }
  await service.handle("_deskfleet/agent/configuration", params, first)
  await service.handle("_deskfleet/agent/configuration", { ...params, model: "second" }, first)
  assert.equal(fake.connections, 1, "A model switch reuses the draft process and session")
  assert.equal(fake.sessions.length, 1)
  assert.equal(fake.closed, 0)
  await service.handle("_deskfleet/agent/configuration", params, second)
  assert.equal(fake.connections, 2, "Another login cannot reuse the same probe ID")
  await service.handle("_deskfleet/agent/configuration", { ...params, release: true }, second)
  assert.equal(fake.closed, 1)
  await service.handle("_deskfleet/agent/configuration", params, first)
  assert.equal(fake.connections, 2, "Releasing another login's probe leaves this one usable")
  await providers.update("codex", { name: "Updated", binaryPath: "updated-codex", env: {} })
  const updated = await service.handle("_deskfleet/agent/configuration", params, first) as AgentConfiguration
  assert.equal(updated.provider.name, "Updated")
  assert.equal(fake.configs.at(-1)?.binaryPath, "updated-codex")
  assert.equal(fake.connections, 3)
  await catalog.native.updateWorkspace(workspace.id, "Moved", [{ path: tmpdir() }])
  await service.handle("_deskfleet/agent/configuration", params, first)
  assert.equal(fake.sessions.at(-1)?.cwd, tmpdir())
  assert.equal(fake.connections, 4)
  await providers.remove("codex")
  assert.equal(await service.handle("_deskfleet/agent/configuration", { ...params, workspaceId: "99999", release: true }, first), null,
    "Cleanup works even when its provider and workspace no longer exist")
  assert.deepEqual(await service.journal.list(), [])
  assert.equal((await catalog.native.snapshot()).workspaces[0]?.worktrees.length, 1)
  await service.close()
  assert.equal(fake.closed, 4)
})

test("closing Agent service closes a pending discovery process", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-agent-config-close-"))
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const fake = fakeProvider({ async newSession() { ready(); return new Promise(() => {}) } })
  const catalog = new DaemonCatalog(directory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const service = new AgentSessions(catalog, catalog.native, fake.provider, undefined, undefined, undefined, new TestAgentQuotas())
  await service.init()
  context.after(async () => { await service.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const pending = assert.rejects(service.handle("_deskfleet/agent/configuration", { provider: "codex" }, service.actor()), /service is stopping/i)
  await started
  await service.close()
  await pending
  assert.equal(fake.closed, 1)
})


test("draft configuration resolves the selected provider's current launch settings and identity", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-agent-config-provider-"))
  const fake = fakeProvider()
  const catalog = new DaemonCatalog(directory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const providers = new AgentProviders(directory, fake.provider)
  await providers.init()
  const configured = await providers.create({ template: "codex", name: "Work agent", binaryPath: "/tools/codex", env: { CODEX_HOME: "/work/agent" } })
  const service = new AgentSessions(catalog, catalog.native, fake.provider, providers, undefined, undefined, new TestAgentQuotas())
  await service.init()
  context.after(async () => { await service.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })
  const workspace = await catalog.native.createWorkspace("Configuration target", [{ path: directory }])
  const params = { provider: configured.id, workspaceId: workspace.id, model: "second", reasoningEffort: "medium" }
  const configuration = await service.handle("_deskfleet/agent/configuration", params, service.actor()) as AgentConfiguration
  assert.deepEqual(configuration.provider, { id: configured.id, name: "Work agent" })
  assert.equal(configuration.models?.currentValue, "second")
  assert.equal(configuration.reasoningEfforts?.currentValue, "medium")
  assert.deepEqual(fake.configs[0], { name: "Work agent", binaryPath: "/tools/codex", env: { CODEX_HOME: "/work/agent" } })
  await providers.update(configured.id, { name: "Renamed agent", binaryPath: "", env: { CODEX_HOME: "/work/updated" } })
  const updated = await service.handle("_deskfleet/agent/configuration", params, service.actor()) as AgentConfiguration
  assert.deepEqual(updated.provider, { id: configured.id, name: "Renamed agent" })
  assert.deepEqual(fake.configs[1], { name: "Renamed agent", binaryPath: "codex", env: { CODEX_HOME: "/work/updated" } })
  await providers.remove(configured.id)
  await assert.rejects(service.handle("_deskfleet/agent/configuration", params, service.actor()), /provider.*unavailable/iu)
  assert.deepEqual(await service.journal.list(), [])
  assert.equal((await catalog.native.snapshot()).workspaces[0]?.worktrees.length, 1)
  assert.equal(fake.closed, 2)
})
