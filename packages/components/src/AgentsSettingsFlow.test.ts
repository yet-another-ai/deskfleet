import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { getClient } from "@deskfleet/client/platform"
import type { AgentProviderInput, AgentProviderSettings, ProviderSnapshot } from "../../../apps/daemon/src/provider-protocol.ts"
import { AGENT_PROVIDER_TEMPLATES } from "../../../apps/daemon/src/provider-protocol.ts"
import AccountShell from "./AccountShell.vue"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import { fakeCentral, machineFixture } from "./test/central.ts"
import * as machineRuntimes from "./composables/useMachineRuntimes.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"

// Keep the real provider setup and terminal store, without opening an RTC peer.
vi.mock("./components/terminal/LiveTerminal.vue", async () => {
  const { defineComponent, h } = await import("vue")
  const { usePlatformClient } = await import("./composables/usePlatformClient.ts")
  return { default: defineComponent({
    props: { terminalId: String },
    setup(props) {
      const api = usePlatformClient()
      return () => h("div", { "data-terminal-machine": api.target?.id, "data-terminal-id": props.terminalId })
    },
  }) }
})

const page = () => new DOMWrapper(document.body)
const button = (text: string) => page().findAll("button").find(value => value.text() === text)!
const tabs = () => page().get('nav[aria-label="Agent provider machines"]')
const tab = (name: string) => tabs().findAll("button").find(value => value.text() === name)!
let view: VueWrapper | undefined
let state: Pinia

beforeAll(async () => {
  await Promise.all([
    import("./components/account/MachineSurface.vue"),
    import("./views/SettingsView.vue"),
    import("./components/settings/AgentsSettings.vue"),
  ])
})
beforeEach(() => { state = createPinia() })
afterEach(async () => {
  view?.unmount()
  view = undefined
  disposePinia(state)
  await router.replace("/")
  vi.restoreAllMocks()
})

async function settled(probe: () => void): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 30; attempt++) {
    try { probe(); return } catch (reason) { failure = reason }
    await flushPromises()
  }
  throw failure
}

function fixture() {
  const fake = fakeCentral({ machines: [
    machineFixture("m1", "team-1", "First machine"),
    machineFixture("m2", "team-1", "Second machine"),
    machineFixture("m3", "team-1", "Offline machine", false),
  ] })
  const snapshots = new Map<string, ProviderSnapshot>(["m1", "m2"].map(id => [id, {
    revision: id, templates: [...AGENT_PROVIDER_TEMPLATES],
    providers: [{ id: "shared-provider", template: "codex", name: `Codex ${id}`, env: {} }],
  }]))
  const list = vi.fn(async (machineId: string) => structuredClone(snapshots.get(machineId)!))
  const rpc = vi.fn(async (machineId: string, method: string, params: Record<string, unknown>) => {
    const snapshot = snapshots.get(machineId)!
    if (method === "providerList") return list(machineId)
    if (method === "providerProbe") return { status: "found", auth: "authenticated", installable: true, loginAvailable: true }
    if (method === "providerTest") return { agentName: `Agent ${machineId}` }
    if (method === "providerCreate") {
      const provider = { id: "created-provider", ...(params.provider as AgentProviderInput) }
      snapshot.providers.push(provider)
      return structuredClone(provider)
    }
    if (method === "providerUpdate") {
      const provider = snapshot.providers.find(value => value.id === params.providerId)!
      Object.assign(provider, params.changes as AgentProviderSettings)
      return structuredClone(provider)
    }
    if (method === "providerRemove") {
      snapshot.providers = snapshot.providers.filter(value => value.id !== params.providerId)
      return null
    }
    if (method === "providerInstall" || method === "providerLogin") {
      return { id: "setup-terminal", title: "Provider setup", cwd: "/", status: "running", kind: "shell" }
    }
    if (method === "terminalList") return []
    if (method === "terminalHangup") return null
    throw new Error(`Unexpected RPC: ${machineId} ${method}`)
  })
  Object.assign(fake.central, {
    rpc,
    catalog: vi.fn(async (machineId: string) => ({
      machineId, lastObservedAt: "2026-10-30T00:00:00Z",
      providers: { providers: snapshots.get(machineId)?.providers ?? [] },
      snapshot: { teamId: "team-1", machineId, machineName: fake.state.machines.find(machine => machine.id === machineId)!.name, workspaces: [], sessions: [] },
    })),
    sessions: vi.fn(async () => []),
  })
  const createRuntimes = vi.spyOn(machineRuntimes, "createMachineRuntimes")
  async function render() {
    await router.push("/settings/agents")
    view = mount(AccountShell, {
      props: { host: { ...getClient(), platform: "web", central: fake.central } },
      global: { plugins: [state, router, i18n] }, attachTo: document.body,
    })
    await settled(() => expect(tabs().findAll("button")).toHaveLength(3))
  }
  return { ...fake, snapshots, list, rpc, createRuntimes, render }
}

