import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import type * as acp from "@agentclientprotocol/sdk/unstable"
import { AgentConfigurationCache } from "./agent-configuration-cache.ts"
import { agentConfigurationIdentity, cachedAgentConfiguration } from "./agent-configuration-matrix.ts"
import { agentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { AgentClient, AgentConfig, AgentConnection, AgentProvider } from "./agents/acp.ts"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fakeProvider(hooks: {
  connect?(client: AgentClient): Promise<void>
  set?(request: acp.SetSessionConfigOptionRequest, client: AgentClient): Promise<void>
  options?(options: acp.SessionConfigOption[], client: AgentClient): acp.SessionConfigOption[]
  commands?(): acp.AvailableCommand[] | undefined
} = {}) {
  const configs: AgentConfig[] = []
  const clients: AgentClient[] = []
  const changes: acp.SetSessionConfigOptionRequest[] = []
  const closed = deferred()
  let closes = 0
  const provider: AgentProvider = {
    id: "codex",
    async connect(config, client) {
      configs.push(config)
      clients.push(client)
      assert.equal(config.authentication, "existing")
      await hooks.connect?.(client)
      let model = "first", effort = "high", mode = "manual", fast = false
      const efforts = () => model === "first" ? ["low", "high"] : fast ? ["low"] : ["low", "medium"]
      const options = (): acp.SessionConfigOption[] => hooks.options?.(catalog(), client) ?? catalog()
      const catalog = (): acp.SessionConfigOption[] => [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: model,
          options: ["first", "second"].map(value => ({ value, name: value })) },
        { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: effort,
          options: efforts().map(value => ({ value, name: value })) },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode,
          options: ["manual", "auto"].map(value => ({ value, name: value })) },
        { id: "fast", name: "Fast", type: "boolean", currentValue: fast },
      ]
      const connection: AgentConnection = {
        initialization: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } },
        async newSession(request) {
          assert.equal(request.cwd, config.cwd)
          assert.deepEqual(request.mcpServers, [])
          const commands = hooks.commands ? hooks.commands() : [{ name: "review", description: `Review ${config.cwd}` }]
          if (commands !== undefined) await client.onUpdate({ sessionId: "probe", update: { sessionUpdate: "available_commands_update", availableCommands: commands } })
          return { sessionId: "probe", configOptions: options() }
        },
        async setConfigOption(request) {
          changes.push(request)
          await hooks.set?.(request, client)
          if (request.configId === "model") { model = String(request.value); effort = "low" }
          else if (request.configId === "effort") effort = String(request.value)
          else if (request.configId === "mode") mode = String(request.value)
          else { assert.equal("type" in request ? request.type : undefined, "boolean"); fast = Boolean(request.value) }
          if (model === "second" && mode === "auto") mode = "manual"
          if (!efforts().includes(effort)) effort = "low"
          return { configOptions: options() }
        },
        async close() { closes++; closed.resolve() },
        async prompt() { assert.fail("Cache discovery must never prompt") },
        async steer() { assert.fail("Cache discovery must never steer") },
        async resume() { assert.fail("Cache discovery must never resume") },
        async cancel() {},
      }
      return connection
    },
  }
  return { provider, config: { name: "Configured agent" }, configs, clients, changes, closed: closed.promise, get closes() { return closes } }
}

const params = { provider: "configured", workspaceId: "1", cache: true }

