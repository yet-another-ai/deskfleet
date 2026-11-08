import { TestAgentQuotas } from "./fixtures/agent-quotas.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { AgentClient, AgentConnection, AgentProvider } from "./agents/acp.ts"
import type { AgentConfiguration, AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { AgentSnapshot, AgentTurn } from "./agent-protocol.ts"
import { AgentSessions } from "./agent-sessions.ts"
import type { AgentProviders } from "./agent-providers.ts"
import { DaemonCatalog } from "./catalog.ts"

function options(model: string, effort: string, mode = "manual"): acp.SessionConfigOption[] {
  return [{
    id: "model", category: "model", name: "Model", type: "select", currentValue: model,
    options: ["first", "second"].map(value => ({ value, name: value })),
  }, {
    id: "effort", category: "thought_level", name: "Reasoning", type: "select", currentValue: effort,
    options: ["low", "high"].map(value => ({ value, name: value })),
  }, {
    id: "permission-mode", category: "mode", name: "Mode", type: "select", currentValue: mode,
    options: ["manual", "auto", "full-access"].map(value => ({ value, name: value })),
  }]
}

class ConfigurationProvider implements AgentProvider {
  id = "codex"
  client!: AgentClient
  model = "first"
  effort = "high"
  mode = "manual"
  newSessionOptions: "full" | "missing" | "empty" = "full"
  resumeOptions: "full" | "missing" | "empty" = "full"
  notifyOpeningOptions = false
  openingCommands?: acp.AvailableCommand[]
  resumeCommands?: acp.AvailableCommand[]
  resumeSubagents?: string[]
  onSetOption?: (params: acp.SetSessionConfigOptionRequest) => void
  changes: acp.SetSessionConfigOptionRequest[] = []
  prompts: { model: string; effort: string }[] = []
  promptModes: string[] = []
  connections = 0
  closes = 0
  newSessionWait?: Promise<void>
  closeWait?: Promise<void>
  promptWait?: Promise<void>

  async connect(_config: unknown, client: AgentClient): Promise<AgentConnection> {
    this.connections++
    this.client = client
    return {
      initialization: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
      newSession: async () => {
        await this.newSessionWait
        this.model = "first"
        this.effort = "high"
        this.mode = "manual"
        if (this.notifyOpeningOptions) await client.onUpdate({
          sessionId: "conversation", update: { sessionUpdate: "config_option_update", configOptions: options(this.model, this.effort, this.mode) },
        })
        if (this.openingCommands) await client.onUpdate({ sessionId: "conversation", update: {
          sessionUpdate: "available_commands_update", availableCommands: this.openingCommands,
        } })
        return {
          sessionId: "conversation",
          ...(this.newSessionOptions === "missing" ? {} : {
            configOptions: this.newSessionOptions === "empty" ? [] : options(this.model, this.effort, this.mode),
          }),
        }
      },
      resume: async () => {
        this.model = "first"
        this.effort = "high"
        this.mode = "manual"
        for (const id of this.resumeSubagents ?? []) client.onSubagentSession?.(id)
        if (this.resumeCommands) await client.onUpdate({ sessionId: "conversation", update: {
          sessionUpdate: "available_commands_update", availableCommands: this.resumeCommands,
        } })
        return this.resumeOptions === "missing" ? {} : {
          configOptions: this.resumeOptions === "empty" ? [] : options(this.model, this.effort, this.mode),
        }
      },
      setConfigOption: async params => {
        this.changes.push(params)
        if (params.configId === "model") { this.model = String(params.value); this.effort = "high" }
        else if (params.configId === "effort") this.effort = String(params.value)
        else this.mode = String(params.value)
        // Simulate an Agent whose Auto mode is unavailable for the second model.
        if (this.model === "second" && this.mode === "auto") this.mode = "manual"
        const configOptions = options(this.model, this.effort, this.mode)
        this.onSetOption?.(params)
        return { configOptions }
      },
      prompt: async () => {
        this.prompts.push({ model: this.model, effort: this.effort })
        this.promptModes.push(this.mode)
        await this.promptWait
        return { stopReason: "end_turn" }
      },
      steer: async () => ({ outcome: "inactive" }),
      cancel: async () => {},
      close: async () => { this.closes++; await this.closeWait },
    }
  }

  async notify(configOptions: acp.SessionConfigOption[]): Promise<void> {
    await this.client.onUpdate({ sessionId: "conversation", update: { sessionUpdate: "config_option_update", configOptions } })
  }
}

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (predicate(value)) return value
    await delay(10)
  }
  throw new Error("Timed out waiting for session configuration")
}

