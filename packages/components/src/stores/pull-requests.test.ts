import { configureClient, getClient } from "@deskfleet/client/platform"
import type { CatalogSnapshot } from "@deskfleet/client/catalog"
import type { GithubAppSettings, GithubPullRequest, GithubPullRequestQuery } from "@deskfleet/client/central"
import { useEventBus } from "@vueuse/core"
import { flushPromises } from "@vue/test-utils"
import { createPinia, disposePinia, type Pinia } from "pinia"
import { createApp } from "vue"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../composables/useAccountSession.ts"
import { githubSettingsChanged } from "../services/github-settings-events.ts"
import { catalogFixture } from "../test/catalog.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import { deferred } from "../test/desktop-media.ts"
import { useFleetStore } from "./fleet.ts"
import { usePullRequestsStore } from "./pull-requests.ts"

const host = getClient()
let pinia: Pinia
let account: AccountSession
const settings: GithubAppSettings = { configured: true, authorized: true, actAsYou: true, login: "octocat", manageUrl: null }
const pullRequest: GithubPullRequest = { number: 78, title: "Show PR status", url: "https://github.com/acme/app/pull/78", state: "open" }
function catalog(branch = "feature", sessionIds = ["30"]): CatalogSnapshot {
  return { ...catalogFixture(), githubBranches: sessionIds.map(sessionId => ({ sessionId, repositories: [{ repository: "acme/app", headRepository: "ada/app", branch }] })) }
}
function visible(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value })
  document.dispatchEvent(new Event("visibilitychange"))
}
beforeEach(() => { pinia = createPinia(); visible("visible") })
afterEach(() => {
  disposePinia(pinia); account?.dispose(); configureClient(host)
  vi.useRealTimers(); vi.restoreAllMocks(); visible("visible")
})
async function setup(initialSettings = settings) {
  configureClient({ ...host, target: { id: "m1", local: false } })
  const fake = fakeCentral({ machines: [machineFixture("m1", "team-1", "Laptop"), machineFixture("m2", "team-1", "Server")] })
  const githubSettings = vi.fn(async (): Promise<GithubAppSettings> => ({ ...initialSettings }))
  const githubPullRequest = vi.fn(async (_query: GithubPullRequestQuery): Promise<{ pullRequest: GithubPullRequest | null }> => ({ pullRequest }))
  const readCatalog = vi.fn(async (machineId: string) => ({ machineId, snapshot: catalog("remote"), lastObservedAt: "now" }))
  fake.central.githubSettings = githubSettings
  fake.central.githubPullRequest = githubPullRequest
  fake.central.catalog = readCatalog
  account = createAccountSession(fake.central)
  await flushPromises()
  const app = createApp({}).use(pinia).provide(accountSessionKey, account)
  const store = app.runWithContext(() => usePullRequestsStore(pinia))
  const fleet = useFleetStore(pinia)
  fleet.catalog = catalog("feature", ["30", "31"])
  return { store, fleet, fake, githubSettings, githubPullRequest, readCatalog }
}

test("deduplicates the same branch across rows and keeps machine-local Session IDs separate", async () => {
  const { store, githubPullRequest, readCatalog } = await setup()
  store.observe("m1", "30"); store.observe("m1", "30"); store.observe("m1", "31"); store.observe("m2", "30")
  githubPullRequest.mockImplementation(async query => ({ pullRequest: { ...pullRequest, number: query.branch === "remote" ? 90 : 78 } }))
  await flushPromises()
  expect(githubPullRequest).toHaveBeenCalledTimes(2)
  expect(githubPullRequest).toHaveBeenCalledWith({ owner: "acme", repo: "app", headOwner: "ada", branch: "feature" })
  expect(store.forSession("m1", "30")[0]?.number).toBe(78)
  expect(store.forSession("m2", "30")[0]?.number).toBe(90)
  expect(readCatalog).toHaveBeenCalledExactlyOnceWith("m2")
  await store.refresh()
  expect(readCatalog).toHaveBeenCalledOnce()
})

test("requires the App grant and Act as you, and clears immediately when it is disabled", async () => {
  const { store, fake, githubPullRequest, readCatalog } = await setup({ ...settings, actAsYou: false })
  store.observe("m1", "30"); store.observe("m2", "30")
  await flushPromises()
  expect(githubPullRequest).not.toHaveBeenCalled(); expect(readCatalog).not.toHaveBeenCalled()
  useEventBus(githubSettingsChanged).emit({ central: fake.central, settings })
  await flushPromises()
  expect(store.forSession("m1", "30")).toHaveLength(1)
  useEventBus(githubSettingsChanged).emit({ central: fake.central, settings: { ...settings, actAsYou: false } })
  expect(store.forSession("m1", "30")).toEqual([])
})

