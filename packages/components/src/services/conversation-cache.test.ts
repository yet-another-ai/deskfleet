import { expect, test, vi } from "vitest"
import { reactive } from "vue"
import { agentSnapshot } from "../test/agent.ts"
import { clearConversationOwner, createConversationCache } from "./conversation-cache.ts"

// Only the asynchronous request boundary needed by the cache ordering tests.
// Real IndexedDB upgrade, cursor, and eviction behavior is checked in Chromium.
function storage() {
  const rows = new Map<string, { key: string; json: string }>()
  const changes: string[] = []
  const database = {
    transaction() {
      let requests = 0
      const transaction = { oncomplete: undefined as (() => void) | undefined, objectStore: () => store }
      function request<T>(value: () => T) {
        requests++
        const result = { result: undefined as T | undefined, onsuccess: undefined as (() => void) | undefined }
        queueMicrotask(() => {
          result.result = value()
          result.onsuccess?.()
          if (--requests === 0) transaction.oncomplete?.()
        })
        return result
      }
      const store = {
        get: (key: string) => request(() => rows.get(key)),
        put: (row: { key: string; json: string }) => request(() => { rows.set(row.key, row); changes.push(`put:${row.key}`) }),
        delete: (key: string) => request(() => { rows.delete(key); changes.push(`delete:${key}`) }),
        index: () => ({ openKeyCursor: () => request(() => null) }),
        openKeyCursor() {
          const keys = [...rows.keys()]
          let index = 0
          const result = request(next)
          function next(): { primaryKey: string; continue: () => void } | null {
            const key = keys[index++]
            if (key === undefined) return null
            return { primaryKey: key, continue() {
              const continuation = request(next)
              continuation.onsuccess = () => { result.result = continuation.result; result.onsuccess?.() }
            } }
          }
          return result
        },
      }
      return transaction
    },
  }
  vi.stubGlobal("indexedDB", { open: () => {
    const request = { result: database, onsuccess: undefined as (() => void) | undefined }
    queueMicrotask(() => request.onsuccess?.())
    return request
  } })
  return { rows, changes }
}

test("unavailable browser storage leaves conversation operations usable", async () => {
  vi.stubGlobal("indexedDB", undefined)
  try {
    const cache = createConversationCache("account", "team-machine")
    await expect(cache.read("30")).resolves.toBeUndefined()
    await expect(cache.write("30", { snapshot: agentSnapshot(), events: [] })).resolves.toBeUndefined()
    await expect(cache.remove("30")).resolves.toBeUndefined()
    await expect(cache.retain([])).resolves.toBeUndefined()
    await expect(clearConversationOwner("account")).resolves.toBeUndefined()
  } finally { vi.unstubAllGlobals() }
})

test("queued saves capture snapshots immediately and cannot undo later removals", async () => {
  vi.resetModules()
  const { createConversationCache, clearConversationOwner } = await import("./conversation-cache.ts")
  const encoding = await import("./conversation-cache-serializer.ts")
  const captured: string[] = []
  const release = Promise.withResolvers<void>()
  const serialize = vi.spyOn(encoding, "serializeConversation").mockImplementation(async snapshot => {
    captured.push(snapshot)
    await release.promise
    return `{"snapshot":${snapshot},"events":[]}`
  })
  const fake = storage()
  try {
    const first = createConversationCache("owner", "machine-a")
    const second = createConversationCache("owner", "machine-b")
    const snapshot = reactive(agentSnapshot())
    const save = first.write("30", { snapshot, events: [] })
    snapshot.session.title = "Changed after scheduling"
    const removal = first.remove("30")
    const otherSave = second.write("30", { snapshot, events: [] })
    const clear = clearConversationOwner("owner")
    await Promise.resolve()
    expect(fake.changes).toEqual([])
    expect(serialize).toHaveBeenCalledTimes(1)
    release.resolve()
    await Promise.all([save, removal, otherSave, clear])
    expect(JSON.parse(captured[0]!).session.title).toBe("Fix tests")
    expect(JSON.parse(captured[1]!).session.title).toBe("Changed after scheduling")
    expect(fake.changes).toEqual([
      'put:["owner","machine-a","30"]', 'delete:["owner","machine-a","30"]',
      'put:["owner","machine-b","30"]', 'delete:["owner","machine-b","30"]',
    ])
    expect(fake.rows.size).toBe(0)
  } finally { vi.unstubAllGlobals() }
})

test("a failed queued serialization leaves subsequent cache operations usable", async () => {
  vi.resetModules()
  const { createConversationCache } = await import("./conversation-cache.ts")
  const encoding = await import("./conversation-cache-serializer.ts")
  vi.spyOn(encoding, "serializeConversation").mockRejectedValueOnce(new Error("Cannot encode"))
  const fake = storage()
  try {
    const cache = createConversationCache("owner", "machine")
    await expect(cache.write("30", { snapshot: agentSnapshot(), events: [] })).resolves.toBeUndefined()
    await cache.write("30", { snapshot: agentSnapshot(), events: [] })
    await cache.retain([])
    expect(fake.rows.size).toBe(0)
    expect(fake.changes).toEqual(['put:["owner","machine","30"]', 'delete:["owner","machine","30"]'])
  } finally { vi.unstubAllGlobals() }
})
