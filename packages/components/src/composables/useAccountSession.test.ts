import { flushPromises } from "@vue/test-utils"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { LocalEnrollment, Machine } from "@deskfleet/client/central"
import { centralRequestFailure } from "@deskfleet/client/request-diagnostics"
import { reportingCentral } from "@deskfleet/client/reporting-central"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { router } from "../router/index.ts"
import { createAccountSession, type AccountSession } from "./useAccountSession.ts"
import { captureAnalyticsContext, trackEvent } from "../services/analytics.ts"

vi.mock("../services/analytics.ts", () => { const trackEvent = vi.fn(); return { trackEvent, captureAnalyticsContext: vi.fn(() => trackEvent) } })

let session: AccountSession | undefined
beforeEach(() => vi.mocked(trackEvent).mockClear())
afterEach(() => { session?.dispose(); session = undefined; vi.restoreAllMocks() })
const enrollment = (value: Partial<LocalEnrollment> = {}): LocalEnrollment => ({
  configured: false, connected: false, revoked: false, identity: { originId: "local-origin", machineId: "1" }, machineName: "This Mac", ...value,
})

test("automatic reload failures and explicit sign-in failures retain different triggers", async () => {
  const fake = fakeCentral()
  const report = vi.fn()
  const failure = () => centralRequestFailure(new TypeError("fetch failed"), { method: "GET", path: "/api/me", elapsedMs: 10 })
  vi.mocked(fake.central.status).mockRejectedValueOnce(failure())
  session = createAccountSession(reportingCentral(fake.central, report))
  await flushPromises()
  expect(session.notice.value).toBe("fetch failed")
  expect(report.mock.calls[0]![0].diagnostics.trigger).toBe("background")
  vi.mocked(fake.central.login).mockRejectedValueOnce(failure())
  await expect(session.signIn()).rejects.toThrow("fetch failed")
  expect(report.mock.calls[1]![0].diagnostics.trigger).toBe("user")
})

test("opens this computer's Team and machine before any other", async () => {
  const fake = fakeCentral({
    teams: [{ id: "other", name: "Other", role: "member" }, { id: "home", name: "Home", role: "member" }],
    machines: [machineFixture("remote", "home", "Remote"), machineFixture("mine", "home", "Mine", false)],
    enrollment: enrollment({ configured: true, serverUrl: "https://fleet.example", teamId: "home", machineId: "mine" }),
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.ready.value).toBe(true)
  expect(session.team.value?.name).toBe("Home")
  expect(session.machine.value?.name).toBe("Mine")
  expect(session.localMachineId.value).toBe("mine")
})

test("otherwise opens a reachable machine, and presence updates it in place", async () => {
  const fake = fakeCentral({ machines: [machineFixture("a", "team-1", "Offline box", false), machineFixture("b", "team-1", "Online box")] })
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.machineId.value).toBe("b")
  fake.emit({ type: "presence", teamId: "team-1", machineId: "a", online: true } as never)
  expect(session.machines.value.find(machine => machine.id === "a")?.online).toBe(true)
})

test("opening a Session on the selected Machine navigates without replacing its scope", async () => {
  const fake = fakeCentral({ machines: [machineFixture("a", "team-1", "First")] })
  session = createAccountSession(fake.central)
  await flushPromises()
  const push = vi.spyOn(router, "push").mockResolvedValue(undefined)
  session.openSession("a", "30")
  expect(push).toHaveBeenCalledExactlyOnceWith({ name: "session", params: { sessionId: "30" } })
  expect(session.machineId.value).toBe("a")
  expect(session.takeSessionDestination("a")).toBeUndefined()
  session.openSession("unknown", "30")
  expect(push).toHaveBeenCalledTimes(1)
})

test("opening another Machine's Session hands its destination only to the selected new scope", async () => {
  const fake = fakeCentral({ machines: [machineFixture("a", "team-1", "First"), machineFixture("b", "team-1", "Second", false)] })
  session = createAccountSession(fake.central)
  await flushPromises()
  const push = vi.spyOn(router, "push").mockResolvedValue(undefined)
  session.openSession("b", "30")
  expect(session.machineId.value).toBe("b")
  expect(push).not.toHaveBeenCalled()
  expect(session.takeSessionDestination("a")).toBeUndefined()
  expect(session.takeSessionDestination("b")).toBe("30")
  expect(session.takeSessionDestination("b")).toBeUndefined()
})

