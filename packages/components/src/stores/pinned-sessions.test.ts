import { configureClient, getClient } from "@deskfleet/client/platform"
import { flushPromises } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { createApp, ref } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../composables/useAccountSession.ts"
import { agentSnapshot } from "../test/agent.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { deferred } from "../test/desktop-media.ts"
import { useAgentSessionsStore } from "./agent-sessions.ts"
import { useFleetStore } from "./fleet.ts"
import type { MachineSummary } from "./fleet-types.ts"
import { usePinnedSessionsStore } from "./pinned-sessions.ts"

const originalClient = getClient()
const piniaScopes: Pinia[] = []
const accounts: AccountSession[] = []
beforeEach(() => localStorage.clear())
afterEach(() => {
  for (const pinia of piniaScopes.splice(0)) disposePinia(pinia)
  for (const account of accounts.splice(0)) account.dispose()
  configureClient(originalClient)
  localStorage.clear()
})

async function accountFixture() {
  const fake = fakeCentral({
    teams: [{ id: "team-1", name: "First", role: "admin" }, { id: "team-2", name: "Second", role: "admin" }],
    machines: [machineFixture("m1", "team-1", "Laptop"), machineFixture("m2", "team-1", "Server", false), machineFixture("m3", "team-2", "Second Team")],
  })
  const snapshot = agentSnapshot()
  snapshot.session = { ...snapshot.session, title: "Remote investigation", archiveState: "active" }
  const session = vi.fn(async () => ({ snapshot: structuredClone(snapshot), lastEventSeq: "0", lastObservedAt: "now" }))
  fake.central.session = session
  const account = createAccountSession(fake.central)
  accounts.push(account)
  await flushPromises()
  return { fake, account, session, snapshot }
}

function fixture(account?: AccountSession, target = "m1") {
  configureClient({ ...originalClient, target: { id: target, local: false } })
  const pinia = createPinia()
  piniaScopes.push(pinia)
  const app = createApp({}).use(pinia)
  if (account) app.provide(accountSessionKey, account)
  const store = app.runWithContext(() => usePinnedSessionsStore(pinia))
  return { store, pinia, fleet: useFleetStore(pinia), agents: useAgentSessionsStore(pinia) }
}

test("pins distinguish equal Session IDs on different machines, persist across machine scopes, and unpin independently", async () => {
  const { account, session } = await accountFixture()
  const first = fixture(account)
  first.agents.sessions["30"] = { ...agentSnapshot().session, workspaceId: undefined, title: "Laptop investigation" }
  first.store.pin("m1", "30", "Laptop investigation")
  first.store.pin("m2", "30", "Server investigation")
  first.store.pin("m1", "30", "Duplicate")
  await flushPromises()
  expect(first.store.pins).toHaveLength(2)
  expect(first.store.items.map(item => [item.machineId, item.title, item.loaded, item.online, item.archiveState])).toEqual([
    ["m1", "Laptop investigation", true, true, "active"],
    ["m2", "Remote investigation", false, false, "active"],
  ])
  expect(session).toHaveBeenCalledExactlyOnceWith("m2", "30")
  disposePinia(first.pinia)
  const second = fixture(account, "m2")
  expect(second.store.isPinned("m1", "30")).toBe(true)
  expect(second.store.isPinned("m2", "30")).toBe(true)
  second.store.unpin("m2", "30")
  expect(second.store.pins.map(pin => pin.machineId)).toEqual(["m1"])
})

test("pins are scoped by server, account, and Team and disappear while signed out", async () => {
  const { account } = await accountFixture()
  const { store } = fixture(account)
  store.pin("m1", "30", "First Team title")
  await account.selectTeam("team-2")
  expect(store.pins).toEqual([])
  store.pin("m3", "30", "Second Team title")
  await account.selectTeam("team-1")
  expect(store.pins.map(pin => pin.title)).toEqual(["First Team title"])
  const user = account.account.value.user!
  account.account.value = { ...account.account.value, user: { ...user, id: "someone-else" } }
  await flushPromises()
  expect(store.pins).toEqual([])
  store.pin("m1", "30", "Another user's title")
  await flushPromises()
  account.account.value = { ...account.account.value, user }
  await flushPromises()
  expect(store.pins.map(pin => pin.title)).toEqual(["First Team title"])
  account.account.value = { ...account.account.value, serverUrl: "https://another.example" }
  await flushPromises()
  expect(store.pins).toEqual([])
  account.account.value = { ...account.account.value, serverUrl: "https://fleet.example", user: undefined }
  await flushPromises()
  expect(store.pins).toEqual([])
  store.pin("m1", "40", "Cannot pin while signed out")
  account.account.value = { ...account.account.value, user }
  await flushPromises()
  expect(store.pins.map(pin => pin.title)).toEqual(["First Team title"])
})