async function setup(t: TestContext, provider: ConfigurationProvider, selection: AgentConfigurationSelection = {}, beforeCreate?: (service: AgentSessions) => void, providers?: AgentProviders) {
  const directory = await mkdtemp(join(tmpdir(), "df-runtime-configuration-"))
  const workspaceDirectory = join(directory, "workspace")
  await mkdir(workspaceDirectory)
  const daemonDirectory = join(directory, "daemon")
  await mkdir(daemonDirectory)
  const catalog = new DaemonCatalog(daemonDirectory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const workspace = await catalog.native.createWorkspace("Configuration fixture", [{ path: workspaceDirectory }])
  const service = new AgentSessions(catalog, catalog.native, provider, providers, undefined, undefined, new TestAgentQuotas())
  await service.init()
  t.after(async () => {
    try { await service.close() } finally { await catalog.close(); await rm(directory, { recursive: true, force: true }) }
  })
  const actor = service.actor()
  beforeCreate?.(service)
  const create = {
    workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "directory", ...selection,
  }
  const created = await service.handle("_deskfleet/session/create", create, actor) as AgentSnapshot
  const sessionId = created.session.id
  const read = () => service.journal.read(sessionId)
  const configuration = () => service.handle("_deskfleet/session/configuration", { sessionId }, actor) as Promise<AgentConfiguration>
  const configure = (selection: AgentConfigurationSelection) => service.handle("_deskfleet/session/configure", {
    sessionId, operationId: randomUUID(), ...selection,
  }, actor) as Promise<AgentConfiguration>
  const stop = () => service.handle("_deskfleet/session/stop", { sessionId, operationId: randomUUID() }, actor)
  const resume = () => service.handle("_deskfleet/session/resume", { sessionId, operationId: randomUUID() }, actor)
  const submit = () => service.handle("_deskfleet/input/submit", {
    sessionId, operationId: randomUUID(), content: [{ type: "text", text: "Use my settings" }], delivery: "backlog",
  }, actor)
  return { service, catalog, create, sessionId, read, configuration, configure, stop, resume, submit }
}

test("session command catalogs update independently of choices and survive daemon restart", async t => {
  const provider = new ConfigurationProvider()
  provider.openingCommands = [{ name: "review", description: "Review changes" }, { name: "$release", description: "Release skill" }]
  const f = await setup(t, provider)
  const initial = await f.configuration()
  assert.deepEqual(initial.commands, [{ name: "review", description: "Review changes" }])
  assert.deepEqual(initial.skills, [{ id: "$release", name: "release", description: "Release skill", invocation: "$release" }])
  await provider.client.onUpdate({ sessionId: "conversation", update: {
    sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact context" }],
  } })
  await provider.notify(options("second", "low"))
  const current = await f.configuration()
  assert.deepEqual(current.commands, [{ name: "compact", description: "Compact context" }])
  assert.deepEqual(current.skills, [])
  assert.equal(current.models?.currentValue, "second")
  await f.service.close()
  const service = new AgentSessions(f.catalog, f.catalog.native, provider, undefined, undefined, undefined, new TestAgentQuotas())
  try {
    await service.init()
    const restored = await service.handle("_deskfleet/session/configuration", { sessionId: f.sessionId }, service.actor()) as AgentConfiguration
    assert.deepEqual(restored, current)
  } finally { await service.close() }
})

test("resumed providers replace old commands and ignore updates from the previous run", async t => {
  const provider = new ConfigurationProvider()
  provider.openingCommands = [{ name: "$old", description: "Old skill" }]
  const f = await setup(t, provider)
  const previous = provider.client
  await f.stop()
  await f.resume()
  assert.equal((await f.configuration()).skills, undefined, "The new provider has not advertised any skills")
  await previous.onUpdate({ sessionId: "conversation", update: {
    sessionUpdate: "available_commands_update", availableCommands: [{ name: "$stale", description: "Stale skill" }],
  } })
  assert.equal((await f.configuration()).skills, undefined)
  await provider.client.onUpdate({ sessionId: "conversation", update: { sessionUpdate: "available_commands_update", availableCommands: [] } })
  assert.deepEqual((await f.configuration()).skills, [])
  await f.service.close()
  const service = new AgentSessions(f.catalog, f.catalog.native, provider, undefined, undefined, undefined, new TestAgentQuotas())
  try {
    await service.init()
    const restored = await service.handle("_deskfleet/session/configuration", { sessionId: f.sessionId }, service.actor()) as AgentConfiguration
    assert.deepEqual(restored.commands, [])
    assert.deepEqual(restored.skills, [])
  } finally { await service.close() }
})

for (const rejectedRetry of [false, true]) {
  test(`initial configuration survives restart after ${rejectedRetry ? "a rejected creation retry" : "the completed creation receipt"}`, async t => {
    const provider = new ConfigurationProvider()
    const f = await setup(t, provider, { model: "second", reasoningEffort: "low", mode: "full-access" })
    const original = await f.configuration()
    assert.deepEqual(original.models?.options.map(option => option.id), ["first", "second"])
    assert.equal(original.models?.currentValue, "second")
    assert.deepEqual(original.reasoningEfforts?.options.map(option => option.id), ["low", "high"])
    assert.equal(original.reasoningEfforts?.currentValue, "low")
    assert.deepEqual(original.modes?.options.map(option => option.id), ["manual", "auto", "full-access"])
    assert.equal(original.modes?.currentValue, "full-access")
    if (rejectedRetry) await assert.rejects(f.service.handle("_deskfleet/session/create", {
      ...f.create, model: "first",
    }, f.service.actor()), /Operation ID was reused/)
    await f.service.close()
    const connections = provider.connections
    const service = new AgentSessions(f.catalog, f.catalog.native, provider, undefined, undefined, undefined, new TestAgentQuotas())
    try {
      await service.init()
      const configuration = await service.handle("_deskfleet/session/configuration", { sessionId: f.sessionId }, service.actor()) as AgentConfiguration
      assert.deepEqual(configuration, original)
      assert.equal(provider.connections, connections, "Reading saved choices does not start the provider")
    } finally { await service.close() }
  })
}

test("a resume without configOptions reapplies the saved choices before the next prompt", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider, { model: "second", reasoningEffort: "low" })
  await f.stop()
  provider.resumeOptions = "missing"
  provider.changes.length = 0
  await f.resume()
  await f.submit()
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  assert.deepEqual(provider.prompts, [{ model: "second", effort: "low" }])
  assert.deepEqual(provider.changes.map(change => [change.configId, change.value]), [["model", "second"], ["effort", "low"]])
  const configuration = await f.configuration()
  assert.equal(configuration.models?.currentValue, "second")
  assert.equal(configuration.reasoningEfforts?.currentValue, "low")
  assert.equal((await f.read()).session.error, undefined)
})

