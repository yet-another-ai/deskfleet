import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentConfiguration } from "../../../../client/src/agent-configuration.ts"
import { i18n } from "../../i18n/index.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import { agentSnapshot } from "../../test/agent.ts"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"
import SessionComposer from "./SessionComposer.vue"

const storageKey = "deskfleet.agent-configuration"
const wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia>
let agents: ReturnType<typeof useAgentSessionsStore>
function configuration(model = "sequoia", effort = "medium"): AgentConfiguration {
  return {
    provider: { id: "codex", name: "Codex" },
    models: { id: "model", currentValue: model, options: [{ id: "sequoia", name: "Sequoia" }, { id: "orbit", name: "Orbit" }] },
    reasoningEfforts: { id: "reasoning_effort", currentValue: effort, options: [{ id: "medium", name: "Medium" }, { id: "high", name: "High" }] },
    modes: null,
  }
}
function nativeConfiguration(mode = "acceptEdits", model = "sequoia", effort = "medium"): AgentConfiguration {
  return {
    ...configuration(model, effort),
    modes: { id: "mode", currentValue: mode, options: [
      { id: "acceptEdits", name: "Accept edits", description: "Automatically approve file edits." },
      { id: "auto", name: "Auto", description: "Review tool permissions automatically." },
      { id: "plan", name: "Plan", description: "Plan before making changes." },
    ] },
  }
}
function deferredConfiguration() {
  let resolve!: (value: AgentConfiguration) => void
  const promise = new Promise<AgentConfiguration>(done => { resolve = done })
  return { promise, resolve }
}
function render(workspaceId = "11") {
  const view = mount(AgentConfigurationSelector, { attachTo: document.body, props: { workspaceId }, global: { plugins: [i18n, pinia] } })
  wrappers.push(view)
  return view
}
const trigger = (view: VueWrapper) => view.get("[data-agent-configuration-trigger]")
const row = (view: VueWrapper, control: string) => view.get(`[data-agent-control="${control}"]`)
const options = (view: VueWrapper) => view.findAll('[role="menuitemradio"]')
async function choose(view: VueWrapper, control: string, value: string): Promise<void> {
  await row(view, control).trigger("click")
  await view.get(`[role="menuitemradio"][data-value="${value}"]`).trigger("click")
  await flushPromises()
}
beforeEach(() => {
  window.localStorage.clear()
  pinia = createPinia(); setActivePinia(pinia)
  agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  providers.providers = [{ id: "codex", name: "Codex", template: "codex" }]
  providers.selectedId = "codex"
  providers.ready = providers.loaded = true
  agents.sessions["30"] = agentSnapshot().session
  vi.spyOn(agents, "agentConfiguration").mockResolvedValue(configuration())
})
afterEach(() => {
  for (const view of wrappers.splice(0)) view.unmount()
  disposePinia(pinia); vi.restoreAllMocks(); window.localStorage.clear()
  i18n.global.locale.value = "en-US"
})

