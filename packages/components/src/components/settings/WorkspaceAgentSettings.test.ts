import { getClient } from "@deskfleet/client/platform"
import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { platformClientKey } from "../../composables/usePlatformClient.ts"
import { i18n } from "../../i18n/index.ts"
import { useWorkspaceAgentMode } from "../../services/workspace-agent-navigation.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import UiSelect from "../common/UiSelect.vue"
import WorkspaceAgentSettings from "./WorkspaceAgentSettings.vue"

afterEach(() => { useWorkspaceAgentMode().value = false })

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