test("an explicitly empty resume configuration is not replaced by saved option metadata", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider, { model: "second", reasoningEffort: "low" })
  await f.stop()
  provider.resumeOptions = "empty"
  provider.changes.length = 0
  await assert.rejects(f.resume(), /Unsupported agent model/)
  assert.deepEqual(provider.changes, [], "An explicit empty response offers no settable options")
  const configuration = await f.configuration()
  assert.deepEqual(configuration.models?.options.map(option => option.id), ["first", "second"])
  assert.equal(configuration.models?.currentValue, "second")
  assert.equal(configuration.reasoningEfforts?.currentValue, "low")
})

for (const response of ["missing", "empty"] as const) {
  test(`failed startup with ${response} configOptions can discover replacements without delivering backlog`, async t => {
    const provider = new ConfigurationProvider()
    provider.newSessionOptions = response
    const f = await setup(t, provider, { model: "second", reasoningEffort: "low" })
    assert.match((await f.read()).session.error!, /Unsupported agent model/)
    await f.submit()
    await until(f.read, state => state.runs.length === 2 && state.runs.at(-1)?.state === "failed")
    provider.newSessionOptions = "full"
    const before = await f.read()
    const configuration = await f.configuration()
    assert.deepEqual(configuration.models?.options.map(option => option.id), ["first", "second"])
    assert.deepEqual(configuration.reasoningEfforts?.options.map(option => option.id), ["low", "high"])
    assert.equal(configuration.models?.currentValue, "second")
    assert.equal(configuration.reasoningEfforts?.currentValue, "low")
    assert.deepEqual(await f.read(), before, "Reading alternatives leaves confirmed settings and pending inputs unchanged")
    assert.deepEqual(provider.prompts, [])
    provider.newSessionOptions = "missing"
    await f.configure({ model: "first", reasoningEffort: "low" })
    await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
    assert.deepEqual(provider.prompts, [{ model: "first", effort: "low" }])
  })
}

