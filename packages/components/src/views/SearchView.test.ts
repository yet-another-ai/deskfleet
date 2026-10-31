import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { computed, ref } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import type { SearchPage, SearchResult } from "@deskfleet/client/search"
import { createAccountSession, accountSessionKey } from "../composables/useAccountSession.ts"
import { i18n } from "../i18n/index.ts"
import { fakeCentral, machineFixture } from "../test/central.ts"
import SearchView from "./SearchView.vue"
import { useSearchFeature } from "../services/search-feature.ts"

vi.mock("../services/search-feature.ts", () => ({ useSearchFeature: vi.fn() }))

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers() })
const chat = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  kind: "chat", machineId: "remote", machineName: "Build machine", workspaceName: "DeskFleet", resourceId: "30",
  title: "Find a+b", snippet: "Literal A+B <img src=x onerror=alert(1)>", entryId: "message-8", updatedAt: "2026-10-31T12:00:00Z", ...overrides,
} as SearchResult)

async function setup(path = "/search", featureEnabled = true) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const enabled = ref(featureEnabled)
  vi.mocked(useSearchFeature).mockReturnValue(computed(() => enabled.value))
  const fake = fakeCentral({ machines: [machineFixture("local", "team-1", "Local"), machineFixture("remote", "team-1", "Remote", false)] })
  const account = createAccountSession(fake.central)
  await flushPromises()
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", name: "new-session", component: { template: "<div />" } },
    { path: "/search", name: "search", component: SearchView },
  ] })
  await router.push(path)
  const wrapper = mount(SearchView, { attachTo: document.body, global: {
    plugins: [router, i18n], provide: { [accountSessionKey as symbol]: account }, stubs: { PaneHeader: { template: "<header><slot /></header>" } },
  } })
  cleanup.push(() => { wrapper.unmount(); account.dispose() })
  return { ...fake, account, router, wrapper, enabled }
}
async function settleSearch() { await vi.advanceTimersByTimeAsync(250); await flushPromises() }

test("debounces Team-wide queries, preserves URL state, highlights literal text safely, and opens the exact remote message", async () => {
  const { central, account, router, wrapper } = await setup()
  central.search.mockResolvedValue({ results: [chat()] })
  const open = vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  await wrapper.get("input").setValue("a")
  await vi.advanceTimersByTimeAsync(200)
  await wrapper.get("input").setValue("a+b")
  expect(central.search).not.toHaveBeenCalled()
  await settleSearch()
  expect(central.search).toHaveBeenCalledExactlyOnceWith("team-1", { q: "a+b", kind: "all", limit: 30 })
  expect(router.currentRoute.value.query).toEqual({ q: "a+b" })
  expect(account.searchPath.value).toBe("/search?q=a%2Bb")
  expect(wrapper.findAll("mark").map(mark => mark.text())).toEqual(["a+b", "A+B"])
  expect(wrapper.find("img").exists()).toBe(false)
  expect(wrapper.text()).toContain("<img src=x onerror=alert(1)>")
  expect(wrapper.text()).toContain("Build machine · DeskFleet")
  await wrapper.get("[data-search-result]").trigger("click")
  expect(open).toHaveBeenCalledExactlyOnceWith("remote", { name: "session", params: { sessionId: "30" }, query: { entry: "message-8" } })
})

test("ignores a stale response as soon as the query changes, before its next debounce expires", async () => {
  const { central, wrapper } = await setup("/search?q=old")
  const old = Promise.withResolvers<SearchPage>()
  central.search.mockReturnValueOnce(old.promise).mockResolvedValue({ results: [chat({ title: "New result" })] })
  await settleSearch()
  await wrapper.get("input").setValue("new")
  old.resolve({ results: [chat({ title: "Stale result" })] })
  await flushPromises()
  expect(wrapper.text()).not.toContain("Stale result")
  await settleSearch()
  expect(wrapper.text()).toContain("New result")
})

