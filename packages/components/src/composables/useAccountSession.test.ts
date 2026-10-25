import { flushPromises } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import type { LocalEnrollment } from "@deskfleet/client/central"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { createAccountSession, type AccountSession } from "./useAccountSession.ts"

let session: AccountSession | undefined
afterEach(() => { session?.dispose(); session = undefined })
const enrollment = (value: Partial<LocalEnrollment> = {}): LocalEnrollment => ({
  configured: false, connected: false, revoked: false, identity: { originId: "local-origin", machineId: "1" }, machineName: "This Mac", ...value,
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
  fake.emit({ type: "presence", machineId: "a", online: true } as never)
  expect(session.machines.value.find(machine => machine.id === "a")?.online).toBe(true)
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
  expect(fake.central.renameMachine).toHaveBeenCalledExactlyOnceWith("a", "GPU runner")
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
  expect(session.team.value?.name).toBe("Invited team")
  expect(session.teams.value).toHaveLength(2)
  await session.signOut()
  expect(session.account.value.user).toBeUndefined()
  expect(session.teams.value).toEqual([])
  expect(session.teamId.value).toBeUndefined()
})