test("a second archive closes configuration discovery opened after restoring a failed Session", async t => {
  const provider = new ConfigurationProvider()
  provider.newSessionOptions = "missing"
  const f = await setup(t, provider, { model: "second" })
  const change = (method: "_deskfleet/session/archive" | "_deskfleet/session/restore") => f.service.handle(method, {
    sessionId: f.sessionId, operationId: randomUUID(),
  }, f.service.actor()) as Promise<AgentSnapshot>
  await change("_deskfleet/session/archive")
  await change("_deskfleet/session/restore")
  let releaseDiscovery!: () => void
  let releaseClose!: () => void
  provider.newSessionWait = new Promise<void>(resolve => { releaseDiscovery = resolve })
  provider.closeWait = new Promise<void>(resolve => { releaseClose = resolve })
  try {
    const discovery = assert.rejects(f.configuration(), /configuration discovery was stopped/u)
    await until(f.read, () => provider.connections === 2)
    let finished = false
    const archive = change("_deskfleet/session/archive").then(result => { finished = true; return result })
    await until(f.read, state => provider.closes === 2 && state.session.archiveState === "archiving")
    assert.equal(finished, false)
    releaseClose()
    assert.equal((await archive).session.archiveState, "archived")
    await discovery
    assert.deepEqual(provider.prompts, [])
  } finally {
    releaseDiscovery()
    releaseClose()
  }
})

test("configuration received while opening supplies options omitted from the new-session response", async t => {
  const provider = new ConfigurationProvider()
  provider.newSessionOptions = "missing"
  provider.notifyOpeningOptions = true
  const f = await setup(t, provider, { model: "second", reasoningEffort: "low" })
  assert.equal((await f.read()).session.error, undefined)
  assert.equal((await f.configuration()).reasoningEfforts?.currentValue, "low")
  await f.submit()
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  assert.deepEqual(provider.prompts, [{ model: "second", effort: "low" }])
})

test("a configuration notification received during startup cannot commit after the final choices", async t => {
  const provider = new ConfigurationProvider()
  let notified: Promise<void> | undefined
  let blocked: Promise<void> | undefined
  const f = await setup(t, provider, { model: "second", reasoningEffort: "low" }, service => {
    const unsubscribe = service.onEvent(event => {
      if (event.kind !== "acp" || notified) return
      const update = (event.payload as acp.SessionNotification).update
      if (update.sessionUpdate !== "config_option_update") return
      unsubscribe()
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      blocked = service.journal.serial(event.sessionId, () => gate)
      notified = provider.notify(options("second", "high"))
      setImmediate(release)
    })
  })
  await Promise.all([blocked, notified])
  assert.equal((await f.configuration()).reasoningEfforts?.currentValue, "low")
  await f.stop()
  await f.resume()
  await f.submit()
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  assert.deepEqual(provider.prompts, [{ model: "second", effort: "low" }])
})

test("a queued notification from before configure cannot replace the newer explicit selection", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let blocked: Promise<void> | undefined
  let notified: Promise<void> | undefined
  const unsubscribe = f.service.onEvent(event => {
    if (event.kind !== "command" || !("method" in event.payload) || event.payload.method !== "_deskfleet/session/configure") return
    unsubscribe()
    blocked = f.service.journal.serial(f.sessionId, () => gate)
    notified = provider.notify(options("first", "low"))
  })
  provider.onSetOption = () => { setImmediate(release) }
  const configured = await f.configure({ model: "second" }).finally(release)
  await Promise.all([blocked, notified])
  assert.equal(configured.models?.currentValue, "second")
  assert.equal(configured.reasoningEfforts?.currentValue, "high")
  assert.deepEqual(await f.configuration(), configured)
})

