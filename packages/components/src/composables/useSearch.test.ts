import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import type { SearchPage } from "@deskfleet/client/search"
import { accountSessionKey, createAccountSession } from "./useAccountSession.ts"
import { useSearch } from "./useSearch.ts"
import { fakeCentral } from "../test/central.ts"

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); vi.useRealTimers() })

async function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const fake = fakeCentral()
  const account = createAccountSession(fake.central)
  await flushPromises()
  const query = ref("review")
  let search!: ReturnType<typeof useSearch>
  const wrapper = mount(defineComponent({ setup() { search = useSearch(query, ref("all")); return () => null } }), {
    global: { provide: { [accountSessionKey as symbol]: account } },
  })
  cleanup.push(() => { wrapper.unmount(); account.dispose() })
  return { ...fake, account, query, search }
}

test("no selected Team blocks debounce, refresh, and pagination requests", async () => {
  const { central, account, search, query } = await setup()
  account.teamId.value = undefined
  query.value = "changed"
  await search.refresh()
  await search.loadMore()
  await vi.advanceTimersByTimeAsync(300)
  expect(search.available.value).toBe(false)
  expect(search.loading.value).toBe(false)
  expect(central.search).not.toHaveBeenCalled()
})

test("clearing the selected Team clears results and cursor immediately and invalidates an older page", async () => {
  const { central, search, account } = await setup()
  central.search.mockResolvedValueOnce({ results: [{ kind: "chat", machineId: "m1", machineName: "Machine", resourceId: "30", title: "Review", snippet: "Review tests", updatedAt: "now" }], nextCursor: "next" })
  await vi.advanceTimersByTimeAsync(250)
  expect(search.results.value).toHaveLength(1)
  const pending = Promise.withResolvers<SearchPage>()
  central.search.mockReturnValueOnce(pending.promise)
  const loading = search.loadMore()
  account.teamId.value = undefined
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

test("clearing the selected Team while debounce is pending cancels the request", async () => {
  const { central, search, account } = await setup()
  account.teamId.value = undefined
  await vi.advanceTimersByTimeAsync(300)
  expect(central.search).not.toHaveBeenCalled()
  expect(search.loading.value).toBe(false)
  account.teamId.value = "team-1"
  await vi.advanceTimersByTimeAsync(250)
  expect(central.search).toHaveBeenCalledOnce()
})