test("opens a compact configuration menu and dynamically populates checked submenus", async () => {
  const loaded = deferredConfiguration()
  const api = vi.mocked(agents.agentConfiguration).mockReturnValueOnce(loaded.promise)
  const view = render()
  expect(api).not.toHaveBeenCalled()
  expect(view.find('[role="menu"]').exists()).toBe(false)
  await trigger(view).trigger("click")
  expect(api).toHaveBeenCalledExactlyOnceWith({ provider: "codex", workspaceId: "11" })
  expect(view.findAll("[data-agent-control]")).toHaveLength(4)
  expect(row(view, "agent").text()).toBe("AgentCodex")
  expect(document.activeElement).toBe(row(view, "agent").element)
  expect(row(view, "model").attributes("disabled")).toBeDefined()
  expect(row(view, "reasoning").attributes("disabled")).toBeDefined()
  expect(row(view, "mode").attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Reading configuration from the agent…")
  loaded.resolve(configuration()); await flushPromises()
  expect(row(view, "model").text()).toBe("ModelSequoia")
  expect(row(view, "reasoning").text()).toBe("ReasoningMedium")
  await row(view, "model").trigger("click")
  expect(options(view).map(option => [option.attributes("data-value"), option.text(), option.attributes("aria-checked")])).toEqual([["sequoia", "Sequoia", "true"], ["orbit", "Orbit", "false"]])
  expect(document.activeElement).toBe(options(view)[0]!.element)
  expect(view.find("select").exists()).toBe(false)
})

test("changes a model before offering its supported reasoning choices", async () => {
  const view = render(); await trigger(view).trigger("click"); await flushPromises()
  const next = { ...configuration("orbit"), reasoningEfforts: { id: "reasoning_effort", currentValue: "minimal", options: [{ id: "minimal", name: "Minimal" }, { id: "careful", name: "Agent careful" }] } }
  const api = vi.mocked(agents.agentConfiguration).mockResolvedValueOnce(next)
  await choose(view, "model", "orbit")
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", model: "orbit", workspaceId: "11" })
  expect(row(view, "reasoning").attributes("data-value")).toBe("minimal")
  await row(view, "reasoning").trigger("click")
  expect(options(view).map(option => option.text())).toEqual(["Minimal", "Agent careful"])
  api.mockResolvedValueOnce({ ...next, reasoningEfforts: { ...next.reasoningEfforts, currentValue: "careful" } })
  await choose(view, "reasoning", "careful")
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", model: "orbit", reasoningEffort: "careful", workspaceId: "11" })
})

test("shows native mode names and descriptions and saves only the agent's confirmed choice", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const api = vi.mocked(agents.agentConfiguration).mockResolvedValue(nativeConfiguration())
  const view = render(); await trigger(view).trigger("click"); await flushPromises()
  expect(row(view, "mode").text()).toBe("模式Accept edits")
  await row(view, "mode").trigger("click")
  expect(options(view).map(option => option.attributes("data-value"))).toEqual(["acceptEdits", "auto", "plan"])
  expect(options(view)[1]!.text()).toContain("Review tool permissions automatically.")
  await view.get('[role="menuitemradio"][data-value="auto"]').trigger("click"); await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "11", model: "sequoia", reasoningEffort: "medium", mode: "auto" })
  // An unsupported auto mode can be accepted with a native fallback.
  expect(row(view, "mode").attributes("data-value")).toBe("acceptEdits")
  expect(agents.draftConfiguration.mode).toBe("acceptEdits")
  expect(JSON.parse(window.localStorage.getItem(storageKey)!).mode).toBe("acceptEdits")
  api.mockRejectedValueOnce(new Error("Mode change rejected"))
  await choose(view, "mode", "plan")
  expect(row(view, "mode").attributes("data-value")).toBe("acceptEdits")
  expect(view.get('[role="alert"]').text()).toBe("Mode change rejected")
})

test("draft model changes preserve native mode and reset effort, while mode changes preserve model and effort", async () => {
  const api = vi.mocked(agents.agentConfiguration).mockResolvedValue(nativeConfiguration("auto", "sequoia", "high"))
  const view = render(); await trigger(view).trigger("click"); await flushPromises()
  api.mockResolvedValueOnce(nativeConfiguration("auto", "orbit"))
  await choose(view, "model", "orbit")
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "11", model: "orbit", mode: "auto" })
  expect(agents.draftConfiguration).toEqual({ provider: "codex", model: "orbit", reasoningEffort: "medium", mode: "auto" })
  api.mockResolvedValueOnce(nativeConfiguration("auto", "orbit", "high"))
  await choose(view, "reasoning", "high")
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "11", model: "orbit", reasoningEffort: "high", mode: "auto" })
  api.mockResolvedValueOnce(nativeConfiguration("plan", "orbit", "high"))
  await choose(view, "mode", "plan")
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "11", model: "orbit", reasoningEffort: "high", mode: "plan" })
  expect(trigger(view).text()).toBe("Codex · Orbit · High · Plan")
  view.unmount(); wrappers.splice(wrappers.indexOf(view), 1)
  const restored = render(); await trigger(restored).trigger("click"); await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "11", model: "orbit", reasoningEffort: "high", mode: "plan" })
})

