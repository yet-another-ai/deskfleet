import assert from "node:assert/strict"
import test from "node:test"
import type * as acp from "@agentclientprotocol/sdk"
import { AgentConfigurationProbes } from "./agent-configuration-probes.ts"
import { setImmediate as nextTurn } from "node:timers/promises"
import type { AgentClient, AgentConfig, AgentConnection, AgentProvider } from "./agents/acp.ts"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function options(model = "first", effort = "high", mode = "manual"): acp.SessionConfigOption[] {
  return [
    { id: "model", category: "model", name: "Model", type: "select", currentValue: model,
      options: ["first", "second"].map(value => ({ value, name: value })) },
    { id: "effort", category: "thought_level", name: "Effort", type: "select", currentValue: effort,
      options: (model === "first" ? ["low", "high"] : ["low", "medium"]).map(value => ({ value, name: value })) },
    { id: "mode", category: "mode", name: "Mode", type: "select", currentValue: mode,
      options: ["manual", "auto", "plan"].map(value => ({ value, name: value })) },
  ]
}

function fakeProvider(hooks: {
  connect?(client: AgentClient): Promise<void>
  newSession?(params: acp.NewSessionRequest): Promise<void>
  set?(params: acp.SetSessionConfigOptionRequest): Promise<void>
  close?(): Promise<void>
} = {}) {
  const configs: AgentConfig[] = []
  const sessions: acp.NewSessionRequest[] = []
  const changes: acp.SetSessionConfigOptionRequest[] = []
  const clients: AgentClient[] = []
  let closes = 0
  const provider: AgentProvider = {
    id: "codex",
    async connect(config, client) {
      configs.push(config)
      clients.push(client)
      await hooks.connect?.(client)
      let model = "first"
      let effort = "high"
      let mode = "manual"
      const connection: AgentConnection = {
        initialization: { protocolVersion: 1 },
        async newSession(params) {
          sessions.push(params)
          await hooks.newSession?.(params)
          return { sessionId: `probe-${configs.length}`, configOptions: options(model, effort, mode) }
        },
        async setConfigOption(params) {
          changes.push(params)
          await hooks.set?.(params)
          if (params.configId === "model") {
            model = String(params.value); effort = "low"
            if (model === "second" && mode === "auto") mode = "manual"
          } else if (params.configId === "effort") effort = String(params.value)
          else mode = String(params.value)
          return { configOptions: options(model, effort, mode) }
        },
        async close() { closes++; await hooks.close?.() },
        async prompt() { assert.fail("Probes must never prompt") },
        async steer() { assert.fail("Probes must never steer") },
        async resume() { assert.fail("Probes must never resume") },
        async cancel() {},
      }
      return connection
    },
  }
  return { provider, config: { name: "Test provider" }, configs, sessions, changes, clients, get closes() { return closes } }
}

const params = { provider: "codex", workspaceId: "1", probeId: "draft" }

test("warm draft choices reuse one ACP process/session and use its dependent options", async context => {
  const fake = fakeProvider()
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  assert.equal((await probes.read("alice", params, "/workspace", fake)).reasoningEfforts?.currentValue, "high")
  const changed = await probes.read("alice", { ...params, model: "second", reasoningEffort: "medium" }, "/workspace", fake)
  assert.equal(changed.models?.currentValue, "second")
  assert.equal(changed.reasoningEfforts?.currentValue, "medium")
  assert.deepEqual(fake.changes.map(change => change.configId), ["model", "effort"])
  assert.equal(fake.configs.length, 1)
  assert.equal(fake.sessions.length, 1)
  assert.equal(fake.closes, 0)
  await probes.release("alice", params.probeId)
  await probes.release("alice", params.probeId)
  assert.equal(fake.closes, 1)
})

test("a new probe restores confirmed choices before applying the delta and accepts native fallback", async context => {
  const fake = fakeProvider()
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  const result = await probes.read("alice", {
    ...params, restore: { model: "first", reasoningEffort: "low", mode: "auto" }, model: "second",
  }, "/workspace", fake)
  assert.deepEqual(fake.changes.map(change => [change.configId, change.value]), [
    ["effort", "low"], ["mode", "auto"], ["model", "second"],
  ])
  assert.equal(result.models?.currentValue, "second")
  assert.equal(result.reasoningEfforts?.currentValue, "low")
  assert.equal(result.modes?.currentValue, "manual", "The changed model can reconcile the restored mode")
})

