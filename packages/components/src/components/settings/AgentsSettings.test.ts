import { createPinia } from "pinia"
import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { reactive } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { AGENT_PROVIDER_TEMPLATES, type AgentProviderConfig, type ProviderSnapshot } from "../../../../../apps/daemon/src/provider-protocol.ts"
import { i18n } from "../../i18n/index.ts"
import type { MachineSummary } from "../../stores/fleet-types.ts"
import AgentsSettings from "./AgentsSettings.vue"

const fleet = reactive<{ machines: MachineSummary[]; targetId: string }>({ machines: [], targetId: "local-daemon" })
vi.mock("../../stores/fleet.ts", () => ({ useFleetStore: () => fleet }))
let wrapper: VueWrapper | undefined
let changed: () => void
let snapshot: ProviderSnapshot
const unsubscribe = vi.fn()
const provider: AgentProviderConfig = { id: "codex", template: "codex", name: "Work Codex", env: { TEAM: "work" } }
const button = (view: VueWrapper, text: string) => view.findAll("button").find(value => value.text() === text)!
function render() {
  wrapper = mount(AgentsSettings, { attachTo: document.body, global: { stubs: { teleport: { inheritAttrs: false, template: "<slot />" } }, plugins: [createPinia(), i18n] } })
  return wrapper
}
beforeEach(() => {
  fleet.machines = [{ id: "local-daemon", name: "my-machine", local: true, online: true, desktop: true, workspaces: [], terminals: [] }]
  snapshot = { revision: "test-settings", templates: [...AGENT_PROVIDER_TEMPLATES], providers: [structuredClone(provider)] }
  vi.spyOn(platformClient.providers, "list").mockImplementation(async () => structuredClone(snapshot))
  vi.spyOn(platformClient.providers, "onChanged").mockImplementation(listener => { changed = listener; return unsubscribe })
  unsubscribe.mockClear()
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); i18n.global.locale.value = "en-US" })

test("lists the owning machine's providers and follows updates", async () => {
  const view = render()
  expect(button(view, "Add provider").attributes("disabled")).toBeDefined()
  await flushPromises()
  expect(view.text()).toContain("my-machine")
  expect(view.get('[data-provider-id="codex"]').text()).toContain("Work Codex")
  // Rows identify the provider; launch details stay in its editor.
  expect(view.get('[data-provider-id="codex"] [data-provider-row-template]').text()).toBe("Codex")
  expect(view.get('[data-provider-id="codex"]').text()).toBe("Work CodexCodex")
  snapshot.providers = []
  changed()
  await flushPromises()
  expect(view.text()).toContain("No providers yet")
  expect(button(view, "Add provider").attributes("disabled")).toBeUndefined()
  view.unmount()
  wrapper = undefined
  expect(unsubscribe).toHaveBeenCalledOnce()
})

test("adds a provider and edits its settings without sending a template change", async () => {
  const create = vi.spyOn(platformClient.providers, "create").mockImplementation(async input => {
    const created = { id: "second", ...input }
    snapshot.providers.push(created)
    return created
  })
  const update = vi.spyOn(platformClient.providers, "update").mockImplementation(async (id, settings) => {
    const updated = { ...snapshot.providers.find(value => value.id === id)!, ...settings }
    snapshot.providers = snapshot.providers.map(value => value.id === id ? updated : value)
    return updated
  })
  const view = render()
  await flushPromises()
  await button(view, "Add provider").trigger("click")
  await view.get('[data-provider-template-choice="acp"]').trigger("click")
  await view.get('[name="provider-name"]').setValue("Other agent")
  await view.get('[name="provider-binary"]').setValue("/tools/my-acp")
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(create).toHaveBeenCalledExactlyOnceWith({ template: "acp", name: "Other agent", binaryPath: "/tools/my-acp", icon: undefined, env: {} })
  expect(view.find("form").exists()).toBe(false)
  await view.get('[data-provider-id="codex"] [data-provider-open]').trigger("click")
  expect(view.find("[data-provider-template-choice]").exists()).toBe(false)
  await view.get('[name="provider-name"]').setValue("Renamed")
  await view.get('form button[aria-expanded]').trigger("click")
  await vi.waitFor(() => expect(view.find('input[type="search"]').exists()).toBe(true))
  await view.get('input[type="search"]').setValue("gemini")
  await view.get('[data-provider-icon-choice="gemini"]').trigger("click")
  await view.get("form").trigger("submit")
  await flushPromises()
  expect(update).toHaveBeenCalledExactlyOnceWith("codex", { name: "Renamed", binaryPath: undefined, icon: "gemini", env: { TEAM: "work" } })
  expect(view.get('[data-provider-id="codex"]').text()).toContain("Renamed")
})