test("reload recovers rejected draft choices using the agent's current defaults", async () => {
  agents.draftConfiguration = { provider: "codex", model: "retired-model", mode: "retired-mode" }
  const api = vi.mocked(agents.agentConfiguration).mockRejectedValueOnce(new Error("Mode is no longer available"))
  const view = render(); await trigger(view).trigger("click"); await flushPromises()
  api.mockResolvedValueOnce(nativeConfiguration())
  await view.findAll("button").find(button => button.text() === "Reload from agent")!.trigger("click"); await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "11" })
  expect(agents.draftConfiguration).toEqual({ provider: "codex", model: "sequoia", reasoningEffort: "medium", mode: "acceptEdits" })
})

test("switches configured providers without reusing another provider's model or accepting its pending response", async () => {
  const providers = useProvidersStore()
  providers.providers.push({ id: "work-agent", name: "Work agent", template: "acp", icon: "claude" })
  agents.draftConfiguration = { provider: "codex", model: "retired-model", reasoningEffort: "high" }
  const previous = deferredConfiguration()
  const workConfiguration = { ...configuration("work-model"), provider: { id: "work-agent", name: "Work agent" } }
  const api = vi.mocked(agents.agentConfiguration).mockResolvedValue(workConfiguration).mockReturnValueOnce(previous.promise)
  const view = render()
  await trigger(view).trigger("click")
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", model: "retired-model", reasoningEffort: "high", workspaceId: "11" })
  await choose(view, "agent", "work-agent")
  expect(api).toHaveBeenLastCalledWith({ provider: "work-agent", workspaceId: "11" })
  expect(providers.selectedId).toBe("work-agent")
  expect(trigger(view).text()).toBe("Work agent · work-model · Medium")
  await vi.waitFor(() => expect(trigger(view).find('[data-provider-icon="claude"]').exists()).toBe(true))
  previous.resolve(configuration("retired-model", "high")); await flushPromises()
  expect(agents.draftConfiguration).toEqual({ provider: "work-agent", model: "work-model", reasoningEffort: "medium" })
  await choose(view, "reasoning", "high")
  expect(api).toHaveBeenLastCalledWith({ provider: "work-agent", model: "work-model", reasoningEffort: "high", workspaceId: "11" })
})

test("keeps confirmed choices after rejected changes and allows retry", async () => {
  const view = render(); await trigger(view).trigger("click"); await flushPromises()
  const saved = window.localStorage.getItem(storageKey)
  const api = vi.mocked(agents.agentConfiguration)
  for (const [control, value, message] of [["model", "orbit", "Model change rejected"], ["reasoning", "high", "Effort change rejected"]]) {
    api.mockRejectedValueOnce(new Error(message))
    await choose(view, control!, value!)
    expect(row(view, "model").attributes("data-value")).toBe("sequoia")
    expect(row(view, "reasoning").attributes("data-value")).toBe("medium")
    expect(view.get('[role="alert"]').text()).toBe(message)
    expect(window.localStorage.getItem(storageKey)).toBe(saved)
  }
  api.mockResolvedValueOnce(configuration("orbit", "high"))
  await choose(view, "model", "orbit")
  expect(row(view, "model").attributes("data-value")).toBe("orbit")
  expect(view.find('[role="alert"]').exists()).toBe(false)
})

test("keyboard navigation, Escape and outside clicks preserve the draft and selection", async () => {
  const view = mount(SessionComposer, {
    attachTo: document.body,
    props: { location: { machine: { id: "1", name: "Machine", local: true, online: true, desktop: false, terminals: [], workspaces: [] }, workspace: { id: "11", name: "Workspace", directories: [], sessions: [], terminals: [] } } },
    global: { plugins: [i18n, pinia] },
  }); wrappers.push(view)
  await view.get("textarea").setValue("Keep this unfinished task")
  await trigger(view).trigger("click"); await flushPromises()
  await row(view, "agent").trigger("keydown", { key: "ArrowDown" })
  expect(document.activeElement).toBe(row(view, "model").element)
  await row(view, "model").trigger("keydown", { key: "ArrowRight" })
  expect(document.activeElement).toBe(options(view)[0]!.element)
  await options(view)[0]!.trigger("keydown", { key: "ArrowDown" })
  expect(document.activeElement).toBe(options(view)[1]!.element)
  await options(view)[1]!.trigger("keydown", { key: "ArrowLeft" })
  expect(document.activeElement).toBe(row(view, "model").element)
  await row(view, "model").trigger("keydown", { key: "Escape" })
  expect(view.find('[data-agent-configuration-menu]').exists()).toBe(false)
  expect(document.activeElement).toBe(trigger(view).element)
  await trigger(view).trigger("click")
  await new Promise(resolve => setTimeout(resolve, 0))
  await view.get("textarea").trigger("pointerdown")
  await view.get("textarea").trigger("click")
  expect(view.find('[data-agent-configuration-menu]').exists()).toBe(false)
  expect(view.get("textarea").element.value).toBe("Keep this unfinished task")
  expect(trigger(view).text()).toBe("Codex · Sequoia · Medium")
  expect(agents.agentConfiguration).toHaveBeenCalledTimes(1)
})