test("a queued notification received during live configure cannot replace the confirmed choices", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider)
  let notified: Promise<void> | undefined
  let blocked: Promise<void> | undefined
  provider.onSetOption = params => {
    if (params.configId !== "effort") return
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    blocked = f.service.journal.serial(f.sessionId, () => gate)
    notified = provider.notify(options("second", "high"))
    // The final setter response reaches the runtime before the queued update.
    setImmediate(release)
  }
  const configured = await f.configure({ model: "second", reasoningEffort: "low" })
  await Promise.all([blocked, notified])
  assert.equal(configured.reasoningEfforts?.currentValue, "low")
  assert.equal((await f.configuration()).reasoningEfforts?.currentValue, "low")
  provider.onSetOption = undefined
  await f.stop()
  await f.resume()
  await f.submit()
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  assert.deepEqual(provider.prompts, [{ model: "second", effort: "low" }])
})

test("unsolicited provider updates can return to an earlier exact configuration and remain durable", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider, { model: "second", reasoningEffort: "low" })
  const updated = options("first", "high")
  const model = updated[0]!
  if (model.type === "select") model.options = ["first", "second", "third"].map(value => ({ value, name: value }))
  await provider.notify(updated)
  const configuration = await f.configuration()
  assert.equal(configuration.models?.currentValue, "first")
  assert.deepEqual(configuration.models?.options.map(option => option.id), ["first", "second", "third"])
  assert.equal(configuration.reasoningEfforts?.currentValue, "high")
  await provider.notify(options("second", "high"))
  const returned = await f.configuration()
  assert.equal(returned.models?.currentValue, "second")
  assert.equal(returned.reasoningEfforts?.currentValue, "high")
  await f.stop()
  assert.deepEqual(await f.configuration(), returned)
  await f.resume()
  await f.submit()
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  assert.deepEqual(provider.prompts, [{ model: "second", effort: "high" }])
})

test("Session creation applies its native mode and retains it when replacing a stopped Session's model", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider, { model: "first", reasoningEffort: "low", mode: "full-access" })
  assert.equal((await f.configuration()).modes?.currentValue, "full-access")
  await f.stop()
  const changed = await f.configure({ model: "second" })
  assert.equal(changed.models?.currentValue, "second")
  assert.equal(changed.reasoningEfforts?.currentValue, "high", "Changing models accepts its default effort")
  assert.equal(changed.modes?.currentValue, "full-access")
  await f.submit()
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  assert.deepEqual(provider.promptModes, ["full-access"])
})

test("model changes between turns preserve the Agent and publish the provider's actual mode fallback", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider, { mode: "auto" })
  await f.submit()
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  const before = await f.read()
  const changed = await f.configure({ model: "second" })
  assert.equal(changed.models?.currentValue, "second")
  assert.equal(changed.modes?.currentValue, "manual")
  assert.deepEqual(provider.changes.slice(-1).map(change => [change.configId, change.value]), [["model", "second"]])
  await f.submit()
  await until(f.read, state => state.turns.filter(turn => turn.state === "completed").length === 2)
  const after = await f.read()
  assert.equal(after.session.id, before.session.id)
  assert.equal(after.session.provider, "codex")
  assert.equal(after.session.providerSessionId, before.session.providerSessionId)
  assert.equal(provider.connections, 1, "Changing a model retains the existing provider conversation")
  assert.deepEqual(provider.prompts.map(prompt => prompt.model), ["first", "second"])
  assert.deepEqual(provider.promptModes, ["auto", "manual"])
  await assert.rejects(f.service.handle("_deskfleet/session/configure", {
    sessionId: f.sessionId, operationId: randomUUID(), provider: "claude", model: "first",
  }, f.service.actor()), /Agent cannot be changed/)
  assert.equal((await f.read()).session.provider, "codex")
  assert.equal(provider.model, "second")
})

test("a saved mode survives a service restart and an omitted resume configuration", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider, { mode: "auto" })
  const changed = await f.configure({ mode: "full-access" })
  assert.equal(changed.modes?.currentValue, "full-access")
  await f.service.close()
  provider.resumeOptions = "missing"
  provider.changes.length = 0
  // A fresh service reads only the durable journal; no runtime state is reused.
  const service = new AgentSessions(f.catalog, f.catalog.native, provider, undefined, undefined, undefined, new TestAgentQuotas())
  try {
    await service.init()
    const actor = service.actor()
    const configuration = await service.handle("_deskfleet/session/configuration", { sessionId: f.sessionId }, actor) as AgentConfiguration
    assert.equal(configuration.modes?.currentValue, "full-access")
    await service.handle("_deskfleet/session/resume", { sessionId: f.sessionId, operationId: randomUUID() }, actor)
    assert.equal(provider.mode, "full-access")
    assert.ok(provider.changes.some(change => change.configId === "permission-mode" && change.value === "full-access"))
  } finally { await service.close() }
})

