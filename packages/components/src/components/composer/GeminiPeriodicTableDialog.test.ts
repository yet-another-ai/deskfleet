import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentConfiguration } from "@deskfleet/client/agent-configuration"
import { client as platformClient } from "@deskfleet/client/platform"
import { i18n } from "../../i18n/index.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import { agentSnapshot } from "../../test/agent.ts"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"

const wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia>
let agents: ReturnType<typeof useAgentSessionsStore>

function antigravityConfiguration(model = "gemini-4-neon", extraOptions = true): AgentConfiguration {
  return {
    provider: { id: "agy", name: "Antigravity" },
    models: {
      id: "model",
      currentValue: model,
      options: [
        { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", description: "Ultra-fast execution for everyday coding." },
        { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
        { id: "gemini-4-neon", name: "Gemini 4 Neon", description: "Balanced reasoning and multi-file refactoring." },
        { id: "gemini-4-argon", name: "Gemini 4 Argon", description: "A highly capable model built to solve complex problems with depth and precision." },
        ...(extraOptions ? [{ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", description: "Third-party model." }] : []),
      ],
    },
    reasoningEfforts: { id: "effort", currentValue: "high", options: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] },
    modes: null,
  }
}

function render(props: { workspaceId?: string; sessionId?: string } = { workspaceId: "11" }) {
  const view = mount(AgentConfigurationSelector, {
    attachTo: document.body,
    props,
    global: { plugins: [i18n, pinia] },
  })
  wrappers.push(view)
  return view
}

const body = () => new DOMWrapper(document.body)

beforeEach(() => {
  window.localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  vi.spyOn(platformClient.providers, "onChanged").mockReturnValue(() => {})
  agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  providers.providers = [
    { id: "codex", name: "Codex", template: "codex" },
    { id: "agy", name: "Antigravity", template: "antigravity" },
  ]
  providers.selectedId = "agy"
  providers.ready = providers.loaded = true
  providers.revision = "registry-1"
  agents.sessions["30"] = { ...agentSnapshot().session, provider: "agy" }
  vi.spyOn(agents, "agentConfiguration").mockResolvedValue(antigravityConfiguration())
  vi.spyOn(agents, "releaseAgentConfiguration").mockResolvedValue()
})

afterEach(() => {
  for (const view of wrappers.splice(0)) view.unmount()
  disposePinia(pinia)
  vi.restoreAllMocks()
  window.localStorage.clear()
  i18n.global.locale.value = "en-US"
})

test("shows the Gemini 4 periodic table trigger only for Antigravity providers", async () => {
  const providers = useProvidersStore()
  providers.selectedId = "codex"
  const view = render()
  expect(view.find("[data-gemini-periodic-table-trigger]").exists()).toBe(false)

  providers.selectedId = "agy"
  await flushPromises()
  expect(view.find("[data-gemini-periodic-table-trigger]").exists()).toBe(true)
})

test("opens the periodic table, previews model descriptions on hover, and selects a model on click", async () => {
  const api = vi.mocked(agents.agentConfiguration)
  const view = render()

  await view.get("[data-gemini-periodic-table-trigger]").trigger("click")
  await flushPromises()

  expect(api).toHaveBeenCalledExactlyOnceWith({ probeId: expect.any(String), provider: "agy", workspaceId: "11", cache: true })
  const dialog = body().get("[data-gemini-periodic-table-dialog]")
  expect(dialog.text()).toContain("Gemini 4")
  expect(dialog.findAll("[data-periodic-element]").map(el => el.attributes("data-periodic-element"))).toEqual(["H", "C", "Ne", "Ar"])
  expect(dialog.get('[data-periodic-element="Ne"]').attributes("aria-pressed")).toBe("true")
  expect(dialog.get("[data-periodic-model-name]").text()).toBe("Gemini 4 Neon")
  expect(dialog.get("[data-periodic-description]").text()).toBe("Balanced reasoning and multi-file refactoring.")

  // Hovering Argon previews its live description from Antigravity.
  await dialog.get('[data-periodic-element="Ar"]').trigger("pointerenter")
  expect(dialog.get("[data-periodic-model-name]").text()).toBe("Gemini 4 Argon")
  expect(dialog.get("[data-periodic-model-id]").text()).toBe("gemini-4-argon")
  expect(dialog.get("[data-periodic-description]").text()).toContain("solve complex problems with depth and precision")

  // Hovering Carbon (which omitted description) falls back to a helpful explanation.
  await dialog.get('[data-periodic-element="C"]').trigger("pointerenter")
  expect(dialog.get("[data-periodic-model-name]").text()).toBe("Gemini 4 Carbon")
  expect(dialog.get("[data-periodic-description]").text().length).toBeGreaterThan(20)

  // Clicking Argon selects it and updates the element chip on the trigger button.
  api.mockResolvedValueOnce(antigravityConfiguration("gemini-4-argon"))
  await dialog.get('[data-periodic-element="Ar"]').trigger("click")
  await flushPromises()

  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "agy", model: "gemini-4-argon", workspaceId: "11" }))
  expect(view.get("[data-gemini-element-chip]").attributes("data-gemini-element-chip")).toBe("Ar")
})

test("supports multi-variant Gemini 4 elements and live Session model switching", async () => {
  const multiVariant: AgentConfiguration = {
    provider: { id: "agy", name: "Antigravity" },
    models: {
      id: "model",
      currentValue: "gemini-4-neon-high",
      options: [
        { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)", description: "High reasoning budget for complex changes." },
        { id: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)", description: "Low latency for fast iterations." },
        { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", description: "Fast everyday workhorse." },
      ],
    },
    reasoningEfforts: null,
    modes: null,
  }
  vi.spyOn(agents, "sessionConfiguration").mockImplementation(async id => {
    agents.configurations[id] = multiVariant
    return multiVariant
  })
  const configure = vi.spyOn(agents, "configureSession").mockImplementation(async (id, choices) => {
    const updated = {
      ...multiVariant,
      models: { ...multiVariant.models!, currentValue: choices.model ?? multiVariant.models!.currentValue },
    }
    agents.configurations[id] = updated
    return updated
  })

  const view = render({ workspaceId: "11", sessionId: "30" })
  await view.get("[data-gemini-periodic-table-trigger]").trigger("click")
  await flushPromises()

  const dialog = body().get("[data-gemini-periodic-table-dialog]")
  await dialog.get('[data-periodic-element="Ne"]').trigger("click")
  expect(configure).not.toHaveBeenCalled()

  const lowVariant = dialog.get('[data-periodic-variant="gemini-4-neon-low"]')
  await lowVariant.trigger("pointerenter")
  expect(dialog.get("[data-periodic-description]").text()).toBe("Low latency for fast iterations.")

  await lowVariant.trigger("click")
  await flushPromises()
  expect(configure).toHaveBeenCalledExactlyOnceWith("30", { model: "gemini-4-neon-low" })
})

test("localizes the periodic table UI and fallback descriptions in Chinese", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const view = render()
  expect(view.get("[data-gemini-periodic-table-trigger]").attributes("aria-label")).toBe("Gemini 4 元素周期表")

  await view.get("[data-gemini-periodic-table-trigger]").trigger("click")
  await flushPromises()
  const dialog = body().get("[data-gemini-periodic-table-dialog]")
  expect(dialog.text()).toContain("选择模型")
  expect(dialog.text()).toContain("个可用")

  await dialog.get('[data-periodic-element="C"]').trigger("pointerenter")
  expect(dialog.get("[data-periodic-description]").text()).toContain("深度前沿推理旗舰模型")
})

test("supports keyboard arrow navigation between available Gemini 4 elements", async () => {
  const view = render()
  await view.get("[data-gemini-periodic-table-trigger]").trigger("click")
  await flushPromises()

  const dialog = body().get("[data-gemini-periodic-table-dialog]")
  const neon = dialog.get('[data-periodic-element="Ne"]')
  ;(neon.element as HTMLButtonElement).focus()
  await neon.trigger("keydown", { key: "ArrowRight" })
  expect(document.activeElement).toBe(dialog.get('[data-periodic-element="Ar"]').element)
  expect(dialog.get("[data-periodic-model-name]").text()).toBe("Gemini 4 Argon")

  await dialog.get('[data-periodic-element="Ar"]').trigger("keydown", { key: "ArrowRight" })
  expect(document.activeElement).toBe(dialog.get('[data-periodic-element="H"]').element)
  expect(dialog.get("[data-periodic-model-name]").text()).toBe("Gemini 4 Hydrogen")
})

test("refetches configuration on provider revision invalidation while the periodic table is open", async () => {
  const providers = useProvidersStore()
  const api = vi.mocked(agents.agentConfiguration)
  const view = render()

  await view.get("[data-gemini-periodic-table-trigger]").trigger("click")
  await flushPromises()
  expect(api).toHaveBeenCalledTimes(1)

  api.mockResolvedValueOnce(antigravityConfiguration("gemini-4-argon"))
  providers.revision = "registry-2"
  await flushPromises()

  expect(api).toHaveBeenCalledTimes(2)
  const dialog = body().get("[data-gemini-periodic-table-dialog]")
  expect(dialog.get('[data-periodic-element="Ar"]').attributes("aria-pressed")).toBe("true")
  expect(dialog.get("[data-periodic-model-name]").text()).toBe("Gemini 4 Argon")
})

test("moves initial focus to the active element after asynchronous model loading completes", async () => {
  let resolveConfig!: (value: AgentConfiguration) => void
  vi.mocked(agents.agentConfiguration).mockReturnValueOnce(new Promise(resolve => { resolveConfig = resolve }))
  const view = render()

  await view.get("[data-gemini-periodic-table-trigger]").trigger("click")
  await flushPromises()
  const dialog = body().get("[data-gemini-periodic-table-dialog]")
  expect(dialog.findAll("[data-periodic-element]")).toHaveLength(0)

  resolveConfig(antigravityConfiguration("gemini-4-neon"))
  await flushPromises()

  expect(document.activeElement).toBe(dialog.get('[data-periodic-element="Ne"]').element)
})

test("announces loading status while refreshing cached live Session models", async () => {
  agents.configurations["30"] = antigravityConfiguration("gemini-4-neon")
  let resolveRefresh!: (value: AgentConfiguration) => void
  vi.spyOn(agents, "sessionConfiguration").mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve }))

  const view = render({ workspaceId: "11", sessionId: "30" })
  await view.get("[data-gemini-periodic-table-trigger]").trigger("click")
  await flushPromises()

  const dialog = body().get("[data-gemini-periodic-table-dialog]")
  expect(dialog.attributes("aria-busy")).toBe("true")
  expect(dialog.get("[data-periodic-refreshing]").attributes("role")).toBe("status")
  expect(dialog.get("[data-periodic-refreshing]").text()).toContain("Reading configuration from the agent")
  expect(dialog.get('[data-periodic-element="Ne"]').attributes("disabled")).toBeDefined()

  const refreshed = antigravityConfiguration("gemini-4-argon")
  agents.configurations["30"] = refreshed
  resolveRefresh(refreshed)
  await flushPromises()

  expect(dialog.find("[data-periodic-refreshing]").exists()).toBe(false)
  expect(dialog.get('[data-periodic-element="Ar"]').attributes("disabled")).toBeUndefined()
  expect(document.activeElement).toBe(dialog.get('[data-periodic-element="Ar"]').element)
})
