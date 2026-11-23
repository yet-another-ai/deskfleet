import { isAbsolute } from "node:path"
import type { AgentCommand, AgentSnapshot } from "@deskfleet/protocol/agent"
import { validateAgentConfigurationSelection } from "@deskfleet/protocol/agent-configuration"
import type { GitPreparedRevision } from "@deskfleet/protocol/git"
import { truncateGeneratedTitle } from "@deskfleet/protocol/titles"
import type { DaemonCatalog } from "../machine/catalog.ts"
import { copyForkHistory } from "./fork-history.ts"
import { requiredString } from "./params.ts"
import { consumedTurns, type SessionAdmissions } from "./quotas.ts"
import type { AgentRuntime, ResolveAgentProvider } from "./runtime.ts"
import { savedAgentConfiguration } from "./session-configuration.ts"
import { errorMessage, timestamp, type AgentJournal } from "./store.ts"

export interface SessionProvisioningHost {
  readonly journal: AgentJournal
  readonly catalog: DaemonCatalog
  readonly admissions: SessionAdmissions
  readonly resolveProvider: ResolveAgentProvider
  closed(): boolean
  /** The Session's runtime, created when it has none. */
  runtime(sessionId: string): AgentRuntime
  existingRuntime(sessionId: string): AgentRuntime | undefined
}

/**
 * Creating or forking a Session admits it, prepares its working directory, and
 * then starts its Agent. A deferred creation returns before its directory is
 * ready; work that needs the directory waits for `ready`.
 */
export class SessionProvisioning {
  readonly #host: SessionProvisioningHost
  readonly #pending = new Map<string, Promise<void>>()
  readonly #stoppedBeforeStart = new Set<string>()

