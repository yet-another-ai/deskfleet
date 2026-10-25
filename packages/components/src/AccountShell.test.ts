import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { configureClient, getClient } from "@deskfleet/client/platform"
import type { CentralApi, CentralEvent, Machine } from "@deskfleet/client/central"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import AccountShell from "./AccountShell.vue"
import { agentEvent, agentInput, agentSnapshot } from "./test/agent.ts"
import { fakeCentral, machineFixture } from "./test/central.ts"

const host = getClient()
let view: VueWrapper | undefined
afterEach(async () => { view?.unmount(); view = undefined; configureClient(host); await router.replace("/"); vi.restoreAllMocks() })

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
    setServer: vi.fn(), login: vi.fn(async () => { signedIn = true }), logout: vi.fn(async () => { signedIn = false }),
    teams: vi.fn(async () => [{ id: "7", name: "Team", role: "member" }]),
    members: vi.fn(async () => [{ userId: "u1", name: "Ada", role: "member" }]),
    machines: vi.fn(async () => machines),
    onEvent: (listener: (event: CentralEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    catalog: vi.fn(async (machineId: string) => ({ machineId, lastObservedAt: "2026-10-25T00:00:00Z", providers: { providers: [{ id: "codex", name: "Codex", template: "codex" }] }, snapshot: {
      teamId: "1", machineId: "1", machineName: machines.find(machine => machine.id === machineId)!.name,
      workspaces: [{ id: "20", name: `Workspace ${machineId}`, worktrees: [{ id: "21", workspaceId: "20", directories: [{ path: "/code" }] }, { id: "31", workspaceId: "20", sessionId: "30", directories: [{ path: "/worktree" }] }] }],
    } })),
    sessions: vi.fn(async (machineId: string) => [snapshot(machineId)]),
    session: vi.fn(async (machineId: string) => ({ snapshot: snapshot(machineId), lastEventSeq: "1", lastObservedAt: "2026-10-25T00:00:00Z" })),
    events: vi.fn(async (machineId: string) => ({ events: [agentEvent(1, "input", snapshot(machineId).inputs[0]!)], lastEventSeq: "1" })),
    rpc: vi.fn(async () => { throw new Error("Offline") }), createPeer: vi.fn(),
  } as unknown as CentralApi
  view = mount(AccountShell, { props: { host: { ...host, platform: "web", central } }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 101"))
  expect(view.text()).toContain("Conversation 101")
  await router.push("/sessions/30"); await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Message from 101"))
  expect(central.createPeer).not.toHaveBeenCalled()
  // Other Team machines are collapsed sidebar groups; opening one switches machines.
  expect(view.find('aside button[data-machine-id="101"]').exists()).toBe(false)
  await view.get('aside button[data-machine-id="102"]').trigger("click"); await flushPromises()
  await router.push("/sessions/30"); await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 102"))
  await vi.waitFor(() => expect(view!.text()).toContain("Message from 102"))
  expect(view.text()).not.toContain("Message from 101")
  expect(central.createPeer).not.toHaveBeenCalled()
  await view.get('button[aria-label="Ada"]').trigger("click")
  await view.findAll('button[role="menuitem"]').find(button => button.text() === "Sign out")!.trigger("click")
  await flushPromises()
  expect(view.text()).toContain("Sign in to deskfleet")
  expect(view.text()).not.toContain("Workspace 102")
  await view.get("form").trigger("submit")
  await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 101"))
})

const mountShell = (central: CentralApi, platform: "web" | "darwin" = "darwin") => {
  view = mount(AccountShell, { props: { host: { ...host, platform, central } }, global: { plugins: [i18n] }, attachTo: document.body })
}
const buttonText = (text: string) => view!.findAll("button").find(button => button.text() === text)
/**
 * Machine views read synchronized catalogs and history; these machines have none.
 * Like the server, the catalog names each machine with its Team name.
 */
function withEmptyCatalogs({ central, state }: ReturnType<typeof fakeCentral>): void {
  Object.assign(central, {
    catalog: vi.fn(async (machineId: string) => ({ machineId, lastObservedAt: "2026-10-25T00:00:00Z", snapshot: { teamId: "team-1", machineId, machineName: state.machines.find(machine => machine.id === machineId)?.name ?? "hostname", workspaces: [] } })),
    sessions: vi.fn(async () => []),
    rpc: vi.fn(async () => { throw new Error("Offline") }),
  })
}

test("a user without a Team creates one from onboarding and is asked to add a machine", async () => {
  const fake = fakeCentral({ teams: [] })
  mountShell(fake.central, "web")
  await flushPromises()
  expect(view!.find('button[aria-label="Team"]').exists()).toBe(false)
  expect(view!.text()).toContain("Welcome, Ada")
  await buttonText("Create a teamStart a new team and invite others to it.")!.trigger("click")
  await flushPromises()
  expect(document.activeElement).toBe(view!.get('dialog[open] [name="team-name"]').element)
  fake.central.createTeam.mockRejectedValueOnce(new Error("Name taken"))
  await view!.get('dialog[open] [name="team-name"]').setValue("Platform")
  await view!.get("dialog[open] form").trigger("submit")
  await flushPromises()
  // The failure belongs to the dialog, not the sidebar.
  expect(view!.get('dialog[open] [role="alert"]').text()).toBe("Name taken")
  expect(view!.findAll('[role="alert"]')).toHaveLength(1)
  await view!.get("dialog[open] form").trigger("submit")
  await flushPromises()
  expect(view!.find("dialog").exists()).toBe(false)
  expect(view!.get('button[aria-label="Team"]').text()).toContain("Platform")
  expect(view!.get("main h1").text()).toBe("Add a machine to Platform")
})

test("joining from the Team menu selects the joined Team", async () => {
  const fake = fakeCentral()
  mountShell(fake.central, "web")
  await flushPromises()
  const trigger = view!.get('button[aria-label="Team"]')
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  expect(document.activeElement).toBe(view!.get('[data-team-id="team-1"]').element)
  await view!.get('[role="menu"]').trigger("keydown", { key: "Escape" })
  expect(document.activeElement).toBe(trigger.element)
  await trigger.trigger("click")
  await view!.findAll('[role="menuitem"]').find(item => item.text() === "Join a team")!.trigger("click")
  await flushPromises()
  await view!.get('dialog[open] [name="invite-code"]').setValue(" invitation-code ")
  await view!.get("dialog[open] form").trigger("submit")
  await flushPromises()
  expect(fake.central.acceptInvite).toHaveBeenCalledExactlyOnceWith("invitation-code")
  expect(trigger.text()).toContain("Invited team")
})

test("a Team without machines still opens Team settings beside Preferences", async () => {
  const fake = fakeCentral()
  mountShell(fake.central)
  await flushPromises()
  await view!.get('button[aria-label="Team"]').trigger("click")
  await view!.findAll('[role="menuitem"]').find(item => item.text() === "Team settings")!.trigger("click")
  await flushPromises()
  expect(view!.get("h1").text()).toBe("Design team")
  expect(view!.findAll("[data-member-id]")).toHaveLength(2)
  expect(view!.get('nav[aria-label="Settings sections"]').text()).toContain("Preferences")
  await buttonText("Add machine")!.trigger("click")
  await flushPromises()
  expect(view!.get("dialog[open] h2").text()).toBe("Add a machine to Design team")
  await buttonText("Cancel")!.trigger("click")
  await buttonText("Back to app")!.trigger("click")
  expect(view!.get("main h1").text()).toBe("Add a machine to Design team")
  expect(fake.central.members).toHaveBeenCalledWith("team-1")
})

test.each(["darwin", "web"] as const)("notification settings are available without machines only on desktop (%s)", async (platform) => {
  const fake = fakeCentral()
  mountShell(fake.central, platform)
  await flushPromises()
  await view!.get('button[aria-label="Settings"]').trigger("click")
  await flushPromises()
  const notifications = view!.findAll('nav[aria-label="Settings sections"] button').find(button => button.text() === "Notifications")
  expect(!!notifications).toBe(platform !== "web")
  if (notifications) {
    await notifications.trigger("click")
    await flushPromises()
    expect(view!.get("h1").text()).toBe("Notifications")
    expect(view!.findAll('[role="switch"]')).toHaveLength(3)
    await buttonText("Back to app")!.trigger("click")
    expect(view!.get("main h1").text()).toBe("Add a machine to Design team")
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
  await view!.get("form").trigger("submit")
  await flushPromises()
  // Signing back in returns to the Team this computer belonged to.
  expect(view!.get('button[aria-label="Team"]').text()).toContain("Original team")
  expect(view!.text()).toContain("This computer was removed from its team")
  await buttonText("Reconnect this computer")!.trigger("click")
  await flushPromises()
  await view!.get('dialog[open] [data-add-machine="local"]').trigger("click")
  await flushPromises()
  await view!.get("dialog[open] form").trigger("submit")
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
  await vi.waitFor(() => expect(view!.find('aside button[data-machine-id="m2"]').exists()).toBe(true))
  expect(view!.get('aside button[data-machine-id="m2"]').text()).toContain("Offline")
  await view!.get('aside button[aria-label="Add machine"]').trigger("click")
  await flushPromises()
  expect(view!.get("dialog[open] h2").text()).toBe("Add a machine to Design team")
})

test("the open machine's heading follows a rename from any client", async () => {
  const fake = fakeCentral({ machines: [machineFixture("m1", "team-1", "build-01")] })
  withEmptyCatalogs(fake)
  mountShell(fake.central, "web")
  await flushPromises()
  await vi.waitFor(() => expect(view!.get("aside").text()).toContain("build-01"))
  // Another client renamed the machine; the server announces a catalog change.
  fake.state.machines[0]!.name = "GPU runner"
  fake.emit({ type: "catalogChanged", machineId: "m1" } as never)
  await vi.waitFor(() => expect(view!.get("aside").text()).toContain("GPU runner"))
  await flushPromises()
  expect(view!.get("aside").text()).not.toContain("build-01")
})

test("the selected machine shows when central presence reports it offline", async () => {
  const fake = fakeCentral({ machines: [machineFixture("m1", "team-1", "Build server")] })
  withEmptyCatalogs(fake)
  mountShell(fake.central, "web")
  await flushPromises()
  await vi.waitFor(() => expect(fake.central.catalog).toHaveBeenCalledWith("m1"))
  await flushPromises()
  expect(view!.get("aside").text()).not.toContain("Offline")
  fake.emit({ type: "presence", machineId: "m1", online: false } as never)
  await vi.waitFor(() => expect(view!.get("aside").text()).toContain("Offline"))
})
