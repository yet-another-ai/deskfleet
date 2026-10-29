import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { configureClient, getClient } from "@deskfleet/client/platform"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { usePinnedSessionsStore } from "../../stores/pinned-sessions.ts"
import { agentSnapshot } from "../../test/agent.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import PinnedSessions from "./PinnedSessions.vue"

const host = getClient()
let wrapper: VueWrapper | undefined
let account: AccountSession | undefined
let pinia: ReturnType<typeof createPinia>
const page = () => new DOMWrapper(document.body)
const row = (machineId: string) => wrapper!.get(`[data-pinned-machine="${machineId}"]`)

beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia)
  localStorage.clear()
  i18n.global.locale.value = "en-US"
})
afterEach(async () => {
  wrapper?.unmount(); wrapper = undefined
  disposePinia(pinia)
  account?.dispose(); account = undefined
  configureClient(host)
  await flushPromises()
  vi.restoreAllMocks()
})

async function render(withAccount = false) {
  if (withAccount) {
    const fake = fakeCentral({ machines: [machineFixture("first", "team-1", "Laptop"), machineFixture("second", "team-1", "Build server", false)] })
    fake.central.session = vi.fn(async () => {
      const snapshot = agentSnapshot()
      snapshot.session = { ...snapshot.session, title: "Archived remote investigation", archiveState: "archived" }
      return { snapshot, lastEventSeq: "0", lastObservedAt: "2026-10-28T00:00:00Z" }
    })
    account = createAccountSession(fake.central)
    await flushPromises()
    configureClient({ ...host, target: { id: "first", local: false } })
  }
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "home", component: { template: "<div />" } },
    { path: "/sessions/:sessionId", name: "session", component: { template: "<div />" } },
  ] })
  await router.push("/")
  wrapper = mount(PinnedSessions, {
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n], provide: account ? { [accountSessionKey as symbol]: account } : {} },
  })
  const pins = usePinnedSessionsStore()
  const fleet = useFleetStore()
  fleet.localDesktopTarget.online = true
  fleet.localDesktopTarget.name = "Laptop"
  const agents = useAgentSessionsStore()
  agents.sessions["30"] = { ...agentSnapshot().session, title: "Current investigation", archiveState: "archived" }
  return { pins, agents, router, machineId: fleet.targetId }
}

test("Pinned appears in pin order with current titles and archived sessions from every Team machine", async () => {
  const { pins, agents } = await render(true)
  expect(wrapper!.find("[data-pinned-sessions]").exists()).toBe(false)
  pins.pin("second", "30", "Cached remote title")
  pins.pin("first", "30", "Cached local title")
  await flushPromises()
  expect(wrapper!.get("h2").text()).toBe("Pinned")
  expect(wrapper!.findAll("[data-pinned-machine]").map(item => item.attributes("data-pinned-machine"))).toEqual(["second", "first"])
  expect(row("second").text()).toContain("Archived remote investigation")
  expect(row("second").text()).toContain("Offline")
  expect(row("first").text()).toContain("Current investigation")
  expect(row("first").text()).not.toContain("Offline")
  expect(row("second").get("button").attributes("title")).toContain("Build server")
  agents.sessions["30"] = { ...agents.sessions["30"]!, title: "Renamed investigation" }
  await flushPromises()
  expect(row("first").text()).toContain("Renamed investigation")
})

test("account pins use their owning machine for navigation and active state when local IDs match", async () => {
  const { pins, router } = await render(true)
  pins.pin("first", "30", "First title")
  pins.pin("second", "30", "Second title")
  await router.push("/sessions/30"); await flushPromises()
  expect(row("first").get("button").attributes("aria-current")).toBe("page")
  expect(row("second").get("button").attributes("aria-current")).toBeUndefined()
  const open = vi.spyOn(account!, "openSession").mockImplementation(() => {})
  const navigate = vi.spyOn(router, "push")
  await row("second").get("button").trigger("click")
  expect(open).toHaveBeenCalledExactlyOnceWith("second", "30")
  expect(navigate).not.toHaveBeenCalled()
})

test("a local pin opens its Session through the local router", async () => {
  const { pins, router, machineId } = await render()
  pins.pin(machineId, "30", "Cached title"); await flushPromises()
  await row(machineId).get("button").trigger("click"); await flushPromises()
  expect(router.currentRoute.value).toMatchObject({ name: "session", params: { sessionId: "30" } })
  expect(row(machineId).get("button").attributes("aria-current")).toBe("page")
})

test("unpinning a remote row keeps the matching local ID pinned and permits offline unpinning", async () => {
  const { pins } = await render(true)
  pins.pin("first", "30", "First title")
  pins.pin("second", "30", "Second title")
  await flushPromises()
  const unpin = vi.spyOn(pins, "unpin")
  await row("second").get("button").trigger("contextmenu", { button: 2 }); await flushPromises()
  const items = page().findAll('[role="menuitem"]')
  const remove = items.find(item => item.text() === "Unpin session")!
  expect(remove.attributes("data-disabled")).toBeUndefined()
  expect(items.find(item => item.text() === "Restore session")!.attributes("data-disabled")).toBeDefined()
  await remove.trigger("click"); await flushPromises()
  expect(unpin).toHaveBeenCalledExactlyOnceWith("second", "30")
  expect(wrapper!.find('[data-pinned-machine="second"]').exists()).toBe(false)
  expect(wrapper!.find('[data-pinned-machine="first"]').exists()).toBe(true)
  expect(pins.isPinned("first", "30")).toBe(true)
})

test("unpinning the final row removes the empty Pinned section", async () => {
  const { pins, machineId } = await render()
  pins.pin(machineId, "30", "Cached title"); await flushPromises()
  await row(machineId).get("button").trigger("contextmenu", { button: 2 }); await flushPromises()
  await page().findAll('[role="menuitem"]').find(item => item.text() === "Unpin session")!.trigger("click")
  await flushPromises()
  expect(wrapper!.find("[data-pinned-sessions]").exists()).toBe(false)
  expect(pins.items).toEqual([])
})

test("pinned rows show a working indicator for the selected machine's live turn", async () => {
  const { pins, agents, machineId } = await render()
  pins.pin(machineId, "30", "Cached title"); await flushPromises()
  expect(row(machineId).find("[data-session-working]").exists()).toBe(false)
  const live = agentSnapshot()
  live.turns = [{ id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "starting", startedAt: "now" }]
  agents.views["30"] = { snapshot: live, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }
  await flushPromises()
  expect(row(machineId).get("[data-session-working]").attributes("role")).toBe("status")
  expect(row(machineId).get("[data-session-working]").text()).toContain("Working")
  agents.views["30"] = {
    ...agents.views["30"]!,
    snapshot: { ...live, turns: [{ ...live.turns[0]!, state: "completed", endedAt: "now" }] },
  }
  await flushPromises()
  expect(row(machineId).find("[data-session-working]").exists()).toBe(false)
})

test("pinned rows on another machine do not use this scope's live turns", async () => {
  const { pins, agents } = await render(true)
  pins.pin("first", "30", "Local title")
  pins.pin("second", "30", "Remote title")
  await flushPromises()
  const live = agentSnapshot()
  live.turns = [{ id: "70", sessionId: "30", initialInputId: "40", dispatchCommandId: "50", runGeneration: 1, state: "running", startedAt: "now" }]
  agents.views["30"] = { snapshot: live, events: [], loading: false, error: null, historySeq: "0", snapshotSeq: "0" }
  await flushPromises()
  expect(row("first").find("[data-session-working]").exists()).toBe(true)
  expect(row("second").find("[data-session-working]").exists()).toBe(false)
})