test("mode and model changes wait for the current turn", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider)
  let release!: () => void
  provider.promptWait = new Promise<void>(resolve => { release = resolve })
  try {
    await f.submit()
    await until(f.read, () => provider.prompts.length === 1)
    await assert.rejects(f.configure({ mode: "full-access" }), /Wait for the current turn/)
    await assert.rejects(f.configure({ model: "second" }), /Wait for the current turn/)
    assert.deepEqual(provider.changes, [])
  } finally { release() }
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  assert.equal((await f.configure({ mode: "full-access" })).modes?.currentValue, "full-access")
})

test("turns retain their configured model across later updates and daemon restart", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider)
  let release!: () => void
  provider.promptWait = new Promise<void>(resolve => { release = resolve })
  try {
    await f.submit()
    const running = await until(f.read, () => provider.prompts.length === 1)
    assert.deepEqual(running.turns[0]?.model, { id: "first", name: "first" })
    provider.model = "second"
    await provider.notify(options("second", "high"))
  } finally { release() }
  await until(f.read, state => state.turns[0]?.state === "completed")
  await f.configure({ model: "second" })
  await f.submit()
  const completed = await until(f.read, state => state.turns.length === 2 && state.turns.every(turn => turn.state === "completed"))
  assert.deepEqual(completed.turns.map(turn => turn.model), [
    { id: "first", name: "first" }, { id: "second", name: "second" },
  ])
  const history = await f.service.journal.history(f.sessionId, "0", 200)
  for (const event of history.filter(event => event.kind === "turn")) {
    const payload = event.payload as AgentTurn
    const turn = completed.turns.find(turn => turn.id === payload.id)
    assert.deepEqual(payload.model, turn?.model)
  }
  await f.service.close()
  const restarted = new AgentSessions(f.catalog, f.catalog.native, provider, undefined, undefined, undefined, new TestAgentQuotas())
  try {
    await restarted.init()
    assert.deepEqual((await restarted.journal.read(f.sessionId)).turns, completed.turns)
    const replayed = await restarted.journal.history(f.sessionId, "0", 200)
    assert.deepEqual(replayed.filter(event => event.kind === "turn"), history.filter(event => event.kind === "turn"))
  } finally { await restarted.close() }
})

for (const response of ["missing", "empty"] as const) {
  test(`turns omit model snapshots when the provider reports ${response} configOptions`, async t => {
    const provider = new ConfigurationProvider()
    provider.newSessionOptions = response
    const f = await setup(t, provider)
    await f.submit()
    const snapshot = await until(f.read, state => state.turns[0]?.state === "completed")
    assert.equal(Object.hasOwn(snapshot.turns[0]!, "model"), false)
    const history = await f.service.journal.history(f.sessionId, "0", 200)
    for (const event of history.filter(event => event.kind === "turn")) {
      assert.equal(Object.hasOwn(event.payload, "model"), false)
    }
  })
}

function registry(codex: ConfigurationProvider, claude: ConfigurationProvider): AgentProviders {
  return {
    resolve: (id: string) => {
      if (id === "codex") return { provider: codex, config: { name: "Codex" } }
      if (id === "claude") return { provider: claude, config: { name: "Claude" } }
      throw new Error("Agent provider is unavailable")
    },
    onChanged: () => () => {},
  } as unknown as AgentProviders
}