test("warm probes ignore stale restore snapshots", async context => {
  const fake = fakeProvider()
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  await probes.read("alice", { ...params, model: "second", reasoningEffort: "medium", mode: "plan" }, "/workspace", fake)
  const before = fake.changes.length
  const result = await probes.read("alice", {
    ...params, restore: { model: "first", reasoningEffort: "high", mode: "auto" }, reasoningEffort: "low",
  }, "/workspace", fake)
  assert.deepEqual(fake.changes.slice(before).map(change => [change.configId, change.value]), [["effort", "low"]])
  assert.equal(result.models?.currentValue, "second")
  assert.equal(result.modes?.currentValue, "plan")
  assert.equal(fake.configs.length, 1)
})

test("expired probes restore the picker's confirmed selection before the next change", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const fake = fakeProvider()
  const probes = new AgentConfigurationProbes({ idleMs: 100 })
  context.after(() => probes.close())
  const confirmed = { model: "second", reasoningEffort: "medium", mode: "plan" }
  await probes.read("alice", { ...params, ...confirmed }, "/workspace", fake)
  const before = fake.changes.length
  context.mock.timers.tick(100)
  const result = await probes.read("alice", { ...params, restore: confirmed, model: "first" }, "/workspace", fake)
  assert.equal(fake.configs.length, 2)
  assert.deepEqual(fake.changes.slice(before).map(change => [change.configId, change.value]), [
    ["model", "second"], ["effort", "medium"], ["mode", "plan"], ["model", "first"],
  ])
  assert.equal(result.models?.currentValue, "first")
  assert.equal(result.modes?.currentValue, "plan")
})

test("unsupported restored choices retire the probe and explicit reload can recover", async context => {
  const fake = fakeProvider()
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  await assert.rejects(probes.read("alice", {
    ...params, restore: { model: "retired-model" }, model: "second",
  }, "/workspace", fake), /Unsupported agent model/)
  assert.equal(fake.closes, 1)
  assert.equal(fake.changes.length, 0, "A failed restore must not proceed to the new selection")
  const reloaded = await probes.read("alice", params, "/workspace", fake)
  assert.equal(reloaded.models?.currentValue, "first")
  assert.equal(fake.configs.length, 2)
})

test("probe scope, provider, workspace and launch settings isolate state", async context => {
  const fake = fakeProvider()
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  await probes.read("alice", params, "/workspace", fake)
  await probes.read("bob", params, "/workspace", fake)
  await probes.read("alice", { ...params, probeId: "another-draft" }, "/workspace", fake)
  assert.equal(fake.configs.length, 3)
  await probes.release("bob", params.probeId)
  assert.equal(fake.closes, 1)
  await probes.read("alice", { ...params, provider: "other-provider" }, "/workspace", fake)
  await probes.read("alice", { ...params, provider: "other-provider", workspaceId: "2" }, "/workspace", fake)
  await probes.read("alice", { ...params, provider: "other-provider", workspaceId: "2" }, "/new-workspace", fake)
  assert.equal(fake.configs.length, 6)
  assert.equal(fake.closes, 4)
  const selected = { ...params, provider: "other-provider", workspaceId: "2" }
  await probes.read("alice", selected, "/new-workspace", { ...fake, config: { name: "Changed", binaryPath: "/bin/provider", env: { ACCOUNT: "second", ORDER: "same" } } })
  await probes.read("alice", selected, "/new-workspace", { ...fake, config: { name: "Changed", binaryPath: "/bin/provider", env: { ORDER: "same", ACCOUNT: "second" } } })
  assert.equal(fake.configs.length, 7, "Environment key order does not invalidate identical settings")
  const replacement = fakeProvider()
  await probes.read("alice", selected, "/new-workspace", replacement)
  assert.equal(replacement.configs.length, 1)
  assert.equal(fake.closes, 6)
})

test("concurrent changes to one probe serialize, and notifications supply later options", async context => {
  const entered = deferred()
  const continueChange = deferred()
  const fake = fakeProvider({ async set(request) { if (request.configId === "model") { entered.resolve(); await continueChange.promise } } })
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  await probes.read("alice", params, "/workspace", fake)
  const model = probes.read("alice", { ...params, model: "second" }, "/workspace", fake)
  await entered.promise
  const effort = probes.read("alice", { ...params, reasoningEffort: "medium" }, "/workspace", fake)
  await Promise.resolve()
  assert.equal(fake.changes.length, 1)
  continueChange.resolve()
  assert.equal((await model).reasoningEfforts?.currentValue, "low")
  assert.equal((await effort).reasoningEfforts?.currentValue, "medium")
  assert.equal(fake.configs.length, 1)
  await fake.clients[0]!.onUpdate({ sessionId: "probe-1", update: { sessionUpdate: "config_option_update", configOptions: options("second", "low") } })
  assert.equal((await probes.read("alice", params, "/workspace", fake)).reasoningEfforts?.currentValue, "low")
})