test("Agents tabs switch the owning runtime for provider operations and setup terminals", async () => {
  const f = fixture()
  await f.render()
  await settled(() => expect(page().get('[data-provider-id="shared-provider"]').text()).toContain("Codex m1"))
  const runtimes = f.createRuntimes.mock.results[0]!.value!
  const first = runtimes.opened.get("m1")!
  useAgentSessionsStore(first.state).drafts["30"] = "Keep the first machine's draft"

  await tab("Second machine").trigger("click")
  await settled(() => expect(page().get('[data-provider-id="shared-provider"]').text()).toContain("Codex m2"))
  expect(router.currentRoute.value.path).toBe("/settings/agents")
  expect(tab("Second machine").attributes("aria-current")).toBe("page")
  expect(tab("First machine").attributes("aria-current")).toBeUndefined()
  expect(runtimes.opened.get("m1")).toBe(first)
  expect(useAgentSessionsStore(first.state).drafts["30"]).toBe("Keep the first machine's draft")

  f.rpc.mockClear()
  await page().get('[data-provider-id="shared-provider"] [data-provider-open]').trigger("click")
  await settled(() => expect(page().find('[data-provider-status="found"]').exists()).toBe(true))
  expect(f.rpc).toHaveBeenCalledWith("m2", "providerProbe", expect.anything())
  await page().get('[data-provider-test]').trigger("click")
  await settled(() => expect(page().get('[data-provider-test-result]').text()).toContain("Agent m2"))
  expect(f.rpc).toHaveBeenCalledWith("m2", "providerTest", expect.anything())

  await page().get('[data-provider-install]').trigger("click")
  await settled(() => expect(page().get('[data-terminal-id="setup-terminal"]').attributes("data-terminal-machine")).toBe("m2"))
  expect(f.rpc).toHaveBeenCalledWith("m2", "providerInstall", expect.anything())
  await page().get('[data-provider-stop]').trigger("click")
  await flushPromises()
  expect(f.rpc).toHaveBeenCalledWith("m2", "terminalHangup", { terminalId: "setup-terminal" })

  await page().get('[name="provider-name"]').setValue("Renamed second provider")
  await page().get("form").trigger("submit")
  await settled(() => expect(page().find("[role=dialog]").exists()).toBe(false))
  expect(f.rpc).toHaveBeenCalledWith("m2", "providerUpdate", { providerId: "shared-provider", changes: expect.objectContaining({ name: "Renamed second provider" }) })
  expect(f.snapshots.get("m1")!.providers[0]!.name).toBe("Codex m1")

  await button("Add provider").trigger("click")
  await page().get('[data-provider-template-choice="acp"]').trigger("click")
  await flushPromises()
  await page().get('[name="provider-name"]').setValue("Second custom agent")
  await page().get("form").trigger("submit")
  await settled(() => expect(page().find("[role=dialog]").exists()).toBe(false))
  expect(f.rpc).toHaveBeenCalledWith("m2", "providerCreate", { provider: expect.objectContaining({ name: "Second custom agent" }) })
  await page().get('[aria-label="Actions for Renamed second provider"]').trigger("click")
  await settled(() => expect(page().findAll('[role="menuitem"]')).toHaveLength(2))
  await page().findAll('[role="menuitem"]').find(item => item.text() === i18n.global.t("providers.remove"))!.trigger("click")
  await page().get('[role=dialog] .ui-button-danger').trigger("click")
  await settled(() => expect(page().find('[data-provider-id="shared-provider"]').exists()).toBe(false))
  expect(f.rpc).toHaveBeenCalledWith("m2", "providerRemove", { providerId: "shared-provider" })
  expect(f.rpc.mock.calls.filter(([, method]) => method.startsWith("provider") || method === "terminalHangup").every(([id]) => id === "m2")).toBe(true)

  await tab("First machine").trigger("click")
  await settled(() => expect(page().get('[data-provider-id="shared-provider"]').text()).toContain("Codex m1"))
  expect(runtimes.opened.get("m1")).toBe(first)
  expect(useAgentSessionsStore(first.state).drafts["30"]).toBe("Keep the first machine's draft")
})

test("a late provider read stays on its machine and offline tabs do not read providers", async () => {
  const f = fixture()
  let finishFirst!: (snapshot: ProviderSnapshot) => void
  f.list.mockImplementation(machineId => machineId === "m1"
    ? new Promise(resolve => { finishFirst = resolve })
    : Promise.resolve(structuredClone(f.snapshots.get(machineId)!)))
  await f.render()
  await settled(() => expect(f.list).toHaveBeenCalledWith("m1"))
  await tab("Second machine").trigger("click")
  await settled(() => expect(page().get('[data-provider-id="shared-provider"]').text()).toContain("Codex m2"))
  finishFirst(structuredClone(f.snapshots.get("m1")!))
  await flushPromises()
  expect(page().get('[data-provider-id="shared-provider"]').text()).toContain("Codex m2")
  expect(router.currentRoute.value.path).toBe("/settings/agents")

  f.rpc.mockClear()
  await tabs().findAll("button").find(value => value.text().includes("Offline machine"))!.trigger("click")
  await settled(() => expect(tabs().get('[aria-current="page"]').text()).toContain("Offline machine"))
  expect(button("Add provider").attributes("disabled")).toBeDefined()
  expect(page().find("[data-provider-id]").exists()).toBe(false)
  expect(f.rpc.mock.calls.filter(([, method]) => method.startsWith("provider"))).toEqual([])
  expect(router.currentRoute.value.path).toBe("/settings/agents")
})
