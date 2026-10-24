import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { AgentConfiguration } from "../../../../shared/agent-configuration.ts"
import { i18n } from "../../i18n/index.ts"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"
import SessionComposer from "./SessionComposer.vue"

const storageKey = "deskfleet.agent-configuration"
const wrappers: VueWrapper[] = []

function configuration(model = "sequoia", effort = "medium"): AgentConfiguration {
  return {
    provider: { id: "codex", name: "Codex" },
    models: {
      id: "model",
      currentValue: model,
      options: [{ id: "sequoia", name: "Sequoia" }, { id: "orbit", name: "Orbit" }],
    },
    reasoningEfforts: {
      id: "reasoning_effort",
      currentValue: effort,
      options: [{ id: "medium", name: "Medium" }, { id: "high", name: "High" }],
    },
  }
}

function deferredConfiguration() {
  let resolve!: (value: AgentConfiguration) => void
  const promise = new Promise<AgentConfiguration>(done => { resolve = done })
  return { promise, resolve }
}

function render(worktreeId = "11") {
  const view = mount(AgentConfigurationSelector, {
    attachTo: document.body,
    props: { worktreeId },
    global: { plugins: [i18n] },
  })
  wrappers.push(view)
  return view
}

const trigger = (view: VueWrapper) => view.get("button.ui-chip")
const modelSelect = (view: VueWrapper) => view.findAll("select")[1]!
const effortSelect = (view: VueWrapper) => view.findAll("select")[2]!

beforeEach(() => {
  window.localStorage.clear()
  vi.spyOn(window.deskfleet.agents, "configuration").mockResolvedValue(configuration())
})

afterEach(() => {
  for (const view of wrappers.splice(0)) view.unmount()
  vi.restoreAllMocks()
  window.localStorage.clear()
  i18n.global.locale.value = "en-US"
})

test("discovers agent options only on expansion and displays three labeled selects", async () => {
  const loaded = deferredConfiguration()
  const api = vi.mocked(window.deskfleet.agents.configuration).mockReturnValueOnce(loaded.promise)
  const view = render()
  expect(api).not.toHaveBeenCalled()
  expect(view.get('[role="group"]').isVisible()).toBe(false)

  await trigger(view).trigger("click")
  expect(api).toHaveBeenCalledExactlyOnceWith({ provider: "codex", worktreeId: "11" })
  expect(view.findAll("select")).toHaveLength(3)
  expect(view.findAll("label").map(label => label.element.firstChild?.textContent?.trim())).toEqual(["Agent", "Model", "Reasoning effort"])
  expect(document.activeElement).toBe(view.get("select").element)
  expect(modelSelect(view).attributes("disabled")).toBeDefined()
  expect(effortSelect(view).attributes("disabled")).toBeDefined()
  expect(view.get('[role="status"]').text()).toBe("Reading configuration from the agent…")

  loaded.resolve(configuration())
  await flushPromises()
  expect(modelSelect(view).findAll("option").map(option => [option.attributes("value"), option.text()])).toEqual([["sequoia", "Sequoia"], ["orbit", "Orbit"]])
  expect(modelSelect(view).element.value).toBe("sequoia")
  expect(effortSelect(view).element.value).toBe("medium")
  expect(modelSelect(view).attributes("disabled")).toBeUndefined()
  expect(view.find('[role="status"]').exists()).toBe(false)
})

test("lets the agent resolve a new model's supported effort before changing that effort", async () => {
  const view = render()
  await trigger(view).trigger("click")
  await flushPromises()
  const next = {
    ...configuration("orbit"),
    reasoningEfforts: {
      id: "reasoning_effort",
      currentValue: "minimal",
      options: [{ id: "minimal", name: "Minimal" }, { id: "careful", name: "Agent careful" }],
    },
  }
  const api = vi.mocked(window.deskfleet.agents.configuration).mockResolvedValueOnce(next)
  await modelSelect(view).setValue("orbit")
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", model: "orbit", worktreeId: "11" })
  expect(effortSelect(view).element.value).toBe("minimal")
  expect(effortSelect(view).findAll("option").map(option => option.text())).toEqual(["Minimal", "Agent careful"])

  api.mockResolvedValueOnce({ ...next, reasoningEfforts: { ...next.reasoningEfforts, currentValue: "careful" } })
  await effortSelect(view).setValue("careful")
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", model: "orbit", reasoningEffort: "careful", worktreeId: "11" })
  expect(effortSelect(view).element.value).toBe("careful")
})

test("keeps confirmed model and effort after rejected changes and accepts a later retry", async () => {
  const view = render()
  await trigger(view).trigger("click")
  await flushPromises()
  const saved = window.localStorage.getItem(storageKey)
  const api = vi.mocked(window.deskfleet.agents.configuration)

  for (const [select, value, confirmed, message] of [
    [modelSelect(view), "orbit", "sequoia", "Model change rejected"],
    [effortSelect(view), "high", "medium", "Effort change rejected"],
  ] as const) {
    api.mockRejectedValueOnce(new Error(message))
    select.element.value = value
    select.element.dispatchEvent(new Event("change", { bubbles: true }))
    // Check before Vue renders: production Vapor does not rerun an unchanged value binding.
    expect(select.element.value).toBe(confirmed)
    await flushPromises()
    expect(modelSelect(view).element.value).toBe("sequoia")
    expect(effortSelect(view).element.value).toBe("medium")
    expect(view.get('[role="alert"]').text()).toBe(message)
    expect(window.localStorage.getItem(storageKey)).toBe(saved)
  }

  api.mockResolvedValueOnce(configuration("orbit"))
  await modelSelect(view).setValue("orbit")
  await flushPromises()
  expect(modelSelect(view).element.value).toBe("orbit")
  expect(view.find('[role="alert"]').exists()).toBe(false)

  api.mockResolvedValueOnce(configuration("orbit", "high"))
  await effortSelect(view).setValue("high")
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", model: "orbit", reasoningEffort: "high", worktreeId: "11" })
  expect(effortSelect(view).element.value).toBe("high")
  expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual({ provider: "codex", model: "orbit", reasoningEffort: "high" })
})

