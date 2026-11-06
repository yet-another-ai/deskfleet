import { hasInjectionContext, inject, type InjectionKey } from "vue"
import type { AgentEvent, AgentSnapshot } from "../../../../apps/daemon/src/agent-protocol.ts"

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
const maxBytes = 32 * 1024 * 1024
let database: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("deskfleet-conversations", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("conversations", { keyPath: "key" })
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
      return transaction<CachedConversation>((store, finish) => {
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
      })
    },
    async write(id, value) {
      const json = JSON.stringify(value)
      const bytes = json.length * 2
      await transaction((store) => {
        if (bytes > maxBytes) { store.delete(key(id)); return }
        const request = store.getAll()
        request.onsuccess = () => {
          const rows = (request.result as Row[]).filter(row => row.key !== key(id)).sort((a, b) => b.touched - a.touched)
          let total = bytes
          let count = 1
          for (const row of rows) {
            total += row.bytes
            if (++count > maxEntries || total > maxBytes) store.delete(row.key)
          }
          store.put({ key: key(id), owner, scope, id, touched: Date.now(), bytes, json } satisfies Row)
        }
      })
    },
    async retain(ids) {
      const keep = new Set(ids)
      await transaction(store => {
        const request = store.openCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          const row = cursor.value as Row
          if (row.owner === owner && row.scope === scope && !keep.has(row.id)) cursor.delete()
          cursor.continue()
        }
      })
    },
    async remove(id) { await transaction(store => { store.delete(key(id)) }) },
  }
}

export async function clearConversationOwner(owner: string): Promise<void> {
  await transaction(store => {
    const request = store.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      if ((cursor.value as Row).owner === owner) cursor.delete()
      cursor.continue()
    }
  })
}
