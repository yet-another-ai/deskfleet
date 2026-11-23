import { hasInjectionContext, inject, toRaw, type InjectionKey } from "vue"
import type { AgentEvent, AgentSnapshot } from "@deskfleet/protocol/agent"
import { maxConversationCacheBytes, serializeConversation } from "./conversation-cache-serializer.ts"

export interface CachedConversation { snapshot: AgentSnapshot; events: AgentEvent[] }
export interface ConversationCache {
  read(id: string): Promise<CachedConversation | undefined>
  write(id: string, value: CachedConversation): Promise<void>
  remove(id: string): Promise<void>
  retain(ids: string[]): Promise<void>
}
export const conversationCacheKey: InjectionKey<ConversationCache> = Symbol("conversation cache")
export const useConversationCache = () => hasInjectionContext() ? inject(conversationCacheKey, undefined) : undefined

interface Row { key: string; owner: string; scope: string; id: string; touched: number; bytes: number; json: string }
const maxEntries = 30
let database: Promise<IDBDatabase> | undefined
let pending: Promise<unknown> = Promise.resolve()

// Serialization may yield. Keep writes, reads, and removals ordered so a slow
// save cannot recreate a cache entry after its Session or owner was removed.
function enqueue<T>(operation: () => Promise<T>): Promise<T | undefined> {
  const next = pending.then(operation).catch(() => undefined)
  pending = next
  return next
}

function open(): Promise<IDBDatabase> {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("deskfleet-conversations", 2)
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains("conversations")
        ? request.transaction!.objectStore("conversations")
        : request.result.createObjectStore("conversations", { keyPath: "key" })
      store.createIndex("recency", ["touched", "bytes"])
    }
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined }; resolve(request.result) }
    request.onerror = () => reject(request.error)
  }).catch(error => { database = undefined; throw error })
}

// Cache failures (including private browsing and storage quota) never block a conversation.
async function transaction<T>(run: (store: IDBObjectStore, finish: (value: T) => void) => void): Promise<T | undefined> {
  try {
    const db = await open()
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction("conversations", "readwrite")
      let result: T | undefined
      tx.oncomplete = () => resolve(result)
      tx.onerror = tx.onabort = () => reject(tx.error)
      run(tx.objectStore("conversations"), value => { result = value })
    })
  } catch { return undefined }
}

export function createConversationCache(owner: string, scope: string): ConversationCache {
  const key = (id: string) => JSON.stringify([owner, scope, id])
  return {
    async read(id) {
      return enqueue(() => transaction<CachedConversation>((store, finish) => {
        const request = store.get(key(id))
        request.onsuccess = () => {
          const row = request.result as Row | undefined
          if (!row) return
          try {
            const value = JSON.parse(row.json) as CachedConversation
            if (value.snapshot.session.id !== id || !Array.isArray(value.events)) return
            store.put({ ...row, touched: Date.now() })
            finish(value)
          } catch { store.delete(key(id)) }
        }
      }))
    },
    async write(id, value) {
      // Capture the mutable snapshot now; only immutable journal events can be
      // serialized later. Avoid walking Vue proxies while capturing it.
      let snapshot: string
      try { snapshot = JSON.stringify(toRaw(value.snapshot)) } catch { return }
      const events = toRaw(value.events).slice()
      await enqueue(async () => {
        const json = await serializeConversation(snapshot, events)
        const bytes = json === undefined ? 0 : json.length * 2
        await transaction((store) => {
          if (json === undefined) { store.delete(key(id)); return }
          let total = bytes
          let count = 1
          // Index keys contain the LRU metadata; never load old JSON payloads
          // just to decide which entries should be evicted.
          const request = store.index("recency").openKeyCursor(null, "prev")
          request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) {
              store.put({ key: key(id), owner, scope, id, touched: Date.now(), bytes, json } satisfies Row)
              return
            }
            if (cursor.primaryKey !== key(id)) {
              total += (cursor.key as [number, number])[1]
              if (++count > maxEntries || total > maxConversationCacheBytes) store.delete(cursor.primaryKey)
            }
            cursor.continue()
          }
        })
      })
    },
    async retain(ids) {
      const keep = new Set(ids)
      await enqueue(() => transaction(store => {
        const request = store.openKeyCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          const [entryOwner, entryScope, id] = JSON.parse(cursor.primaryKey as string) as string[]
          if (entryOwner === owner && entryScope === scope && !keep.has(id!)) store.delete(cursor.primaryKey)
          cursor.continue()
        }
      }))
    },
    async remove(id) { await enqueue(() => transaction(store => { store.delete(key(id)) })) },
  }
}

export async function clearConversationOwner(owner: string): Promise<void> {
  await enqueue(() => transaction(store => {
    const request = store.openKeyCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const [entryOwner] = JSON.parse(cursor.primaryKey as string) as string[]
      if (entryOwner === owner) store.delete(cursor.primaryKey)
      cursor.continue()
    }
  }))
}