test("live local titles update pins immediately and their cached titles survive an unavailable remote read", async () => {
  const { account, session } = await accountFixture()
  const first = fixture(account)
  first.agents.sessions["30"] = { ...agentSnapshot().session, workspaceId: undefined, title: "Initial name" }
  first.store.pin("m1", "30", "Initial name")
  first.agents.sessions["30"]!.title = "Renamed locally"
  expect(first.store.items[0]?.title).toBe("Renamed locally")
  await flushPromises()
  expect(first.store.pins[0]?.title).toBe("Renamed locally")
  disposePinia(first.pinia)
  session.mockRejectedValueOnce(new Error("History unavailable"))
  const second = fixture(account, "m2")
  await flushPromises()
  expect(second.store.items[0]?.title).toBe("Renamed locally")
  expect(second.store.items[0]?.loaded).toBe(false)
})

test("completed local archives persistently unpin, cannot be pinned, and do not re-pin on restore", async () => {
  const { account } = await accountFixture()
  const first = fixture(account)
  first.agents.sessions["30"] = { ...agentSnapshot().session, workspaceId: undefined }
  first.store.pin("m1", "30", "Local investigation")
  first.agents.sessions["30"]!.archiveState = "archiving"
  await flushPromises()
  expect(first.store.isPinned("m1", "30")).toBe(true)
  first.agents.sessions["30"]!.archiveState = "archived"
  await flushPromises()
  expect(first.store.pins).toEqual([])
  expect(first.store.items).toEqual([])
  first.store.pin("m1", "30", "Cannot pin archived")
  expect(first.store.isPinned("m1", "30")).toBe(false)
  first.agents.sessions["30"]!.archiveState = "active"
  await flushPromises()
  expect(first.store.isPinned("m1", "30")).toBe(false)
  disposePinia(first.pinia)
  const second = fixture(account, "m2")
  expect(second.store.pins).toEqual([])
})

test("remote archive notifications unpin only that machine's Session and prevent pinning it again", async () => {
  const { account, fake, snapshot } = await accountFixture()
  const { store, agents } = fixture(account)
  agents.sessions["30"] = { ...agentSnapshot().session, workspaceId: undefined, title: "Local investigation" }
  store.pin("m1", "30", "Local investigation")
  store.pin("m2", "30", "Remote investigation")
  await flushPromises()
  expect(store.pins).toHaveLength(2)
  snapshot.session.archiveState = "archived"
  fake.emit({ type: "catalogChanged", machineId: "m2", sessionId: "30" })
  await flushPromises()
  expect(store.pins.map(pin => [pin.machineId, pin.sessionId])).toEqual([["m1", "30"]])
  store.pin("m2", "30", "Cannot pin archived")
  expect(store.isPinned("m2", "30")).toBe(false)
  snapshot.session.archiveState = "active"
  fake.emit({ type: "catalogChanged", machineId: "m2", sessionId: "30" })
  await flushPromises()
  expect(store.isPinned("m1", "30")).toBe(true)
  expect(store.isPinned("m2", "30")).toBe(false)
})

test("retained machine scopes preserve an explicit pin after the Session is restored", async () => {
  const { account, fake, snapshot } = await accountFixture()
  const first = fixture(account, "m1")
  first.store.pin("m2", "30", "Remote investigation")
  await flushPromises()
  snapshot.session.archiveState = "archived"
  fake.emit({ type: "catalogChanged", machineId: "m2", sessionId: "30" })
  await flushPromises()
  expect(first.store.isPinned("m2", "30")).toBe(false)

  // Switching machines keeps the first scope and its retained remote metadata alive.
  const second = fixture(account, "m2")
  second.agents.sessions["30"] = { ...snapshot.session, workspaceId: undefined }
  snapshot.session.archiveState = "active"
  second.agents.sessions["30"]!.archiveState = "active"
  fake.emit({ type: "catalogChanged", machineId: "m2", sessionId: "30" })
  await flushPromises()
  expect(first.store.isPinned("m2", "30")).toBe(false)
  expect(second.store.isPinned("m2", "30")).toBe(false)

  second.store.pin("m2", "30", "Remote investigation")
  await flushPromises()
  expect(first.store.isPinned("m2", "30")).toBe(true)
  expect(second.store.isPinned("m2", "30")).toBe(true)
  expect(first.store.items[0]?.archiveState).toBe("active")
  expect(second.store.items[0]?.archiveState).toBe("active")
  const scope = JSON.stringify(["https://fleet.example", "user-1", "team-1"])
  expect(JSON.parse(localStorage.getItem("deskfleet.pinned-sessions")!)[scope]).toEqual([
    { machineId: "m2", sessionId: "30", title: "Remote investigation" },
  ])
})