test("late results cannot cross logout or account changes", async () => {
  const { store, githubPullRequest } = await setup()
  const pending = deferred<{ pullRequest: GithubPullRequest | null }>()
  githubPullRequest.mockReturnValueOnce(pending.promise)
  store.observe("m1", "30"); await flushPromises()
  const user = account.account.value.user!
  account.account.value = { ...account.account.value, user: undefined }
  pending.resolve({ pullRequest }); await flushPromises()
  expect(store.forSession("m1", "30")).toEqual([])
  githubPullRequest.mockResolvedValue({ pullRequest: null })
  account.account.value = { ...account.account.value, user: { ...user, id: "other" } }
  await flushPromises()
  expect(store.forSession("m1", "30")).toEqual([])
})

test("polls GitHub while visible, refreshes on focus, and stops after the last row leaves", async () => {
  const { store, githubPullRequest, readCatalog } = await setup()
  vi.useFakeTimers()
  const stop = store.observe("m1", "30")
  await flushPromises()
  githubPullRequest.mockClear()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(githubPullRequest).toHaveBeenCalledOnce()
  visible("hidden"); await flushPromises()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(githubPullRequest).toHaveBeenCalledOnce()
  visible("visible"); await flushPromises()
  expect(githubPullRequest).toHaveBeenCalledTimes(2)
  window.dispatchEvent(new Event("blur")); await flushPromises()
  window.dispatchEvent(new Event("focus")); await flushPromises()
  expect(githubPullRequest).toHaveBeenCalledTimes(3)
  stop(); await flushPromises()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(githubPullRequest).toHaveBeenCalledTimes(3)
  expect(readCatalog).not.toHaveBeenCalled()
})

test("catalog changes while hidden invalidate a pinned machine before visibility resumes", async () => {
  const { store, fake, githubPullRequest, readCatalog } = await setup()
  store.observe("m2", "30"); await flushPromises()
  visible("hidden"); await flushPromises()
  readCatalog.mockResolvedValue({ machineId: "m2", snapshot: catalog("changed"), lastObservedAt: "later" })
  fake.emit({ type: "catalogChanged", machineId: "m2" }); await flushPromises()
  expect(readCatalog).toHaveBeenCalledOnce()
  expect(store.forSession("m2", "30")).toEqual([])
  visible("visible"); await flushPromises()
  expect(readCatalog).toHaveBeenCalledTimes(2)
  expect(githubPullRequest).toHaveBeenLastCalledWith({ owner: "acme", repo: "app", headOwner: "ada", branch: "changed" })
})

test.each(["catalogChanged", "connection"] as const)("%s during a pinned catalog read rereads before using its branch", async type => {
  const { store, fake, githubPullRequest, readCatalog } = await setup()
  const pending = deferred<Awaited<ReturnType<typeof readCatalog>>>()
  readCatalog.mockReturnValueOnce(pending.promise)
  readCatalog.mockResolvedValue({ machineId: "m2", snapshot: catalog("changed"), lastObservedAt: "later" })
  store.observe("m2", "30"); await flushPromises()
  fake.emit(type === "catalogChanged" ? { type, machineId: "m2" } : { type, connected: true })
  pending.resolve({ machineId: "m2", snapshot: catalog("old"), lastObservedAt: "earlier" }); await flushPromises()
  expect(readCatalog).toHaveBeenCalledTimes(2)
  expect(githubPullRequest).toHaveBeenCalled()
  expect(githubPullRequest.mock.calls.every(([query]) => query.branch === "changed")).toBe(true)
})

test("catalog changes while a row is unmounted are read when it is observed again", async () => {
  const { store, fake, githubPullRequest, readCatalog } = await setup()
  const stop = store.observe("m2", "30"); await flushPromises()
  stop(); await flushPromises()
  readCatalog.mockResolvedValue({ machineId: "m2", snapshot: catalog("changed"), lastObservedAt: "later" })
  fake.emit({ type: "catalogChanged", machineId: "m2" }); await flushPromises()
  expect(readCatalog).toHaveBeenCalledOnce()
  store.observe("m2", "30"); await flushPromises()
  expect(readCatalog).toHaveBeenCalledTimes(2)
  expect(githubPullRequest).toHaveBeenLastCalledWith({ owner: "acme", repo: "app", headOwner: "ada", branch: "changed" })
})

test("branch removal and unavailable upstream results leave no indicator", async () => {
  const { store, fleet, githubPullRequest } = await setup()
  store.observe("m1", "30"); await flushPromises()
  expect(store.forSession("m1", "30")).toHaveLength(1)
  fleet.catalog = catalogFixture(); await flushPromises()
  expect(store.forSession("m1", "30")).toEqual([])
  githubPullRequest.mockRejectedValue(new Error("GitHub access unavailable"))
  fleet.catalog = catalog("other"); await flushPromises()
  expect(store.forSession("m1", "30")).toEqual([])
})
