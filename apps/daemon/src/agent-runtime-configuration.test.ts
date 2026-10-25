import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type * as acp from "@agentclientprotocol/sdk"
import { openInMemoryCatalog } from "@deskfleet/native"
import type { AgentClient, AgentConnection, AgentProvider } from "./agents/acp.ts"
import type { AgentConfiguration, AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { AgentSessions } from "./agent-sessions.ts"
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

async function setup(t: TestContext, provider: ConfigurationProvider, selection: AgentConfigurationSelection = {}, beforeCreate?: (service: AgentSessions) => void) {
  const directory = await mkdtemp(join(tmpdir(), "df-runtime-configuration-"))
  const workspaceDirectory = join(directory, "workspace")
  await mkdir(workspaceDirectory)
  const daemonDirectory = join(directory, "daemon")
  await mkdir(daemonDirectory)
  const catalog = new DaemonCatalog(daemonDirectory)
  await catalog.init((_path, name) => openInMemoryCatalog(name))
  const workspace = await catalog.native.createWorkspace("Configuration fixture", [{ path: workspaceDirectory }])
  const service = new AgentSessions(catalog, catalog.native, provider)
  await service.init()
  t.after(async () => {
    try { await service.close() } finally { await catalog.close(); await rm(directory, { recursive: true, force: true }) }
  })
  const actor = service.actor()
  beforeCreate?.(service)
  const created = await service.handle("_deskfleet/session/create", {
    workspaceId: workspace.id, operationId: randomUUID(), provider: "codex", context: "directory", ...selection,
  }, actor) as AgentSnapshot
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
  return { service, catalog, sessionId, read, configuration, configure, stop, resume, submit }
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
  const service = new AgentSessions(f.catalog, f.catalog.native, provider)
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
