import { configureClient, getClient } from "@deskfleet/client/platform"
import type { CentralApi } from "@deskfleet/client/central"
import type { SystemStatus } from "@deskfleet/client/system"
import { flushPromises } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { createApp } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../composables/useAccountSession.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { deferred } from "../test/desktop-media.ts"
import { MACHINE_BATTERY_MISSING_INTERVAL, useMachineBatteriesStore } from "./machine-batteries.ts"

const host = getClient()
const charging = { percent: 68.4, state: "charging" } as const
let pinia: Pinia
let account: AccountSession

beforeEach(() => { pinia = createPinia() })
afterEach(() => {
  disposePinia(pinia)
  account?.dispose()
  configureClient(host)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function setup(machines = [
  machineFixture("m1", "team-1", "Laptop"),
  machineFixture("m2", "team-1", "Server"),
  machineFixture("m3", "team-1", "Offline", false),
]) {
  configureClient({ ...host, target: { id: "m1", local: false } })
  const fake = fakeCentral({ machines })
  const rpc = vi.fn<CentralApi["rpc"]>(async () => ({ battery: charging } as unknown as SystemStatus))
  fake.central.rpc = rpc
  account = createAccountSession(fake.central)
  await flushPromises()
  const app = createApp({}).use(pinia).provide(accountSessionKey, account)
  const store = app.runWithContext(() => useMachineBatteriesStore(pinia))
  return { store, rpc, fake }
}

test("reads observed online machines once and exposes their battery", async () => {
  const { store, rpc } = await setup()
  store.observe("m1")
  store.observe("m1")
  await flushPromises()
  expect(rpc).toHaveBeenCalledExactlyOnceWith("team-1", "m1", "systemStatus", {})
  expect(store.forMachine("m1")).toEqual(charging)
  await store.refresh()
  expect(rpc).toHaveBeenCalledOnce()
})

test("skips offline machines and only retries a missing battery after the long interval", async () => {
  const { store, rpc } = await setup()
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000)
  rpc.mockResolvedValue({ battery: undefined } as unknown as SystemStatus)
  store.observe("m1")
  store.observe("m3")
  await flushPromises()
  expect(rpc).toHaveBeenCalledExactlyOnceWith("team-1", "m1", "systemStatus", {})
  await store.refresh()
  expect(rpc).toHaveBeenCalledOnce()
  now.mockReturnValue(1_000 + MACHINE_BATTERY_MISSING_INTERVAL + 1)
  await store.refresh()
  expect(rpc).toHaveBeenCalledTimes(2)
})

test("drops entries and late replies after the Team changes", async () => {
  const { store, rpc } = await setup([
    machineFixture("m1", "team-1", "Laptop"),
    machineFixture("m2", "team-2", "Second laptop"),
  ])
  account.teams.value = [
    { id: "team-1", name: "Team one", role: "owner" },
    { id: "team-2", name: "Team two", role: "owner" },
  ]
  rpc.mockResolvedValueOnce({ battery: charging } as SystemStatus)
  store.observe("m1")
  await flushPromises()
  expect(store.forMachine("m1")).toEqual(charging)
  const pending = deferred<SystemStatus>()
  rpc.mockReturnValueOnce(pending.promise)
  const refresh = store.refresh(true)
  account.teamId.value = "team-2"
  pending.resolve({ battery: charging } as SystemStatus)
  await refresh
  await flushPromises()
  expect(store.forMachine("m1")).toBeUndefined()
})