test("a ready Session switches Agents without reusing the previous conversation or its configuration", async t => {
  const codex = new ConfigurationProvider()
  const claude = new ConfigurationProvider()
  claude.id = "claude"
  const providers = registry(codex, claude)
  const f = await setup(t, codex, { model: "second", reasoningEffort: "low" }, undefined, providers)
  await f.submit()
  await until(f.read, state => state.turns.some(turn => turn.state === "completed"))
  assert.equal((await f.configuration()).models?.currentValue, "second")
  const switched = await f.service.handle("_deskfleet/session/switch-agent", {
    sessionId: f.sessionId, operationId: randomUUID(), provider: "claude",
  }, f.service.actor()) as AgentSnapshot
  assert.equal(switched.session.provider, "claude")
  assert.equal(switched.session.providerSessionId, "conversation")
  assert.equal(switched.turns.length, 1, "conversation history remains available")
  assert.equal(codex.closes, 1)
  assert.equal(claude.connections, 1)
  const configuration = await f.configuration()
  assert.equal(configuration.provider.id, "claude")
  assert.equal(configuration.models?.currentValue, "first", "the replacement Agent starts from its own defaults")
  assert.equal(configuration.reasoningEfforts?.currentValue, "high")
  await f.submit()
  const completed = await until(f.read, state => state.turns.filter(turn => turn.state === "completed").length === 2)
  assert.equal(completed.session.provider, "claude")
  assert.deepEqual(codex.prompts, [{ model: "second", effort: "low" }])
  assert.deepEqual(claude.prompts, [{ model: "first", effort: "high" }])
  await assert.rejects(f.service.handle("_deskfleet/session/switch-agent", {
    sessionId: f.sessionId, operationId: randomUUID(), provider: "missing",
  }, f.service.actor()), /unavailable/)
  assert.equal((await f.read()).session.provider, "claude")
  // Repeating a switch to the current Agent is a no-op, so a retried request cannot stop it again.
  const repeated = await f.service.handle("_deskfleet/session/switch-agent", {
    sessionId: f.sessionId, operationId: randomUUID(), provider: "claude",
  }, f.service.actor()) as AgentSnapshot
  assert.equal(repeated.session.provider, "claude")
  assert.equal(codex.closes, 1)
  assert.equal(claude.connections, 1)
  await f.service.close()
  // The provider boundary survives restart; the previous Agent's choices are not reapplied.
  const restarted = new AgentSessions(f.catalog, f.catalog.native, codex, providers, undefined, undefined, new TestAgentQuotas())
  try {
    await restarted.init()
    const saved = await restarted.handle("_deskfleet/session/configuration", { sessionId: f.sessionId }, restarted.actor()) as AgentConfiguration
    assert.equal(saved.provider.id, "claude")
    assert.equal(saved.models?.currentValue, "first")
    assert.equal(saved.reasoningEfforts?.currentValue, "high")
  } finally { await restarted.close() }
})

test("a running turn blocks an Agent switch", async t => {
  const codex = new ConfigurationProvider()
  const claude = new ConfigurationProvider()
  claude.id = "claude"
  const providers = registry(codex, claude)
  const f = await setup(t, codex, {}, undefined, providers)
  let release!: () => void
  codex.promptWait = new Promise<void>(resolve => { release = resolve })
  try {
    await f.submit()
    await until(f.read, () => codex.prompts.length === 1)
    await assert.rejects(f.service.handle("_deskfleet/session/switch-agent", {
      sessionId: f.sessionId, operationId: randomUUID(), provider: "claude",
    }, f.service.actor()), /Wait for the current turn/)
    assert.equal((await f.read()).session.provider, "codex")
    assert.equal(claude.connections, 0)
  } finally { release() }
  await until(f.read, state => state.turns[0]?.state === "completed")
})

test("provider child state stays in the parent journal without changing root configuration or title", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider)
  const before = await f.read()
  const initial = await f.configuration()
  await provider.client.onUpdate({ sessionId: "conversation", update: {
    sessionUpdate: "subagent_update", sessionId: "child", title: "Reviewer", state: { state: "running" },
  } })
  await provider.client.onUpdate({ sessionId: "child", update: { sessionUpdate: "session_info_update", title: "Child title" } })
  await provider.client.onUpdate({ sessionId: "child", update: { sessionUpdate: "config_option_update", configOptions: options("second", "low") } })
  await provider.client.onUpdate({ sessionId: "child", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "child-only", description: "Child command" }] } })
  assert.equal((await f.read()).session.title, before.session.title)
  assert.deepEqual(await f.configuration(), initial)
  const history = await f.service.journal.history(f.sessionId, "0")
  const children = history.filter(event => event.kind === "acp" && "update" in event.payload && event.payload.sessionId === "child")
  assert.equal(children.length, 3)
  assert.ok(children.every(event => event.kind === "acp" && "update" in event.payload && (event.payload._meta?.deskfleet as { subagent?: boolean })?.subagent === true))
})