test("previously saved pins are pruned when retained remote history reveals an archived Session", async () => {
  const { account, session, snapshot } = await accountFixture()
  const scope = JSON.stringify(["https://fleet.example", "user-1", "team-1"])
  localStorage.setItem("deskfleet.pinned-sessions", JSON.stringify({
    [scope]: [{ machineId: "m2", sessionId: "30", title: "Saved investigation" }],
  }))
  snapshot.session.archiveState = "archived"
  const response = deferred<Awaited<ReturnType<typeof session>>>()
  session.mockReturnValueOnce(response.promise)
  const first = fixture(account)
  expect(first.store.isPinned("m2", "30")).toBe(true)
  expect(first.store.items[0]?.archiveState).toBeUndefined()
  response.resolve({ snapshot, lastEventSeq: "0", lastObservedAt: "now" })
  await flushPromises()
  expect(first.store.pins).toEqual([])
  disposePinia(first.pinia)
  const second = fixture(account, "m2")
  expect(second.store.pins).toEqual([])
})

test("catalog notifications refresh pinned remote history and removed machines leave the visible section", async () => {
  const { account, fake, session, snapshot } = await accountFixture()
  const { store } = fixture(account)
  store.pin("m2", "30", "Cached")
  await flushPromises()
  snapshot.session.title = "Renamed remotely"
  snapshot.session.archiveState = "active"
  fake.emit({ type: "catalogChanged", machineId: "m2", sessionId: "30" })
  await flushPromises()
  expect(store.items[0]).toMatchObject({ title: "Renamed remotely", archiveState: "active" })
  expect(store.pins[0]?.title).toBe("Renamed remotely")
  fake.emit({ type: "catalogChanged", machineId: "m2", sessionId: "99" })
  await flushPromises()
  expect(session).toHaveBeenCalledTimes(2)
  account.machines.value = account.machines.value.filter(machine => machine.id !== "m2")
  expect(store.items).toEqual([])
  expect(store.isPinned("m2", "30")).toBe(true)
})

test("a late remote title cannot overwrite pins after switching away and back to the Team", async () => {
  const { account, session, snapshot } = await accountFixture()
  const response = deferred<Awaited<ReturnType<typeof session>>>()
  session.mockReturnValueOnce(response.promise)
  const { store } = fixture(account)
  store.pin("m2", "30", "Cached")
  await flushPromises()
  await account.selectTeam("team-2")
  await account.selectTeam("team-1")
  await flushPromises()
  expect(store.items[0]?.title).toBe("Remote investigation")
  response.resolve({ snapshot: { ...snapshot, session: { ...snapshot.session, title: "Stale title" } }, lastEventSeq: "0", lastObservedAt: "earlier" })
  await flushPromises()
  expect(store.pins[0]?.title).toBe("Remote investigation")
})

test("local and demo pins remain in memory and project each loaded machine's own Session title", async () => {
  const first = fixture()
  const machine = (id: string, title: string): MachineSummary => ({
    id, name: id, online: true, local: true, desktop: false, workspaces: [], terminals: [],
    sessions: [{ id: "30", title, archiveState: "active" }],
  })
  Reflect.set(first.fleet, "machines", ref([machine("demo-1", "First demo"), machine("demo-2", "Second demo")]))
  first.store.pin("demo-1", "30", "First demo")
  first.store.pin("demo-2", "30", "Second demo")
  expect(first.store.items.map(item => [item.title, item.loaded])).toEqual([["First demo", true], ["Second demo", true]])
  await first.store.refresh()
  expect(localStorage.getItem("deskfleet.pinned-sessions")).toBeNull()
  const second = fixture()
  expect(second.store.pins).toEqual([])
})
