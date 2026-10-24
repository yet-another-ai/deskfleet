import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { configureClient, getClient } from "@deskfleet/client/platform"
import type { CentralApi, CentralEvent, Machine } from "@deskfleet/client/central"
import { i18n } from "./i18n/index.ts"
import { router } from "./router/index.ts"
import AccountShell from "./AccountShell.vue"
import { agentEvent, agentInput, agentSnapshot } from "./test/agent.ts"

const host = getClient()
let view: VueWrapper | undefined
afterEach(async () => { view?.unmount(); view = undefined; configureClient(host); await router.replace("/"); vi.restoreAllMocks() })

test("browses synchronized history with the machine offline and isolates equal local IDs when switching machines", async () => {
  const listeners = new Set<(event: CentralEvent) => void>()
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
    status: vi.fn(async () => ({ serverUrl: "https://fleet.example", user: { id: "u1", name: "Ada" } })),
    teams: vi.fn(async () => [{ id: "7", name: "Team", role: "member" }]),
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
  await view.get('select[aria-label="Machine"]').setValue("102"); await flushPromises()
  await router.push("/sessions/30"); await flushPromises()
  await vi.waitFor(() => expect(view!.text()).toContain("Workspace 102"))
  await vi.waitFor(() => expect(view!.text()).toContain("Message from 102"))
  expect(view.text()).not.toContain("Message from 101")
  expect(central.createPeer).not.toHaveBeenCalled()
})

function enrollmentFixture({ revoked = false, initiallySignedIn = true, configured = true, role = "admin" }: { revoked?: boolean; initiallySignedIn?: boolean; configured?: boolean; role?: "admin" | "member" } = {}) {
  let signedIn = initiallySignedIn
  let enrollment = { configured, connected: false, revoked, serverUrl: "https://fleet.example", machineId: "old-machine", teamId: "original-team", identity: { originId: "old-origin", machineId: "1" }, machineName: "This computer" }
  const state = () => ({ serverUrl: "https://fleet.example", user: signedIn ? { id: "u1", name: "Ada" } : undefined })
  const central = {
    status: vi.fn(async () => state()), setServer: vi.fn(async () => state()),
    login: vi.fn(async () => { signedIn = true }),
    teams: vi.fn(async () => [{ id: "other-team", name: "Another team", role }, { id: "original-team", name: "Original team", role }]),
    machines: vi.fn(async () => []), onEvent: () => () => {},
    localEnrollment: vi.fn(async () => enrollment),
    enrollLocal: vi.fn(async (teamId: string) => { enrollment = { ...enrollment, configured: true, teamId, machineId: "fresh-machine", identity: { originId: "fresh-origin", machineId: "1" }, revoked: false }; return enrollment }),
    enrollHeadless: vi.fn(async () => ({ machine: { id: "headless-machine" }, token: "enrollment-token" })),
  } as unknown as CentralApi
  return { central, revoke: () => { enrollment = { ...enrollment, revoked: true } } }
}

test("signing back in offers the original team and re-registers a revoked computer", async () => {
  const f = enrollmentFixture({ revoked: true, initiallySignedIn: false })
  view = mount(AccountShell, { props: { host: { ...host, central: f.central } }, global: { plugins: [i18n] } })
  await flushPromises()
  await view.get('form').trigger("submit")
  await flushPromises()
  expect(view.get('select[aria-label="Team"]').element).toHaveProperty("value", "original-team")
  expect(view.text()).toContain("This computer was removed from its team")
  const button = view.findAll("button").find(button => button.text() === "Reconnect this computer to the team")!
  await button.trigger("click")
  await flushPromises()
  expect(f.central.enrollLocal).toHaveBeenCalledExactlyOnceWith("original-team")
  expect(view.text()).not.toContain("This computer was removed from its team")
  expect(view.text()).toContain("This computer is already enrolled")
})

test("an active registration stays protected and Refresh discovers its later revocation", async () => {
  const f = enrollmentFixture()
  view = mount(AccountShell, { props: { host: { ...host, central: f.central } }, global: { plugins: [i18n] } })
  await flushPromises()
  expect(view.text()).not.toContain("Reconnect this computer to the team")
  expect(view.text()).toContain("This computer is already enrolled")
  f.revoke()
  await view.findAll("button").find(button => button.text() === "Refresh")!.trigger("click")
  await flushPromises()
  expect(view.text()).toContain("Reconnect this computer to the team")
  expect(f.central.enrollLocal).not.toHaveBeenCalled()
})

test.each([false, true])("a team member can enroll their local computer (revoked=%s)", async revoked => {
  const f = enrollmentFixture({ role: "member", configured: revoked, revoked })
  view = mount(AccountShell, { props: { host: { ...host, central: f.central } }, global: { plugins: [i18n] } })
  await flushPromises()
  const label = revoked ? "Reconnect this computer to the team" : "Connect this computer to the team"
  const buttons = view.findAll("button").filter(button => button.text() === label)
  expect(buttons).toHaveLength(2)
  await buttons[1]!.trigger("click")
  await flushPromises()
  expect(f.central.enrollLocal).toHaveBeenCalledExactlyOnceWith("original-team")
  expect(view.text()).toContain("This computer is already enrolled")
})

test("a team member can enroll a headless machine from the Web client", async () => {
  const f = enrollmentFixture({ role: "member" })
  const central = { ...f.central, localEnrollment: undefined, enrollLocal: undefined }
  view = mount(AccountShell, { props: { host: { ...host, platform: "web", central } }, global: { plugins: [i18n] } })
  await flushPromises()
  await view.get('select[aria-label="Team"]').setValue("original-team")
  await flushPromises()
  await view.findAll("button").find(button => button.text() === "Enroll headless machine")!.trigger("click")
  const form = view.get("dialog form")
  const inputs = form.findAll("input")
  await inputs[0]!.setValue("SSH server")
  await inputs[1]!.setValue("server-origin")
  await inputs[2]!.setValue("1")
  await form.trigger("submit")
  await flushPromises()
  expect(f.central.enrollHeadless).toHaveBeenCalledExactlyOnceWith("original-team", { name: "SSH server", originId: "server-origin", localMachineId: "1" })
  expect(JSON.parse((view.get("dialog textarea").element as HTMLTextAreaElement).value)).toEqual({ machineId: "headless-machine", teamId: "original-team", token: "enrollment-token" })
})
