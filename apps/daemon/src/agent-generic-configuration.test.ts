import assert from "node:assert/strict"
import test from "node:test"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { applyAgentConfiguration } from "./agent-configuration.ts"
import { agentConfiguration, agentConfigurationSelection, validateAgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import { AgentConfigurationProbes } from "./agent-configuration-probes.ts"
import type { AgentConnection, AgentProvider } from "./agents/acp.ts"
import { savedAgentConfiguration } from "./agent-session-configuration.ts"
import type { AgentJournal } from "./agent-store.ts"
import type { AgentEvent } from "./agent-protocol.ts"
import { subagentNotification } from "../../../packages/client/src/agent-session-scope.ts"

const catalog = (): acp.SessionConfigOption[] => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "first", options: [{ value: "first", name: "First" }, { value: "second", name: "Second" }] },
  { id: "collaboration_mode", name: "Collaboration", description: "Choose the workflow.", type: "select", currentValue: "default", options: [
    { group: "workflows", name: "Workflows", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan", description: "Plan first." }] },
  ] },
  { id: "fast-mode", name: "Fast", category: "model_config", type: "boolean", currentValue: false },
  { id: "agent", name: "Agent", category: "_agent", type: "select", currentValue: "general", options: [{ value: "general", name: "General" }, { value: "reviewer", name: "Reviewer" }] },
]

function fake() {
  const changes: acp.SetSessionConfigOptionRequest[] = []
  let connections = 0
  const provider: AgentProvider = { id: "generic", async connect(_config, client) {
    assert.equal(client.capabilities?.configOptions, true)
    connections++
    let options = catalog()
    const connection: AgentConnection = {
      initialization: { protocolVersion: 1 },
      async newSession() { return { sessionId: `probe-${connections}`, configOptions: options } },
      async setConfigOption(request) {
        changes.push(request)
        options = options.map(option => option.id === request.configId ? { ...option, currentValue: request.value } as acp.SessionConfigOption : option)
        return { configOptions: options }
      },
      async close() {}, async cancel() {},
      async prompt() { throw new Error("Unexpected prompt") },
      async steer() { throw new Error("Unexpected steer") },
      async resume() { throw new Error("Unexpected resume") },
    }
    return connection
  } }
  return { provider, config: { name: "Generic" }, changes, get connections() { return connections } }
}

test("full configuration retains labels, grouping, categories and false selections", () => {
  const options = catalog()
  const configuration = agentConfiguration(options)
  assert.deepEqual(configuration.configOptions, options)
  assert.deepEqual(agentConfigurationSelection(configuration), {
    model: "first", reasoningEffort: undefined, mode: undefined,
    configValues: { collaboration_mode: "default", "fast-mode": false, agent: "general" },
  })
  validateAgentConfigurationSelection({ configValues: { "fast-mode": false, agent: "reviewer" } })
  for (const configValues of [null, [], { agent: 1 }, { agent: {} }, { "": true }]) {
    assert.throws(() => validateAgentConfigurationSelection({ configValues }), /Invalid agent configuration/)
  }
})

test("generic changes use provider config IDs and correctly typed ACP requests", async () => {
  const f = fake()
  const connection = await f.provider.connect(f.config, { capabilities: { configOptions: true }, onUpdate() {} })
  const updated = await applyAgentConfiguration(connection, "session", catalog(), {
    model: "second", configValues: { collaboration_mode: "plan", "fast-mode": true, agent: "reviewer" },
  })
  assert.deepEqual(f.changes, [
    { sessionId: "session", configId: "model", value: "second" },
    { sessionId: "session", configId: "collaboration_mode", value: "plan" },
    { sessionId: "session", configId: "fast-mode", type: "boolean", value: true },
    { sessionId: "session", configId: "agent", value: "reviewer" },
  ])
  assert.equal(agentConfigurationSelection(agentConfiguration(updated)).configValues?.["fast-mode"], true)
  await applyAgentConfiguration(connection, "session", updated, { configValues: { "fast-mode": false } })
  assert.deepEqual(f.changes.at(-1), { sessionId: "session", configId: "fast-mode", type: "boolean", value: false })
  const count = f.changes.length
  const invalid: Record<string, string | boolean>[] = [{ "fast-mode": "true" }, { collaboration_mode: true }, { agent: "missing" }, { unknown: false }]
  for (const configValues of invalid) {
    await assert.rejects(applyAgentConfiguration(connection, "session", updated, { configValues }), /Unsupported agent configuration/)
  }
  assert.equal(f.changes.length, count)
  await assert.rejects(applyAgentConfiguration(connection, "session", updated, { model: "second", configValues: { model: "first" } }), /specified twice/)
  assert.equal(f.changes.length, count, "Conflicting aliases are rejected before changing the provider")
})

test("generic model IDs are applied before their dependent options regardless of map order", async () => {
  const f = fake()
  const connection = await f.provider.connect(f.config, { capabilities: { configOptions: true }, onUpdate() {} })
  await applyAgentConfiguration(connection, "session", catalog(), { configValues: { "fast-mode": true, model: "second" } })
  assert.deepEqual(f.changes.map(change => [change.configId, change.value]), [["model", "second"], ["fast-mode", true]])
})

test("a replacement probe restores generic selections before applying one edited option", async context => {
  const f = fake()
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  const params = { provider: "generic", probeId: "draft" }
  const first = await probes.read("user", { ...params, configValues: { collaboration_mode: "plan", "fast-mode": true } }, "/workspace", f)
  await probes.release("user", params.probeId)
  f.changes.length = 0
  const restored = await probes.read("user", { ...params, restore: agentConfigurationSelection(first), configValues: { agent: "reviewer" } }, "/workspace", f)
  assert.equal(f.connections, 2)
  assert.deepEqual(f.changes.map(change => [change.configId, change.value]), [["collaboration_mode", "plan"], ["fast-mode", true], ["agent", "reviewer"]])
  assert.deepEqual(agentConfigurationSelection(restored).configValues, { collaboration_mode: "plan", "fast-mode": true, agent: "reviewer" })
})

test("saved configuration restores generic selections and ignores child catalogs", async () => {
  const options = catalog()
  const root: acp.SessionNotification = { sessionId: "root", update: { sessionUpdate: "config_option_update", configOptions: options } }
  const commands: acp.SessionNotification = { sessionId: "root", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review" }] } }
  const notifications = [root, commands,
    subagentNotification({ sessionId: "child", update: { sessionUpdate: "config_option_update", configOptions: [] } }),
    subagentNotification({ sessionId: "child", update: { sessionUpdate: "available_commands_update", availableCommands: [] } }),
  ]
  const events: AgentEvent[] = notifications.map((payload, index) => ({ sessionId: "1", seq: String(index + 1), kind: "acp", payload, createdAt: "2026-11-08T00:00:00Z", runGeneration: 1 }))
  const journal = {
    async read() { return { session: { lastEventSeq: "4" }, runs: [{ generation: 1 }] } },
    async history(_id: string, after: string) { return events.filter(event => BigInt(event.seq) > BigInt(after)) },
  } as unknown as AgentJournal
  const saved = await savedAgentConfiguration(journal, "1")
  assert.deepEqual(saved.options, options)
  assert.deepEqual(saved.selection.configValues, { collaboration_mode: "default", "fast-mode": false, agent: "general" })
  assert.deepEqual(saved.commands, [{ name: "review", description: "Review" }])
})
