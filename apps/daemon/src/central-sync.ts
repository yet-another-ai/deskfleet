import type { AgentSessions } from "./agent-sessions.ts"
import type { DaemonCatalog } from "./catalog.ts"
import type { AgentProviders } from "./agent-providers.ts"
import type { ProviderUpdates } from "./provider-updates.ts"
import type { ScheduledTasks } from "./scheduled-tasks.ts"
import { supportsDesktop } from "./desktop-capabilities.ts"
import { MUX_PROFILE } from "../../../packages/client/src/mux/protocol.ts"

type Post = (path: string, value: unknown) => Promise<unknown>

/** The daemon journal is authoritative; acknowledged event cursors are replayable. */
export class CentralSync {
  readonly #agents: AgentSessions
  readonly #catalog: DaemonCatalog
  readonly #post: Post
  readonly #providers: AgentProviders
  readonly #providerUpdates: Pick<ProviderUpdates, "snapshot" | "onChanged"> | undefined
  readonly #schedules: Pick<ScheduledTasks, "snapshot" | "onChanged"> | undefined
  readonly #desktopSupported: () => Promise<boolean>
  readonly #cursors = new Map<string, string>()
  readonly #commandCursors = new Map<string, string>()
  readonly #pendingSessions = new Set<string>()
  readonly #unsubscribe: (() => void)[]
  #running: Promise<void> | undefined
  #dirty = false
  #catalogDirty = true
  #schedulesDirty = true
  #enabled = false
  #closed = false
  #closing = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(agents: AgentSessions, catalog: DaemonCatalog, providers: AgentProviders, post: Post, desktopSupported: () => Promise<boolean> = supportsDesktop, schedules?: Pick<ScheduledTasks, "snapshot" | "onChanged">, providerUpdates?: Pick<ProviderUpdates, "snapshot" | "onChanged">) {
    this.#agents = agents; this.#catalog = catalog; this.#post = post
    this.#providers = providers
    this.#providerUpdates = providerUpdates
    this.#schedules = schedules
    this.#desktopSupported = desktopSupported
    this.#unsubscribe = [agents.onEvent(event => {
      if (event.kind === "session") this.#catalogDirty = true
      this.changed(event.sessionId)
    }), catalog.onChange(() => this.changed()), providers.onChanged(() => this.changed())]
    if (providerUpdates) this.#unsubscribe.push(providerUpdates.onChanged(() => this.changed()))
    if (schedules) this.#unsubscribe.push(schedules.onChanged(() => {
      this.#schedulesDirty = true
      this.#dirty = true
      this.#schedule()
    }))
  }

  enable(): void { this.#enabled = true; this.#schedulesDirty = true; this.changed() }
  disable(): void { this.#enabled = false; clearTimeout(this.#timer); this.#timer = undefined }
  changed(sessionId?: string): void {
    this.#dirty = true
    if (!sessionId) this.#catalogDirty = true
    else this.#pendingSessions.add(sessionId)
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
        try {
          // Allocate before capture so a delayed older upload cannot remove newer Sessions.
          const revision = await this.#agents.journal.id()
          await this.#post("/api/daemon/catalog", {
            revision, snapshot: await this.#catalog.snapshot(),
            providers: { ...this.#providers.metadata(), ...(this.#providerUpdates ? { updates: this.#providerUpdates.snapshot() } : {}) },
            capabilities: { platform: process.platform, desktop: await this.#desktopSupported(), agent: true, terminal: true, git: true, mux: MUX_PROFILE },
          })
        }
        catch (error) { this.#catalogDirty = true; throw error }
      }
      if (this.#schedules && this.#schedulesDirty) {
        this.#schedulesDirty = false
        try { await this.#post("/api/daemon/schedules", { tasks: this.#schedules.snapshot() }) }
        catch (error) { this.#schedulesDirty = true; throw error }
      }
      const errors: unknown[] = []
      for (const session of await this.#agents.journal.list()) {
        if (!this.#enabled || this.#closed) break
        const acknowledged = this.#cursors.get(session.id)
        if (acknowledged !== undefined && BigInt(session.lastEventSeq) <= BigInt(acknowledged) && !this.#pendingSessions.has(session.id)) continue
        this.#pendingSessions.delete(session.id)
        try { await this.#syncSession(session.id) }
        catch (error) { this.#pendingSessions.add(session.id); errors.push(error) }
      }
      // A failed history upload must not prevent other Sessions' summaries from
      // reaching the already-published catalog. Keep the failure retriable below.
      if (errors.length) throw errors[0]
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

  async #syncSession(sessionId: string): Promise<void> {
    const { snapshot, receipts } = await this.#agents.journal.serial(sessionId, async () => ({
      snapshot: await this.#agents.journal.read(sessionId),
      receipts: await this.#agents.journal.commandsSince(sessionId, this.#commandCursors.get(sessionId) ?? "-1"),
    }), { flushStreaming: false })
    let cursor = this.#cursors.get(sessionId) ?? "0"
    let commandOffset = 0
    let first = true
    do {
      const events = (await this.#agents.journal.history(sessionId, cursor, 200)).filter(event => BigInt(event.seq) <= BigInt(snapshot.session.lastEventSeq))
      const commands = receipts.commands.slice(commandOffset, commandOffset + 200)
      const response = await this.#post("/api/daemon/history", {
        sessionId, ...(first ? { snapshot } : { snapshotSeq: snapshot.session.lastEventSeq }), commands, events,
      }) as { lastEventSeq: string }
      const next = response.lastEventSeq
      if (!/^\d+$/u.test(next) || BigInt(next) < BigInt(cursor)) throw new Error("Backend returned an invalid history acknowledgement")
      this.#cursors.set(sessionId, next)
      commandOffset += commands.length
      first = false
      if (BigInt(next) >= BigInt(snapshot.session.lastEventSeq) && commandOffset >= receipts.commands.length) {
        // Receipts can change without advancing the event sequence. A lost
        // response must replay every unacknowledged receipt revision.
        this.#commandCursors.set(sessionId, receipts.revision)
        return
      }
      if (next === cursor && BigInt(next) < BigInt(snapshot.session.lastEventSeq)) throw new Error("Backend did not acknowledge history progress")
      cursor = next
    } while (this.#enabled && !this.#closed)
    this.#pendingSessions.add(sessionId)
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