test("keeps unsaved provider edits open when the same machine's resource tree refreshes", async () => {
  const view = render()
  await flushPromises()
  await view.get('[data-provider-id="codex"] [data-provider-open]').trigger("click")
  await view.get('[name="provider-name"]').setValue("Unsaved name")
  const reads = vi.mocked(platformClient.providers.list).mock.calls.length
  fleet.machines = [{ ...fleet.machines[0]!, terminals: [{ id: "new-shell", title: "shell", cwd: "/code" }] }]
  await flushPromises()
  expect((view.get('[name="provider-name"]').element as HTMLInputElement).value).toBe("Unsaved name")
  expect(platformClient.providers.list).toHaveBeenCalledTimes(reads)
  fleet.machines[0]!.online = false
  await flushPromises()
  expect(view.find("form").exists()).toBe(false)
})

test("removes a provider after confirmation and keeps errors available for retry", async () => {
  const remove = vi.spyOn(platformClient.providers, "remove").mockRejectedValueOnce(new Error("Could not save providers")).mockImplementation(async () => { snapshot.providers = [] })
  const view = render()
  await flushPromises()
  await view.get('[aria-label="Actions for Work Codex"]').trigger("click")
  await view.findAll('[role="menuitem"]')[1]!.trigger("click")
  expect(remove).not.toHaveBeenCalled()
  expect(view.get("[role=dialog]").text()).toContain("Remove Work Codex?")
  expect(view.get("[role=dialog]").text()).toContain("Running sessions will continue")
  await view.get('[role=dialog] .ui-button-danger').trigger("click")
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Could not save providers")
  expect(view.find('[data-provider-id="codex"]').exists()).toBe(true)
  await view.get('[role=dialog] .ui-button-danger').trigger("click")
  await flushPromises()
  expect(remove).toHaveBeenCalledTimes(2)
  expect(remove).toHaveBeenLastCalledWith("codex")
  expect(view.text()).toContain("No providers yet")
})

test("shows offline and remote states without reading local providers for another machine", async () => {
  fleet.machines[0]!.online = false
  fleet.machines.push({ ...fleet.machines[0]!, id: "remote", name: "remote-machine", local: false, online: true })
  const view = render()
  await flushPromises()
  expect(platformClient.providers.list).not.toHaveBeenCalled()
  expect(view.get('[role="status"]').text()).toContain("Start the local Agent")
  expect(button(view, "Add provider").attributes("disabled")).toBeDefined()
  await button(view, "remote-machine").trigger("click")
  expect(view.get('[role="status"]').text()).toBe("Provider settings are unavailable for this machine.")
  expect(platformClient.providers.list).not.toHaveBeenCalled()
})

test("retries failed reads without allowing changes before providers load", async () => {
  vi.mocked(platformClient.providers.list).mockRejectedValueOnce(new Error("Daemon disconnected"))
  const view = render()
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Daemon disconnected")
  expect(button(view, "Add provider").attributes("disabled")).toBeDefined()
  await button(view, "Retry").trigger("click")
  await flushPromises()
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.get('[data-provider-id="codex"]').text()).toContain("Work Codex")
})
