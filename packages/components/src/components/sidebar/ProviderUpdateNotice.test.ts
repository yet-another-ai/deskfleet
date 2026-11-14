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
const machineRow = (name: string, template = "codex") => dialog().get(`[data-provider-update-group="${template}"]`).findAll("li").find(row => row.text().includes(name))!
const card = () => wrapper!.get("[data-provider-update]")

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

test("groups all tools in one notice and updates only the chosen tool and machine pairs", async () => {
  const team = teamFixture({
    m1: { codex: codex("0.160.0") },
    m2: { codex: codex("0.165.1"), "claude-code": { currentVersion: "2.1.190", latestVersion: "2.1.200", status: "available" } },
    m3: { codex: codex("0.150.0") },
  }, [machineFixture("m1", "team-1", "MacBook"), machineFixture("m2", "team-1", "Build"), machineFixture("m3", "team-1", "Home", false)])
  await renderTeam(team.session)

  expect(wrapper!.findAll("[data-provider-update]")).toHaveLength(1)
  expect(card().text()).toContain("2 agent updates available")

  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  expect(document.activeElement).toBe(dialogButton("Cancel").element)
  expect(dialog().text()).toContain("Codex")
  expect(dialog().text()).toContain("0.167.2")
  expect(dialog().text()).toContain("Claude Code")
  expect(dialog().text()).toContain("2.1.200")
  expect(machineRow("MacBook").text()).toContain("Current 0.160.0")
  expect(machineRow("Home").text()).toContain("Offline")
  expect(machineRow("Home").get("button").attributes("disabled")).toBeDefined()

  await machineRow("Build").get("button").trigger("click")
  await dialogButton("Install 2 updates").trigger("click")
  await flushPromises()

  expect(team.central.rpc).toHaveBeenCalledTimes(2)
  expect(team.central.rpc).toHaveBeenCalledWith("team-1", "m1", "providerUpgrade", { template: "codex" })
  expect(team.central.rpc).toHaveBeenCalledWith("team-1", "m2", "providerUpgrade", { template: "claude-code" })
  expect(page().find("[data-provider-update-dialog]").exists()).toBe(false)
  expect(card().get("[data-provider-update-action]").attributes("disabled")).toBeUndefined()
})

test("holds the completed state when only offline machines still list the update", async () => {
  vi.useFakeTimers()
  const updates: Record<string, ProviderTemplateUpdates> = {
    m1: { codex: codex("0.160.0", "updating") },
    m2: { codex: codex("0.140.0", "error", "stale offline error") },
  }
  const team = teamFixture(updates, [machineFixture("m1", "team-1", "MacBook"), machineFixture("m2", "team-1", "Old Laptop", false)])
  await renderTeam(team.session)
  expect(card().find('[role="alert"]').exists()).toBe(false)

  updates.m1 = {}
  team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1" })
  await flushPromises()
  expect(card().text()).toContain("Agents updated")
  expect(card().get("[data-provider-update-action]").text()).toBe("Updated")
  expect(card().find('[role="alert"]').exists()).toBe(false)

  await vi.advanceTimersByTimeAsync(1_500)
  expect(wrapper!.find('[data-provider-update]').exists()).toBe(false)
})

test("keeps the dialog open with the machines that could not start an update", async () => {
  const team = teamFixture({ m1: { codex: codex("0.160.0") }, m2: { codex: codex("0.165.1") } },
    [machineFixture("m1", "team-1", "MacBook"), machineFixture("m2", "team-1", "Build")])
  team.central.rpc.mockImplementation(async (...args: unknown[]) => {
    if (args[1] === "m2") throw new Error("Machine is offline")
    return null
  })
  await renderTeam(team.session)

  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  await dialogButton("Install 2 updates").trigger("click")
  await flushPromises()

  expect(team.central.rpc).toHaveBeenCalledTimes(2)
  expect(dialog().text()).toContain("Codex · Build: Machine is offline")
  expect(machineRow("MacBook").text()).toContain("Updating…")
  expect(dialogButton("Install 1 update").exists()).toBe(true)
})

test("shows each machine's failure and refreshes on catalog change or reconnect without clobbering newer state", async () => {
  const updates: Record<string, ProviderTemplateUpdates> = { m1: { codex: codex("0.160.0", "error", "exit 1") } }
  const team = teamFixture(updates, [machineFixture("m1", "team-1", "MacBook")])
  await renderTeam(team.session)

  expect(card().get('[role="alert"]').text()).toBe("1 update failed")

  // Remounting with the same AccountSession (e.g. switching machines) reuses loaded state without re-fetching.
  wrapper!.unmount()
  await renderTeam(team.session)
  expect(team.central.catalog).toHaveBeenCalledTimes(1)
  expect(card().get('[role="alert"]').text()).toBe("1 update failed")

  // If catalogChanged resolves with a new failure before the upgrade RPC returns, the optimistic updating state must not overwrite it.
  team.central.rpc.mockImplementationOnce(async () => {
    updates.m1 = { codex: codex("0.160.0", "error", "installer missing") }
    team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1" })
    await flushPromises()
    return null
  })
  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  expect(machineRow("MacBook").text()).toContain("exit 1")
  await dialogButton("Install 1 update").trigger("click")
  await flushPromises()
  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  expect(machineRow("MacBook").text()).toContain("installer missing")
  await dialogButton("Cancel").trigger("click")

  updates.m1 = {}
  team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1", sessionId: "1" })
  await flushPromises()
  expect(team.central.catalog).toHaveBeenCalledTimes(2)

  team.emit({ type: "connection", connected: true })
  await flushPromises()
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(false)
})

