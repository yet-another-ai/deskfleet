import { configureClient, getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { ProviderSnapshot } from "../../../../apps/daemon/src/provider-protocol.ts"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { createApp } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useProvidersStore } from "../stores/providers.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import { agentSnapshot } from "../test/agent.ts"
import { catalogFixture } from "../test/catalog.ts"
import { platformClientKey, usePlatformClient } from "./usePlatformClient.ts"

const host = getClient()
const states: Pinia[] = []
afterEach(() => {
  for (const state of states.splice(0)) disposePinia(state)
  configureClient(host)
})

test("the local-only fallback captures its adapter before the configured client changes", () => {
  const captured = usePlatformClient()
  configureClient({ ...host, target: { id: "other", local: false } })
  expect(captured).toBe(host)
  expect(usePlatformClient()).not.toBe(captured)
})

test("retained machine stores read their injected adapters after another machine is selected", async () => {
  function machine(id: string) {
    const catalog = { ...catalogFixture(), machineName: id }
    const snapshot = agentSnapshot()
    snapshot.session.title = `Conversation ${id}`
    const listCatalog = vi.fn(async () => catalog)
    const listProviders = vi.fn(async (): Promise<ProviderSnapshot> => ({ revision: id, templates: [], providers: [{ id: "codex", name: `Provider ${id}`, template: "codex", env: {} }] }))
    const listTerminals = vi.fn(async () => [])
    const listSessions = vi.fn(async () => [snapshot.session])
    const api: DeskfleetDesktopApi = {
      ...host, target: { id, local: false },
      catalog: { ...host.catalog, list: listCatalog },
      desktop: { ...host.desktop, target: async () => ({ id, name: id, online: false, desktop: false }) },
      providers: { ...host.providers, list: listProviders },
      terminal: { ...host.terminal, list: listTerminals },
      agent: { ...host.agent, history: {
        available: () => false, list: listSessions, snapshot: async () => snapshot, events: async () => [],
      } },
    }
    const state = createPinia()
    states.push(state)
    const app = createApp({}).provide(platformClientKey, api).use(state)
    const stores = app.runWithContext(() => ({
      fleet: useFleetStore(state), providers: useProvidersStore(state),
      terminals: useTerminalsStore(state), agents: useAgentSessionsStore(state),
    }))
    return { api, ...stores, listCatalog, listProviders, listTerminals, listSessions }
  }

  const first = machine("first")
  const second = machine("second")
  configureClient(second.api)
  for (const runtime of [first, second]) {
    await Promise.all([runtime.fleet.refreshLocal(), runtime.providers.refresh(), runtime.terminals.refresh(), runtime.agents.refresh()])
  }

  for (const [runtime, id] of [[first, "first"], [second, "second"]] as const) {
    expect(runtime.fleet.targetId).toBe(id)
    expect(runtime.fleet.machines[0]?.name).toBe(id)
    expect(runtime.providers.providers[0]?.name).toBe(`Provider ${id}`)
    expect(runtime.agents.sessions["30"]?.title).toBe(`Conversation ${id}`)
    expect(runtime.listCatalog).toHaveBeenCalledOnce()
    expect(runtime.listProviders).toHaveBeenCalledOnce()
    expect(runtime.listTerminals).toHaveBeenCalledOnce()
    expect(runtime.listSessions).toHaveBeenCalledOnce()
  }
})
