import type { AgentSessions } from "./agent-sessions.ts"
import type { DaemonCatalog } from "./catalog.ts"
import type { AgentActor, AgentSnapshot } from "./agent-protocol.ts"
import type { GithubPullRequestQuery, GithubPullRequest } from "../../../packages/client/src/central.ts"
import { cleanupGitEligible, cleanupSessionIdle, cleanupTimeReason } from "./worktree-cleanup-policy.ts"
import { worktreeCleanupFingerprint } from "./worktree-cleanup-inspection.ts"

interface CleanupOptions {
  agents: AgentSessions
  catalog: DaemonCatalog
  pullRequest(actor: AgentActor, query: GithubPullRequestQuery): Promise<{ pullRequest: GithubPullRequest | null }>
  now?: () => number
  report?: (sessionId: string, error: unknown) => void
}

/** Each Team registration scans only its own journal and ownership manifests. */
export class WorktreeCleanup {
  readonly #options: CleanupOptions
  #timer?: ReturnType<typeof setTimeout>
  #pending?: Promise<void>
  #closed = false

  constructor(options: CleanupOptions) { this.#options = options }

  start(): void {
    if (this.#timer || this.#closed) return
    this.#schedule(60_000)
  }

  #schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.run().catch(error => this.#report("settings", error)).finally(() => {
        if (!this.#closed) this.#schedule(15 * 60_000)
      })
    }, delay)
    this.#timer.unref()
  }

  #report(sessionId: string, error: unknown): void {
    if (this.#options.report) this.#options.report(sessionId, error)
    else console.error(`Could not clean up Session ${sessionId} worktree`, error)
  }

  run(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    return this.#pending ??= this.#run().finally(() => { this.#pending = undefined })
  }

  async #run(): Promise<void> {
    const { agents, catalog } = this.#options
    await agents.resumeArchiving()
    const { cleanup } = await catalog.getWorktreePreferences()
    if (![cleanup.archived, cleanup.inactive, cleanup.settled, cleanup.merged, cleanup.unchanged].some(Boolean)) return
    for (const session of await agents.journal.list()) {
      if (this.#closed) return
      if (session.context !== "worktree" || !["ready", "provision_failed"].includes(session.lifecycle) || session.archiveState === "archiving") continue
      try {
        const snapshot = await agents.journal.read(session.id)
        if (!cleanupSessionIdle(snapshot) || agents.presence().some(presence => presence.sessionId === session.id && presence.userIds.length)) continue
        const timed = cleanupTimeReason(snapshot, cleanup, (this.#options.now ?? Date.now)())
        const gitEligible = cleanupGitEligible(snapshot) && (cleanup.unchanged || cleanup.merged)
        if (!timed && !gitEligible) continue
        if (!timed) await catalog.refreshSessionWorktreeDefaults(session.id)
        const inspection = await catalog.inspectSessionWorktreeCleanup(session.id, cleanup.keepLocalChanges)
        if (!inspection?.hasCheckouts || inspection.protected) continue
        const included = inspection.repositories.length > 0 && inspection.repositories.every(repository => repository.includedInDefault)
        if (!timed && !(included && (cleanup.unchanged || cleanup.merged && await this.#merged(snapshot)))) continue
        if (this.#closed) return
        await agents.cleanupWorktree(session.id, snapshot.session.lastEventSeq, cleanup, timed ? undefined : worktreeCleanupFingerprint(inspection))
      } catch (error) { this.#report(session.id, error) }
    }
  }

  async #merged(snapshot: AgentSnapshot): Promise<boolean> {
    const actor = snapshot.inputs.find(input => input.author.kind === "user" && input.author.userId)?.author
    if (!actor) return false
    const branches = (await this.#options.catalog.snapshot()).githubBranches?.find(entry => entry.sessionId === snapshot.session.id)?.repositories ?? []
    if (!branches.length) return false
    const groups = new Map<string, typeof branches>()
    for (const branch of branches) {
      const key = `${branch.headRepository}\0${branch.branch}`
      groups.set(key, [...groups.get(key) ?? [], branch])
    }
    for (const group of groups.values()) {
      let merged = false
      for (const branch of group) {
        const [owner, repo] = branch.repository.split("/")
        const headOwner = branch.headRepository.split("/")[0]
        if (!owner || !repo || !headOwner) continue
        const result = await this.#options.pullRequest(actor, { owner, repo, headOwner, branch: branch.branch })
        if (result.pullRequest?.state === "merged") { merged = true; break }
      }
      if (!merged) return false
    }
    return true
  }

  async close(): Promise<void> {
    this.#closed = true
    clearTimeout(this.#timer)
    await this.#pending
  }
}
