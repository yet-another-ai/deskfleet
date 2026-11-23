import { flushPromises } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { effectScope, reactive, watch, type EffectScope } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentConfiguration, AgentConfigurationMatrix, AgentConfigurationSnapshot } from "@deskfleet/client/agent-configuration"
import { useAgentConfigurationCacheStore } from "../../stores/agent-configuration-cache.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useAgentConfiguration } from "./useAgentConfiguration.ts"

let pinia: ReturnType<typeof createPinia>
let agents: ReturnType<typeof useAgentSessionsStore>
let providers: ReturnType<typeof useProvidersStore>
const scopes: EffectScope[] = []

function snapshot(model = "alpha", effort = "medium", mode = "default", fast = false, specialist = "general", provider = "codex"): AgentConfigurationSnapshot {
  return {
    provider: { id: provider, name: provider },
    models: { id: "model", currentValue: model, options: [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }] },
    reasoningEfforts: { id: "effort", currentValue: effort, options: [{ id: "medium", name: "Medium" }, { id: "high", name: "High" }] },
    modes: { id: "mode", currentValue: mode, options: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
    configOptions: [
      { id: "fast", name: "Fast", type: "boolean", currentValue: fast },
      { id: "specialist", name: "Specialist", type: "select", currentValue: specialist, options: [{ value: "general", name: "General" }, { value: "reviewer", name: "Reviewer" }] },
    ],
  }
}

function configuration(provider = "codex"): AgentConfiguration {
  const configurations = [
    snapshot(), snapshot("beta"), snapshot("beta", "high"), snapshot("beta", "high", "plan"),
    snapshot("beta", "high", "plan", true), snapshot("beta", "high", "plan", true, "reviewer"),
  ].map(value => ({ ...value, provider: { id: provider, name: provider } }))
  const matrix: AgentConfigurationMatrix = { configurations, complete: false, transitions: [
    { from: 0, selection: { model: "beta" }, to: 1 },
    { from: 1, selection: { reasoningEffort: "high" }, to: 2 },
    { from: 2, selection: { mode: "plan" }, to: 3 },
    { from: 3, selection: { configValues: { fast: true } }, to: 4 },
    { from: 4, selection: { configValues: { specialist: "reviewer" } }, to: 5 },
  ] }
  return { ...configurations[0]!, matrix }
}

function picker(target = reactive<{ providerId: string; workspaceId?: string; sessionId?: string }>({ providerId: "codex", workspaceId: "11" })) {
  const scope = effectScope()
  scopes.push(scope)
  return { menu: scope.run(() => useAgentConfiguration(() => target))!, target, scope }
}

function workspaceDirectory(path: string): void {
  useFleetStore().catalog = {
    teamId: "1", machineId: "1", machineName: "Test", sessions: [], sessionIds: [],
    workspaces: [{ id: "11", name: "Workspace", worktrees: [{ id: "12", workspaceId: "11", directories: [{ path }] }] }],
  }
}

beforeEach(() => {
  window.localStorage.clear()
  pinia = createPinia(); setActivePinia(pinia)
  agents = useAgentSessionsStore()
  providers = useProvidersStore()
  providers.revision = "settings-1"
  providers.providers = [{ id: "codex", name: "Codex", template: "codex" }]
  providers.ready = providers.loaded = true
  vi.spyOn(agents, "agentConfiguration").mockResolvedValue(configuration())
  vi.spyOn(agents, "releaseAgentConfiguration").mockResolvedValue()
})

afterEach(async () => {
  for (const scope of scopes.splice(0)) scope.stop()
  await flushPromises()
  disposePinia(pinia)
  vi.restoreAllMocks()
  window.localStorage.clear()
})

test("confirmed matrix choices update consecutive draft controls without RPC or loading", async () => {
  const { menu } = picker()
  menu.toggle(); await flushPromises()
  const loading: boolean[] = []
  const stop = watch(menu.loading, value => loading.push(value), { flush: "sync" })
  await menu.changeModel("beta")
  await menu.changeReasoningEffort("high")
  await menu.changeMode("plan")
  await menu.changeConfigOption("fast", true)
  await menu.changeConfigOption("specialist", "reviewer")
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(1)
  expect(agents.draftConfiguration).toEqual({ provider: "codex", model: "beta", reasoningEffort: "high", mode: "plan", configValues: { fast: true, specialist: "reviewer" } })
  expect(menu.configuration.value).toMatchObject(snapshot("beta", "high", "plan", true, "reviewer"))
  expect(menu.loading.value).toBe(false)
  expect(loading).toEqual([])
  expect(agents.releaseAgentConfiguration).toHaveBeenCalledTimes(1)
  stop()
})

test("a matrix miss restores locally confirmed choices into a fresh probe", async () => {
  const { menu } = picker()
  menu.toggle(); await flushPromises()
  const previousProbe = vi.mocked(agents.agentConfiguration).mock.calls[0]![0].probeId
  await menu.changeModel("beta")
  let reject!: (reason: Error) => void
  vi.mocked(agents.agentConfiguration).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
  const changing = menu.changeMode("plan")
  expect(menu.loading.value).toBe(true)
  expect(agents.agentConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({
    provider: "codex", workspaceId: "11", mode: "plan", cache: true,
    restore: { model: "beta", reasoningEffort: "medium", mode: "default", configValues: { fast: false, specialist: "general" } },
  }))
  expect(vi.mocked(agents.agentConfiguration).mock.calls.at(-1)![0].probeId).not.toBe(previousProbe)
  reject(new Error("Plan unavailable")); await changing
  expect(menu.configuration.value?.modes?.currentValue).toBe("default")
  expect(agents.draftConfiguration.model).toBe("beta")
  expect(menu.error.value).toBe("Plan unavailable")
})