test("restores filters from the URL, loads another page, and opens a schedule on its owning machine", async () => {
  const { central, account, wrapper } = await setup("/search?q=review&kind=schedule")
  const task: SearchResult = { kind: "schedule", machineId: "remote", machineName: "Remote", resourceId: "task-1", title: "Review", snippet: "Review the repository", updatedAt: "now" }
  central.search.mockResolvedValueOnce({ results: [task], nextCursor: "page-2" }).mockResolvedValueOnce({ results: [{ ...task, resourceId: "task-2", title: "Second review" }] })
  const open = vi.spyOn(account, "openMachineRoute").mockImplementation(() => {})
  await settleSearch()
  expect(central.search).toHaveBeenLastCalledWith("team-1", { q: "review", kind: "schedule", limit: 30 })
  await wrapper.findAll("button").find(button => button.text() === "Load more")!.trigger("click")
  await flushPromises()
  expect(central.search).toHaveBeenLastCalledWith("team-1", { q: "review", kind: "schedule", cursor: "page-2", limit: 30 })
  expect(wrapper.findAll("[data-search-result]")).toHaveLength(2)
  await wrapper.get("[data-search-result]").trigger("click")
  expect(open).toHaveBeenCalledWith("remote", { name: "schedules", params: { scheduleId: "task-1" } })
})

test("clears a previous Team's query and ignores its in-flight results", async () => {
  const { central, account, wrapper, router } = await setup("/search?q=private")
  const page = Promise.withResolvers<SearchPage>()
  central.search.mockReturnValue(page.promise)
  await settleSearch()
  account.teamId.value = "team-2"
  await flushPromises()
  page.resolve({ results: [chat()] })
  await flushPromises()
  expect(wrapper.get<HTMLInputElement>("input").element.value).toBe("")
  expect(wrapper.findAll("[data-search-result]")).toHaveLength(0)
  expect(router.currentRoute.value.query).toEqual({})
  await settleSearch()
  expect(central.search).toHaveBeenCalledOnce()
})

test("shows a query error and retries without losing the query", async () => {
  const { central, wrapper } = await setup("/search?q=review")
  central.search.mockRejectedValueOnce(new Error("Search unavailable")).mockResolvedValueOnce({ results: [chat()] })
  await settleSearch()
  expect(wrapper.get('[role="alert"]').text()).toBe("Search unavailable")
  await wrapper.findAll("button").find(button => button.text() === "Retry")!.trigger("click")
  await flushPromises()
  expect(wrapper.findAll("[data-search-result]")).toHaveLength(1)
})

test("Enter refreshes unchanged text and cancels an outstanding debounce", async () => {
  const { central, wrapper } = await setup()
  central.search.mockResolvedValue({ results: [] })
  await wrapper.get("input").setValue("review")
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(central.search).toHaveBeenCalledOnce()
  await settleSearch()
  expect(central.search).toHaveBeenCalledOnce()
  await wrapper.get("form").trigger("submit")
  await flushPromises()
  expect(central.search).toHaveBeenCalledTimes(2)
})

test("a disabled direct link returns to Conversations without displaying or requesting search", async () => {
  const { central, router, wrapper } = await setup("/search?q=private", false)
  await settleSearch()
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(wrapper.find("input").exists()).toBe(false)
  expect(central.search).not.toHaveBeenCalled()
})

test("turning the gate off hides the page and discards an in-flight response", async () => {
  const { central, router, wrapper, enabled } = await setup("/search?q=review")
  const response = Promise.withResolvers<SearchPage>()
  central.search.mockReturnValue(response.promise)
  await settleSearch()
  expect(central.search).toHaveBeenCalledOnce()
  enabled.value = false
  await flushPromises()
  response.resolve({ results: [chat({ title: "Hidden result" })], nextCursor: "next" })
  await settleSearch()
  expect(router.currentRoute.value.name).toBe("new-session")
  expect(wrapper.find("input").exists()).toBe(false)
  expect(wrapper.text()).not.toContain("Hidden result")
  expect(central.search).toHaveBeenCalledOnce()
})