test("search state survives a cross-machine result and resets when the Team changes", async () => {
  const fake = fakeCentral({
    teams: [{ id: "team-1", name: "First", role: "member" }, { id: "team-2", name: "Second", role: "member" }],
    machines: [machineFixture("a", "team-1", "First"), machineFixture("b", "team-1", "Second", false)],
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  session.searchPath.value = "/search?q=review&kind=chat"
  const destination = { name: "session", params: { sessionId: "30" }, query: { entry: "message-8" } }
  session.openMachineRoute("b", destination)
  expect(session.takeMachineDestination("b")).toEqual(destination)
  expect(session.searchPath.value).toBe("/search?q=review&kind=chat")
  await session.selectTeam("team-2")
  expect(session.searchPath.value).toBe("/search")
})

test("a newer Session selection replaces the destination of a Machine still mounting", async () => {
  const fake = fakeCentral({ machines: [machineFixture("a", "team-1", "First"), machineFixture("b", "team-1", "Second")] })
  session = createAccountSession(fake.central)
  await flushPromises()
  const push = vi.spyOn(router, "push").mockResolvedValue(undefined)
  session.openSession("b", "30")
  session.openSession("b", "31")
  expect(push).toHaveBeenCalledExactlyOnceWith({ name: "session", params: { sessionId: "31" } })
  expect(session.takeSessionDestination("b")).toBe("31")
})

test.each([
  { name: "session", params: { sessionId: "20" } },
  { name: "terminal", params: { terminalId: "10" } },
  { name: "machine-control", params: { machineId: "b" }, query: { tab: "terminal" } },
  { name: "new-session" },
])("opening another Machine's $name waits for its own scope before navigating", async destination => {
  const fake = fakeCentral({ machines: [machineFixture("a", "team-1", "First"), machineFixture("b", "team-1", "Second")] })
  session = createAccountSession(fake.central)
  await flushPromises()
  const push = vi.spyOn(router, "push").mockResolvedValue(undefined)
  session.openMachineRoute("b", destination)
  expect(session.machineId.value).toBe("b")
  expect(push).not.toHaveBeenCalled()
  expect(session.takeMachineDestination("a")).toBeUndefined()
  expect(session.takeMachineDestination("b")).toEqual(destination)
  expect(session.takeMachineDestination("b")).toBeUndefined()
  session.openMachineRoute("b", destination)
  expect(push).toHaveBeenCalledExactlyOnceWith(destination)
})

test("opening a terminal replaces a queued Session destination while its Machine mounts", async () => {
  const fake = fakeCentral({ machines: [machineFixture("a", "team-1", "First"), machineFixture("b", "team-1", "Second")] })
  session = createAccountSession(fake.central)
  await flushPromises()
  const push = vi.spyOn(router, "push").mockResolvedValue(undefined)
  session.openSession("b", "30")
  const terminal = { name: "terminal", params: { terminalId: "20" } }
  session.openMachineRoute("b", terminal)
  expect(push).toHaveBeenCalledExactlyOnceWith(terminal)
  expect(session.takeMachineDestination("b")).toEqual(terminal)
})

test.each(["machine", "same team", "other team", "sign out"] as const)("ordinary %s selection clears a queued Session destination", async action => {
  const fake = fakeCentral({
    teams: [{ id: "team-1", name: "First", role: "member" }, { id: "team-2", name: "Second", role: "member" }],
    machines: [machineFixture("a", "team-1", "First"), machineFixture("b", "team-1", "Second"), machineFixture("c", "team-2", "Third")],
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  session.openSession("b", "30")
  if (action === "machine") session.selectMachine("b")
  else if (action === "same team") await session.selectTeam("team-1")
  else if (action === "other team") await session.selectTeam("team-2")
  else await session.signOut()
  expect(session.takeSessionDestination("b")).toBeUndefined()
})

test("a removed Machine's queued destination is discarded when the roster selects another Machine", async () => {
  const fake = fakeCentral({ machines: [machineFixture("a", "team-1", "First"), machineFixture("b", "team-1", "Second")] })
  session = createAccountSession(fake.central)
  await flushPromises()
  session.openSession("b", "30")
  fake.state.machines = [fake.state.machines[0]!]
  await session.refreshMachines()
  expect(session.machineId.value).toBe("a")
  expect(session.takeSessionDestination("a")).toBeUndefined()
  expect(session.takeSessionDestination("b")).toBeUndefined()
})

test("Team roster notifications add, rename and remove machines without replacing a valid selection", async () => {
  const fake = fakeCentral()
  session = createAccountSession(fake.central)
  await flushPromises()
  fake.state.machines.push(machineFixture("a", "team-1", "New machine", false))
  fake.emit({ type: "machinesChanged", teamId: "another-team" })
  await flushPromises()
  expect(fake.central.machines).toHaveBeenCalledTimes(1)
  expect(session.machines.value).toEqual([])

  fake.emit({ type: "machinesChanged", teamId: "team-1" })
  await flushPromises()
  expect(session.machineId.value).toBe("a")
  fake.state.machines.push(machineFixture("b", "team-1", "Second machine"))
  fake.state.machines[0]!.name = "Renamed machine"
  fake.emit({ type: "machinesChanged", teamId: "team-1" })
  await flushPromises()
  expect(session.machines.value.map(machine => machine.name)).toEqual(["Renamed machine", "Second machine"])
  expect(session.machineId.value).toBe("a")

  fake.state.machines = fake.state.machines.filter(machine => machine.id !== "a")
  fake.emit({ type: "machinesChanged", teamId: "team-1" })
  await flushPromises()
  expect(session.machineId.value).toBe("b")
  fake.state.machines = []
  fake.emit({ type: "machinesChanged", teamId: "team-1" })
  await flushPromises()
  expect(session.machine.value).toBeUndefined()
  expect(session.machines.value).toEqual([])
})

test("reconnecting refreshes missed roster changes and this computer's enrollment", async () => {
  const fake = fakeCentral({
    machines: [machineFixture("mine", "team-1", "This computer"), machineFixture("other", "team-1", "Other machine")],
    enrollment: enrollment({ configured: true, serverUrl: "https://fleet.example", teamId: "team-1", machineId: "mine" }),
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.machineId.value).toBe("mine")
  fake.emit({ type: "connection", connected: false })
  fake.state.machines = fake.state.machines.filter(machine => machine.id !== "mine")
  fake.state.enrollment = { ...fake.state.enrollment!, revoked: true }
  fake.emit({ type: "connection", connected: true })
  await flushPromises()
  expect(session.machineId.value).toBe("other")
  expect(session.localMachineId.value).toBeUndefined()
  expect(session.canEnrollLocal.value).toBe(true)
})

test("a roster from before reconnect cannot complete reconciliation while the new reload is pending", async () => {
  const original = machineFixture("mine", "team-1", "This computer")
  const fake = fakeCentral({ machines: [original] })
  session = createAccountSession(fake.central)
  await flushPromises()
  const version = session.machineRosterVersion.value
  const stale = Promise.withResolvers<Machine[]>()
  vi.mocked(fake.central.machines).mockReturnValueOnce(stale.promise)
  const oldRefresh = session.refreshMachines()
  await flushPromises()
  const status = await fake.central.status()
  const pendingStatus = Promise.withResolvers<typeof status>()
  vi.mocked(fake.central.status).mockReturnValueOnce(pendingStatus.promise)
  fake.emit({ type: "connection", connected: false })
  fake.emit({ type: "connection", connected: true })
  stale.resolve([{ ...original, name: "Stale name" }])
  await oldRefresh
  expect(session.machineRosterVersion.value).toBeUndefined()
  expect(session.machine.value?.name).toBe(original.name)

  original.online = false
  pendingStatus.resolve(status)
  await flushPromises()
  expect(session.machineRosterVersion.value).toBeGreaterThan(version!)
  expect(session.machine.value?.online).toBe(false)
})

test("a slow machine list for a Team the user already left is discarded", async () => {
  const fake = fakeCentral({
    teams: [{ id: "first", name: "First", role: "admin" }, { id: "second", name: "Second", role: "admin" }],
    machines: [machineFixture("first-machine", "first", "First machine"), machineFixture("second-machine", "second", "Second machine")],
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  fake.central.machines.mockImplementationOnce(async teamId => {
    await held
    return fake.state.machines.filter(machine => machine.teamId === teamId)
  })
  const abandoned = session.selectTeam("second")
  await session.selectTeam("first")
  release()
  await abandoned
  expect(session.teamId.value).toBe("first")
  expect(session.machines.value.map(machine => machine.id)).toEqual(["first-machine"])
  expect(session.machine.value?.name).toBe("First machine")
})

test("member identities follow the selected Team, discard a late response after switching and clear on sign-out", async () => {
  const fake = fakeCentral({ teams: [{ id: "first", name: "First", role: "admin" }, { id: "second", name: "Second", role: "admin" }] })
  fake.central.members.mockImplementation(async teamId => [{ userId: teamId, name: `${teamId} member`, role: "member" }])
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.members.value.map(member => member.name)).toEqual(["first member"])
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  fake.central.members.mockImplementationOnce(async teamId => {
    await held
    return [{ userId: teamId, name: `${teamId} member`, role: "member" }]
  })
  const abandoned = session.selectTeam("second")
  expect(session.members.value).toEqual([])
  await session.selectTeam("first")
  release()
  await abandoned
  expect(session.members.value.map(member => member.name)).toEqual(["first member"])
  await session.signOut()
  expect(session.members.value).toEqual([])
})

test("connecting this computer selects its new machine; removing a machine reselects", async () => {
  const fake = fakeCentral({ machines: [machineFixture("server", "team-1", "Server")], enrollment: enrollment() })
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.canEnrollLocal.value).toBe(true)
  await session.enrollLocal("Studio Mac")
  expect(fake.central.enrollLocal).toHaveBeenCalledExactlyOnceWith("team-1", "Studio Mac")
  expect(session.machine.value?.name).toBe("Studio Mac")
  expect(session.canEnrollLocal.value).toBe(false)
  await session.removeMachine(session.machineId.value!)
  expect(session.machine.value?.name).toBe("Server")
  expect(session.enrollment.value?.revoked).toBe(true)
  expect(session.canEnrollLocal.value).toBe(true)
})

test("renaming keeps the open machine selected and rejects for its caller on failure", async () => {
  const fake = fakeCentral({ machines: [machineFixture("a", "team-1", "build-01"), machineFixture("b", "team-1", "laptop")] })
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.machineId.value).toBe("a")
  await session.renameMachine("a", "GPU runner")
  expect(fake.central.renameMachine).toHaveBeenCalledExactlyOnceWith("team-1", "a", "GPU runner")
  expect(session.machineId.value).toBe("a")
  expect(session.machine.value?.name).toBe("GPU runner")
  expect(session.machines.value.map(machine => machine.name)).toEqual(["GPU runner", "laptop"])
  fake.central.renameMachine.mockRejectedValueOnce(new Error("access denied"))
  await expect(session.renameMachine("b", "Taken")).rejects.toThrow("access denied")
  expect(session.machines.value[1]!.name).toBe("laptop")
})

test("user actions reject for their caller while background refreshes report a notice", async () => {
  const fake = fakeCentral()
  session = createAccountSession(fake.central)
  await flushPromises()
  fake.central.createTeam.mockRejectedValueOnce(new Error("Name taken"))
  await expect(session.createTeam("Design team")).rejects.toThrow("Name taken")
  expect(session.notice.value).toBeUndefined()
  fake.central.machines.mockRejectedValueOnce(new Error("Server unavailable"))
  await session.refreshMachines()
  expect(session.notice.value).toBe("Server unavailable")
})

test("creating and joining Teams select them; signing out clears every selection", async () => {
  const fake = fakeCentral({ teams: [] })
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.team.value).toBeUndefined()
  await session.createTeam("Platform")
  expect(session.team.value?.name).toBe("Platform")
  await session.joinTeam("code")
  expect(fake.central.acceptInvite).toHaveBeenCalledExactlyOnceWith("code")
  expect(vi.mocked(trackEvent).mock.calls).toEqual([
    ["team_join_action", { outcome: "attempt" }],
    ["team_join_action", { outcome: "success" }],
  ])
  expect(session.team.value?.name).toBe("Invited team")
  expect(session.teams.value).toHaveLength(2)
  await session.signOut()
  expect(session.account.value.user).toBeUndefined()
  expect(session.teams.value).toEqual([])
  expect(session.teamId.value).toBeUndefined()
})

test("a rejected invitation acceptance records failure without the code or server message", async () => {
  const fake = fakeCentral()
  fake.central.acceptInvite.mockRejectedValueOnce(new Error("Private invitation details"))
  session = createAccountSession(fake.central)
  await flushPromises()
  await expect(session.joinTeam("private-token")).rejects.toThrow("Private invitation details")
  expect(vi.mocked(trackEvent).mock.calls).toEqual([
    ["team_join_action", { outcome: "attempt" }],
    ["team_join_action", { outcome: "failure" }],
  ])
})

test("join completion uses the context captured before accepting the invite", async () => {
  const fake = fakeCentral()
  session = createAccountSession(fake.central)
  await flushPromises()
  const captured = vi.fn()
  vi.mocked(captureAnalyticsContext).mockReturnValueOnce(captured)
  const response = Promise.withResolvers<{ id: string; name: string; role: "member" }>()
  fake.central.acceptInvite.mockReturnValueOnce(response.promise)
  const operation = session.joinTeam("private-token")
  response.resolve({ id: "joined", name: "Joined", role: "member" })
  await operation
  expect(trackEvent).not.toHaveBeenCalled()
  expect(captured.mock.calls).toEqual([
    ["team_join_action", { outcome: "attempt" }],
    ["team_join_action", { outcome: "success" }],
  ])
})

test("accepted membership remains successful when its subsequent roster refresh fails", async () => {
  const fake = fakeCentral()
  session = createAccountSession(fake.central)
  await flushPromises()
  fake.central.teams.mockRejectedValueOnce(new Error("Roster unavailable"))
  await expect(session.joinTeam("private-token")).rejects.toThrow("Roster unavailable")
  expect(vi.mocked(trackEvent).mock.calls).toEqual([
    ["team_join_action", { outcome: "attempt" }],
    ["team_join_action", { outcome: "success" }],
  ])
})

test("account refresh updates site privileges and creation policy even without a Team", async () => {
  const fake = fakeCentral({ teams: [], siteAdmin: true })
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.account.value.siteAdmin).toBe(true)
  expect(session.site.value?.allowTeamCreation).toBe(true)
  fake.state.siteAdmin = false
  fake.state.site = { ...fake.state.site, siteName: "Changed site", announcement: "News", allowTeamCreation: false }
  fake.emit({ type: "connection", connected: true })
  await flushPromises()
  expect(session.account.value.siteAdmin).toBe(false)
  expect(session.site.value).toEqual(fake.state.site)
  const previous = session.site.value
  let finishSite!: (value: NonNullable<typeof previous>) => void
  fake.central.site.mockImplementationOnce(() => new Promise(resolve => { finishSite = resolve }))
  const refreshing = session.reload()
  await flushPromises()
  expect(session.site.value).toEqual(previous)
  finishSite({ siteName: "Still here", announcement: "", allowTeamCreation: true, termsOfServiceUrl: "", privacyTermsUrl: "" })
  await refreshing
  expect(session.site.value).toEqual({ siteName: "Still here", announcement: "", allowTeamCreation: true, termsOfServiceUrl: "", privacyTermsUrl: "" })
  fake.central.site.mockRejectedValueOnce(new Error("Site unavailable"))
  await expect(session.reload()).rejects.toThrow("Site unavailable")
  expect(session.site.value).toEqual({ siteName: "Still here", announcement: "", allowTeamCreation: true, termsOfServiceUrl: "", privacyTermsUrl: "" })
})

test("the same local Machine selects the current Team's registration and revocation state", async () => {
  const fake = fakeCentral({
    teams: [{ id: "first", name: "First", role: "admin" }, { id: "second", name: "Second", role: "admin" }],
    machines: [machineFixture("shared", "first", "First machine"), machineFixture("shared", "second", "Second machine")],
    enrollment: enrollment(),
  })
  const registrations = [
    enrollment({ configured: true, connected: true, serverUrl: "https://fleet.example", teamId: "first", machineId: "shared", identity: { originId: "first-origin", machineId: "1" } }),
    enrollment({ configured: true, connected: true, serverUrl: "https://fleet.example", teamId: "second", machineId: "shared", identity: { originId: "second-origin", machineId: "1" } }),
  ]
  fake.central.localEnrollment!.mockImplementation(async () => ({ machineName: "Host", registrations: structuredClone(registrations) }))
  session = createAccountSession(fake.central)
  await flushPromises()
  expect(session.teamId.value).toBe("first")
  expect(session.localMachineId.value).toBe("shared")
  expect(session.enrollment.value?.identity.originId).toBe("first-origin")
  expect(session.canEnrollLocal.value).toBe(false)
  await session.selectTeam("second")
  expect(session.localMachineId.value).toBe("shared")
  expect(session.enrollment.value?.identity.originId).toBe("second-origin")
  expect(session.machine.value?.name).toBe("Second machine")
  expect(session.canEnrollLocal.value).toBe(false)
  fake.emit({ type: "presence", teamId: "first", machineId: "shared", online: false })
  expect(session.machine.value?.online).toBe(true)

  registrations[0]!.revoked = true
  await session.refreshMachines()
  expect(session.canEnrollLocal.value).toBe(false)
  await session.selectTeam("first")
  expect(session.localMachineId.value).toBeUndefined()
  expect(session.enrollment.value?.identity.originId).toBe("first-origin")
  expect(session.canEnrollLocal.value).toBe(true)
  await session.selectTeam("second")
  expect(session.localMachineId.value).toBe("shared")
  expect(fake.central.enrollLocal).not.toHaveBeenCalled()
})

test.each(["team", "account"] as const)("a pending rename cannot change the same Machine ID after a %s switch", async change => {
  const fake = fakeCentral({
    teams: [{ id: "first", name: "First", role: "admin" }, { id: "second", name: "Second", role: "admin" }],
    machines: [machineFixture("shared", "first", "First machine"), machineFixture("shared", "second", "Second machine")],
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  const response = Promise.withResolvers<ReturnType<typeof machineFixture>>()
  fake.central.renameMachine.mockReturnValueOnce(response.promise)
  const renaming = session.renameMachine("shared", "A's new name")
  if (change === "team") await session.selectTeam("second")
  else {
    fake.central.status.mockResolvedValueOnce({ ...session.account.value, user: { id: "user-2", name: "Bob", email: "bob@example.test" } })
    await session.reload()
  }
  const selected = session.machine.value!.name
  response.resolve(machineFixture("shared", "first", "A's new name"))
  await renaming
  expect(fake.central.renameMachine).toHaveBeenCalledExactlyOnceWith("first", "shared", "A's new name")
  expect(session.machine.value!.name).toBe(selected)
})

test("removing a Team's registration cannot reset another Team's selection after switching", async () => {
  const fake = fakeCentral({
    teams: [{ id: "first", name: "First", role: "admin" }, { id: "second", name: "Second", role: "admin" }],
    machines: [machineFixture("shared", "first", "First machine"), machineFixture("other", "second", "Other machine"), machineFixture("shared", "second", "Second machine")],
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  const response = Promise.withResolvers<void>()
  fake.central.removeMachine.mockReturnValueOnce(response.promise)
  const removing = session.removeMachine("shared")
  await session.selectTeam("second")
  session.selectMachine("shared")
  const reads = fake.central.machines.mock.calls.length
  response.resolve()
  await removing
  expect(session.machineId.value).toBe("shared")
  expect(session.machine.value!.name).toBe("Second machine")
  expect(fake.central.machines).toHaveBeenCalledTimes(reads)
})

test("local enrollment completion keeps the selection made after changing Teams", async () => {
  const fake = fakeCentral({
    teams: [{ id: "first", name: "First", role: "admin" }, { id: "second", name: "Second", role: "admin" }],
    machines: [machineFixture("shared", "second", "Second machine"), machineFixture("other", "second", "Other machine")],
    enrollment: enrollment(),
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  const response = Promise.withResolvers<LocalEnrollment>()
  fake.central.enrollLocal!.mockReturnValueOnce(response.promise)
  const enrolling = session.enrollLocal("First machine")
  await session.selectTeam("second")
  session.selectMachine("other")
  response.resolve(enrollment({ configured: true, serverUrl: "https://fleet.example", teamId: "first", machineId: "shared" }))
  await enrolling
  expect(session.machineId.value).toBe("other")
  expect(session.machine.value!.name).toBe("Other machine")
})
