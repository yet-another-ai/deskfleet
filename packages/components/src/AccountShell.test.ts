import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { configureClient, getClient } from "@deskfleet/client/platform"
import type { CentralApi, CentralEvent, Machine } from "@deskfleet/client/central"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import type { AccountSession } from "./composables/useAccountSession.ts"
import AccountShell from "./AccountShell.vue"
import { agentEvent, agentInput, agentSnapshot } from "./test/agent.ts"
import { fakeCentral, machineFixture } from "./test/central.ts"
import * as analytics from "./services/analytics.ts"
import { useAgentSessionsStore } from "./stores/agent-sessions.ts"
import { useProvidersStore } from "./stores/providers.ts"
import * as machineRuntimes from "./composables/useMachineRuntimes.ts"

const host = getClient()
const page = () => new DOMWrapper(document.body)
let view: VueWrapper | undefined
let pinia: Pinia
beforeEach(() => { pinia = createPinia() })
// Compile the lazy shell routes once. Doing it inside a test leaves vi.waitFor polling a 50ms timer while Vite loads them.
beforeAll(async () => {
  await Promise.all([
    import("./components/account/MachineSurface.vue"),
    import("./views/NewSessionView.vue"),
    import("./views/SessionView.vue"),
    import("./views/ArchivedSessionsView.vue"),
    import("./views/SettingsView.vue"),
    import("./components/settings/PreferencesSettings.vue"),
    import("./components/settings/AppearanceSettings.vue"),
    import("./views/TeamSettingsView.vue"),
    import("./components/team/TeamSettings.vue"),
    import("./components/settings/PlansUsageSettings.vue"),
    import("./components/settings/AiUsageSettings.vue"),
    import("./components/team/AiUsageChart.vue"),
  ])
})
/** Check the shell as soon as its microtasks render, instead of on a real-time interval. */
async function settled(probe: () => void): Promise<void> {
  let failure: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      probe()
      return
    } catch (reason) {
      failure = reason
    }
    await flushPromises()
  }
  throw failure
}
afterEach(async () => { view?.unmount(); view = undefined; disposePinia(pinia); configureClient(host); await router.replace("/"); vi.restoreAllMocks() })

