import type { AgentCommand, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { WorktreePreferences } from "@deskfleet/protocol/worktree-preferences"
import type { DaemonCatalog } from "../machine/catalog.ts"
import type { TerminalSessions } from "../terminals/terminals.ts"
import { worktreeCleanupFingerprint } from "../worktrees/cleanup-inspection.ts"
import { cleanupSessionIdle } from "../worktrees/cleanup-policy.ts"
import type { SessionPresence } from "./presence.ts"
import type { SessionAdmissions } from "./quotas.ts"
import type { AgentRuntime } from "./runtime.ts"
import { timestamp, type AgentJournal } from "./store.ts"

type CleanupSettings = WorktreePreferences["cleanup"]
interface AutomaticCleanup { sequence: string; settings: CleanupSettings; git?: string }

export interface SessionTransitionHost {
  readonly journal: AgentJournal
  readonly catalog: DaemonCatalog
  readonly admissions: SessionAdmissions
  readonly presence: SessionPresence
  readonly terminals?: TerminalSessions
  closed(): boolean
  /** The Session's runtime, created when it has none. */
  runtime(sessionId: string): AgentRuntime
  /** Drops a deleted Session's runtime. */
  forget(sessionId: string): void
}

/**
 * Archive, restore, automatic worktree cleanup, and deletion run one at a time
 * for each Session. Archiving stops live resources before its checkout changes.
 */
export class SessionTransitions {
  readonly #host: SessionTransitionHost
  readonly #pending = new Map<string, Promise<unknown>>()
  readonly #archiveListeners = new Set<(worktreeId: string) => Promise<void>>()

  constructor(host: SessionTransitionHost) { this.#host = host }

  /** Listeners close resources bound to a Worktree before its Session is archived. */
  onArchive(listener: (worktreeId: string) => Promise<void>): () => void {
    this.#archiveListeners.add(listener)
    return () => this.#archiveListeners.delete(listener)
  }

  /** Archives or restores the command's Session. */
  transition(command: AgentCommand): Promise<AgentSnapshot> {
    const { journal, catalog, admissions } = this.#host
    const sessionId = command.sessionId!
    return this.#after(sessionId, async () => {
      if (command.method === "_deskfleet/session/archive") await this.#archive(sessionId)
      else await journal.serial(sessionId, async () => {
        const snapshot = await journal.read(sessionId)
        if (snapshot.session.archiveState === "archiving") throw new Error("Finish archiving this Session before restoring it")
        if (snapshot.session.archiveState === "active") return
        await catalog.restoreSessionWorktree(sessionId)
        const session = { ...snapshot.session, archiveState: "active" as const, updatedAt: timestamp() }
        await journal.commit(snapshot, { session, events: [journal.event(sessionId, "session", session)] })
      })
      const snapshot = await journal.read(sessionId)
      await admissions.synchronize(snapshot.session)
      await journal.complete(command, snapshot)
      return snapshot
    })
  }

  /** Finishes an archive interrupted by a daemon restart. */
  continueArchive(sessionId: string): Promise<void> {
    const { journal, admissions } = this.#host
    return this.#after(sessionId, async () => {
      if (this.#host.closed()) return
      const current = await journal.session(sessionId)
      if (current.archiveState !== "archiving" || !["ready", "provision_failed"].includes(current.lifecycle)) return
      await this.#archive(sessionId)
      const snapshot = await journal.read(sessionId)
      await admissions.synchronize(snapshot.session)
    })
  }

  /** Recheck the candidate under the same gate used by input and terminal admission. */
  cleanupWorktree(sessionId: string, sequence: string, settings: CleanupSettings, git?: string): Promise<void> {
    if (this.#host.closed() || this.#pending.has(sessionId)) return Promise.resolve()
    return this.#track(sessionId, this.#archive(sessionId, { sequence, settings, git }).then(async () => {
      await this.#host.admissions.synchronize(await this.#host.journal.session(sessionId))
    }))
  }

  delete(command: AgentCommand): Promise<null> {
    return this.#after(command.sessionId!, () => this.#delete(command))
  }

  settle(): Promise<unknown> { return Promise.allSettled(this.#pending.values()) }

  #after<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(sessionId) ?? Promise.resolve()
    return this.#track(sessionId, previous.catch(() => {}).then(action))
  }

  #track<T>(sessionId: string, next: Promise<T>): Promise<T> {
    this.#pending.set(sessionId, next)
    void next.finally(() => { if (this.#pending.get(sessionId) === next) this.#pending.delete(sessionId) }).catch(() => {})
    return next
  }

  async #archive(sessionId: string, automatic?: AutomaticCleanup): Promise<void> {
    const { journal, catalog, presence, terminals } = this.#host
    const settingsUnchanged = async (settings: CleanupSettings) => JSON.stringify((await catalog.getWorktreePreferences()).cleanup) === JSON.stringify(settings)
    const alreadyArchived = await journal.serial(sessionId, async () => {
      const snapshot = await journal.read(sessionId)
      if (automatic) {
        if (!await settingsUnchanged(automatic.settings)) return "skip"
        if (this.#host.closed() || snapshot.session.lastEventSeq !== automatic.sequence || !cleanupSessionIdle(snapshot)
          || presence.userIds(sessionId).length) return "skip"
        const worktree = await catalog.sessionWorktree(sessionId)
        if (worktree && terminals?.list().some(terminal => terminal.worktreeId === worktree.id && terminal.status === "running" && terminal.kind !== "acp")) return "skip"
        const inspection = await catalog.inspectSessionWorktreeCleanup(sessionId, automatic.settings.keepLocalChanges)
        if (!inspection?.hasCheckouts || inspection.protected || presence.userIds(sessionId).length) return "skip"
        if (automatic.git !== undefined && worktreeCleanupFingerprint(inspection) !== automatic.git) return "skip"
        if (snapshot.session.archiveState === "archived") {
          if (automatic.settings.archived && await settingsUnchanged(automatic.settings)) {
            await catalog.cleanupSessionWorktree(sessionId, automatic.settings.keepLocalChanges)
          }
          return "skip"
        }
        if (snapshot.session.archiveState !== "active") return "skip"
      }
      if (!["ready", "provision_failed"].includes(snapshot.session.lifecycle)) throw new Error("Wait for Session provisioning or deletion before archiving")
      if (snapshot.session.archiveState === "archived") return true
      await catalog.prepareSessionWorktreeArchive(sessionId)
      const session = { ...snapshot.session, archiveState: "archiving" as const, updatedAt: timestamp() }
      await journal.commit(snapshot, { session, events: [journal.event(sessionId, "session", session)] })
      return false
    })
    if (alreadyArchived === "skip") return
    if (alreadyArchived) {
      await catalog.archiveSessionWorktree(sessionId)
      return
    }
    const worktree = await catalog.sessionWorktree(sessionId)
    const closures = [this.#host.runtime(sessionId).stop()]
    if (worktree) for (const listener of this.#archiveListeners) closures.push(Promise.resolve().then(() => listener(worktree.id)))
    const results = await Promise.allSettled(closures)
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Session resources could not all be closed; retry archive")
    if (!automatic) await catalog.archiveSessionWorktree(sessionId)
    await journal.serial(sessionId, async () => {
      const snapshot = await journal.read(sessionId)
      if (snapshot.session.lifecycle === "deleting") return
      const removed = !automatic || (!this.#host.closed() && !presence.userIds(sessionId).length
        && await settingsUnchanged(automatic.settings)
        && await catalog.cleanupSessionWorktree(sessionId, automatic.settings.keepLocalChanges, automatic.git))
      const session = { ...snapshot.session, archiveState: removed ? "archived" as const : "active" as const, updatedAt: timestamp() }
      await journal.commit(snapshot, { session, events: [journal.event(sessionId, "session", session)] })
    })
  }

  async #delete(command: AgentCommand): Promise<null> {
    const { journal, catalog, admissions } = this.#host
    const sessionId = command.sessionId!
    await journal.serial(sessionId, async () => {
      const snapshot = await journal.read(sessionId)
      const session = { ...snapshot.session, lifecycle: "deleting" as const, updatedAt: timestamp() }
      await journal.commit(snapshot, { session, events: [journal.event(sessionId, "session", session)] })
    })
    await this.#host.runtime(sessionId).stop()
    const deleted = await journal.session(sessionId)
    await catalog.handle({ method: "workspaceSessionDestroy", params: { sessionId } })
    journal.live.remove(sessionId)
    await admissions.releaseDeleted(deleted)
    this.#host.forget(sessionId)
    await journal.complete(command, null)
    return null
  }
}