test("dismisses stale manual-update notices across refresh and remount, but shows a new version", async () => {
  const updates: Record<string, ProviderTemplateUpdates> = {
    m1: { codex: codex("0.160.0"), "claude-code": { currentVersion: "2.1.190", latestVersion: "2.1.200", status: "available" } },
  }
  const team = teamFixture(updates, [machineFixture("m1", "team-1", "MacBook")])
  await renderTeam(team.session)

  await card().get("[data-provider-update-dismiss]").trigger("click")
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(false)
  expect(team.central.rpc).not.toHaveBeenCalled()
  team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1" })
  await flushPromises()
  wrapper!.unmount()
  await renderTeam(team.session)
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(false)

  updates.m1 = { ...updates.m1, codex: { ...codex("0.167.2"), latestVersion: "0.168.0" } }
  team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1" })
  await flushPromises()
  expect(card().text()).toContain("1 agent update available")
  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  expect(dialog().text()).toContain("0.168.0")
  expect(dialog().find('[data-provider-update-group="claude-code"]').exists()).toBe(false)
})

test("keeps update progress reviewable and dismissible without cancelling the installer", async () => {
  const team = teamFixture({ m1: { codex: codex("0.160.0", "updating") } }, [machineFixture("m1", "team-1", "MacBook")])
  await renderTeam(team.session)
  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  expect(machineRow("MacBook").text()).toContain("Updating…")
  expect(dialogButton("Install 0 updates").attributes("disabled")).toBeDefined()
  await dialogButton("Cancel").trigger("click")
  await card().get("[data-provider-update-dismiss]").trigger("click")
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(false)
  expect(team.central.rpc).not.toHaveBeenCalled()
})

test("closes a stale dialog after a manual update and does not reopen it for the next release", async () => {
  const updates: Record<string, ProviderTemplateUpdates> = { m1: { codex: codex("0.160.0") } }
  const team = teamFixture(updates, [machineFixture("m1", "team-1", "MacBook")])
  await renderTeam(team.session)
  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  updates.m1 = {}
  team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1" })
  await flushPromises()
  expect(page().find("[data-provider-update-dialog]").exists()).toBe(false)
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(false)

  updates.m1 = { codex: { ...codex("0.167.2"), latestVersion: "0.168.0" } }
  team.emit({ type: "catalogChanged", teamId: "team-1", machineId: "m1" })
  await flushPromises()
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(true)
  expect(page().find("[data-provider-update-dialog]").exists()).toBe(false)
  expect(team.central.rpc).not.toHaveBeenCalled()
})

test("scopes dismissals to the team even when the public machine and target version match", async () => {
  const team = teamFixture({ m1: { codex: codex("0.160.0") } }, [machineFixture("m1", "team-1", "MacBook")])
  await renderTeam(team.session)
  await card().get("[data-provider-update-dismiss]").trigger("click")
  team.session.teamId.value = "team-2"
  team.session.machines.value = [machineFixture("m1", "team-2", "MacBook")]
  await flushPromises()
  expect(card().text()).toContain("1 agent update available")

  team.session.teamId.value = "team-1"
  team.session.machines.value = [machineFixture("m1", "team-1", "MacBook")]
  await flushPromises()
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(false)
})

test("accepts multiple tools on one machine in order and keeps their optimistic progress", async () => {
  const team = teamFixture({ m1: {
    codex: codex("0.160.0"),
    "claude-code": { currentVersion: "2.1.190", latestVersion: "2.1.200", status: "available" },
  } }, [machineFixture("m1", "team-1", "MacBook")])
  let accept!: () => void
  team.central.rpc.mockImplementationOnce(() => new Promise<null>(resolve => { accept = () => resolve(null) }))
  await renderTeam(team.session)
  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  await dialogButton("Install 2 updates").trigger("click")
  await flushPromises()
  expect(team.central.rpc).toHaveBeenCalledTimes(1)
  accept()
  await flushPromises()
  expect(team.central.rpc).toHaveBeenNthCalledWith(2, "team-1", "m1", "providerUpgrade", { template: "claude-code" })

  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  expect(machineRow("MacBook").text()).toContain("Updating…")
  expect(machineRow("MacBook", "claude-code").text()).toContain("Updating…")
})

test("does not carry an open dialog or completed progress into another team", async () => {
  const updates: Record<string, ProviderTemplateUpdates> = { m1: { codex: codex("0.160.0", "updating") } }
  const team = teamFixture(updates, [machineFixture("m1", "team-1", "MacBook")])
  await renderTeam(team.session)
  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  updates.m1 = {}
  team.session.teamId.value = "team-2"
  team.session.machines.value = [machineFixture("m1", "team-2", "MacBook")]
  await flushPromises()
  expect(wrapper!.find("[data-provider-updates]").exists()).toBe(false)
  expect(page().find("[data-provider-update-dialog]").exists()).toBe(false)

  updates.m1 = { codex: codex("0.165.1") }
  team.emit({ type: "catalogChanged", teamId: "team-2", machineId: "m1" })
  await flushPromises()
  expect(card().text()).toContain("1 agent update available")
  expect(page().find("[data-provider-update-dialog]").exists()).toBe(false)
})

test("allows an available tool to be selected while another tool is updating", async () => {
  const team = teamFixture({ m1: {
    codex: codex("0.160.0", "updating"),
    "claude-code": { currentVersion: "2.1.190", latestVersion: "2.1.200", status: "available" },
  } }, [machineFixture("m1", "team-1", "MacBook")])
  await renderTeam(team.session)
  await card().get("[data-provider-update-action]").trigger("click")
  await flushPromises()
  await dialogButton("Install 1 update").trigger("click")
  await flushPromises()
  expect(team.central.rpc).toHaveBeenCalledExactlyOnceWith("team-1", "m1", "providerUpgrade", { template: "claude-code" })
})