test("warming discovers confirmed model, mode, effort and boolean transitions without mutable shared drafts", async t => {
  const fake = fakeProvider()
  const cache = new AgentConfigurationCache()
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await fake.closed
  const root = await cache.read(params, "/workspace", fake)
  assert.equal(root.matrix?.complete, true)
  assert.equal(fake.configs.length, 1)
  assert.deepEqual(root.commands, [{ name: "review", description: "Review /workspace" }])
  const changed = cachedAgentConfiguration(root.matrix!, root, { model: "second", reasoningEffort: "medium", configValues: { fast: true } })!
  assert.equal(changed.models?.currentValue, "second")
  assert.equal(changed.reasoningEfforts?.currentValue, "low")
  assert.deepEqual(changed.reasoningEfforts?.options.map(option => option.id), ["low"])
  const declined = cachedAgentConfiguration(root.matrix!, changed, { mode: "auto" })!
  assert.equal(declined.modes?.currentValue, "manual", "The cache preserves the provider's declined mode")
  const count = fake.changes.length
  const selected = await cache.read({ ...params, restore: agentConfigurationSelection(changed), configValues: { fast: false } }, "/workspace", fake)
  assert.equal(selected.configOptions?.find(option => option.id === "fast")?.currentValue, false)
  assert.equal(fake.changes.length, count, "Cached choices do not call the provider")
  assert.equal(fake.configs.length, 1)
  root.matrix!.configurations.length = 0
  assert.ok((await cache.read(params, "/workspace", fake)).matrix!.configurations.length > 1, "Callers cannot mutate the stored matrix")
  assert.equal((await cache.read(params, "/workspace", fake)).models?.currentValue, "first", "Another caller starts with provider defaults")
})

test("model-only reads share default discovery without waiting for composer commands or exporting other states", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const fake = fakeProvider({ commands: () => undefined })
  const cache = new AgentConfigurationCache({ maxTransitions: 2 })
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  const compact = { ...params, includeMatrix: false }
  const [first, second] = await Promise.all([cache.read(compact, "/workspace", fake), cache.read(compact, "/workspace", fake)])
  assert.equal(first.models?.currentValue, "first")
  assert.equal(second.matrix, undefined)
  assert.equal(fake.configs.length, 1)
  assert.equal(fake.changes.length, 0)
  // The unadvanced notification timeout is still pending in the full warmup.
  t.mock.timers.tick(1_000)
  await fake.closed
  const full = await cache.read(params, "/workspace", fake)
  assert.ok(full.matrix!.configurations.length > 1)
  assert.equal((await cache.read(compact, "/workspace", fake)).matrix, undefined)
})

test("a cold composer and model picker share the same startup and receive their own requested metadata", async t => {
  const connecting = deferred(), connected = deferred()
  const fake = fakeProvider({ async connect() { connecting.resolve(); await connected.promise }, commands: () => undefined })
  const cache = new AgentConfigurationCache({ maxStates: 1 })
  t.after(() => cache.close())
  const menu = cache.read({ ...params, includeMatrix: false }, "/workspace", fake)
  await connecting.promise
  const composer = cache.read({ ...params, composer: true }, "/workspace", fake)
  connected.resolve()
  assert.equal((await menu).models?.currentValue, "first")
  const advertised = [{ name: "review", description: "Review" }]
  await fake.clients[0]!.onUpdate({ sessionId: "probe", update: { sessionUpdate: "available_commands_update", availableCommands: advertised } })
  assert.deepEqual((await composer).commands, advertised)
  assert.equal(fake.configs.length, 1)
})

test("a standalone model picker reads model-specific efforts without starting full matrix exploration", async t => {
  const fake = fakeProvider()
  const cache = new AgentConfigurationCache()
  t.after(() => cache.close())
  const compact = { ...params, includeMatrix: false }
  await cache.read(compact, "/workspace", fake)
  const changed = await cache.read({ ...compact, model: "second" }, "/workspace", fake)
  assert.equal(changed.matrix, undefined)
  assert.deepEqual(changed.reasoningEfforts?.options.map(option => option.id), ["low", "medium"])
  assert.equal(fake.changes.length, 1)
  const reused = await cache.read({ ...compact, model: "second" }, "/workspace", fake)
  assert.deepEqual(reused, changed)
  assert.equal(fake.configs.length, 2)
})

test("a cold read shares startup and returns defaults while background setters are pending", async t => {
  const started = deferred(), continueSet = deferred()
  const fake = fakeProvider({ async set() { started.resolve(); await continueSet.promise } })
  const cache = new AgentConfigurationCache()
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await started.promise
  const root = await cache.read(params, "/workspace", fake)
  assert.equal(root.models?.currentValue, "first")
  assert.equal(root.matrix?.complete, false)
  assert.equal(fake.configs.length, 1)
  continueSet.resolve()
  await fake.closed
})

