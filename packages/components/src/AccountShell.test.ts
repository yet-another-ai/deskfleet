import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { configureClient, getClient } from "@deskfleet/client/platform"
import type { CentralApi, CentralEvent, Machine } from "@deskfleet/client/central"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import AccountShell from "./AccountShell.vue"
import { agentEvent, agentInput, agentSnapshot } from "./test/agent.ts"
import { fakeCentral, machineFixture } from "./test/central.ts"

const host = getClient()
const page = () => new DOMWrapper(document.body)
let view: VueWrapper | undefined
let pinia: Pinia
beforeEach(() => { pinia = createPinia() })
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
    site: vi.fn(async () => ({ siteName: "deskfleet", announcement: "", allowTeamCreation: true })),
    setServer: vi.fn(), login: vi.fn(async () => { signedIn = true }), logout: vi.fn(async () => { signedIn = false }),
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
  view = mount(AccountShell, { props: { host: { ...host, platform: "web", central } }, global: { plugins: [pinia, i18n] }, attachTo: document.body })
  await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 101"))
  expect(view.text()).toContain("Conversation 101")
  await router.push("/sessions/30"); await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Message from 101"))
  expect(central.createPeer).not.toHaveBeenCalled()
  // Other Team machines are collapsed sidebar groups; opening one switches machines.
  expect(page().find('aside button[data-machine-id="101"]').exists()).toBe(false)
  await page().get('aside button[data-machine-id="102"]').trigger("click"); await flushPromises()
  await router.push("/sessions/30"); await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 102"))
  await vi.waitFor(() => expect(view!.text()).toContain("Message from 102"))
  expect(view.text()).not.toContain("Message from 101")
  expect(central.createPeer).not.toHaveBeenCalled()
  await page().get('button[aria-label="Ada"]').trigger("click")
  await page().findAll('button[role="menuitem"]').find(button => button.text() === "Sign out")!.trigger("click")
  await flushPromises()
  expect(view.text()).toContain("Sign in to deskfleet")
  expect(view.text()).not.toContain("Workspace 102")
  await page().get("form").trigger("submit")
  await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 101"))
})

const mountShell = (central: CentralApi, platform: "web" | "darwin" = "darwin") => {
  view = mount(AccountShell, { props: { host: { ...host, platform, central } }, global: { plugins: [pinia, i18n] }, attachTo: document.body })
}
const buttonText = (text: string) => page().findAll("button").find(button => button.text() === text)
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

test("a Team without machines still opens Team settings beside Preferences", async () => {
  const fake = fakeCentral()
  mountShell(fake.central)
  await flushPromises()
  await page().get('button[aria-label="Team"]').trigger("click")
  await page().findAll('[role="menuitem"]').find(item => item.text() === "Team settings")!.trigger("click")
  await flushPromises()
  expect(page().get("h1").text()).toBe("Design team")
  expect(page().findAll("[data-member-id]")).toHaveLength(2)
  expect(page().get('nav[aria-label="Settings sections"]').text()).toContain("Preferences")
  await buttonText("Add machine")!.trigger("click")
  await flushPromises()
  expect(page().get("[role=dialog] h2").text()).toBe("Add a machine to Design team")
  await buttonText("Cancel")!.trigger("click")
  await buttonText("Back to app")!.trigger("click")
  expect(page().get("main h1").text()).toBe("Add a machine to Design team")
  expect(fake.central.members).toHaveBeenCalledWith("team-1")
})

test.each(["darwin", "web"] as const)("notification settings are available without machines (%s)", async (platform) => {
  const fake = fakeCentral()
  mountShell(fake.central, platform)
  await flushPromises()
  await page().get('button[aria-label="Settings"]').trigger("click")
  await flushPromises()
  const notifications = page().findAll('nav[aria-label="Settings sections"] button').find(button => button.text() === "Notifications")
  expect(notifications).toBeDefined()
  if (notifications) {
    await notifications.trigger("click")
    await flushPromises()
    expect(page().get("h1").text()).toBe("Notifications")
    expect(page().findAll('[role="switch"]')).toHaveLength(3)
    await buttonText("Back to app")!.trigger("click")
    expect(page().get("main h1").text()).toBe("Add a machine to Design team")
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