test("concurrent cold reads share startup and preserve request order", async context => {
  const entered = deferred()
  const started = deferred()
  const fake = fakeProvider({ async newSession() { entered.resolve(); await started.promise } })
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  const first = probes.read("alice", { ...params, model: "second" }, "/workspace", fake)
  const second = probes.read("alice", { ...params, reasoningEffort: "medium" }, "/workspace", fake)
  await entered.promise
  assert.equal(fake.configs.length, 1)
  started.resolve()
  assert.equal((await first).reasoningEfforts?.currentValue, "low")
  assert.equal((await second).reasoningEfforts?.currentValue, "medium")
  assert.equal(fake.sessions.length, 1)
})

test("failed choices retire the probe and a retry reads a fresh provider", async context => {
  const fake = fakeProvider()
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  await probes.read("alice", params, "/workspace", fake)
  await assert.rejects(probes.read("alice", { ...params, model: "missing" }, "/workspace", fake), /Unsupported agent model/)
  assert.equal(fake.closes, 1)
  await probes.read("alice", params, "/workspace", fake)
  assert.equal(fake.configs.length, 2)
  await probes.invalidate()
  assert.equal(fake.closes, 2)
  await probes.read("alice", params, "/workspace", fake)
  assert.equal(fake.configs.length, 3)
})

test("provider authentication failures are reported unchanged and can be retried", async context => {
  let fail = true
  const reason = new Error("Agent authentication required")
  const fake = fakeProvider({ async newSession() { if (fail) throw reason } })
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  await assert.rejects(probes.read("alice", params, "/workspace", fake), error => error === reason)
  assert.equal(fake.closes, 1)
  fail = false
  await probes.read("alice", params, "/workspace", fake)
  assert.equal(fake.configs.length, 2)
})

test("idle expiry and maximum age bound retained metadata", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const fake = fakeProvider()
  const probes = new AgentConfigurationProbes({ idleMs: 100, maxAgeMs: 250 })
  context.after(() => probes.close())
  await probes.read("alice", params, "/workspace", fake)
  context.mock.timers.tick(100)
  await probes.read("alice", params, "/workspace", fake)
  assert.equal(fake.configs.length, 2)
  assert.equal(fake.closes, 1)
  for (let index = 0; index < 3; index++) {
    context.mock.timers.tick(90)
    await probes.read("alice", params, "/workspace", fake)
  }
  assert.equal(fake.configs.length, 3, "Active use still refreshes at the maximum age")
  assert.equal(fake.closes, 2)
})

test("a failed probe close still frees capacity for the next draft", async () => {
  const fake = fakeProvider({ async close() { throw new Error("stdin teardown failed") } })
  const probes = new AgentConfigurationProbes({ maxProbes: 1 })
  await probes.read("alice", params, "/workspace", fake)
  await probes.read("bob", params, "/workspace", fake)
  await probes.read("carol", params, "/workspace", fake)
  assert.equal(fake.configs.length, 3)
  assert.equal(fake.closes, 2)
  await assert.rejects(probes.close(), /Could not close Agent configuration probes/)
})

test("request timeout closes a stalled session and releases capacity for retry", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const entered = deferred()
  let stall = true
  const fake = fakeProvider({ async newSession() { if (stall) { entered.resolve(); await new Promise(() => {}) } } })
  const probes = new AgentConfigurationProbes({ timeoutMs: 50, maxProbes: 1 })
  context.after(() => probes.close())
  const timedOut = assert.rejects(probes.read("alice", params, "/workspace", fake), /timed out/)
  await entered.promise
  context.mock.timers.tick(50)
  await timedOut
  assert.equal(fake.closes, 1)
  stall = false
  await probes.read("alice", params, "/workspace", fake)
  assert.equal(fake.configs.length, 2)
})

test("capacity counts closing processes and evicts only idle probes", async context => {
  const closing = deferred()
  const closed = deferred()
  let hold = true
  const fake = fakeProvider({ async close() { if (hold) { closing.resolve(); await closed.promise } } })
  const probes = new AgentConfigurationProbes({ maxProbes: 1 })
  context.after(() => probes.close())
  await probes.read("alice", params, "/workspace", fake)
  const next = probes.read("bob", params, "/workspace", fake)
  await closing.promise
  assert.equal(fake.configs.length, 1, "A closing process still owns the sole slot")
  hold = false
  closed.resolve()
  await next
  assert.equal(fake.configs.length, 2)
  assert.equal(fake.closes, 1)
})