test("bounded matrices fall back to independent foreground probes and retain confirmed results", async t => {
  const fake = fakeProvider()
  const cache = new AgentConfigurationCache({ maxStates: 2 })
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await fake.closed
  const root = await cache.read(params, "/workspace", fake)
  assert.equal(root.matrix?.complete, false)
  const changed = await cache.read({ ...params, restore: agentConfigurationSelection(root), model: "second", reasoningEffort: "medium" }, "/workspace", fake)
  assert.equal(changed.models?.currentValue, "second")
  assert.equal(changed.reasoningEfforts?.currentValue, "medium")
  assert.equal(fake.configs.length, 2)
  assert.equal(fake.closes, 2)
  assert.equal(changed.matrix!.configurations.length, 2)
})

test("a restore that the provider declines never creates a transition for the requested source", async t => {
  let first = true
  const fake = fakeProvider({ options(options) {
    // The initial effort is advertised, but cannot be restored after another choice.
    if (first) { first = false; return options }
    return options.map(option => option.id === "effort" && option.currentValue === "high"
      ? { ...option, currentValue: "low" } : option)
  } })
  const cache = new AgentConfigurationCache()
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await fake.closed
  const root = await cache.read(params, "/workspace", fake)
  assert.equal(root.matrix?.complete, false)
  assert.equal(cachedAgentConfiguration(root.matrix!, root, { mode: "auto" }), undefined)
})

test("provider, Workspace and launch identity isolate catalogs, and refresh discovers fresh defaults", async t => {
  const fake = fakeProvider()
  const cache = new AgentConfigurationCache({ maxStates: 1 })
  t.after(() => cache.close())
  for (const [provider, workspaceId, cwd, name] of [
    ["configured", "1", "/one", "One"], ["configured", "2", "/two", "One"],
    ["other", "1", "/one", "One"], ["configured", "1", "/one", "Renamed"],
  ]) {
    const found = await cache.read({ provider: provider!, workspaceId }, cwd!, { ...fake, config: { name: name! } })
    assert.equal(found.provider.name, name)
    assert.equal(found.commands?.[0]?.description, `Review ${cwd}`)
  }
  assert.equal(fake.configs.length, 4)
  await cache.read({ provider: "configured", workspaceId: "1", refresh: true }, "/one", { ...fake, config: { name: "One" } })
  assert.equal(fake.configs.length, 5)
})

test("failed background initialization is retried by a foreground read without caching the error", async t => {
  let calls = 0
  const fake = fakeProvider({ async connect() { if (++calls === 1) throw new Error("Sign in required") } })
  const cache = new AgentConfigurationCache({ maxStates: 1 })
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  for (let turn = 0; turn < 10; turn++) await nextTurn()
  for (let turn = 0; turn < 10; turn++) {
    cache.warm(params, "/workspace", fake)
    await nextTurn()
  }
  assert.equal(fake.configs.length, 1, "Catalog notifications do not continuously relaunch an unavailable provider")
  const root = await cache.read(params, "/workspace", fake)
  assert.equal(root.models?.currentValue, "first")
  assert.equal(fake.configs.length, 2)
})

test("composer reads rediscover missing command metadata and then reuse the complete catalog", async t => {
  let advertise = false
  const fake = fakeProvider({ commands: () => advertise ? [{ name: "review", description: "Review" }] : undefined })
  const cache = new AgentConfigurationCache({ maxStates: 1 })
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await fake.closed
  assert.equal((await cache.read(params, "/workspace", fake)).commands, undefined)
  advertise = true
  assert.deepEqual((await cache.read({ ...params, composer: true }, "/workspace", fake)).commands, [{ name: "review", description: "Review" }])
  assert.equal(fake.configs.length, 2)
  assert.deepEqual((await cache.read({ ...params, composer: true }, "/workspace", fake)).commands, [{ name: "review", description: "Review" }])
  assert.equal(fake.configs.length, 2)
})

