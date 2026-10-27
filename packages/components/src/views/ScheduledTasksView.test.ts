import { client as platformClient } from "@deskfleet/client/platform"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { defineComponent, h } from "vue"
import { createMemoryHistory, createRouter, RouterView } from "vue-router"
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
import { selectOption, setTime } from "../test/controls.ts"
import { DOMWrapper } from "@vue/test-utils"

const ConfigurationStub = defineComponent({ name: "AgentConfigurationSelector", props: ["workspaceId", "sessionId", "providerId", "selection", "disabled"], emits: ["update:providerId", "update:selection"], template: '<div data-configuration />' })
const originalTarget = platformClient.target
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  platformClient.target = originalTarget
  localStorage.removeItem("deskfleet.agent-configuration")
  i18n.global.locale.value = "en-US"
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

async function open(wrapper: Awaited<ReturnType<typeof setup>>["wrapper"], id = "schedule-1") {
  await wrapper.get(`[data-schedule-id="${id}"]`).trigger("click")
  await flushPromises()
}
const choose = (wrapper: Awaited<ReturnType<typeof setup>>["wrapper"], _name: string, value: string) => wrapper.get(`[role="radio"][value="${value}"]`).trigger("click")

async function setup(initial: ScheduledTask[] = []) {
  // Exercise real timezone choices without mounting the entire host Intl catalog.
  const supportedValuesOf = Intl.supportedValuesOf
  vi.spyOn(Intl, "supportedValuesOf").mockImplementation(key => key === "timeZone" ? ["Asia/Singapore", "Europe/London"] : supportedValuesOf(key))
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
  fleet.localDesktopTarget.online = true
  vi.spyOn(platformClient.catalog, "list").mockResolvedValue({
    teamId: "team-1", machineId: "machine-1", machineName: "Build machine",
    workspaces: [{ id: "10", name: "Deskfleet", worktrees: [{ id: "11", workspaceId: "10", directories: [{ path: "/code/deskfleet" }] }] }],
    sessions: [],
  })
  await fleet.refreshLocalCatalog()
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
    { path: "/schedules/:scheduleId?", name: "schedules", component: ScheduledTasksView, props: true },
    { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
  ] })
  await router.push("/schedules")
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], provide: { [accountSessionKey as symbol]: account }, stubs: { AgentConfigurationSelector: ConfigurationStub, PaneHeader: { template: "<header><slot /></header>" } } },
  })
  cleanup.push(() => { wrapper.unmount(); disposePinia(pinia); account.dispose() })
  await flushPromises()
  return { wrapper, rpc, router, account, fleet, agents, providers }
}

test("the list summarizes each task's cadence, destination, next run, and last result", async () => {
  const run: ScheduleRun = { id: "run-1", state: "failed", scheduledFor: "2026-10-26T01:00:00Z", startedAt: "2026-10-26T01:00:00Z", error: "Provider unavailable" }
  const { wrapper } = await setup([
    task({ runs: [run], lastRun: run }),
    task({ id: "schedule-2", title: "Release notes", enabled: false, target: { kind: "existing", sessionId: "20" }, trigger: { kind: "weekly", time: "17:30", timeZone: "Asia/Singapore", weekdays: [1, 3, 5] } }),
    task({ id: "schedule-3", title: "On demand", trigger: { kind: "manual" }, nextRunAt: undefined }),
    task({ id: "schedule-4", title: "Poll", trigger: { kind: "interval", minutes: 120 } }),
  ])
  const rows = wrapper.findAll("li")
  expect(rows[0]!.text()).toContain("Every day at 9:00 AM")
  expect(rows[0]!.text()).toContain("Codex · New worktree")
  expect(rows[0]!.text()).toContain("Failed")
  expect(rows[1]!.text()).toContain("Mon, Wed, Fri at 5:30 PM")
  expect(rows[1]!.text()).toContain("Review session")
  expect(rows[1]!.text()).toContain("Paused")
  expect(rows[1]!.get("[data-schedule-toggle]").attributes("aria-checked")).toBe("false")
  expect(rows[2]!.text()).toContain("On demand")
  expect(rows[2]!.find("[data-schedule-toggle]").exists()).toBe(false)
  expect(rows[3]!.text()).toContain("Every 2 hours")
})

test("creates a manual task on the selected machine with the chosen workspace, destination, and agent configuration", async () => {
  const { wrapper, rpc, router } = await setup()
  await wrapper.get("[data-schedule-new]").trigger("click")
  await flushPromises()
  await wrapper.get('[name="schedule-title"]').setValue("  Review on demand  ")
  await wrapper.get('[name="schedule-prompt"]').setValue("Review the changes")
  await choose(wrapper, "schedule-repeat", "manual")
  await choose(wrapper, "schedule-target", "directory")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleCreate", { schedule: {
    title: "Review on demand", prompt: "Review the changes", workspaceId: "10", enabled: true,
    target: { kind: "new", provider: "codex", context: "directory", configuration: { model: "draft-model", reasoningEffort: "medium" } },
    trigger: { kind: "manual" },
  } })
  expect(router.currentRoute.value.params.scheduleId).toBe("schedule-new")
  expect(wrapper.get("h1").text()).toBe("Review on demand")
})