test("browses synchronized history with the machine offline and isolates equal local IDs when switching machines", async () => {
  const listeners = new Set<(event: CentralEvent) => void>()
  let signedIn = true
  const machines: Machine[] = ["First", "Second"].map((name, index) => ({ id: String(index + 101), teamId: "7", name, localMachineId: "1", originId: `origin-${index}`, online: false, capabilities: {} }))
  const snapshot = (machineId: string) => {
    const value = agentSnapshot()
    value.session.title = `Conversation ${machineId}`
    value.session.workspaceId = "20"
    value.session.lastEventSeq = "1"
    value.inputs = [agentInput({ content: [{ type: "text", text: `Message from ${machineId}` }] })]
    return value
  }
  const central = {
    status: vi.fn(async () => ({ serverUrl: "https://fleet.example", user: signedIn ? { id: "u1", name: "Ada" } : undefined })),
    site: vi.fn(async () => ({ siteName: "DeskFleet", announcement: "", allowTeamCreation: true, termsOfServiceUrl: "", privacyTermsUrl: "" })),
    login: vi.fn(async () => { signedIn = true }), logout: vi.fn(async () => { signedIn = false }),
    teams: vi.fn(async () => [{ id: "7", name: "Team", role: "member" }]),
    members: vi.fn(async () => [{ userId: "u1", name: "Ada", role: "member" }]),
    machines: vi.fn(async () => machines),
    onEvent: (listener: (event: CentralEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    catalog: vi.fn(async (machineId: string) => ({ machineId, lastObservedAt: "2026-10-25T00:00:00Z", providers: { providers: [{ id: "codex", name: "Codex", template: "codex" }] }, snapshot: {
      teamId: "1", machineId: "1", machineName: machines.find(machine => machine.id === machineId)!.name,
      workspaces: [{ id: "20", name: `Workspace ${machineId}`, worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code" }] }, { id: "31", workspaceId: "20", sessionId: "30", directories: [{ path: "/worktree" }] }] }],
      sessions: [],
    } })),
    sessions: vi.fn(async (machineId: string) => [snapshot(machineId)]),
    session: vi.fn(async (machineId: string) => ({ snapshot: snapshot(machineId), lastEventSeq: "1", lastObservedAt: "2026-10-25T00:00:00Z" })),
    events: vi.fn(async (machineId: string) => ({ events: [agentEvent(1, "input", snapshot(machineId).inputs[0]!)], lastEventSeq: "1" })),
    rpc: vi.fn(async () => { throw new Error("Offline") }), createPeer: vi.fn(),
  } as unknown as CentralApi
  view = mount(AccountShell, { props: { host: { ...host, platform: "web", central } }, global: { plugins: [pinia, router, i18n] }, attachTo: document.body })
  await settled(() => expect(view!.text()).toContain("Workspace 101"))
  expect(view.text()).toContain("Conversation 101")
  await router.push("/sessions/30")
  await settled(() => expect(view!.text()).toContain("Message from 101"))
  expect(central.createPeer).not.toHaveBeenCalled()
  // Opening another machine retains the first machine's expanded resource tree.
  expect(page().find('aside button[data-machine-id="101"]').exists()).toBe(false)
  await page().get('aside button[data-machine-id="102"]').trigger("click")
  await settled(() => expect(view!.text()).toContain("Workspace 102"))
  expect(page().get("aside").text()).toContain("Workspace 101")
  expect(page().get("aside").text()).toContain("Conversation 101")
  await router.push("/sessions/30")
  await settled(() => expect(view!.text()).toContain("Message from 102"))
  expect(view.text()).not.toContain("Message from 101")
  expect(central.createPeer).not.toHaveBeenCalled()
  // An explicit Session destination survives the fresh Machine mount, even when
  // both machines use the same local Session ID and synchronized offline history.
  const account = view.getComponent({ name: "MachineSurface" }).props("session") as AccountSession
  await page().get('aside section[data-machine-id="101"] a[href="#/sessions/30"]').trigger("click")
  await settled(() => expect(view!.text()).toContain("Message from 101"))
  expect(router.currentRoute.value.path).toBe("/sessions/30")
  expect(view.text()).not.toContain("Message from 102")
  expect(page().get("aside").text()).toContain("Workspace 102")
  expect(page().get('aside section[data-machine-id="101"] a[href="#/sessions/30"]').attributes("aria-current")).toBe("page")
  expect(page().get('aside section[data-machine-id="102"] a[href="#/sessions/30"]').attributes("aria-current")).toBeUndefined()
  // A catalog update for an inactive machine stays bound to its own client.
  vi.mocked(central.catalog).mockClear()
  for (const listener of listeners) listener({ type: "catalogChanged", machineId: "102" } as CentralEvent)
  await settled(() => expect(central.catalog).toHaveBeenCalledWith("102"))
  expect(central.catalog).not.toHaveBeenCalledWith("101")
  account.openSession("102", "30")
  await settled(() => expect(page().get("main").text()).toContain("Message from 102"))
  await page().get('button[aria-label="Ada"]').trigger("click")
  await page().findAll('button[role="menuitem"]').find(button => button.text() === "Sign out")!.trigger("click")
  await flushPromises()
  expect(view.text()).toContain("Sign in to DeskFleet")
  expect(view.text()).not.toContain("Workspace 102")
  await page().get("form").trigger("submit")
  await settled(() => expect(view!.text()).toContain("Workspace 101"))
})

const mountShell = (central: CentralApi, platform: "web" | "darwin" = "darwin") => {
  view = mount(AccountShell, { props: { host: { ...host, platform, central } }, global: { plugins: [pinia, router, i18n] }, attachTo: document.body })
}
const buttonText = (text: string) => page().findAll("button").find(button => button.text() === text)

test("Refresh reloads every opened machine's resources with unchanged roster metadata", async () => {
  const fake = fakeCentral({ machines: [
    machineFixture("m1", "team-1", "First", false),
    machineFixture("m2", "team-1", "Second", false),
    machineFixture("m3", "team-1", "Unopened", false),
  ] })
  let revision = 0
  const snapshot = (machineId: string) => {
    const value = agentSnapshot()
    value.session.workspaceId = "20"
    value.session.title = `Conversation ${machineId} revision ${revision}`
    return value
  }
  const catalog = vi.fn(async (machineId: string) => ({
    machineId, lastObservedAt: "2026-10-29T00:00:00Z",
    providers: { providers: [{ id: "codex", name: `Provider ${machineId} revision ${revision}`, template: "codex" }] },
    snapshot: {
      teamId: "1", machineId: "1", machineName: fake.state.machines.find(machine => machine.id === machineId)!.name,
      workspaces: [{ id: "20", name: `Workspace ${machineId} revision ${revision}`, worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code" }] }] }],
      sessions: [],
    },
  }))
  const createPeer = vi.fn(async (_teamId: string, machineId: string) => ({
    peerId: `peer-${machineId}`, authorization: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, iceServers: [],
  }))
  const closePeer = vi.fn(async () => {})
  Object.assign(fake.central, { catalog, createPeer, closePeer, sessions: vi.fn(async (machineId: string) => [snapshot(machineId)]) })
  const createRuntimes = vi.spyOn(machineRuntimes, "createMachineRuntimes")
  mountShell(fake.central, "web")
  await settled(() => expect(page().get("aside").text()).toContain("Workspace m1 revision 0"))
  await page().get('aside button[data-machine-id="m2"]').trigger("click")
  await settled(() => {
    expect(page().get("aside").text()).toContain("Workspace m2 revision 0")
    expect(page().get("aside").text()).toContain("Conversation m1 revision 0")
    expect(page().get("aside").text()).toContain("Conversation m2 revision 0")
  })
  const account = view!.getComponent({ name: "MachineSurface" }).props("session") as AccountSession
  const runtimes = createRuntimes.mock.results[0]!.value!
  const first = runtimes.opened.get("m1")!
  const second = runtimes.opened.get("m2")!
  const firstAgents = useAgentSessionsStore(first.state)
  firstAgents.drafts["30"] = "Keep the background draft"
  await first.api.agent.prepare!("retained-peer")
  await second.api.agent.prepare!("retained-peer")
  const main = page().get("main").element
  catalog.mockClear()
  fake.central.machines.mockClear()
  revision++

  await buttonText("Refresh")!.trigger("click")
  await settled(() => {
    const sidebar = page().get("aside").text()
    expect(sidebar).toContain("Workspace m1 revision 1")
    expect(sidebar).toContain("Workspace m2 revision 1")
    expect(sidebar).toContain("Conversation m1 revision 1")
    expect(sidebar).toContain("Conversation m2 revision 1")
    expect(useProvidersStore(first.state).providers[0]?.name).toBe("Provider m1 revision 1")
    expect(useProvidersStore(second.state).providers[0]?.name).toBe("Provider m2 revision 1")
  })
  expect(fake.central.machines).toHaveBeenCalledWith("team-1")
  expect(catalog).not.toHaveBeenCalledWith("m3")
  expect(runtimes.opened.size).toBe(2)
  expect(runtimes.opened.get("m1")).toBe(first)
  expect(runtimes.opened.get("m2")).toBe(second)
  expect(firstAgents.drafts["30"]).toBe("Keep the background draft")
  expect(account.machineId.value).toBe("m2")
  expect(page().get("main").element).toBe(main)
  expect(createPeer).toHaveBeenCalledTimes(2)
  expect(closePeer).not.toHaveBeenCalled()
})

/**
 * Machine views read synchronized catalogs and history; these machines have none.
 * Like the server, the catalog names each machine with its Team name.
 */
function withEmptyCatalogs({ central, state }: ReturnType<typeof fakeCentral>): void {
  Object.assign(central, {
    catalog: vi.fn(async (machineId: string) => ({ machineId, lastObservedAt: "2026-10-25T00:00:00Z", snapshot: { teamId: "team-1", machineId, machineName: state.machines.find(machine => machine.id === machineId)?.name ?? "hostname", workspaces: [], sessions: [] } })),
    sessions: vi.fn(async () => []),
    rpc: vi.fn(async () => { throw new Error("Offline") }),
  })
}

test("refreshing to another account remounts the same Team machine in its new identity scope", async () => {
  const fake = fakeCentral({ machines: [machineFixture("m1", "team-1", "Shared machine", false)] })
  withEmptyCatalogs(fake)
  mountShell(fake.central, "web")
  await settled(() => expect(page().get("aside").text()).toContain("Shared machine"))
  const previousMain = page().get("main").element
  const account = view!.getComponent({ name: "MachineSurface" }).props("session") as AccountSession
  vi.mocked(fake.central.catalog).mockClear()
  fake.central.status.mockResolvedValue({
    serverUrl: "https://fleet.example", siteAdmin: false,
    user: { id: "user-3", name: "Grace", email: "grace@example.test" },
  })

  await account.reload()
  await settled(() => {
    expect(page().find('button[aria-label="Grace"]').exists()).toBe(true)
    expect(page().get("aside").text()).toContain("Shared machine")
    expect(fake.central.catalog).toHaveBeenCalledWith("m1")
  })
  expect(account.teamId.value).toBe("team-1")
  expect(account.machineId.value).toBe("m1")
  expect(page().get("main").element).not.toBe(previousMain)
})

test.each(["selected", "background"])("late local enrollment switches a %s machine's channel without losing its route or draft", async visibility => {
  const fake = fakeCentral({
    machines: [machineFixture("mine", "team-1", "This computer", false), machineFixture("other", "team-1", "Other machine", false)],
    enrollment: { configured: true, connected: true, revoked: false, serverUrl: "https://fleet.example", teamId: "team-1", machineId: "mine", identity: { originId: "origin-mine", machineId: "1" }, machineName: "This computer" },
  })
  withEmptyCatalogs(fake)
  fake.central.localEnrollment!.mockRejectedValueOnce(new Error("Daemon is starting"))
  const createRuntimes = vi.spyOn(machineRuntimes, "createMachineRuntimes")
  mountShell(fake.central)
  const runtimes = createRuntimes.mock.results[0]!.value!
  await settled(() => expect(runtimes.opened.get("mine")).toBeDefined())
  const runtime = runtimes.opened.get("mine")!
  const api = runtime.api
  expect(api.agent.connectChannel).toBeUndefined()
  await settled(() => expect(page().get("aside").text()).toContain("This computer"))
  const agents = useAgentSessionsStore(runtime.state)
  agents.drafts["machine:mine"] = "Keep this unsent message"
  const session = view!.getComponent({ name: "MachineSurface" }).props("session") as AccountSession
  if (visibility === "background") {
    session.selectMachine("other")
    await settled(() => expect(runtimes.opened.get("other")).toBeDefined())
    await flushPromises()
  }
  await router.push("/settings/preferences")
  await session.refreshMachines()
  await settled(() => expect(api.agent.connectChannel).toBeTypeOf("function"))
  expect(runtimes.opened.get("mine")?.api).toBe(api)
  expect(router.currentRoute.value.path).toBe("/settings/preferences")
  expect(useAgentSessionsStore(runtime.state)).toBe(agents)
  expect(agents.drafts["machine:mine"]).toBe("Keep this unsent message")
  fake.central.localEnrollment!.mockRejectedValueOnce(new Error("Daemon discovery is temporarily unavailable"))
  await session.refreshMachines()
  expect(api.agent.connectChannel).toBeTypeOf("function")
  fake.state.enrollment!.revoked = true
  await session.refreshMachines()
  await settled(() => expect(api.agent.connectChannel).toBeUndefined())
  expect(router.currentRoute.value.path).toBe("/settings/preferences")
  expect(agents.drafts["machine:mine"]).toBe("Keep this unsent message")
})

test("keeps archived lists and their Conversations return path scoped to the selected machine", async () => {
  const fake = fakeCentral({ machines: [
    machineFixture("m1", "team-1", "Build server", false),
    machineFixture("m2", "team-1", "Laptop", false),
  ] })
  withEmptyCatalogs(fake)
  const snapshot = (machineId: string) => {
    const archived = agentSnapshot()
    archived.session.title = `Archived conversation ${machineId}`
    archived.session.archiveState = "archived"
    return archived
  }
  Object.assign(fake.central, {
    sessions: vi.fn(async (machineId: string) => [snapshot(machineId)]),
    session: vi.fn(async (machineId: string) => ({ snapshot: snapshot(machineId), lastEventSeq: "0", lastObservedAt: "2026-10-25T00:00:00Z" })),
    events: vi.fn(async () => ({ events: [], lastEventSeq: "0" })),
  })
  localStorage.setItem("deskfleet.details-open", "true")
  await router.push("/sessions/archived")
  mountShell(fake.central, "web")
  await settled(() => expect(page().get("main").text()).toContain("Archived conversation m1"))
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(router.currentRoute.value.path).toBe("/sessions/archived")
  expect(page().find('aside[aria-label="Changes"]').exists()).toBe(false)

  // Returning from the archive on the same machine retains its selected Session.
  const conversations = () => page().get('a[aria-label="Conversations"]')
  await router.push("/sessions/30")
  await settled(() => expect(fake.central.session).toHaveBeenCalledWith("m1", "30"))
  await router.push("/sessions/archived")
  await flushPromises()
  expect(conversations().attributes("href")).toBe("#/sessions/30")
  await conversations().trigger("click"); await flushPromises()
  expect(router.currentRoute.value.path).toBe("/sessions/30")
  await router.push("/sessions/archived"); await flushPromises()

  await page().get('aside button[data-machine-id="m2"]').trigger("click")
  await settled(() => expect(page().get("main").text()).toContain("Archived conversation m2"))
  expect(page().get("main").text()).not.toContain("Archived conversation m1")
  expect(router.currentRoute.value.name).toBe("archived-sessions")
  expect(router.currentRoute.value.path).toBe("/sessions/archived")
  expect(page().find('aside[aria-label="Changes"]').exists()).toBe(false)
  expect(localStorage.getItem("deskfleet.details-open")).toBe("true")
  // The second machine also has Session 30, but it must not inherit the first
  // machine's selection when leaving this management list.
  expect(conversations().attributes("href")).toBe("#/")
  await conversations().trigger("click"); await flushPromises()
  expect(router.currentRoute.value.path).toBe("/")
  expect(fake.central.session).not.toHaveBeenCalledWith("m2", "30")
})

test("a user without a Team creates one from onboarding and is asked to add a machine", async () => {
  const fake = fakeCentral({ teams: [] })
  mountShell(fake.central, "web")
  await flushPromises()
  expect(page().find('button[aria-label="Team"]').exists()).toBe(false)
  expect(view!.text()).toContain("Welcome, Ada")
  await buttonText("Create a teamStart a new team and invite others to it.")!.trigger("click")
  await flushPromises()
  expect(document.activeElement).toBe(page().get('[role=dialog] [name="team-name"]').element)
  fake.central.createTeam.mockRejectedValueOnce(new Error("Name taken"))
  await page().get('[role=dialog] [name="team-name"]').setValue("Platform")
  await page().get("[role=dialog] form").trigger("submit")
  await flushPromises()
  // The failure belongs to the dialog, not the sidebar.
  expect(page().get('[role=dialog] [role="alert"]').text()).toBe("Name taken")
  expect(page().findAll('[role="alert"]')).toHaveLength(1)
  await page().get("[role=dialog] form").trigger("submit")
  await flushPromises()
  expect(page().find("[role=dialog]").exists()).toBe(false)
  expect(page().get('button[aria-label="Team"]').text()).toContain("Platform")
  expect(page().get("main h1").text()).toBe("Add a machine to Platform")
})

test("joining from the Team menu selects the joined Team", async () => {
  const fake = fakeCentral()
  mountShell(fake.central, "web")
  await flushPromises()
  const trigger = page().get<HTMLButtonElement>('button[aria-label="Team"]')
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  expect(document.activeElement).toBe(page().get('[data-team-id="team-1"]').element)
  await page().get('[role="menu"]').trigger("keydown", { key: "Escape" })
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger.element))
  await trigger.trigger("click")
  await page().findAll('[role="menuitem"]').find(item => item.text() === "Join a team")!.trigger("click")
  await flushPromises()
  await page().get('[role=dialog] [name="invite-code"]').setValue(" invitation-code ")
  await page().get("[role=dialog] form").trigger("submit")
  await flushPromises()
  expect(fake.central.acceptInvite).toHaveBeenCalledExactlyOnceWith("invitation-code")
  expect(trigger.text()).toContain("Invited team")
})

test.each(["Create a team", "Join a team"])("keyboard %s cancellation returns focus to the Team menu trigger", async (label) => {
  mountShell(fakeCentral().central, "web")
  await flushPromises()
  const trigger = page().get<HTMLButtonElement>('button[aria-label="Team"]')
  trigger.element.focus()
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  const item = page().findAll('[role="menuitem"]').find(item => item.text() === label)!
  const itemElement = item.element as HTMLElement
  itemElement.focus()
  await item.trigger("keydown", { key: "Enter" })
  await flushPromises()
  const input = page().get('[role="dialog"] input')
  expect(document.activeElement).toBe(input.element)
  await input.trigger("keydown", { key: "Escape" })
  await flushPromises()
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  expect(document.activeElement).toBe(trigger.element)
})

test("a Team without machines opens its own settings and can add a machine", async () => {
  const fake = fakeCentral()
  mountShell(fake.central)
  await flushPromises()
  await page().get('button[aria-label="Team"]').trigger("click")
  await page().findAll('[role="menuitem"]').find(item => item.text() === "Team settings")!.trigger("click")
  await flushPromises()
  await vi.waitFor(() => expect(page().get("h1").text()).toBe("Design team"))
  expect(page().findAll("[data-member-id]")).toHaveLength(2)
  expect(router.currentRoute.value.path).toBe("/team/settings")
  expect(page().get('nav[aria-label="Settings sections"]').text()).not.toContain("Preferences")
  await buttonText("Add machine")!.trigger("click")
  await flushPromises()
  expect(page().get("[role=dialog] h2").text()).toBe("Add a machine to Design team")
  await buttonText("Cancel")!.trigger("click")
  await buttonText("Back to app")!.trigger("click")
  await vi.waitFor(() => expect(page().get("main h1").text()).toBe("Add a machine to Design team"))
  expect(fake.central.members).toHaveBeenCalledWith("team-1")
})

test.each([
  ["web", "admin", false], ["darwin", "member", false],
  ["web", "member", true], ["darwin", "admin", true],
] as const)("%s %s enters separate Team and ordinary settings and returns to the source (machine: %s)", async (platform, role, hasMachine) => {
  const fake = fakeCentral({
    teams: [{ id: "team-1", name: "Design team", role }],
    machines: hasMachine ? [machineFixture("m1", "team-1", "Build server")] : [],
  })
  withEmptyCatalogs(fake)
  mountShell(fake.central, platform)
  await settled(() => expect(page().find('button[aria-label="Team"]').exists()).toBe(true))
  const source = "/?from=settings-navigation"
  await router.push(source)
  await page().get('button[aria-label="Team"]').trigger("click")
  await page().findAll('[role="menuitem"]').find(item => item.text() === "Team settings")!.trigger("click")
  await settled(() => expect(page().get("h1").text()).toBe("Design team"))
  expect(router.currentRoute.value.path).toBe("/team/settings")
  const settingsLinks = () => page().findAll('nav[aria-label="Settings sections"] a')
  expect(settingsLinks().map(link => link.text())).toEqual(["Team settings", "Plans & Usages", "AI usage"])
  expect(page().find("[data-team-plan]").exists()).toBe(false)
  expect(fake.central.billing).not.toHaveBeenCalled()
  const navItem = (label: string) => settingsLinks().find(item => item.text() === label)!
  await navItem("Plans & Usages").trigger("click")
  await settled(() => expect(page().get("h1").text()).toBe("Plans & Usages"))
  expect(page().find("[data-team-plan]").exists()).toBe(true)
  expect(page().find("[data-member-id]").exists()).toBe(false)
  expect(fake.central.billing).toHaveBeenCalledExactlyOnceWith("team-1")
  expect(router.currentRoute.value.path).toBe("/team/settings/plans")
  const usageNavigation = vi.spyOn(router, "replace")
  await navItem("AI usage").trigger("click")
  expect(usageNavigation).toHaveBeenCalledExactlyOnceWith({ name: "team-settings-ai-usage" })
  // The first visit must load the lazy route and its chart modules before rendering.
  await usageNavigation.mock.results[0]!.value
  usageNavigation.mockRestore()
  await flushPromises()
  expect(page().get("h1").text()).toBe("AI usage")
  expect(router.currentRoute.value.path).toBe("/team/settings/ai-usage")
  expect(fake.central.aiUsage).toHaveBeenCalledExactlyOnceWith("team-1", { period: "30d", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  expect(page().find("[data-team-plan]").exists()).toBe(false)
  await navItem("Team settings").trigger("click")
  await flushPromises()
  expect(page().get("h1").text()).toBe("Design team")
  expect(page().find("[data-team-plan]").exists()).toBe(false)
  await buttonText("Back to app")!.trigger("click")
  await settled(() => expect(router.currentRoute.value.fullPath).toBe(source))
  await flushPromises()
  await page().get('button[aria-label="Settings"]').trigger("click")
  await settled(() => expect(page().get("h1").text()).toBe("Preferences"))
  expect(router.currentRoute.value.path).toBe("/settings/preferences")
  expect(settingsLinks().map(link => link.attributes("href"))).toEqual([
    "#/settings/preferences", "#/settings/appearance", "#/settings/notifications",
    ...(hasMachine ? ["#/settings/agents", "#/settings/mcp-servers"] : []),
    "#/settings/about",
  ])
  await navItem("Appearance").trigger("click")
  await settled(() => expect(page().get("h1").text()).toBe("Appearance"))
  await buttonText("Back to app")!.trigger("click")
  await settled(() => expect(router.currentRoute.value.fullPath).toBe(source))
})

test.each([
  ["web", false, "/team/settings", "Design team"],
  ["darwin", false, "/team/settings/plans", "Plans & Usages"],
  ["web", true, "/team/settings/plans", "Plans & Usages"],
  ["darwin", true, "/team/settings", "Design team"],
  ["web", false, "/team/settings/ai-usage", "AI usage"],
  ["darwin", true, "/team/settings/ai-usage", "AI usage"],
] as const)("%s opens direct Team settings (machine: %s, route: %s)", async (platform, hasMachine, path, title) => {
  const fake = fakeCentral({ machines: hasMachine ? [machineFixture("m1", "team-1", "Build server")] : [] })
  withEmptyCatalogs(fake)
  await router.push(path)
  mountShell(fake.central, platform)
  await flushPromises()
  await vi.waitFor(() => expect(page().get("h1").text()).toBe(title))
  expect(router.currentRoute.value.path).toBe(path)
  expect(page().findAll('nav[aria-label="Settings sections"] a').map(link => link.text())).toEqual(["Team settings", "Plans & Usages", "AI usage"])
  if (path === "/team/settings/ai-usage") expect(fake.central.aiUsage).toHaveBeenCalledExactlyOnceWith("team-1", { period: "30d", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
})

test.each([
  [false, false, "team-2"], [true, false, "team-2"],
  [true, true, "team-2"], [true, true, "team-1"],
] as const)("a Stripe return opens the paying Team's Plans & Usages (target machine: %s, initial machine: %s, target: %s)", async (hasMachine, initialMachine, target) => {
  const events = vi.spyOn(analytics, "trackEvent")
  const fake = fakeCentral({
    teams: [{ id: "team-1", name: "First team", role: "admin" }, { id: "team-2", name: "Paying team", role: "admin" }],
    machines: [...(hasMachine ? [machineFixture("m2", "team-2", "Build server")] : []), ...(initialMachine ? [machineFixture("m1", "team-1", "Initial server")] : [])],
  })
  withEmptyCatalogs(fake)
  history.replaceState(history.state, "", `${location.pathname}?team=${target}&settings=plans&billing_return=checkout_success${location.hash}`)
  mountShell(fake.central, "web")
  await flushPromises()
  await vi.waitFor(() => expect(page().get("h1").text()).toBe("Plans & Usages"))
  expect(page().get("section header").text()).toContain(target === "team-1" ? "First team" : "Paying team")
  expect(fake.central.billing).toHaveBeenCalledExactlyOnceWith(target)
  expect(location.search).toBe("")
  expect(router.currentRoute.value.path).toBe("/team/settings/plans")
  expect(events).toHaveBeenCalledWith("billing_returned", { source: "checkout_success" })
  expect(events.mock.calls.filter(([name]) => name === "billing_returned")).toHaveLength(1)
  expect(events.mock.calls.map(([name]) => name)).not.toContain("billing_invoice_paid")
})

test.each(["darwin", "web"] as const)("notification settings are available without machines (%s)", async (platform) => {
  const fake = fakeCentral()
  mountShell(fake.central, platform)
  await flushPromises()
  await page().get('button[aria-label="Settings"]').trigger("click")
  await flushPromises()
  const notifications = page().findAll('nav[aria-label="Settings sections"] a').find(link => link.text() === "Notifications")
  expect(notifications).toBeDefined()
  if (notifications) {
    await notifications.trigger("click")
    await flushPromises()
    await vi.waitFor(() => expect(page().get("h1").text()).toBe("Notifications"))
    expect(page().findAll('[role="switch"]')).toHaveLength(3)
    await buttonText("Back to app")!.trigger("click")
    await vi.waitFor(() => expect(page().get("main h1").text()).toBe("Add a machine to Design team"))
  }
})

test("a removed computer offers reconnection, which opens the new machine", async () => {
  const fake = fakeCentral({
    signedIn: false,
    teams: [{ id: "other", name: "Another team", role: "member" }, { id: "home", name: "Original team", role: "member" }],
    enrollment: { configured: true, connected: false, revoked: true, serverUrl: "https://fleet.example", teamId: "home", machineId: "old", identity: { originId: "old-origin", machineId: "1" }, machineName: "This computer" },
  })
  withEmptyCatalogs(fake)
  mountShell(fake.central)
  await flushPromises()
  await page().get("form").trigger("submit")
  await flushPromises()
  // Signing back in returns to the Team this computer belonged to.
  expect(page().get('button[aria-label="Team"]').text()).toContain("Original team")
  expect(view!.text()).toContain("This computer was removed from its team")
  await buttonText("Reconnect this computer")!.trigger("click")
  await flushPromises()
  await page().get('[role=dialog] [data-add-machine="local"]').trigger("click")
  await flushPromises()
  await page().get("[role=dialog] form").trigger("submit")
  await flushPromises()
  expect(fake.central.enrollLocal).toHaveBeenCalledExactlyOnceWith("home", "This computer")
  const machineId = fake.state.enrollment!.machineId!
  await vi.waitFor(() => expect(fake.central.catalog).toHaveBeenCalledWith(machineId))
  expect(view!.text()).not.toContain("This computer was removed from its team")
})

test("machines are listed and added from the workspace sidebar", async () => {
  const fake = fakeCentral({ machines: [machineFixture("m1", "team-1", "Build server"), machineFixture("m2", "team-1", "Laptop", false)] })
  withEmptyCatalogs(fake)
  mountShell(fake.central, "web")
  await flushPromises()
  await vi.waitFor(() => expect(page().find('aside button[data-machine-id="m2"]').exists()).toBe(true))
  expect(page().get('aside button[data-machine-id="m2"]').text()).toContain("Offline")
  await page().get('aside button[aria-label="Add machine"]').trigger("click")
  await flushPromises()
  expect(page().get("[role=dialog] h2").text()).toBe("Add a machine to Design team")
})

test("the open machine's heading follows a rename from any client", async () => {
  const fake = fakeCentral({ machines: [machineFixture("m1", "team-1", "build-01")] })
  withEmptyCatalogs(fake)
  mountShell(fake.central, "web")
  await flushPromises()
  await vi.waitFor(() => expect(page().get("aside").text()).toContain("build-01"))
  // Another client renamed the machine; the server announces a catalog change.
  fake.state.machines[0]!.name = "GPU runner"
  fake.emit({ type: "catalogChanged", machineId: "m1" } as never)
  await vi.waitFor(() => expect(page().get("aside").text()).toContain("GPU runner"))
  await flushPromises()
  expect(page().get("aside").text()).not.toContain("build-01")
})

test("the selected machine shows when central presence reports it offline", async () => {
  const fake = fakeCentral({ machines: [machineFixture("m1", "team-1", "Build server")] })
  withEmptyCatalogs(fake)
  mountShell(fake.central, "web")
  await flushPromises()
  await vi.waitFor(() => expect(fake.central.catalog).toHaveBeenCalledWith("m1"))
  await flushPromises()
  expect(page().get("aside").text()).not.toContain("Offline")
  fake.emit({ type: "presence", machineId: "m1", online: false } as never)
  await vi.waitFor(() => expect(page().get("aside").text()).toContain("Offline"))
})
