import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { defineComponent } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import type { ScheduleInput, ScheduleRun, ScheduledTask } from "@deskfleet/client/schedules"
import { accountSessionKey, createAccountSession } from "../composables/useAccountSession.ts"
import { i18n } from "../i18n/index.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useProvidersStore } from "../stores/providers.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import ScheduledTasksView from "./ScheduledTasksView.vue"

const ConfigurationStub = defineComponent({ name: "AgentConfigurationSelector", props: ["workspaceId", "sessionId", "providerId", "selection", "disabled"], emits: ["update:providerId", "update:selection"], template: '<div data-configuration />' })
const originalTarget = platformClient.target
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  platformClient.target = originalTarget
  localStorage.removeItem("deskfleet.agent-configuration")
  vi.restoreAllMocks()
})
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const input: ScheduleInput = {
  title: "Daily review", prompt: "Review recent changes", workspaceId: "10", enabled: true,
  target: { kind: "new", provider: "codex", context: "worktree", configuration: { model: "review-model", reasoningEffort: "high" } },
  trigger: { kind: "daily", time: "09:00", timeZone: "Asia/Singapore" },
}
const task = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  ...clone(input), id: "schedule-1", createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z",
  nextRunAt: "2026-10-27T01:00:00Z", runs: [], ...overrides,
})

async function setup(initial: ScheduledTask[] = []) {
  platformClient.target = { id: "machine-1", local: false }
  const fake = fakeCentral({ machines: [machineFixture("machine-1", "team-1", "Build machine"), machineFixture("machine-2", "team-1", "Other machine")] })
  let schedules = clone(initial)
  const rpc = vi.fn(async (_machineId: string, method: string, params: unknown): Promise<unknown> => {
    if (method === "scheduleList") return clone(schedules)
    if (method === "scheduleCreate") {
      const created = task({ ...(params as { schedule: ScheduleInput }).schedule, id: "schedule-new" })
      schedules.push(created)
      return clone(created)
    }
    if (method === "scheduleUpdate") {
      const { scheduleId, changes } = params as { scheduleId: string; changes: Partial<ScheduleInput> }
      const updated = { ...schedules.find(value => value.id === scheduleId)!, ...changes }
      if (!updated.enabled) delete updated.nextRunAt
      schedules = schedules.map(value => value.id === scheduleId ? updated : value)
      return clone(updated)
    }
    if (method === "scheduleRun") {
      const run: ScheduleRun = { id: "run-1", state: "running", scheduledFor: "2026-10-26T01:00:00Z", startedAt: "2026-10-26T01:00:00Z", sessionId: "20" }
      schedules = schedules.map(value => value.id === (params as { scheduleId: string }).scheduleId ? { ...value, runs: [run], lastRun: run } : value)
      return clone(run)
    }
    throw new Error(`Unexpected method ${method}`)
  })
  fake.central.rpc = rpc as CentralApi["rpc"]
  const account = createAccountSession(fake.central)
  await flushPromises()
  const pinia = createPinia()
  setActivePinia(pinia)
  const fleet = useFleetStore()
  fleet.machines[0]!.online = true
  fleet.machines[0]!.workspaces = [{ id: "10", name: "Deskfleet", directories: [{ path: "/code/deskfleet" }], sessions: [], terminals: [] }]
  fleet.targetWorkspaceId = "10"
  const providers = useProvidersStore()
  providers.ready = true
  providers.loaded = true
  providers.providers = [{ id: "codex", name: "Codex", template: "codex" }]
  providers.selectedId = "codex"
  const agents = useAgentSessionsStore()
  agents.draftConfiguration = { provider: "codex", model: "draft-model", reasoningEffort: "medium" }
  agents.sessions["20"] = { id: "20", workspaceId: "10", provider: "codex", title: "Review session", context: "directory", lifecycle: "ready", archiveState: "active", lastEventSeq: "0", createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z" }
  agents.sessions["21"] = { ...agents.sessions["20"], id: "21", title: "Archived session", archiveState: "archived" }
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/schedules", name: "schedules", component: ScheduledTasksView },
    { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
  ] })
  await router.push("/schedules")
  const wrapper = mount(ScheduledTasksView, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: account }, stubs: { AgentConfigurationSelector: ConfigurationStub, PaneHeader: { template: "<header><slot /></header>" } } },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia); account.dispose() })
  await flushPromises()
  return { wrapper, rpc, account, fleet, agents, providers }
}

