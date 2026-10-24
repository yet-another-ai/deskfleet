import { flushPromises } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { ProviderSnapshot } from "../../../../../daemon/src/provider-protocol.ts"
import { deferred } from "../test/desktop-media.ts"
import { useProvidersStore } from "./providers.ts"

let pinia: ReturnType<typeof createPinia>
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia) })
afterEach(() => { disposePinia(pinia); vi.restoreAllMocks() })
const snapshot = (ids: string[]): ProviderSnapshot => ({
  templates: [{ id: "codex", name: "Codex", defaultBinaryPath: "codex" }],
  providers: ids.map(id => ({ id, template: "codex", name: id, env: {} })),
})

test("preserves the chosen provider on edits and replaces it when removed", async () => {
  const list = vi.spyOn(window.deskfleet.providers, "list").mockResolvedValue(snapshot(["first", "second"]))
  const store = useProvidersStore()
  await store.refresh()
  expect(store.selectedId).toBe("first")
  store.selectedId = "second"
  await store.refresh()
  expect(store.selectedId).toBe("second")
  list.mockResolvedValue(snapshot(["first"]))
  await store.refresh()
  expect(store.selectedId).toBe("first")
  list.mockResolvedValue(snapshot([]))
  await store.refresh()
  expect(store.selectedId).toBe("")
  expect(store.ready).toBe(true)
})

test("a change during a pending read refreshes before publishing stale options", async () => {
  const read = deferred<ProviderSnapshot>()
  const list = vi.spyOn(window.deskfleet.providers, "list").mockReturnValueOnce(read.promise).mockResolvedValue(snapshot(["new"]))
  let changed = () => {}
  const unsubscribe = vi.fn()
  vi.spyOn(window.deskfleet.providers, "onChanged").mockImplementation(listener => { changed = listener; return unsubscribe })
  const store = useProvidersStore()
  const refreshing = store.refresh()
  changed()
  read.resolve(snapshot(["old"]))
  await refreshing
  expect(list).toHaveBeenCalledTimes(2)
  expect(store.selectedId).toBe("new")
  store.$dispose()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

test("a disconnected daemon disables creation until a successful refresh", async () => {
  const list = vi.spyOn(window.deskfleet.providers, "list").mockResolvedValue(snapshot(["first"]))
  const store = useProvidersStore()
  expect(store.loaded).toBe(false)
  await store.refresh()
  expect(store.loaded).toBe(true)
  list.mockRejectedValue(new Error("Daemon unavailable"))
  await store.refresh()
  expect(store.ready).toBe(false)
  expect(store.loaded).toBe(true)
  expect(store.providers).toEqual(snapshot(["first"]).providers)
  expect(store.error).toBe("Daemon unavailable")
  list.mockResolvedValue(snapshot(["first"]))
  await store.refresh()
  await flushPromises()
  expect(store.ready).toBe(true)
  expect(store.error).toBeNull()
})

test("an unsuccessful initial read does not confirm that providers are missing", async () => {
  vi.spyOn(window.deskfleet.providers, "list").mockRejectedValue(new Error("Daemon unavailable"))
  const store = useProvidersStore()
  await store.refresh()
  expect(store.loaded).toBe(false)
  expect(store.ready).toBe(false)
})
