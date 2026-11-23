export interface SessionPresenceUpdate {
  sessionId: string
  userIds: string[]
}

/** Live attendance for one daemon. A person with several connections counts once. */
export class SessionPresence {
  readonly #watchers = new Map<string, Map<string, string>>()
  readonly #listeners = new Set<(update: SessionPresenceUpdate) => void>()

  watch(sessionId: string, connectionId: string, userId: string): void {
    let session = this.#watchers.get(sessionId)
    if (!session) {
      session = new Map()
      this.#watchers.set(sessionId, session)
    }
    if (session.get(connectionId) === userId) return
    session.set(connectionId, userId)
    this.#emit(sessionId)
  }

  unwatch(sessionId: string, connectionId: string): void {
    const session = this.#watchers.get(sessionId)
    if (!session?.delete(connectionId)) return
    if (!session.size) this.#watchers.delete(sessionId)
    this.#emit(sessionId)
  }

  disconnect(connectionId: string): void {
    for (const sessionId of [...this.#watchers.keys()]) this.unwatch(sessionId, connectionId)
  }

  userIds(sessionId: string): string[] {
    return [...new Set(this.#watchers.get(sessionId)?.values() ?? [])].sort()
  }

  visits(connectionId: string): { sessionId: string; userId: string }[] {
    return [...this.#watchers].flatMap(([sessionId, watchers]) => {
      const userId = watchers.get(connectionId)
      return userId ? [{ sessionId, userId }] : []
    })
  }

  snapshot(): SessionPresenceUpdate[] {
    return [...this.#watchers.keys()].map(sessionId => ({ sessionId, userIds: this.userIds(sessionId) }))
  }

  onChange(listener: (update: SessionPresenceUpdate) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #emit(sessionId: string): void {
    const update = { sessionId, userIds: this.userIds(sessionId) }
    for (const listener of this.#listeners) listener(update)
  }
}