  constructor(host: SessionProvisioningHost) { this.#host = host }

  /** Settles when the Session's deferred provisioning, if any, finishes. */
  ready(sessionId: string): Promise<void> { return this.#pending.get(sessionId) ?? Promise.resolve() }

  inProgress(sessionId: string): boolean { return this.#pending.has(sessionId) }

  /** A Stop accepted while the directory is being prepared keeps the Agent from starting afterward. */
  stopBeforeStart(sessionId: string): void {
    if (this.#pending.has(sessionId)) this.#stoppedBeforeStart.add(sessionId)
  }

  /** A Resume, or further input, lets the Agent start once provisioning finishes. */
  allowStart(sessionId: string): void { this.#stoppedBeforeStart.delete(sessionId) }

  settle(): Promise<unknown> { return Promise.allSettled(this.#pending.values()) }

  async create(command: AgentCommand): Promise<AgentSnapshot> {
    const { journal, catalog, admissions } = this.#host
    const provider = requiredString(command.params.provider, "Agent provider")
    this.#host.resolveProvider(provider)
    validateAgentConfigurationSelection(command.params)
    if (command.params.deferStartup !== undefined && typeof command.params.deferStartup !== "boolean") {
      throw new Error("Invalid deferred startup flag")
    }
    if (command.params.yolo !== undefined && typeof command.params.yolo !== "boolean") {
      throw new Error("Invalid YOLO flag")
    }
    if (command.params.superAgent !== undefined && typeof command.params.superAgent !== "boolean") {
      throw new Error("Invalid Super Agent flag")
    }
    const yoloFields = command.params.yolo ? { yolo: true, yoloActor: command.actor } : {}
    const superAgentFields = command.params.superAgent ? { superAgent: true } : {}
    const context = command.params.context
    if (context !== "worktree" && context !== "directory") throw new Error("Invalid Session context")
    if (!command.workspaceId && context !== "directory") throw new Error("Sessions without a workspace use the home directory")
    const cwd = command.params.cwd === undefined ? undefined : requiredString(command.params.cwd, "working directory").trim()
    if (cwd !== undefined && (context !== "directory" || !cwd || !isAbsolute(cwd) || cwd.includes("\0") || cwd.length > 4096)) {
      throw new Error("Invalid Session working directory")
    }
    const baseBranch = command.params.baseBranch === undefined ? undefined : requiredString(command.params.baseBranch, "base branch").trim()
    if (baseBranch !== undefined && (!baseBranch || context !== "worktree")) throw new Error("Invalid base branch")
    const baseRevisions = command.params.baseRevisions as GitPreparedRevision[] | undefined
    if (baseRevisions !== undefined && (context !== "worktree" || !command.workspaceId || baseBranch !== undefined
      || !Array.isArray(baseRevisions) || !baseRevisions.length || baseRevisions.some(value => !value
        || typeof value.path !== "string" || typeof value.revision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.revision)))) {
      throw new Error("Invalid prepared Git revisions")
    }
    const title = typeof command.params.title === "string" ? truncateGeneratedTitle(command.params.title) : ""
    const session = await admissions.allocate(command, "create", admissionGeneration =>
      journal.create(command, command.workspaceId, title, context, provider, {
        admissionGeneration,
        ...yoloFields,
        ...superAgentFields,
      }))
    command.sessionId = session.id
    const provision = async (includeCommandEvent: boolean): Promise<void> => {
      try {
        await catalog.provisionSession(session.id, session.workspaceId, context, baseBranch, baseRevisions, cwd)
        await journal.serial(session.id, async () => {
          const snapshot = await journal.read(session.id)
          const ready = { ...snapshot.session, lifecycle: "ready" as const, updatedAt: timestamp() }
          const events = [journal.event(session.id, "session", ready)]
          if (includeCommandEvent) events.push(journal.event(session.id, "command", command))
          await journal.commit(snapshot, { session: ready, events })
        })
        // Provider failures are persisted by the runtime and can be resumed.
        if (!this.#host.closed() && !this.#stoppedBeforeStart.delete(session.id)) {
          await this.#host.runtime(session.id).start().catch(() => {})
        }
      } catch (error) {
        this.#stoppedBeforeStart.delete(session.id)
        await journal.serial(session.id, async () => {
          const snapshot = await journal.read(session.id)
          const failed = { ...snapshot.session, lifecycle: "provision_failed" as const, error: errorMessage(error), updatedAt: timestamp() }
          await journal.commit(snapshot, { session: failed, events: [journal.event(session.id, "session", failed)] })
        })
      }
    }
    if (command.params.deferStartup === true) {
      const initial = await journal.serial(session.id, async () => {
        const snapshot = await journal.read(session.id)
        const completed = { ...command, status: "completed" as const, result: snapshot, completedAt: timestamp() }
        await journal.commit(snapshot, {
          command: completed,
          events: [
            journal.event(session.id, "command", command, { commandId: command.id }),
            journal.event(session.id, "command", completed, { commandId: command.id }),
          ],
        })
        return journal.read(session.id)
      })
      const pending = provision(false)
        .finally(() => { this.#pending.delete(session.id); catalog.changed() })
        .catch(error => console.error(`Could not provision Session ${session.id}`, error))
      this.#pending.set(session.id, pending)
      catalog.changed()
      return initial
    }
    await provision(true)
    const snapshot = await journal.read(session.id)
    await journal.complete(command, snapshot)
    catalog.changed()
    return snapshot
  }

  async fork(command: AgentCommand): Promise<AgentSnapshot> {
    const { journal, catalog, admissions } = this.#host
    const context = command.params.context
    if (context !== "worktree" && context !== "directory") throw new Error("Invalid Session context")
    const sourceId = command.sessionId!
    const sourceSession = await journal.session(sourceId)
    if (!sourceSession.workspaceId && context !== "directory") throw new Error("Sessions without a workspace use the home directory")
    return this.#host.runtime(sourceId).withFork(async source => {
      this.#host.resolveProvider(source.session.provider)
      const title = typeof command.params.title === "string" ? truncateGeneratedTitle(command.params.title) : source.session.title
      const creation = { ...command, sessionId: undefined, workspaceId: source.session.workspaceId }
      const yoloFields = source.session.yolo ? { yolo: true, yoloActor: command.actor } : {}
      const superAgentFields = source.session.superAgent ? { superAgent: true } : {}
      const child = await admissions.allocate(command, "fork", admissionGeneration =>
        journal.create(creation, source.session.workspaceId, title, context, source.session.provider, {
          admissionGeneration,
          inheritedTurnCount: consumedTurns(source),
          ...yoloFields,
          ...superAgentFields,
        }))
      command.sessionId = child.id
      command.workspaceId = child.workspaceId
      try {
        // Only directory→directory forks keep the source primary path. Forking
        // from a worktree Session must not attach the owned checkout as cwd.
        const cwd = context === "directory" && source.session.context === "directory"
          ? (await catalog.sessionWorktree(sourceId))?.directories[0]?.path
          : undefined
        await catalog.provisionSession(child.id, child.workspaceId, context, undefined, undefined, cwd)
        await copyForkHistory(journal, source, child.id)
        await journal.serial(child.id, async () => {
          const snapshot = await journal.read(child.id)
          await journal.commit(snapshot, { events: [journal.event(child.id, "command", command)] })
        })
        if (this.#host.closed()) throw new Error("Agent service is stopping")
        const saved = await savedAgentConfiguration(journal, sourceId)
        await this.#host.runtime(child.id).start(saved.selection, source.session.providerSessionId!)
      } catch (error) {
        await this.#host.existingRuntime(child.id)?.stop().catch(() => {})
        await journal.serial(child.id, async () => {
          const snapshot = await journal.read(child.id)
          const failed = { ...snapshot.session, lifecycle: "provision_failed" as const, error: errorMessage(error), updatedAt: timestamp() }
          await journal.commit(snapshot, { session: failed, events: [journal.event(child.id, "session", failed)] })
        })
      }
      const snapshot = await journal.read(child.id)
      await journal.complete(command, snapshot)
      catalog.changed()
      return snapshot
    })
  }
}