test("a newly observed dynamic catalog is not labeled a fully explored matrix", async t => {
  let changed = false
  const fake = fakeProvider({
    options: options => changed ? options : [],
    commands: () => changed ? [] : undefined,
  })
  const cache = new AgentConfigurationCache()
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await fake.closed
  assert.equal((await cache.read(params, "/workspace", fake)).matrix?.complete, true)
  changed = true
  const current = await cache.read({ ...params, composer: true }, "/workspace", fake)
  assert.equal(current.models?.currentValue, "first")
  assert.equal(current.matrix?.complete, false)
  assert.equal(current.matrix?.configurations[0]?.models?.currentValue, "first", "Fresh defaults replace the empty warm catalog")
  assert.equal(cachedAgentConfiguration(current.matrix!, undefined, {})?.models?.currentValue, "first")
  const returning = await cache.read(params, "/workspace", fake)
  assert.equal(returning.models?.currentValue, "first", "Switching back to this Agent uses its latest confirmed default")
})

test("fresh defaults discard old edges and an older warm traversal cannot restore its catalog", async t => {
  const restoring = deferred(), finishRestore = deferred()
  let advertise = false
  const fake = fakeProvider({
    commands: () => advertise ? [] : undefined,
    options: (options, client) => fake.clients.indexOf(client) === 0 ? options
      : [...options, { id: "new-option", name: "New option", type: "boolean", currentValue: false }],
    async set(_request, client) {
      if (fake.clients.indexOf(client) === 0 && fake.changes.length === 2) {
        restoring.resolve()
        await finishRestore.promise
      }
    },
  })
  const cache = new AgentConfigurationCache({ maxTransitions: 2 })
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await restoring.promise
  const old = await cache.read(params, "/workspace", fake)
  assert.equal(old.matrix?.transitions.length, 1)
  advertise = true
  const fresh = await cache.read({ ...params, composer: true }, "/workspace", fake)
  assert.equal(fresh.matrix?.configurations.length, 1)
  assert.deepEqual(fresh.matrix?.transitions, [], "Transitions confirmed against the old default catalog are discarded")
  assert.ok(fresh.matrix?.configurations[0]?.configOptions?.some(option => option.id === "new-option"))
  finishRestore.resolve()
  for (let turn = 0; turn < 10; turn++) await nextTurn()
  const returning = await cache.read(params, "/workspace", fake)
  assert.ok(returning.configOptions?.some(option => option.id === "new-option"))
  assert.ok(returning.matrix?.configurations.every(configuration => configuration.configOptions?.some(option => option.id === "new-option")),
    "Late old-process responses never append obsolete states to the replacement matrix")
  assert.equal(fake.configs.length, 3, "Bounded warming restarts against the newly confirmed defaults")
})

for (const stage of ["startup", "setter"] as const) {
  test(`a foreground read superseded during ${stage} returns its selection without a newer matrix`, async t => {
    const blocked = deferred(), resume = deferred()
    const fake = fakeProvider({
      async connect(client) {
        if (stage === "startup" && fake.clients.indexOf(client) === 1) { blocked.resolve(); await resume.promise }
      },
      async set(request, client) {
        if (stage === "setter" && request.configId === "model" && fake.clients.indexOf(client) === 1) { blocked.resolve(); await resume.promise }
      },
      options: (options, client) => fake.clients.indexOf(client) < 2 ? options
        : [...options, { id: "new-option", name: "New option", type: "boolean", currentValue: false }],
    })
    const cache = new AgentConfigurationCache({ maxStates: 1 })
    t.after(() => cache.close())
    cache.warm(params, "/workspace", fake)
    await fake.closed
    const older = cache.read({ ...params, model: "second" }, "/workspace", fake)
    await blocked.promise
    const newer = await cache.read({ ...params, mode: "auto" }, "/workspace", fake)
    assert.ok(newer.matrix?.configurations[0]?.configOptions?.some(option => option.id === "new-option"))
    resume.resolve()
    const selected = await older
    assert.equal(selected.models?.currentValue, "second", "The requested private selection remains confirmed")
    assert.equal(selected.matrix === undefined, true, "A snapshot from the old generation must not carry the replacement matrix")
    const latest = await cache.read(params, "/workspace", fake)
    assert.equal(latest.models?.currentValue, "first")
    assert.ok(latest.matrix?.configurations.every(configuration => configuration.configOptions?.some(option => option.id === "new-option")),
      "Completing the older read does not change the newer shared graph")
    assert.equal(cachedAgentConfiguration(latest.matrix!, undefined, {})?.models?.currentValue, "first")
    assert.equal(fake.configs.length, 3)
  })
}

