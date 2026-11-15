import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable"
import { AgentProviders } from "./agent-providers.ts"
import { AgentSessions } from "./agent-sessions.ts"
import { DaemonCatalog } from "./catalog.ts"
import type { AgentConfig, AgentProvider } from "./agents/acp.ts"
import type { AgentConfiguration } from "./agent-configuration-protocol.ts"

async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!ready()) {
    assert.ok(Date.now() < deadline, "Background configuration warmup did not finish")
    await delay(5)
  }
}

test("registration startup and provider edits warm every configured Agent and Workspace", async t => {
  const directory = await mkdtemp(join(tmpdir(), "df-config-cache-service-"))
  const catalog = new DaemonCatalog(directory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const workspace = await catalog.native.createWorkspace("Workspace", [{ path: directory }])
  const launches: AgentConfig[] = []
  let closed = 0
  const provider: AgentProvider = {
    id: "codex",
    async connect(config, client) {
      launches.push(config)
      assert.equal(config.authentication, "existing")
      let selected = "first"
      const options = (): SessionConfigOption[] => [{
        id: "model", category: "model", type: "select", name: "Model", currentValue: selected,
        options: ["first", "second"].map(value => ({ value, name: value })),
      }]
      return {
        initialization: { protocolVersion: 1 },
        async newSession(params) {
          assert.deepEqual(params.mcpServers, [])
          assert.equal(params.cwd, config.cwd)
          client.onUpdate({ sessionId: "discovery", update: { sessionUpdate: "available_commands_update", availableCommands: [] } })
          return { sessionId: "discovery", configOptions: options() }
        },
        async setConfigOption(params) { selected = String(params.value); return { configOptions: options() } },
        async prompt() { assert.fail("Warmup must not send a prompt") },
        async resume() { assert.fail("Warmup must not resume a Session") },
        async steer() { assert.fail("Warmup must not steer") },
        async cancel() {},
        async close() { closed++ },
      }
    },
  }
  const providers = new AgentProviders(directory, provider)
  await providers.init()
  const first = await providers.create({ template: "codex", name: "First", inheritShellEnvironment: false, env: { CACHE_TEST_SECRET: "private-setting" } })
  await providers.create({ template: "codex", name: "Second", inheritShellEnvironment: false, env: {} })
  const service = new AgentSessions(catalog, catalog.native, provider, providers)
  await service.init()
  t.after(async () => { await service.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }) })

  service.startConfigurationCache()
  await until(() => closed === 4)
  assert.equal(launches.length, 4)
  assert.deepEqual(new Set(launches.map(value => `${value.name}:${value.cwd}`)), new Set([
    `First:${homedir()}`, `First:${directory}`, `Second:${homedir()}`, `Second:${directory}`,
  ]))
  const params = { provider: first.id, workspaceId: workspace.id, cache: true }
  const configuration = await service.handle("_deskfleet/agent/configuration", params, service.actor()) as AgentConfiguration
  assert.equal(configuration.matrix?.complete, true)
  assert.equal(configuration.models?.currentValue, "first")
  const selected = await service.handle("_deskfleet/agent/configuration", { ...params, model: "second" }, service.actor()) as AgentConfiguration
  assert.equal(selected.models?.currentValue, "second")
  assert.equal(launches.length, 4, "Warmed configurations do not reconnect on selection")
  assert.ok(!JSON.stringify(selected).includes("private-setting"))
  assert.deepEqual(await service.journal.list(), [])

  await providers.update(first.id, { name: "Changed", inheritShellEnvironment: false, env: {} })
  await until(() => closed === 8)
  const changed = await service.handle("_deskfleet/agent/configuration", params, service.actor()) as AgentConfiguration
  assert.equal(changed.provider.name, "Changed")
  assert.equal(launches.length, 8)

  await catalog.native.updateWorkspace(workspace.id, "Moved", [{ path: tmpdir() }])
  catalog.changed()
  await until(() => closed === 10)
  assert.equal(launches.length, 10, "Only the new Workspace directory needs warming")
  assert.ok(launches.slice(-2).every(value => value.cwd === tmpdir()))
})
