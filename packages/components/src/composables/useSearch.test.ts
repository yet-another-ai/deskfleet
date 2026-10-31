import { flushPromises, mount } from "@vue/test-utils"
import { computed, defineComponent, ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import type { SearchPage } from "@deskfleet/client/search"
import { accountSessionKey, createAccountSession } from "./useAccountSession.ts"
import { useSearch } from "./useSearch.ts"
import { useSearchFeature } from "../services/search-feature.ts"
import { fakeCentral } from "../test/central.ts"

vi.mock("../services/search-feature.ts", () => ({ useSearchFeature: vi.fn() }))
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers() })

async function setup(initialEnabled: boolean) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const enabled = ref(initialEnabled)
  vi.mocked(useSearchFeature).mockReturnValue(computed(() => enabled.value))
  const fake = fakeCentral()
  const account = createAccountSession(fake.central)
  await flushPromises()
  const query = ref("review")
  let search!: ReturnType<typeof useSearch>
  const wrapper = mount(defineComponent({ setup() { search = useSearch(query, ref("all")); return () => null } }), {
    global: { provide: { [accountSessionKey as symbol]: account } },
  })
  cleanup.push(() => { wrapper.unmount(); account.dispose() })
  return { ...fake, enabled, query, search }
}

test("a disabled feature blocks debounce, refresh, and pagination requests", async () => {
  const { central, search, query } = await setup(false)
  query.value = "changed"
  await search.refresh()
  await search.loadMore()
  await vi.advanceTimersByTimeAsync(300)
  expect(search.available.value).toBe(false)
  expect(search.loading.value).toBe(false)
  expect(central.search).not.toHaveBeenCalled()
})

test("disabling search clears results and cursor immediately and invalidates an older page", async () => {
  const { central, search, enabled } = await setup(true)
  central.search.mockResolvedValueOnce({ results: [{ kind: "chat", machineId: "m1", machineName: "Machine", resourceId: "30", title: "Review", snippet: "Review tests", updatedAt: "now" }], nextCursor: "next" })
  await vi.advanceTimersByTimeAsync(250)
  expect(search.results.value).toHaveLength(1)
  const pending = Promise.withResolvers<SearchPage>()
  central.search.mockReturnValueOnce(pending.promise)
  const loading = search.loadMore()
  enabled.value = false
  expect(search.results.value).toEqual([])
  expect(search.nextCursor.value).toBeUndefined()
  expect(search.loading.value).toBe(false)
  pending.resolve({ results: [{ kind: "chat", machineId: "m1", machineName: "Machine", resourceId: "31", title: "Stale", snippet: "Stale", updatedAt: "now" }], nextCursor: "stale" })
  await loading
  await search.refresh()
  expect(search.results.value).toEqual([])
  expect(search.nextCursor.value).toBeUndefined()
  expect(central.search).toHaveBeenCalledTimes(2)
})

test("turning search off while its debounce is pending cancels the request", async () => {
  const { central, search, enabled } = await setup(true)
  enabled.value = false
  await vi.advanceTimersByTimeAsync(300)
  expect(central.search).not.toHaveBeenCalled()
  expect(search.loading.value).toBe(false)
  enabled.value = true
  await vi.advanceTimersByTimeAsync(250)
  expect(central.search).toHaveBeenCalledOnce()
})