test("creates a manual task on the selected machine with the chosen workspace, context, and agent configuration", async () => {
  const { wrapper, rpc } = await setup()
  await wrapper.get('[name="schedule-title"]').setValue("  Review on demand  ")
  await wrapper.get('[name="schedule-prompt"]').setValue("Review the changes")
  await wrapper.get('[name="schedule-repeat"]').setValue("manual")
  await wrapper.get('[name="schedule-context"]').setValue("directory")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleCreate", { schedule: {
    title: "Review on demand", prompt: "Review the changes", workspaceId: "10", enabled: true,
    target: { kind: "new", provider: "codex", context: "directory", configuration: { model: "draft-model", reasoningEffort: "medium" } },
    trigger: { kind: "manual" },
  } })
  expect(wrapper.get('[data-schedule-id="schedule-new"]').attributes("aria-current")).toBe("true")
})

test("opening and editing a scheduled task keeps composer defaults unchanged and saves local agent choices", async () => {
  const { wrapper, rpc, agents } = await setup([task()])
  const defaults = clone(agents.draftConfiguration)
  const persisted = localStorage.getItem("deskfleet.agent-configuration")
  await wrapper.get('[data-schedule-id="schedule-1"]').trigger("click")
  const selector = wrapper.getComponent(ConfigurationStub)
  expect(selector.props("selection")).toEqual({ provider: "codex", model: "review-model", reasoningEffort: "high" })
  expect(agents.draftConfiguration).toEqual(defaults)
  const edited = { provider: "codex", model: "schedule-model", reasoningEffort: "high", mode: "plan" }
  selector.vm.$emit("update:selection", edited)
  await flushPromises()
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", {
    scheduleId: "schedule-1", changes: { ...input, target: { kind: "new", provider: "codex", context: "worktree", configuration: { model: "schedule-model", reasoningEffort: "high", mode: "plan" } } },
  })
  expect(agents.draftConfiguration).toEqual(defaults)
  expect(localStorage.getItem("deskfleet.agent-configuration")).toBe(persisted)
})

test("editing an existing-session task keeps workspace ownership and never configures the live agent", async () => {
  const { wrapper, rpc } = await setup([task({ target: { kind: "existing", sessionId: "20" } })])
  await wrapper.get('[data-schedule-id="schedule-1"]').trigger("click")
  expect(wrapper.find("[data-configuration]").exists()).toBe(false)
  expect(wrapper.get('[name="schedule-workspace"]').attributes("disabled")).toBeDefined()
  expect(wrapper.get('[name="schedule-session"]').text()).not.toContain("Archived session")
  await wrapper.get('[name="schedule-prompt"]').setValue("Continue the current review")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", {
    scheduleId: "schedule-1", changes: { ...input, prompt: "Continue the current review", target: { kind: "existing", sessionId: "20" } },
  })
  expect(rpc.mock.calls.every(([, method]) => method.startsWith("schedule"))).toBe(true)
})

test("pausing retains the editor draft while updating the enabled control", async () => {
  const { wrapper, rpc } = await setup([task()])
  await wrapper.get('[data-schedule-id="schedule-1"]').trigger("click")
  await wrapper.get('[name="schedule-title"]').setValue("Unsaved title")
  await wrapper.get("[data-schedule-toggle]").trigger("click")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", { scheduleId: "schedule-1", changes: { enabled: false } })
  expect((wrapper.get('[name="schedule-title"]').element as HTMLInputElement).value).toBe("Unsaved title")
  expect((wrapper.get('[name="schedule-enabled"]').element as HTMLInputElement).checked).toBe(false)
  expect(wrapper.get("[data-schedule-toggle]").text()).toContain("Resume")
})

test("run errors remain visible and a later successful run links to its session", async () => {
  const { wrapper, rpc } = await setup([task()])
  await wrapper.get('[data-schedule-id="schedule-1"]').trigger("click")
  rpc.mockRejectedValueOnce(new Error("The agent provider is unavailable"))
  await wrapper.get("[data-schedule-run]").trigger("click")
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain("The agent provider is unavailable")
  await wrapper.get("[data-schedule-run]").trigger("click")
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.get('a[href="/sessions/20"]').text()).toBe("Open session")
  expect(wrapper.text()).toContain("Queued or running")
})