test("cancelling a new task returns to the list without saving", async () => {
  const { wrapper, rpc, router } = await setup([task()])
  await wrapper.get("[data-schedule-new]").trigger("click")
  await flushPromises()
  await wrapper.findAll("button").find(button => button.text() === "Cancel")!.trigger("click")
  await flushPromises()
  expect(router.currentRoute.value.params.scheduleId).toBeFalsy()
  expect(wrapper.find('[data-schedule-id="schedule-1"]').exists()).toBe(true)
  expect(rpc.mock.calls.filter(([, method]) => method === "scheduleCreate")).toHaveLength(0)
})

test("opening and editing a scheduled task keeps composer defaults unchanged and saves local agent choices", async () => {
  const { wrapper, rpc, agents } = await setup([task()])
  const defaults = clone(agents.draftConfiguration)
  const persisted = localStorage.getItem("deskfleet.agent-configuration")
  await open(wrapper)
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
  await open(wrapper)
  expect(wrapper.find("[data-configuration]").exists()).toBe(false)
  expect(wrapper.get('[role="radio"][value="existing"]').attributes("aria-checked")).toBe("true")
  expect(wrapper.get('[data-control-name="schedule-workspace"]').attributes("disabled")).toBeDefined()
  expect(wrapper.get('[data-control-name="schedule-session"]').text()).not.toContain("Archived session")
  await wrapper.get('[name="schedule-prompt"]').setValue("Continue the current review")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", {
    scheduleId: "schedule-1", changes: { ...input, prompt: "Continue the current review", target: { kind: "existing", sessionId: "20" } },
  })
  expect(rpc.mock.calls.every(([, method]) => method.startsWith("schedule"))).toBe(true)
})

test("pausing retains the editor draft, and a later save keeps the task paused", async () => {
  const { wrapper, rpc } = await setup([task()])
  await open(wrapper)
  await wrapper.get('[name="schedule-title"]').setValue("Unsaved title")
  await wrapper.get("[data-schedule-toggle]").trigger("click")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", { scheduleId: "schedule-1", changes: { enabled: false } })
  expect((wrapper.get('[name="schedule-title"]').element as HTMLInputElement).value).toBe("Unsaved title")
  expect(wrapper.findAll("header").at(-1)!.text()).toContain("Paused")
  expect(wrapper.get("[data-schedule-toggle]").text()).toContain("Resume")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenLastCalledWith("machine-1", "scheduleUpdate", { scheduleId: "schedule-1", changes: expect.objectContaining({ title: "Unsaved title", enabled: false }) })
})

test("run errors remain visible and a later successful run links to its session", async () => {
  const { wrapper, rpc } = await setup([task()])
  await open(wrapper)
  expect(wrapper.text()).toContain("No runs yet")
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

test("runs a task from its list row without opening it", async () => {
  const { wrapper, rpc, router } = await setup([task()])
  await wrapper.get("[data-schedule-run]").trigger("click")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleRun", { scheduleId: "schedule-1" })
  expect(router.currentRoute.value.params.scheduleId).toBeFalsy()
})

test("weekly timing starts on weekdays and saves the chosen days, time, and zone", async () => {
  const { wrapper, rpc } = await setup([task()])
  await open(wrapper)
  await choose(wrapper, "schedule-repeat", "weekly")
  const weekday = (day: number) => wrapper.get(`[role="checkbox"][aria-label="${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}"]`)
  expect([0, 1, 2, 3, 4, 5, 6].filter(day => weekday(day).attributes("aria-checked") === "true")).toEqual([1, 2, 3, 4, 5])
  for (const day of [1, 2, 3, 4, 5]) await weekday(day).trigger("click")
  expect(wrapper.get("[data-schedule-save]").attributes("disabled")).toBeDefined()
  await weekday(5).trigger("click")
  await weekday(1).trigger("click")
  await selectOption(wrapper, '[data-control-name="schedule-timezone"]', "Europe/London")
  await setTime(wrapper, '[data-control-name="schedule-time"]', "14:30")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", expect.objectContaining({ changes: expect.objectContaining({ trigger: { kind: "weekly", time: "14:30", timeZone: "Europe/London", weekdays: [1, 5] } }) }))
})

test("a task in a regional time zone can be changed to UTC", async () => {
  const { wrapper, rpc } = await setup([task()])
  await open(wrapper)
  await selectOption(wrapper, '[data-control-name="schedule-timezone"]', "UTC")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", expect.objectContaining({ changes: expect.objectContaining({ trigger: { kind: "daily", time: "09:00", timeZone: "UTC" } }) }))
})

test("interval timing saves hours as minutes and keeps the typed number when the unit changes", async () => {
  const { wrapper, rpc } = await setup([task()])
  await open(wrapper)
  await choose(wrapper, "schedule-repeat", "interval")
  expect((wrapper.get('[name="schedule-minutes"]').element as HTMLInputElement).value).toBe("1")
  expect(wrapper.get('[data-control-name="schedule-interval-unit"]').text()).toContain("hour")
  await wrapper.get('[name="schedule-minutes"]').setValue("3")
  await wrapper.get('[name="schedule-minutes"]').trigger("blur")
  await selectOption(wrapper, '[data-control-name="schedule-interval-unit"]', "minutes")
  expect((wrapper.get('[name="schedule-minutes"]').element as HTMLInputElement).value).toBe("3")
  await selectOption(wrapper, '[data-control-name="schedule-interval-unit"]', "hours")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", expect.objectContaining({ changes: expect.objectContaining({ trigger: { kind: "interval", minutes: 180 } }) }))
})

test.each(["daily", "weekly"] as const)("saves %s segmented time at minute precision", async kind => {
  const { wrapper, rpc } = await setup([task()])
  await open(wrapper)
  await choose(wrapper, "schedule-repeat", kind)
  await setTime(wrapper, '[data-control-name="schedule-time"]', "14:30")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", expect.objectContaining({ changes: expect.objectContaining({
    trigger: { kind, time: "14:30", timeZone: "Asia/Singapore", ...(kind === "weekly" ? { weekdays: [1, 2, 3, 4, 5] } : {}) },
  }) }))
})