test("remounting uses saved draft choices while requesting fresh options", async () => {
  const api = vi.mocked(agents.agentConfiguration).mockResolvedValue(configuration("orbit", "high"))
  const first = render(); await trigger(first).trigger("click"); await flushPromises()
  first.unmount(); wrappers.splice(wrappers.indexOf(first), 1)
  const second = render()
  expect(trigger(second).text()).toBe("Codex · orbit · High")
  await trigger(second).trigger("click"); await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", model: "orbit", reasoningEffort: "high", workspaceId: "11" })
})

test("reloads after discovery errors and disables controls the agent does not support", async () => {
  const api = vi.mocked(agents.agentConfiguration).mockRejectedValueOnce(new Error("Codex is not authenticated"))
  const view = render(); await trigger(view).trigger("click"); await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Codex is not authenticated")
  api.mockResolvedValueOnce({ provider: { id: "codex", name: "Codex" }, models: null, reasoningEfforts: null, modes: null })
  await view.findAll("button").find(button => button.text() === "Reload from agent")!.trigger("click"); await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", workspaceId: "11" })
  expect(row(view, "model").text()).toBe("ModelUnavailable")
  expect(row(view, "reasoning").attributes("disabled")).toBeDefined()
  expect(row(view, "mode").text()).toBe("ModeUnavailable")
  expect(row(view, "mode").attributes("disabled")).toBeDefined()
})

test("ignores previous workspace responses and responses after unmount", async () => {
  const stale = deferredConfiguration(); const current = deferredConfiguration()
  const api = vi.mocked(agents.agentConfiguration).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise)
  const view = render(); await trigger(view).trigger("click"); await view.setProps({ workspaceId: "22" })
  current.resolve(configuration("orbit", "high")); await flushPromises()
  stale.resolve(configuration()); await flushPromises()
  expect(row(view, "model").attributes("data-value")).toBe("orbit")
  const afterUnmount = deferredConfiguration(); api.mockReturnValueOnce(afterUnmount.promise)
  await view.setProps({ workspaceId: "33" })
  const saved = window.localStorage.getItem(storageKey)
  view.unmount(); wrappers.splice(wrappers.indexOf(view), 1)
  afterUnmount.resolve(configuration()); await flushPromises()
  expect(window.localStorage.getItem(storageKey)).toBe(saved)
})

test("localizes menu labels and efforts while preserving agent model names", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  vi.mocked(agents.agentConfiguration).mockResolvedValue(configuration("orbit", "high"))
  const view = render(); await trigger(view).trigger("click"); await flushPromises()
  expect(row(view, "model").text()).toBe("模型Orbit")
  expect(row(view, "reasoning").text()).toBe("推理强度高")
  await row(view, "reasoning").trigger("click")
  expect(options(view).map(option => option.text())).toEqual(["中", "高"])
})