test("collapse and Escape keep the composer draft and selection and restore trigger focus", async () => {
  const view = mount(SessionComposer, {
    attachTo: document.body,
    props: { location: null },
    global: { plugins: [i18n] },
  })
  wrappers.push(view)
  await view.get("textarea").setValue("Keep this unfinished task")
  await trigger(view).trigger("click")
  await flushPromises()
  vi.mocked(window.deskfleet.agents.configuration).mockResolvedValueOnce(configuration("sequoia", "high"))
  await effortSelect(view).setValue("high")
  await flushPromises()
  await view.get('button[aria-label="Collapse agent configuration"]').trigger("click")
  expect(trigger(view).text()).toBe("Codex · Sequoia · High")
  expect(document.activeElement).toBe(trigger(view).element)

  await trigger(view).trigger("click")
  await effortSelect(view).trigger("keydown", { key: "Escape" })
  expect(view.get('[role="group"]').isVisible()).toBe(false)
  expect(document.activeElement).toBe(trigger(view).element)
  expect(view.get("textarea").element.value).toBe("Keep this unfinished task")
  expect(effortSelect(view).element.value).toBe("high")
  expect(window.deskfleet.agents.configuration).toHaveBeenCalledTimes(2)
})

test("remounting uses the saved selection when requesting fresh agent options", async () => {
  const api = vi.mocked(window.deskfleet.agents.configuration).mockResolvedValue(configuration("orbit", "high"))
  const first = render()
  await trigger(first).trigger("click")
  await flushPromises()
  first.unmount()
  wrappers.splice(wrappers.indexOf(first), 1)
  expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toEqual({ provider: "codex", model: "orbit", reasoningEffort: "high" })

  const second = render()
  expect(trigger(second).text()).toBe("Codex · orbit · High")
  expect(api).toHaveBeenCalledTimes(1)
  await trigger(second).trigger("click")
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", model: "orbit", reasoningEffort: "high", worktreeId: "11" })
  expect(modelSelect(second).element.value).toBe("orbit")
  expect(effortSelect(second).element.value).toBe("high")
})

test("reloads after a discovery error and represents missing agent controls as unavailable", async () => {
  const api = vi.mocked(window.deskfleet.agents.configuration).mockRejectedValueOnce(new Error("Codex is not authenticated"))
  const view = render()
  await trigger(view).trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Codex is not authenticated")
  expect(modelSelect(view).attributes("disabled")).toBeDefined()

  api.mockResolvedValueOnce({ provider: { id: "codex", name: "Codex" }, models: null, reasoningEfforts: null })
  await view.get("button.catalog-button").trigger("click")
  await flushPromises()
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", worktreeId: "11" })
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(modelSelect(view).text()).toBe("Unavailable")
  expect(effortSelect(view).text()).toBe("Unavailable")
  expect(modelSelect(view).attributes("disabled")).toBeDefined()
  expect(effortSelect(view).attributes("disabled")).toBeDefined()
})

test("ignores previous worktree responses and pending responses after unmount", async () => {
  const stale = deferredConfiguration()
  const current = deferredConfiguration()
  const api = vi.mocked(window.deskfleet.agents.configuration)
    .mockReturnValueOnce(stale.promise)
    .mockReturnValueOnce(current.promise)
  const view = render()
  await trigger(view).trigger("click")
  await view.setProps({ worktreeId: "22" })
  expect(api).toHaveBeenLastCalledWith({ provider: "codex", worktreeId: "22" })
  current.resolve(configuration("orbit", "high"))
  await flushPromises()
  stale.resolve(configuration())
  await flushPromises()
  expect(modelSelect(view).element.value).toBe("orbit")
  expect(effortSelect(view).element.value).toBe("high")

  const afterUnmount = deferredConfiguration()
  api.mockReturnValueOnce(afterUnmount.promise)
  await view.setProps({ worktreeId: "33" })
  const saved = window.localStorage.getItem(storageKey)
  view.unmount()
  wrappers.splice(wrappers.indexOf(view), 1)
  afterUnmount.resolve(configuration())
  await flushPromises()
  expect(window.localStorage.getItem(storageKey)).toBe(saved)
})

test("localizes the control labels and known efforts while retaining agent model names", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  vi.mocked(window.deskfleet.agents.configuration).mockResolvedValue(configuration("orbit", "high"))
  const view = render()
  await trigger(view).trigger("click")
  await flushPromises()
  expect(view.get('[role="group"]').attributes("aria-label")).toBe("Agent 配置")
  expect(view.findAll("label").map(label => label.element.firstChild?.textContent?.trim())).toEqual(["Agent", "模型", "推理强度"])
  expect(effortSelect(view).findAll("option").map(option => option.text())).toEqual(["中", "高"])
  await view.get('button[aria-label="收起 Agent 配置"]').trigger("click")
  expect(trigger(view).text()).toBe("Codex · Orbit · 高")
})