test("Chinese schedule dates and time segments use the supported Intl locale", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const { wrapper, rpc } = await setup([task()])
  await open(wrapper)
  await choose(wrapper, "schedule-repeat", "weekly")
  await setTime(wrapper, '[data-control-name="schedule-time"]', "09:05")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleUpdate", expect.objectContaining({ changes: expect.objectContaining({
    trigger: { kind: "weekly", time: "09:05", timeZone: "Asia/Singapore", weekdays: [1, 2, 3, 4, 5] },
  }) }))
})

test("deleting a task from its page returns to the list", async () => {
  const { wrapper, rpc, router } = await setup([task(), task({ id: "schedule-2", title: "Other task" })])
  rpc.mockImplementation(async (_machineId, method, params) => {
    if (method === "scheduleList") return [task({ id: "schedule-2", title: "Other task" })]
    if (method === "scheduleDelete") return null
    throw new Error(`Unexpected method ${method} ${JSON.stringify(params)}`)
  })
  await open(wrapper)
  await wrapper.get("[data-schedule-delete]").trigger("click")
  await flushPromises()
  await new DOMWrapper(document.querySelector('[role="dialog"] .ui-button-danger')!).trigger("click")
  await flushPromises()
  expect(rpc).toHaveBeenCalledWith("machine-1", "scheduleDelete", { scheduleId: "schedule-1" })
  expect(router.currentRoute.value.params.scheduleId).toBeFalsy()
  expect(wrapper.find('[data-schedule-id="schedule-1"]').exists()).toBe(false)
  expect(wrapper.find('[data-schedule-id="schedule-2"]').exists()).toBe(true)
})

test("a link to a task this machine does not have returns to the list", async () => {
  const { wrapper, router } = await setup([task()])
  await router.push({ name: "schedules", params: { scheduleId: "missing" } })
  await flushPromises()
  expect(router.currentRoute.value.params.scheduleId).toBeFalsy()
  expect(wrapper.find('[data-schedule-id="schedule-1"]').exists()).toBe(true)
})

test("an offline transition disables actions and rejects a late list response", async () => {
  const { wrapper, rpc, account } = await setup([task()])
  let resolve!: (tasks: ScheduledTask[]) => void
  rpc.mockImplementationOnce(async () => new Promise<ScheduledTask[]>(done => { resolve = done }))
  await wrapper.get('button[aria-label="Refresh"]').trigger("click")
  account.machines.value[0]!.online = false
  await flushPromises()
  resolve([task({ id: "stale-task", title: "Stale response" })])
  await flushPromises()
  expect(wrapper.find('[data-schedule-id="stale-task"]').exists()).toBe(false)
  expect(wrapper.get("[data-schedule-run]").attributes("disabled")).toBeDefined()
  expect(wrapper.get("[data-schedule-toggle]").attributes("disabled")).toBeDefined()
  expect(wrapper.find("[data-schedule-new]").exists()).toBe(false)
  expect(wrapper.text()).toContain("This machine is offline")
})

test("machine choice uses the account target switch", async () => {
  const { wrapper, account } = await setup()
  const selectMachine = vi.spyOn(account, "selectMachine")
  await selectOption(wrapper, '[data-control-name="schedule-machine"]', account.machines.value.find(machine => machine.id === "machine-2")!.name)
  expect(selectMachine).toHaveBeenCalledWith("machine-2")
})

test("a removed saved provider never silently falls back to the machine default", async () => {
  const { wrapper, rpc } = await setup([task({ target: { kind: "new", provider: "removed-provider", context: "worktree" } })])
  await open(wrapper)
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