test("a slow unrelated cleanup does not block an already warm probe", async context => {
  const closing = deferred()
  const closed = deferred()
  const slow = fakeProvider({ async close() { closing.resolve(); await closed.promise } })
  const warm = fakeProvider()
  const probes = new AgentConfigurationProbes()
  context.after(async () => { closed.resolve(); await probes.close() })
  await probes.read("alice", params, "/workspace", slow)
  await probes.read("bob", params, "/workspace", warm)
  const releasing = probes.release("alice", params.probeId)
  await closing.promise
  let confirmed = false
  const reading = probes.read("bob", { ...params, model: "second" }, "/workspace", warm).then(result => { confirmed = true; return result })
  await nextTurn()
  const readyBeforeCleanup = confirmed
  closed.resolve()
  await releasing
  assert.equal((await reading).models?.currentValue, "second")
  assert.equal(readyBeforeCleanup, true, "Another provider's shutdown must not delay a warm setter")
  assert.equal(warm.configs.length, 1)
})

test("warm reuse cannot overtake a queued release or provider-settings invalidation", async context => {
  for (const action of ["release", "invalidate"] as const) {
    await context.test(action, async childContext => {
      const closing = deferred()
      const closed = deferred()
      const slow = fakeProvider({ async close() { closing.resolve(); await closed.promise } })
      const warm = fakeProvider()
      const probes = new AgentConfigurationProbes()
      childContext.after(async () => { closed.resolve(); await probes.close() })
      await probes.read("alice", params, "/workspace", slow)
      await probes.read("bob", params, "/workspace", warm)
      const releasing = probes.release("alice", params.probeId)
      await closing.promise
      const invalidating = action === "release" ? probes.release("bob", params.probeId) : probes.invalidate()
      const reading = probes.read("bob", { ...params, model: "second" }, "/workspace", warm)
      await nextTurn()
      const settersBeforeCleanup = warm.changes.length
      closed.resolve()
      await Promise.all([releasing, invalidating, reading])
      assert.equal(settersBeforeCleanup, 0, "Do not mutate the probe scheduled for replacement")
      assert.equal(warm.configs.length, 2)
      assert.equal(warm.closes, 1)
    })
  }
})

test("active probes are not evicted and service close cancels pending work once", async () => {
  const entered = deferred()
  const fake = fakeProvider({ async newSession() { entered.resolve(); await new Promise(() => {}) } })
  const probes = new AgentConfigurationProbes({ maxProbes: 1 })
  const cancelled = assert.rejects(probes.read("alice", params, "/workspace", fake), /service is stopping/)
  await entered.promise
  await assert.rejects(probes.read("bob", params, "/workspace", fake), /Too many active/)
  assert.equal(fake.configs.length, 1)
  await probes.close()
  await cancelled
  assert.equal(fake.closes, 1)
  await probes.close()
  assert.equal(fake.closes, 1)
  await assert.rejects(probes.read("alice", params, "/workspace", fake), /service is stopping/)
})

test("release cancels startup and owns the eventual connection cleanup", async context => {
  const connecting = deferred()
  const connected = deferred()
  const fake = fakeProvider({ async connect() { connecting.resolve(); await connected.promise } })
  const probes = new AgentConfigurationProbes()
  context.after(() => probes.close())
  const cancelled = assert.rejects(probes.read("alice", params, "/workspace", fake), /released/)
  await connecting.promise
  const released = probes.release("alice", params.probeId)
  await Promise.resolve()
  connected.resolve()
  await released
  await cancelled
  assert.equal(fake.closes, 1)
  assert.equal(fake.sessions.length, 0)
})

test("shutdown cancels a maximum-age refresh waiting for an active selection", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const entered = deferred()
  const fake = fakeProvider({ async set() { entered.resolve(); await new Promise(() => {}) } })
  const probes = new AgentConfigurationProbes({ maxAgeMs: 100 })
  await probes.read("alice", params, "/workspace", fake)
  const pending = assert.rejects(probes.read("alice", { ...params, model: "second" }, "/workspace", fake), /service is stopping/)
  await entered.promise
  context.mock.timers.tick(100)
  const refresh = assert.rejects(probes.read("alice", params, "/workspace", fake), /service is stopping/)
  await probes.close()
  await Promise.all([pending, refresh])
  assert.equal(fake.configs.length, 1)
  assert.equal(fake.closes, 1)
})
