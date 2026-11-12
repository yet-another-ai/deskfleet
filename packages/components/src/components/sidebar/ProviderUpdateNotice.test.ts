import type { CentralApi, CentralEvent, Machine } from "@deskfleet/client/central"
import type { ProviderTemplateUpdates } from "@deskfleet/client/providers"
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { accountSessionKey, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { machineFixture } from "../../test/central.ts"
import ProviderUpdateNotice from "./ProviderUpdateNotice.vue"

let wrapper: VueWrapper | undefined

const page = () => new DOMWrapper(document.body)
const dialog = () => page().get("[data-provider-update-dialog]")
const dialogButton = (label: string) => dialog().findAll("button").find(button => button.text() === label)!
const machineRow = (name: string) => dialog().findAll("[data-provider-update-machines] li").find(row => row.text().includes(name))!
const card = (template: string) => wrapper!.get(`[data-provider-update="${template}"]`)

const codex = (currentVersion: string, status: "available" | "updating" | "error" = "available", error?: string) =>
  ({ currentVersion, latestVersion: "0.167.2", status, ...(error ? { error } : {}) })

beforeEach(() => {
  i18n.global.locale.value = "en-US"
})

afterEach(() => {
  vi.useRealTimers()
  wrapper?.unmount()
  wrapper = undefined
})

function teamFixture(updates: Record<string, ProviderTemplateUpdates>, machines: Machine[]) {
  const listeners = new Set<(event: CentralEvent) => void>()
  const central = {
    catalog: vi.fn(async (_teamId: string, machineId: string) => ({ providers: { providers: [], updates: updates[machineId] ?? {} } })),
    rpc: vi.fn(async () => null),
    onEvent: (listener: (event: CentralEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const session = { central: central as unknown as CentralApi, teamId: ref("team-1"), machines: ref(machines) } as unknown as AccountSession
  const emit = (event: CentralEvent) => { for (const listener of listeners) listener(event) }
  return { central, session, emit }
}

async function renderTeam(session: AccountSession) {
  wrapper = mount(ProviderUpdateNotice, {
    global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

test("groups one CLI version across machines and updates only the chosen online machines", async () => {
  const team = teamFixture({
    m1: { codex: codex("0.160.0") },
    m2: { codex: codex("0.165.1"), "claude-code": { currentVersion: "2.1.190", latestVersion: "2.1.200", status: "available" } },
    m3: { codex: codex("0.150.0") },
  }, [machineFixture("m1", "team-1", "MacBook"), machineFixture("m2", "team-1", "Build"), machineFixture("m3", "team-1", "Home", false)])
  await renderTeam(team.session)

  expect(card("codex").text()).toContain("Codex 0.167.2 available · 3 machines")
  expect(card("claude-code").text()).toContain("Claude Code 2.1.200 available · 1 machine")

  await card("codex").get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  expect(document.activeElement).toBe(dialogButton("Cancel").element)
  expect(machineRow("MacBook").text()).toContain("Current 0.160.0")
  expect(machineRow("Home").text()).toContain("Offline")
  expect(machineRow("Home").get("button").attributes("disabled")).toBeDefined()

  await machineRow("Build").get("button").trigger("click")
  await dialogButton("Update 1 machine").trigger("click")
  await flushPromises()

  expect(team.central.rpc).toHaveBeenCalledExactlyOnceWith("team-1", "m1", "providerUpgrade", { template: "codex" })
  expect(page().find("[data-provider-update-dialog]").exists()).toBe(false)
  expect(card("codex").get("[data-provider-update-action]").text()).toBe("Updating…")
})

test("holds the completed state when only offline machines still list the update", async () => {
  vi.useFakeTimers()
  const updates: Record<string, ProviderTemplateUpdates> = {
    m1: { codex: codex("0.160.0", "updating") },
    m2: { codex: codex("0.140.0", "error", "stale offline error") },
  }
  const team = teamFixture(updates, [machineFixture("m1", "team-1", "MacBook"), machineFixture("m2", "team-1", "Old Laptop", false)])
  await renderTeam(team.session)
  expect(card("codex").find('[role="alert"]').exists()).toBe(false)

  updates.m1 = {}
  team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1" })
  await flushPromises()
  expect(card("codex").text()).toContain("Codex updated to 0.167.2")
  expect(card("codex").get("[data-provider-update-action]").text()).toBe("Updated")
  expect(card("codex").find('[role="alert"]').exists()).toBe(false)

  await vi.advanceTimersByTimeAsync(1_500)
  expect(wrapper!.find('[data-provider-update="codex"]').exists()).toBe(false)
})

test("keeps the dialog open with the machines that could not start an update", async () => {
  const team = teamFixture({ m1: { codex: codex("0.160.0") }, m2: { codex: codex("0.165.1") } },
    [machineFixture("m1", "team-1", "MacBook"), machineFixture("m2", "team-1", "Build")])
  team.central.rpc.mockImplementation(async (...args: unknown[]) => {
    if (args[1] === "m2") throw new Error("Machine is offline")
    return null
  })
  await renderTeam(team.session)

  await card("codex").get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  await dialogButton("Update 2 machines").trigger("click")
  await flushPromises()

  expect(team.central.rpc).toHaveBeenCalledTimes(2)
  expect(dialog().text()).toContain("Build: Machine is offline")
  expect(machineRow("MacBook").text()).toContain("Updating…")
  expect(dialogButton("Update 1 machine").exists()).toBe(true)
})

test("shows each machine's failure and refreshes on catalog change or reconnect without clobbering newer state", async () => {
  const updates: Record<string, ProviderTemplateUpdates> = { m1: { codex: codex("0.160.0", "error", "exit 1") } }
  const team = teamFixture(updates, [machineFixture("m1", "team-1", "MacBook")])
  await renderTeam(team.session)

  expect(card("codex").get('[role="alert"]').text()).toBe("MacBook: exit 1")
  expect(card("codex").get("[data-provider-update-action]").text()).toBe("Retry update")

  // Remounting with the same AccountSession (e.g. switching machines) reuses loaded state without re-fetching.
  wrapper!.unmount()
  await renderTeam(team.session)
  expect(team.central.catalog).toHaveBeenCalledTimes(1)
  expect(card("codex").get('[role="alert"]').text()).toBe("MacBook: exit 1")

  // If catalogChanged resolves with a new failure before the upgrade RPC returns, the optimistic updating state must not overwrite it.
  team.central.rpc.mockImplementationOnce(async () => {
    updates.m1 = { codex: codex("0.160.0", "error", "installer missing") }
    team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1" })
    await flushPromises()
    return null
  })
  await card("codex").get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  await dialogButton("Update 1 machine").trigger("click")
  await flushPromises()
  expect(card("codex").get('[role="alert"]').text()).toBe("MacBook: installer missing")

  updates.m1 = {}
  team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1", sessionId: "1" })
  await flushPromises()
  expect(team.central.catalog).toHaveBeenCalledTimes(2)

  team.emit({ type: "connection", connected: true })
  await flushPromises()
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(false)
})