test("live session settings remain independent from saved draft preferences and reflect remote updates", async () => {
  agents.draftConfiguration = { provider: "codex", model: "orbit", reasoningEffort: "high" }; await flushPromises()
  const saved = window.localStorage.getItem(storageKey)
  const read = vi.spyOn(agents, "sessionConfiguration").mockImplementation(async id => { const result = configuration(); agents.configurations[id] = result; return result })
  const configure = vi.spyOn(agents, "configureSession").mockImplementation(async (id, choices) => { const result = configuration(choices.model ?? "sequoia", choices.reasoningEffort ?? "medium"); agents.configurations[id] = result; return result })
  const view = render(); await view.setProps({ sessionId: "30" })
  expect(trigger(view).text()).toBe("Codex")
  await trigger(view).trigger("click"); await flushPromises()
  expect(read).toHaveBeenCalledExactlyOnceWith("30")
  expect(agents.agentConfiguration).not.toHaveBeenCalled()
  expect(configure).not.toHaveBeenCalled()
  await choose(view, "reasoning", "high")
  expect(configure).toHaveBeenLastCalledWith("30", { reasoningEffort: "high" })
  expect(window.localStorage.getItem(storageKey)).toBe(saved)
  agents.configurations["30"] = configuration("orbit", "high"); await flushPromises()
  expect(row(view, "model").attributes("data-value")).toBe("orbit")
  await view.setProps({ disabled: true })
  expect(row(view, "model").attributes("disabled")).toBeDefined()
  expect(row(view, "reasoning").attributes("disabled")).toBeDefined()
})

test("a live Session retains its known provider name after registry removal and cannot switch providers", async () => {
  useProvidersStore().providers = []
  agents.sessions["30"] = { ...agentSnapshot().session, provider: "work-agent" }
  const current = { ...configuration(), provider: { id: "work-agent", name: "Work agent" } }
  agents.configurations["30"] = current
  vi.spyOn(agents, "sessionConfiguration").mockResolvedValue(current)
  const view = render(); await view.setProps({ sessionId: "30" })
  expect(trigger(view).text()).toBe("Work agent · Sequoia · Medium")
  await trigger(view).trigger("click"); await flushPromises()
  expect(row(view, "agent").attributes("disabled")).toBeDefined()
  expect(row(view, "agent").attributes("data-value")).toBe("work-agent")
  expect(row(view, "model").attributes("disabled")).toBeUndefined()
  expect(agents.agentConfiguration).not.toHaveBeenCalled()
})

test("changes model and mode in the same Session while its Agent stays fixed", async () => {
  const providers = useProvidersStore()
  providers.providers.push({ id: "other-agent", name: "Other agent", template: "acp" })
  agents.draftConfiguration = { provider: "other-agent", mode: "draft-mode" }; await flushPromises()
  const saved = window.localStorage.getItem(storageKey)
  vi.spyOn(agents, "sessionConfiguration").mockImplementation(async id => {
    const result = nativeConfiguration("auto")
    agents.configurations[id] = result
    return result
  })
  const configure = vi.spyOn(agents, "configureSession").mockImplementation(async (id, choices) => {
    const result = nativeConfiguration(choices.mode ?? "acceptEdits", "orbit")
    agents.configurations[id] = result
    return result
  })
  const view = render(); await view.setProps({ sessionId: "30" })
  await trigger(view).trigger("click"); await flushPromises()
  expect(row(view, "agent").attributes("disabled")).toBeDefined()
  await row(view, "agent").trigger("click")
  expect(options(view)).toHaveLength(0)
  expect(row(view, "model").attributes("disabled")).toBeUndefined()
  await choose(view, "model", "orbit")
  expect(configure).toHaveBeenLastCalledWith("30", { model: "orbit" })
  // Do not reapply Auto after the new model returns Accept edits as its fallback.
  expect(row(view, "mode").attributes("data-value")).toBe("acceptEdits")
  expect(trigger(view).text()).toBe("Codex · Orbit · Medium · Accept edits")
  await choose(view, "mode", "plan")
  expect(configure).toHaveBeenLastCalledWith("30", { mode: "plan" })
  expect(agents.sessions["30"]!.provider).toBe("codex")
  expect(window.localStorage.getItem(storageKey)).toBe(saved)
  expect(agents.agentConfiguration).not.toHaveBeenCalled()
  await view.setProps({ disabled: true })
  expect(row(view, "model").attributes("disabled")).toBeDefined()
  expect(row(view, "mode").attributes("disabled")).toBeDefined()
})