test("invalidation cancels pending work and prevents stale results replacing refreshed catalogs", async t => {
  const started = deferred(), resume = deferred()
  const fake = fakeProvider({ async set(_request, client) {
    if (fake.configs.length === 1) {
      started.resolve()
      await Promise.race([resume.promise, new Promise<void>((_resolve, reject) => client.signal!.addEventListener("abort", () => reject(client.signal!.reason), { once: true }))])
    }
  } })
  const cache = new AgentConfigurationCache()
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await started.promise
  await cache.invalidate()
  assert.equal(fake.clients[0]!.signal?.aborted, true)
  const refreshed = await cache.read(params, "/workspace", fake)
  resume.resolve()
  assert.equal(refreshed.models?.currentValue, "first")
  assert.equal(fake.configs.length, 2)
  assert.equal(agentConfigurationIdentity(refreshed), agentConfigurationIdentity(refreshed.matrix!.configurations[0]!))
})

test("the warm budget closes stalled discovery and shutdown cancels outstanding initialization", async t => {
  const started = deferred()
  const fake = fakeProvider({ async set(_request, client) {
    started.resolve()
    await new Promise<void>((_resolve, reject) => client.signal!.addEventListener("abort", () => reject(client.signal!.reason), { once: true }))
  } })
  const cache = new AgentConfigurationCache({ timeoutMs: 20 })
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await started.promise
  await fake.closed
  assert.equal((await cache.read(params, "/workspace", fake)).matrix?.complete, false)
  const pendingStart = deferred()
  const pending = fakeProvider({ async connect(client) {
    pendingStart.resolve()
    await new Promise<void>((_resolve, reject) => client.signal!.addEventListener("abort", () => reject(client.signal!.reason), { once: true }))
  } })
  const reading = assert.rejects(cache.read({ provider: "pending" }, "/workspace", pending), /stopping/)
  await pendingStart.promise
  await cache.close()
  await reading
})

test("one foreground deadline bounds restoring and editing several configuration values", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const fake = fakeProvider({ async set() { await new Promise(resolve => setTimeout(resolve, 30_000)) } })
  const cache = new AgentConfigurationCache({ maxStates: 1 })
  t.after(() => cache.close())
  cache.warm(params, "/workspace", fake)
  await fake.closed
  const rejected = assert.rejects(cache.read({ ...params, restore: { model: "second" },
    reasoningEffort: "medium", configValues: { fast: true } }, "/workspace", fake), /configuration request timed out/)
  await nextTurn()
  assert.equal(fake.changes.length, 1)
  t.mock.timers.tick(30_000)
  await nextTurn()
  assert.equal(fake.changes.length, 2)
  t.mock.timers.tick(15_000)
  await rejected
  assert.equal(fake.clients[1]!.signal?.aborted, true, "Only the foreground process receives this request's cancellation")
  t.mock.timers.tick(30_000)
  await nextTurn()
  assert.equal(fake.changes.length, 2, "A late setter response cannot start the next edit")
  assert.equal(fake.closes, 2)
  assert.equal((await cache.read(params, "/workspace", fake)).models?.currentValue, "first")
})

test("a reader can time out waiting for shared startup without cancelling warm discovery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const started = deferred(), finish = deferred()
  const fake = fakeProvider({ async connect() { started.resolve(); await finish.promise } })
  const cache = new AgentConfigurationCache({ maxStates: 1, requestTimeoutMs: 10_000 })
  t.after(() => cache.close())
  const rejected = assert.rejects(cache.read(params, "/workspace", fake), /configuration request timed out/)
  await started.promise
  t.mock.timers.tick(10_000)
  await rejected
  assert.equal(fake.clients[0]!.signal?.aborted, false)
  finish.resolve()
  await fake.closed
  const found = await cache.read(params, "/workspace", fake)
  assert.equal(found.models?.currentValue, "first")
  assert.equal(fake.configs.length, 1, "Other readers reuse the shared startup after the first request expires")
})