test("weekly timing rejects an invalid time zone and saves selected weekdays with the corrected zone", async () => {
  const { wrapper, rpc } = await setup([task()])
  await wrapper.get('[data-schedule-id="schedule-1"]').trigger("click")
  await wrapper.get('[name="schedule-repeat"]').setValue("weekly")
  await wrapper.get('[name="schedule-timezone"]').setValue("Invalid/Timezone")
  await wrapper.get("form").trigger("submit")
  expect(wrapper.get('[role="alert"]').text()).toContain("valid time zone")
  expect(rpc.mock.calls.filter(([, method]) => method === "scheduleUpdate")).toHaveLength(0)
  await wrapper.get('[name="schedule-timezone"]').setValue("Europe/London")
  await wrapper.get('[name="schedule-time"]').setValue("14:30")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", expect.objectContaining({ changes: expect.objectContaining({ trigger: { kind: "weekly", time: "14:30", timeZone: "Europe/London", weekdays: [1] } }) }))
})

test.each([
  ["daily", "14:30:00"], ["weekly", "14:30:00"],
  ["daily", "14:30:00.000"], ["weekly", "09:05:07.250"],
  ["daily", "14:30"], ["weekly", "14:30"],
] as const)("saves %s browser time %s at minute precision", async (kind, value) => {
  const { wrapper, rpc } = await setup([task()])
  await wrapper.get('[data-schedule-id="schedule-1"]').trigger("click")
  await wrapper.get('[name="schedule-repeat"]').setValue(kind)
  const control = wrapper.get('[name="schedule-time"]')
  // Preserve the browser payload; happy-dom otherwise strips zero seconds.
  Object.defineProperty(control.element, "value", { configurable: true, writable: true, value })
  await control.trigger("input")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", expect.objectContaining({ changes: expect.objectContaining({
    trigger: { kind, time: value.slice(0, 5), timeZone: "Asia/Singapore", ...(kind === "weekly" ? { weekdays: [1] } : {}) },
  }) }))
})

test("an offline transition disables actions and rejects a late list response", async () => {
  const { wrapper, rpc, account } = await setup([task()])
  await wrapper.get('[data-schedule-id="schedule-1"]').trigger("click")
  let resolve!: (tasks: ScheduledTask[]) => void
  rpc.mockImplementationOnce(async () => new Promise<ScheduledTask[]>(done => { resolve = done }))
  await wrapper.get('button[aria-label="Refresh"]').trigger("click")
  account.machines.value[0]!.online = false
  await flushPromises()
  resolve([task({ id: "stale-task", title: "Stale response" })])
  await flushPromises()
  expect(wrapper.find('[data-schedule-id="stale-task"]').exists()).toBe(false)
  expect(wrapper.get("[data-schedule-run]").attributes("disabled")).toBeDefined()
  expect(wrapper.text()).toContain("This machine is offline")
})

test("machine choice uses the account target switch", async () => {
  const { wrapper, account } = await setup()
  const selectMachine = vi.spyOn(account, "selectMachine")
  await wrapper.get('[name="schedule-machine"]').setValue("machine-2")
  expect(selectMachine).toHaveBeenCalledWith("machine-2")
})

test("a removed saved provider never silently falls back to the machine default", async () => {
  const { wrapper, rpc } = await setup([task({ target: { kind: "new", provider: "removed-provider", context: "worktree" } })])
  await wrapper.get('[data-schedule-id="schedule-1"]').trigger("click")
  expect(wrapper.getComponent(ConfigurationStub).props("providerId")).toBe("removed-provider")
  expect(wrapper.get("[data-schedule-save]").attributes("disabled")).toBeDefined()
  await wrapper.get("form").trigger("submit")
  expect(rpc.mock.calls.filter(([, method]) => method === "scheduleUpdate")).toHaveLength(0)
  wrapper.getComponent(ConfigurationStub).vm.$emit("update:providerId", "codex")
  await flushPromises()
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", expect.objectContaining({ changes: expect.objectContaining({ target: { kind: "new", provider: "codex", context: "worktree" } }) }))
})
