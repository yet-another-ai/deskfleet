import type { AgentSessions } from "./agent-sessions.ts"
import type { DaemonCatalog } from "./catalog.ts"
import type { AgentProviders } from "./agent-providers.ts"

type Post = (path: string, value: unknown) => Promise<unknown>

/** The daemon journal is authoritative; acknowledged event cursors are replayable. */
export class CentralSync {
  readonly #agents: AgentSessions
  readonly #catalog: DaemonCatalog
  readonly #post: Post
  readonly #providers: AgentProviders
  readonly #cursors = new Map<string, string>()
  readonly #unsubscribe: (() => void)[]
  #running: Promise<void> | undefined
  #dirty = false
  #catalogDirty = true
  #enabled = false
  #closed = false
  #closing = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(agents: AgentSessions, catalog: DaemonCatalog, providers: AgentProviders, post: Post) {
    this.#agents = agents; this.#catalog = catalog; this.#post = post
    this.#providers = providers
    this.#unsubscribe = [agents.onEvent(event => this.changed(event.sessionId)), catalog.onChange(() => this.changed()), providers.onChanged(() => this.changed())]
  }

  enable(): void { this.#enabled = true; this.changed() }
  disable(): void { this.#enabled = false; clearTimeout(this.#timer); this.#timer = undefined }
  changed(sessionId?: string): void {
    this.#dirty = true
    if (!sessionId) this.#catalogDirty = true
    this.#schedule()
  }

  #schedule(): void {
    if (!this.#enabled || this.#closed || this.#closing || this.#running || this.#timer) return
    // Coalesce streaming chunks into snapshots while retaining every journal event.
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.flush().catch(() => {}) }, 250)
    this.#timer.unref()
  }

  async flush(): Promise<void> {
    if (this.#running) return this.#running
    if (!this.#enabled || this.#closed) return
    this.#running = this.#flush().finally(() => { this.#running = undefined; if (this.#dirty) this.#schedule() })
    return this.#running
  }

  async #flush(): Promise<void> {
    this.#dirty = false
    try {
      if (this.#catalogDirty) {
        this.#catalogDirty = false
        try { await this.#post("/api/daemon/catalog", {
          snapshot: await this.#catalog.native.snapshot(), providers: this.#providers.metadata(),
          capabilities: { platform: process.platform, desktop: process.platform === "darwin" || process.platform === "win32", agent: true, terminal: true, git: true },
        }) }
        catch (error) { this.#catalogDirty = true; throw error }
      }
      for (const session of await this.#agents.journal.list()) {
        if (!this.#enabled || this.#closed) return
        const acknowledged = this.#cursors.get(session.id)
        if (acknowledged !== undefined && BigInt(session.lastEventSeq) <= BigInt(acknowledged)) continue
        const { snapshot, commands } = await this.#agents.journal.serial(session.id, async () => ({
          snapshot: await this.#agents.journal.read(session.id), commands: await this.#agents.journal.commands(session.id),
        }))
        let cursor = this.#cursors.get(session.id) ?? "0"
        do {
          const events = (await this.#agents.journal.history(session.id, cursor, 200)).filter(event => BigInt(event.seq) <= BigInt(snapshot.session.lastEventSeq))
          const response = await this.#post("/api/daemon/history", { sessionId: session.id, snapshot, commands, events }) as { lastEventSeq: string }
          const next = response.lastEventSeq
          if (!/^\d+$/u.test(next) || BigInt(next) < BigInt(cursor)) throw new Error("Backend returned an invalid history acknowledgement")
          this.#cursors.set(session.id, next)
          if (BigInt(next) >= BigInt(snapshot.session.lastEventSeq)) break
          if (next === cursor) throw new Error("Backend did not acknowledge history progress")
          cursor = next
        } while (this.#enabled && !this.#closed)
      }
    } catch (error) {
      this.#dirty = true
      // Retrying replays durable events. There is no in-memory-only history buffer.
      if (!this.#closing) {
        this.#timer = setTimeout(() => { this.#timer = undefined; this.#schedule() }, 5_000)
        this.#timer.unref()
      }
      throw error
    }
  }

  async close(flush = false): Promise<void> {
    this.#closing = true; this.disable()
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    await this.#running?.catch(() => {})
    if (flush) {
      this.#enabled = true
      // Producers have stopped. A failed final upload remains in the durable
      // journal and is replayed on the next daemon startup.
      await this.#flush().catch(() => {})
    }
    this.#closed = true; this.disable()
  }
}