test.each([
  { model: "retired-model", effort: "retired-effort", control: "model", replacement: "orbit", summary: "Codex · retired-model · retired-effort", next: configuration("orbit") },
  { model: "sequoia", effort: "retired-effort", control: "reasoning", replacement: "high", summary: "Codex · Sequoia · retired-effort", next: configuration("sequoia", "high") },
])("replaces an unavailable saved $control without changing draft preferences", async ({ model, effort, control, replacement, summary, next }) => {
  agents.draftConfiguration = { provider: "codex", model: "draft-model", reasoningEffort: "low" }; await flushPromises()
  const saved = window.localStorage.getItem(storageKey)
  vi.spyOn(agents, "sessionConfiguration").mockImplementation(async id => {
    const result = configuration(model, effort)
    agents.configurations[id] = result
    return result
  })
  const configure = vi.spyOn(agents, "configureSession").mockImplementation(async id => {
    agents.configurations[id] = next
    return next
  })
  const view = render(); await view.setProps({ sessionId: "30" })
  await trigger(view).trigger("click"); await flushPromises()
  expect(trigger(view).text()).toBe(summary)
  expect(row(view, control).attributes("disabled")).toBeUndefined()
  await row(view, control).trigger("click")
  expect(options(view).some(option => option.attributes("aria-checked") === "true")).toBe(false)
  await view.get(`[role="menuitemradio"][data-value="${replacement}"]`).trigger("click"); await flushPromises()
  expect(configure).toHaveBeenCalledExactlyOnceWith("30", control === "model" ? { model: replacement } : { reasoningEffort: replacement })
  expect(row(view, control).attributes("data-value")).toBe(replacement)
  expect(trigger(view).text()).not.toContain("retired-")
  expect(agents.agentConfiguration).not.toHaveBeenCalled()
  expect(window.localStorage.getItem(storageKey)).toBe(saved)
})

test("refreshes cached choices after a failed resume without duplicating pending reads", async () => {
  agents.draftConfiguration = { provider: "codex", model: "draft-model", reasoningEffort: "low" }; await flushPromises()
  const saved = window.localStorage.getItem(storageKey)
  agents.sessions["30"] = { ...agentSnapshot().session, error: "Configured model is no longer available" }
  agents.configurations["30"] = {
    ...configuration("retired-model"),
    models: { id: "model", currentValue: "retired-model", options: [{ id: "retired-model", name: "Retired model" }] },
  }
  const fresh = deferredConfiguration()
  const read = vi.spyOn(agents, "sessionConfiguration")
    .mockImplementation(async id => agents.configurations[id]!)
    .mockImplementationOnce(async id => {
      const result = await fresh.promise
      agents.configurations[id] = result
      return result
    })
  const configure = vi.spyOn(agents, "configureSession").mockImplementation(async id => {
    const result = configuration("orbit")
    agents.configurations[id] = result
    return result
  })
  const view = render(); await view.setProps({ sessionId: "30" })
  expect(trigger(view).text()).toBe("Codex · Retired model · Medium")
  await trigger(view).trigger("click")
  expect(read).toHaveBeenCalledExactlyOnceWith("30")
  expect(row(view, "model").attributes("disabled")).toBeDefined()
  await trigger(view).trigger("click"); await trigger(view).trigger("click")
  expect(read).toHaveBeenCalledTimes(1)
  fresh.resolve(configuration("retired-model")); await flushPromises()
  expect(trigger(view).text()).toBe("Codex · retired-model · Medium")
  await row(view, "model").trigger("click")
  expect(options(view).map(option => option.attributes("data-value"))).toEqual(["sequoia", "orbit"])
  expect(configure).not.toHaveBeenCalled()
  await view.get('[role="menuitemradio"][data-value="orbit"]').trigger("click"); await flushPromises()
  expect(configure).toHaveBeenCalledExactlyOnceWith("30", { model: "orbit" })
  expect(row(view, "model").attributes("data-value")).toBe("orbit")
  expect(read).toHaveBeenCalledTimes(1)
  await trigger(view).trigger("click"); await trigger(view).trigger("click"); await flushPromises()
  expect(read).toHaveBeenCalledTimes(2)
  expect(agents.agentConfiguration).not.toHaveBeenCalled()
  expect(window.localStorage.getItem(storageKey)).toBe(saved)
})
