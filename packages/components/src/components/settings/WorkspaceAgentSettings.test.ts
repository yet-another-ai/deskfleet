import { getClient } from "@deskfleet/client/platform"
import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY } from "../../composables/useWorkspaceAgentDisplayName.ts"
import { i18n } from "../../i18n/index.ts"
import { useWorkspaceAgentMode } from "../../services/workspace-agent-navigation.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiSelect from "../common/UiSelect.vue"
import WorkspaceAgentSettings from "./WorkspaceAgentSettings.vue"

const originalLocale = i18n.global.locale.value

afterEach(() => {
  useWorkspaceAgentMode().value = false
  localStorage.removeItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)
  i18n.global.locale.value = originalLocale
})

test("enabling the mode leaves history untouched until a directory and a project have been confirmed", async () => {
  const paths = ["/work/example"]
  const sessionIds = ["old-1", "old-2"]
  const history = vi.fn<NonNullable<SuperAgentApi["history"]>>()
    .mockResolvedValueOnce({ links: {}, groups: [{ paths, sessionIds, projects: [{ id: "one", name: "Example" }, { id: "two", name: "Example" }] }] })
    .mockResolvedValueOnce({ links: { "old-1": "two", "old-2": "two" }, groups: [] })
  const api = { ...getClient(), superAgent: { history, snapshot: vi.fn(), correct: vi.fn(), send: vi.fn(), settings: vi.fn() } }
  const pinia = createPinia()
  const page = mount(WorkspaceAgentSettings, { global: { plugins: [pinia, i18n], provide: { [platformClientKey as symbol]: api } } })
  try {
    expect(page.get('[role="switch"]').attributes("aria-checked")).toBe("false")
    await page.get('[role="switch"]').trigger("click")
    expect(history).not.toHaveBeenCalled()
    await page.get("button:not([role=switch])").trigger("click")
    await flushPromises()
    expect(history.mock.calls).toEqual([[{ view: "groups", assign: undefined }]])
    const picker = page.getComponent(UiSelect)
    expect(picker.props("modelValue")).toBe("")
    expect(picker.props("options").map(o => o.label)).toEqual(["Example (one)", "Example (two)"])
    const apply = page.findAll("button").at(-1)!
    expect(apply.attributes("disabled")).toBeDefined()
    picker.vm.$emit("update:modelValue", "two")
    await flushPromises()
    const store = useFleetStore(pinia)
    const save = vi.spyOn(store, "setHistoryLinks")
    await apply.trigger("click")
    await flushPromises()
    expect(history).toHaveBeenLastCalledWith({ view: "groups", assign: { workspaceId: "two", sessionIds } })
    expect(save).toHaveBeenCalledWith({ "old-1": "two", "old-2": "two" })
    expect(page.findComponent(UiSelect).exists()).toBe(false)
    await page.get('[role="switch"]').trigger("click")
    expect(history).toHaveBeenCalledTimes(2)
  } finally { page.unmount(); disposePinia(pinia) }
})

test("renames Super Agent display name, persists across reopen, keeps feature label intact, and resets on blank input", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const api = { ...getClient(), superAgent: { snapshot: vi.fn(), correct: vi.fn(), send: vi.fn(), settings: vi.fn() } }
  const mountSettings = () => {
    const pinia = createPinia()
    const page = mount(WorkspaceAgentSettings, {
      global: { plugins: [pinia, i18n], provide: { [platformClientKey as symbol]: api } },
    })
    return { pinia, page }
  }

  const first = mountSettings()
  try {
    // Hidden while Super Agent mode is disabled.
    expect(first.page.find("[data-super-agent-display-name]").exists()).toBe(false)

    // Enable Super Agent -> display name input appears alongside unchanged feature toggle label.
    await first.page.get('[role="switch"]').trigger("click")
    expect(first.page.get("#workspace-agent-mode").text()).toBe("启用 Super Agent")
    expect(first.page.get("#workspace-agent-display-name").text()).toBe("显示名称")
    const input = first.page.get<HTMLInputElement>("[data-super-agent-display-name]")
    expect(input.attributes("placeholder")).toBe("Super Agent")
    expect(input.element.value).toBe("")
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBeNull()

    // IME composition waits until compositionend before persisting.
    await input.trigger("compositionstart")
    input.element.value = "xiao'zhi"
    await input.trigger("input")
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBeNull()
    input.element.value = "  小智总控  "
    await input.trigger("compositionend")
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBe("小智总控")

    // Pressing Enter trims the visible input draft cleanly.
    await input.trigger("keydown", { key: "Enter" })
    expect(input.element.value).toBe("小智总控")
    expect(first.page.get("#workspace-agent-mode").text()).toBe("启用 Super Agent")
  } finally {
    first.page.unmount()
    disposePinia(first.pinia)
  }

  // Reopen settings: saved name is still displayed; disabling & re-enabling mode preserves it.
  const reopened = mountSettings()
  try {
    const input = reopened.page.get<HTMLInputElement>("[data-super-agent-display-name]")
    expect(input.element.value).toBe("小智总控")

    await reopened.page.get('[role="switch"]').trigger("click")
    expect(reopened.page.find("[data-super-agent-display-name]").exists()).toBe(false)
    await reopened.page.get('[role="switch"]').trigger("click")
    const afterToggle = reopened.page.get<HTMLInputElement>("[data-super-agent-display-name]")
    expect(afterToggle.element.value).toBe("小智总控")

    // Whitespace-only input clears storage and tidies input back to empty (placeholder "Super Agent").
    await afterToggle.setValue("   \t  ")
    await afterToggle.trigger("blur")
    expect(localStorage.getItem(WORKSPACE_AGENT_DISPLAY_NAME_STORAGE_KEY)).toBeNull()
    expect(afterToggle.element.value).toBe("")
  } finally {
    reopened.page.unmount()
    disposePinia(reopened.pinia)
  }
})