test("returning to a provider reuses its matrix while Workspace and registry changes refresh", async () => {
  vi.mocked(agents.agentConfiguration).mockImplementation(async params => configuration(params.provider))
  const { menu, target } = picker()
  menu.toggle(); await flushPromises()
  target.providerId = "other"; await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
  target.providerId = "codex"; await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
  expect(menu.configuration.value?.provider.id).toBe("codex")
  target.workspaceId = "22"; await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(3)
  providers.revision = "settings-2"; await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(4)
  target.workspaceId = "11"; await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(5)
})

test("a cached choice supersedes a pending miss without accepting its late response", async () => {
  const { menu } = picker()
  menu.toggle(); await flushPromises()
  let resolve!: (value: AgentConfiguration) => void
  vi.mocked(agents.agentConfiguration).mockReturnValueOnce(new Promise(done => { resolve = done }))
  const pending = menu.changeMode("plan")
  expect(menu.loading.value).toBe(true)
  await menu.changeModel("beta")
  await menu.changeReasoningEffort("high")
  expect(menu.loading.value).toBe(false)
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
  expect(agents.releaseAgentConfiguration).not.toHaveBeenCalled()
  resolve(snapshot("alpha", "medium", "plan")); await pending; await flushPromises()
  expect(agents.draftConfiguration).toMatchObject({ model: "beta", reasoningEffort: "high", mode: "default" })
  expect(menu.modelValue.value).toBe("beta")
  expect(agents.releaseAgentConfiguration).toHaveBeenCalledTimes(1)
})

test("moving a Workspace's primary directory invalidates its matrix even with the same ID", async () => {
  workspaceDirectory("/before")
  const { menu } = picker()
  menu.toggle(); await flushPromises()
  await menu.changeModel("beta")
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(1)
  workspaceDirectory("/after"); await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
  expect(vi.mocked(agents.agentConfiguration).mock.calls.at(-1)![0]).toMatchObject({ workspaceId: "11", cache: true })
  await menu.changeModel("beta")
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
  workspaceDirectory("/before"); await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(3)
})

test("late metadata from a Workspace's previous directory cannot confirm or populate the cache", async () => {
  workspaceDirectory("/before")
  let resolve!: (value: AgentConfiguration) => void
  vi.mocked(agents.agentConfiguration).mockReturnValueOnce(new Promise(done => { resolve = done }))
  const { menu } = picker()
  menu.toggle()
  workspaceDirectory("/after")
  await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
  await menu.changeModel("beta")
  resolve(configuration()); await flushPromises()
  expect(menu.modelValue.value).toBe("beta")
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
})

test("the first Workspace catalog does not restart or discard pending configuration discovery", async () => {
  let resolve!: (value: AgentConfiguration) => void
  vi.mocked(agents.agentConfiguration).mockReturnValueOnce(new Promise(done => { resolve = done }))
  const { menu } = picker()
  menu.toggle()
  workspaceDirectory("/first"); await flushPromises()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(1)
  resolve(configuration()); await flushPromises()
  await menu.changeModel("beta")
  expect(menu.modelValue.value).toBe("beta")
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(1)
})

test("reloading bypasses a warm matrix and requests current defaults", async () => {
  const { menu } = picker()
  menu.toggle(); await flushPromises()
  await menu.changeModel("beta")
  await menu.reload()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
  expect(agents.agentConfiguration).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "11", probeId: expect.any(String), cache: true, refresh: true })
  expect(menu.modelValue.value).toBe("alpha")
})

test("composer discovery requires command metadata and live Sessions still configure their provider", async () => {
  const { menu, target } = picker()
  menu.toggle(); await flushPromises()
  await menu.changeModel("beta")
  await menu.discover()
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
  expect(agents.agentConfiguration).toHaveBeenLastCalledWith(expect.objectContaining({ composer: true, model: "beta", cache: true }))
  vi.spyOn(agents, "sessionConfiguration").mockResolvedValue(configuration())
  vi.spyOn(agents, "configureSession").mockResolvedValue(snapshot("beta"))
  target.sessionId = "30"; await flushPromises()
  await menu.changeModel("beta")
  expect(agents.configureSession).toHaveBeenCalledExactlyOnceWith("30", { model: "beta" })
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(2)
})

test("matrices and stale responses remain isolated by machine runtime and settings generation", () => {
  const cache = useAgentConfigurationCacheStore()
  const target = { provider: "codex", workspaceId: "11" }
  const epoch = cache.epoch(target)
  cache.remember(target, configuration(), epoch)
  expect(cache.read(target, undefined, {})?.models?.currentValue).toBe("alpha")
  const other = { ...target, provider: "other" }
  cache.remember(other, configuration("other"), cache.epoch(other))
  expect(cache.read(other, configuration(), {})?.provider.id).toBe("other")
  const otherMachine = createPinia()
  expect(useAgentConfigurationCacheStore(otherMachine).read(target, undefined, {})).toBeUndefined()
  disposePinia(otherMachine)
  providers.revision = "settings-2"
  cache.remember(target, configuration(), epoch)
  expect(cache.read(target, undefined, {})).toBeUndefined()
})