test("repeated resume restores child ownership without appending replayed child cards", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider)
  await provider.client.onUpdate({ sessionId: "conversation", update: {
    sessionUpdate: "subagent_update", sessionId: "child", title: "Reviewer", state: { state: "idle" },
  } })
  const children = async () => (await f.service.journal.history(f.sessionId, "0"))
    .filter(event => event.kind === "acp" && "update" in event.payload
      && (event.payload.sessionId === "child" || event.payload.update.sessionUpdate === "subagent_update"))
  const original = await children()
  assert.equal(original.length, 1)
  provider.resumeSubagents = ["child"]
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.stop()
    await f.resume()
    assert.deepEqual(await children(), original)
  }
  const configuration = await f.configuration()
  const title = (await f.read()).session.title
  await provider.client.onUpdate({ sessionId: "child", update: { sessionUpdate: "session_info_update", title: "Live child title" } })
  await provider.client.onUpdate({ sessionId: "child", update: { sessionUpdate: "config_option_update", configOptions: options("second", "low") } })
  assert.equal((await f.read()).session.title, title)
  assert.deepEqual(await f.configuration(), configuration)
  assert.ok((await children()).slice(1).every(event => event.kind === "acp" && "update" in event.payload
    && (event.payload._meta?.deskfleet as { subagent?: boolean })?.subagent === true))
})

test("stopped Sessions accept common controls addressed by provider config ID", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider, { model: "first", reasoningEffort: "low", mode: "full-access" })
  await f.stop()
  provider.changes = []
  const model = await f.configure({ configValues: { model: "second" } })
  assert.equal(model.models?.currentValue, "second")
  assert.equal(model.reasoningEfforts?.currentValue, "high", "A generic model edit accepts the new model's default effort")
  assert.equal(model.modes?.currentValue, "full-access")
  assert.ok(!provider.changes.some(change => change.configId === "effort"), "The previous effort is not restored before a replacement model")
  await f.stop()
  const mode = await f.configure({ configValues: { "permission-mode": "manual", effort: "low" } })
  assert.equal(mode.models?.currentValue, "second")
  assert.equal(mode.modes?.currentValue, "manual")
  assert.equal(mode.reasoningEfforts?.currentValue, "low")
})

test("notices remain live-only and old connections cannot restore authentication", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider)
  const live: unknown[] = []
  const release = f.service.onLive(update => live.push(update))
  t.after(release)
  const client = provider.client
  const before = (await f.read()).session.lastEventSeq
  await client.onAuthStatus?.({ kind: "account", label: "Signed in" })
  await client.onUpdate({ sessionId: "conversation", update: { sessionUpdate: "notice", severity: "warning", title: "Rate limit" } })
  assert.equal((await f.read()).session.lastEventSeq, before)
  assert.equal(live.length, 2)
  assert.equal(f.service.live(f.sessionId)?.kind, "auth")
  await f.stop()
  assert.deepEqual(f.service.live(f.sessionId), { sessionId: f.sessionId, runGeneration: 1, kind: "auth", auth: null })
  const count = live.length
  await client.onAuthStatus?.({ kind: "account", label: "Stale account" })
  await client.onUpdate({ sessionId: "conversation", update: { sessionUpdate: "notice", severity: "warning", title: "Stale notice" } })
  assert.equal(live.length, count)
})

test("unexpected connection loss rejects late live updates and a resumed run publishes its own status", async t => {
  const provider = new ConfigurationProvider()
  const f = await setup(t, provider)
  const live: unknown[] = []
  t.after(f.service.onLive(update => live.push(update)))
  const disconnected = provider.client
  await disconnected.onAuthStatus?.({ kind: "account", label: "Original account" })
  disconnected.onClose?.(new Error("connection lost"))
  assert.deepEqual(f.service.live(f.sessionId), { sessionId: f.sessionId, runGeneration: 1, kind: "auth", auth: null })
  const count = live.length
  await disconnected.onAuthStatus?.({ kind: "account", label: "Stale account" })
  await disconnected.onUpdate({ sessionId: "conversation", update: { sessionUpdate: "notice", severity: "warning", title: "Stale notice" } })
  assert.equal(live.length, count)
  await f.service.handle("_deskfleet/session/resume", { sessionId: f.sessionId, operationId: randomUUID() }, f.service.actor())
  assert.deepEqual((await f.read()).runs.map(run => run.state), ["interrupted", "running"])
  await provider.client.onAuthStatus?.({ kind: "api_key", label: "New account" })
  const current = f.service.live(f.sessionId)
  assert.equal(current?.kind === "auth" && current.auth?.label, "New account")
  await disconnected.onAuthStatus?.({ kind: "account", label: "Old generation" })
  assert.deepEqual(f.service.live(f.sessionId), current)
})
