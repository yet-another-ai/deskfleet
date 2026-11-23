import { createHash } from "node:crypto"
import type { AgentActor, AgentCommand, AgentEvent, AgentMethod, AgentPreview, AgentSnapshot } from "@deskfleet/protocol/agent"
import { isSnapshotReference } from "@deskfleet/protocol/agent-command-results"
import { validateAgentConfigurationSelection, type AgentConfigurationSelection } from "@deskfleet/protocol/agent-configuration"
import type { AgentLiveUpdate } from "@deskfleet/protocol/agent-live"
import { validateProviderId } from "@deskfleet/protocol/provider"
import type { WorktreePreferences } from "@deskfleet/protocol/worktree-preferences"
import type { AgentProvider } from "../acp/connection.ts"
import { defaultAgentProvider as codexProvider } from "../acp/registry.ts"
import { GitInspection } from "../git/inspection.ts"
import { prepareGitWorkspace } from "../git/preparation.ts"
import type { DaemonCatalog } from "../machine/catalog.ts"
import type { AgentProviders } from "../providers/providers.ts"
import type { TerminalSessions } from "../terminals/terminals.ts"
import { ComposerReferences } from "./composer-references.ts"
import { SessionConversation } from "./conversation.ts"
import { AgentDiscovery } from "./discovery.ts"
import type { AgentMcp } from "./mcp.ts"
import { canonicalJson, recordId, requestParams, requiredString } from "./params.ts"
import { SessionPresence, type SessionPresenceUpdate } from "./presence.ts"
import { SessionProvisioning } from "./provisioning.ts"
import { SessionAdmissions, unavailableAgentQuotas, type AgentQuotaAuthority } from "./quotas.ts"
import { recoverInterruptedSessions } from "./recovery.ts"
import { AgentRuntime, type ResolveAgentProvider } from "./runtime.ts"
import { markSessionRead, markSessionUnread, rememberSessionViewer, renameSession } from "./session-metadata.ts"
import { SessionTransitions } from "./session-transitions.ts"
import { AgentJournal, errorMessage, requireActiveSession, timestamp, type AgentPersistence } from "./store.ts"

/**
 * Durable collaboration belongs to the daemon, not to a client connection.
 * This service validates Agent requests, deduplicates operations, and routes
 * each to the module that owns it.
 */
export class AgentSessions {
  readonly journal: AgentJournal
  readonly #catalog: DaemonCatalog
  readonly #resolveProvider: ResolveAgentProvider
  readonly #mcp?: AgentMcp
  readonly #terminals?: TerminalSessions
  readonly #quotas: AgentQuotaAuthority
  readonly #admissions: SessionAdmissions
  readonly #presence = new SessionPresence()
  readonly #git = new GitInspection()
  readonly #references: ComposerReferences
  readonly #discovery: AgentDiscovery
  readonly #provisioning: SessionProvisioning
  readonly #conversation: SessionConversation
  readonly #transitions: SessionTransitions
  readonly #runtimes = new Map<string, AgentRuntime>()
  readonly #operations = new Map<string, Promise<unknown>>()
  /** Reads and startup work that close() lets finish before releasing what they use. */
  readonly #inflight = new Set<Promise<unknown>>()
  readonly #unsubscribeProviders?: () => void
  readonly #closing = new AbortController()
  readonly #isClosed = () => this.#closed
  #closed = false

  constructor(catalog: DaemonCatalog, native: AgentPersistence, provider: AgentProvider = codexProvider, providers?: AgentProviders, mcp?: AgentMcp, terminals?: TerminalSessions, quotas: AgentQuotaAuthority = unavailableAgentQuotas) {
    this.#catalog = catalog
    this.journal = new AgentJournal(native)
    this.#references = new ComposerReferences(catalog, this.journal)
    this.#mcp = mcp
    this.#terminals = terminals
    this.#quotas = quotas
    this.#admissions = new SessionAdmissions(this.journal, quotas)
    this.#resolveProvider = providers ? id => providers.resolve(id) : id => {
      if (id !== "codex") throw new Error("Agent provider is unavailable")
      return { provider, config: { name: "Codex" } }
    }
    const configuredProviderIds = providers ? () => providers.metadata().providers.map(provider => provider.id) : () => ["codex"]
    this.#discovery = new AgentDiscovery(catalog, this.#resolveProvider, configuredProviderIds, this.#closing.signal)
    this.#unsubscribeProviders = providers?.onChanged(() => this.#discovery.providersChanged())
    const host = {
      journal: this.journal,
      catalog,
      admissions: this.#admissions,
      presence: this.#presence,
      terminals,
      resolveProvider: this.#resolveProvider,
      closed: this.#isClosed,
      runtime: (sessionId: string) => this.#runtime(sessionId),
      existingRuntime: (sessionId: string) => this.#runtimes.get(sessionId),
      forget: (sessionId: string) => { this.#runtimes.delete(sessionId) },
    }
    this.#provisioning = new SessionProvisioning(host)
    this.#conversation = new SessionConversation({ ...host, provisioning: this.#provisioning })
    this.#transitions = new SessionTransitions(host)
  }

  /** Startup and settings changes prewarm metadata without delaying machine readiness. */
  startConfigurationCache(): void { this.#discovery.start() }

  async init(): Promise<void> {
    await this.journal.init()
    await recoverInterruptedSessions(this.journal)
  }

  onEvent(listener: (event: AgentEvent) => void): () => void { return this.journal.onEvent(listener) }
  onPreview(listener: (preview: AgentPreview) => void): () => void { return this.journal.onPreview(listener) }
  onLive(listener: (update: AgentLiveUpdate) => void): () => void { return this.journal.live.onUpdate(listener) }
  live(sessionId: string): AgentLiveUpdate | undefined { return this.journal.live.current(sessionId) }
  onPresence(listener: (update: SessionPresenceUpdate) => void): () => void { return this.#presence.onChange(listener) }
  presence(): SessionPresenceUpdate[] { return this.#presence.snapshot() }
  preview(sessionId: string): AgentPreview | undefined { return this.journal.preview(sessionId) }
  actor(): AgentActor { return this.journal.actor() }

  async attend(sessionId: string, connectionId: string, actor: AgentActor): Promise<void> {
    if (this.#closed || actor.kind !== "user" || !actor.userId) return
    const session = await this.journal.session(recordId(sessionId, "Session ID"))
    if (this.#closed) return
    this.#presence.watch(session.id, connectionId, actor.userId)
    await rememberSessionViewer(this.journal, session.id, actor.userId, this.#isClosed)
      .catch(error => console.error("Could not record a Session visitor", error))
  }

  leave(sessionId: string, connectionId: string): void {
    for (const visit of this.#presence.visits(connectionId).filter(visit => visit.sessionId === sessionId)) {
      void rememberSessionViewer(this.journal, sessionId, visit.userId, this.#isClosed)
        .catch(error => console.error("Could not record Session activity", error))
    }
    this.#presence.unwatch(recordId(sessionId, "Session ID"), connectionId)
  }

  leaveAll(connectionId: string): void {
    for (const visit of this.#presence.visits(connectionId)) {
      void rememberSessionViewer(this.journal, visit.sessionId, visit.userId, this.#isClosed)
        .catch(error => console.error("Could not record Session activity", error))
    }
    this.#presence.disconnect(connectionId)
  }

  reconcileAdmissions(): Promise<void> { return this.#admissions.reconcile() }

  /** Stops these providers' runtimes so their executable can be replaced; a failed stop aborts the replacement. */
  async stopProviders(providerIds: string[]): Promise<void> {
    const ids = new Set(providerIds)
    const sessions = (await this.journal.list()).filter(session => ids.has(session.provider))
    await Promise.all([
      this.#discovery.invalidateProbes(),
      ...sessions.map(session => this.#runtimes.get(session.id)?.stop()),
    ])
  }

  resumeArchiving(): Promise<void> {
    // Register before awaiting journal I/O so close() drains this startup work
    // while the catalog pool is still open (fire-and-forget from openMachine).
    return this.#track((async () => {
      for (const session of await this.journal.list()) {
        if (this.#closed) return
        if (session.archiveState !== "archiving" || !["ready", "provision_failed"].includes(session.lifecycle)) continue
        await this.#transitions.continueArchive(session.id).catch(error => console.error(`Could not finish archiving Session ${session.id}`, error))
      }
    })())
  }

  /** Listeners close resources bound to a Worktree before its Session is archived. */
  onSessionArchive(listener: (worktreeId: string) => Promise<void>): () => void { return this.#transitions.onArchive(listener) }

  cleanupWorktree(sessionId: string, sequence: string, settings: WorktreePreferences["cleanup"], git?: string): Promise<void> {
    return this.#transitions.cleanupWorktree(sessionId, sequence, settings, git)
  }

  async watchGit(sessionId: string, _actor: AgentActor, listener: (error?: string) => void): Promise<() => void> {
    if (this.#closed) throw new Error("Agent service is stopping")
    recordId(sessionId, "Session ID")
    let stopped = false
    let stopWatch: (() => void) | undefined
    const stop = () => {
      if (stopped) return
      stopped = true
      stopWatch?.()
      unsubscribe()
      this.#closing.signal.removeEventListener("abort", stop)
    }
    const unsubscribe = this.onEvent(event => {
      if (event.sessionId !== sessionId || event.kind !== "session") return
      const session = event.payload as AgentSnapshot["session"]
      if (session.lifecycle === "ready" && session.archiveState === "active") return
      listener("This Session has no active Git observation")
      stop()
    })
    this.#closing.signal.addEventListener("abort", stop, { once: true })
    try {
      const directories = await this.#worktreeDirectories(sessionId)
      const session = await this.journal.session(sessionId)
      if (session.archiveState !== "active") throw new Error("This Session has no active Git observation")
      stopWatch = await this.#git.watch(directories, error => { if (!stopped) listener(error) })
      if (stopped) { stopWatch(); throw new Error("Git observation was cancelled") }
      return stop
    } catch (error) { stop(); throw error }
  }

  async sessionDirectory(sessionId: string): Promise<string> {
    return (await this.#worktreeDirectories(sessionId))[0]!
  }

  async sessionAttachmentDirectory(sessionId: string): Promise<string> {
    const checkedId = recordId(sessionId, "Session ID")
    await this.#provisioning.ready(checkedId)
    const session = await this.journal.session(checkedId)
    requireActiveSession(session)
    if (session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
    return this.#catalog.attachments.directory(checkedId)
  }

  draftAttachmentDirectory(draftId: string): Promise<string> {
    return this.#catalog.attachments.draftDirectory(draftId)
  }

  async requireActive(sessionId: string): Promise<AgentSnapshot> {
    const snapshot = await this.journal.read(sessionId)
    requireActiveSession(snapshot.session)
    return snapshot
  }

  /** Serialize resource admission with archive, without holding a database transaction. */
  withActiveSession<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    return this.journal.serial(sessionId, async () => {
      await this.requireActive(sessionId)
      if (this.#closed) throw new Error("Agent service is stopping")
      return action()
    })
  }

  async handle(method: AgentMethod, value: unknown, actor: AgentActor): Promise<unknown> {
    if (this.#closed) throw new Error("Agent service is stopping")
    const params = requestParams(value)
    if (method === "_deskfleet/agent/configuration") return this.#track(this.#discovery.configuration(params, actor))
    if (method === "_deskfleet/agent/usage") return this.#track(this.#discovery.usage(params))
    if (method === "_deskfleet/session/configuration") {
      const sessionId = recordId(params.sessionId, "Session ID")
      if (params.composer !== undefined && typeof params.composer !== "boolean") throw new Error("Invalid composer discovery flag")
      await this.#provisioning.ready(sessionId)
      await this.journal.session(sessionId)
      return this.#track(this.#runtime(sessionId).configuration(this.#closing.signal, params.composer === true))
    }
    if (method === "_deskfleet/composer/references" || method === "_deskfleet/composer/resolve") return this.#composer(method, params, actor)
    if (method === "_deskfleet/session/list") return this.journal.list()
    if (method === "_deskfleet/session/subscribe") return this.journal.read(recordId(params.sessionId, "Session ID"))
    if (method === "_deskfleet/session/history") {
      const sessionId = recordId(params.sessionId, "Session ID")
      const cursor = requiredString(params.afterSeq, "history cursor")
      if (!/^[0-9]+$/u.test(cursor)) throw new Error("Invalid history cursor")
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) <= 0)) throw new Error("Invalid history page size")
      return this.journal.history(sessionId, cursor, params.limit as number | undefined)
    }
    if (method === "_deskfleet/command/get") {
      return this.journal.command(requiredString(params.operationId, "operation ID"))
    }
    if (method === "_deskfleet/git/branches" || method === "_deskfleet/git/prepare"
      || method === "_deskfleet/git/status" || method === "_deskfleet/git/diff") return this.#gitQuery(method, params, actor)
    const operationId = requiredString(params.operationId, "operation ID")
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(operationId)) throw new Error("Invalid operation ID")
    // Requests sharing an id are checked after the first completes; no caller
    // can adopt another actor's in-flight operation merely by guessing its id.
    const predecessor = this.#operations.get(operationId) ?? Promise.resolve()
    const pending = predecessor.catch(() => {}).then(() => this.#command(method, params, actor, operationId))
    this.#operations.set(operationId, pending)
    void pending.finally(() => { if (this.#operations.get(operationId) === pending) this.#operations.delete(operationId) }).catch(() => {})
    return pending
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#unsubscribeProviders?.()
    this.#closing.abort(new Error("Agent service is stopping"))
    this.#git.close()
    const stopping = Promise.allSettled([this.#discovery.close(), ...[...this.#runtimes.values()].map(runtime => runtime.stop())])
    await Promise.allSettled(this.#inflight)
    await Promise.allSettled(this.#operations.values())
    await this.#provisioning.settle()
    await this.#transitions.settle()
    // A Resume accepted before shutdown may have been waiting for an earlier
    // Stop. Once accepted commands settle, close any generation they restarted.
    const restarted = await Promise.allSettled([...this.#runtimes.values()].map(runtime => runtime.stop()))
    const errors = [...await stopping, ...restarted].flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Could not stop Agent sessions")
  }

  async #composer(method: "_deskfleet/composer/references" | "_deskfleet/composer/resolve", params: Record<string, unknown>, actor: AgentActor): Promise<unknown> {
    const sessionReference = method === "_deskfleet/composer/references" ? params.kind === "session"
      : Array.isArray(params.references) && params.references.some(reference => reference?.kind === "session")
    let allowSessionReferences = !!this.#mcp && actor.kind === "user" && !!actor.userId && !!actor.deviceId
    if (allowSessionReferences && sessionReference && params.sessionId !== undefined) {
      const creation = (await this.journal.commands(recordId(params.sessionId, "Session ID")))
        .find(command => command.isCanonical && (command.method === "_deskfleet/session/create" || command.method === "_deskfleet/session/fork"))
      // Existing providers inherit their initiating actor's MCP delegation,
      // even when a different authenticated viewer later opens the Session.
      allowSessionReferences = creation?.actor.kind === "user" && !!creation.actor.userId && !!creation.actor.deviceId
    }
    if (params.sessionId !== undefined) await this.#provisioning.ready(recordId(params.sessionId, "Session ID"))
    if (method === "_deskfleet/composer/references") return this.#references.search(params, allowSessionReferences)
    if (!allowSessionReferences && sessionReference) {
      throw new Error("Session references require the built-in MCP server and an authenticated user")
    }
    return this.#references.resolve(params)
  }

  async #gitQuery(method: "_deskfleet/git/branches" | "_deskfleet/git/prepare" | "_deskfleet/git/status" | "_deskfleet/git/diff", params: Record<string, unknown>, actor: AgentActor): Promise<unknown> {
    if (method === "_deskfleet/git/branches") {
      const workspaceId = recordId(params.workspaceId, "Workspace ID")
      const directory = (await this.#workspaceDirectories(workspaceId))[0]
      if (!directory) throw new Error("Unknown local workspace")
      return this.#git.branches(workspaceId, directory.path)
    }
    if (method === "_deskfleet/git/prepare") {
      if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and login session are required")
      const workspaceId = recordId(params.workspaceId, "Workspace ID")
      const context = params.context
      if (context !== "worktree" && context !== "directory") throw new Error("Invalid Session context")
      const confirmationToken = params.confirmationToken === undefined ? undefined : requiredString(params.confirmationToken, "confirmation token")
      const directories = await this.#workspaceDirectories(workspaceId)
      if (!directories.length) throw new Error("Unknown local workspace")
      return this.#track(prepareGitWorkspace(workspaceId, directories, context, confirmationToken))
    }
    const sessionId = recordId(params.sessionId, "Session ID")
    const directories = await this.#worktreeDirectories(sessionId)
    if (method === "_deskfleet/git/status") {
      if (params.force !== undefined && typeof params.force !== "boolean") throw new Error("Invalid Git refresh flag")
      return this.#git.status(sessionId, directories, params.force === true)
    }
    const kind = params.kind
    if (kind !== "staged" && kind !== "unstaged" && kind !== "untracked") throw new Error("Invalid Git diff kind")
    return this.#git.diff({
      sessionId,
      repositoryId: requiredString(params.repositoryId, "repository ID"),
      path: requiredString(params.path, "file path"),
      kind,
    }, directories)
  }

  async #command(method: AgentMethod, params: Record<string, unknown>, actor: AgentActor, operationId: string): Promise<unknown> {
    // Bind retries to the same answers without placing secret response values
    // in the command audit, including rejected or malformed submissions.
    const auditParams = method === "_deskfleet/elicitation/respond"
      ? { ...params, response: { fingerprint: createHash("sha256").update(canonicalJson(params.response)).digest("hex") } } : params
    const existing = await this.journal.command(operationId)
    if (existing) return this.#replay(existing, method, auditParams, actor, operationId)
    const command: AgentCommand = {
      id: await this.journal.id(), operationId, actor, method, params: auditParams,
      isCanonical: true, status: "accepted", receivedAt: timestamp(),
      ...(method === "_deskfleet/session/create"
        ? (params.workspaceId === undefined ? {} : { workspaceId: recordId(params.workspaceId, "Workspace ID") })
        : { sessionId: recordId(params.sessionId, "Session ID") }),
    }
    try {
      if (method === "_deskfleet/session/create") return await this.#provisioning.create(command)
      if (method === "_deskfleet/session/fork") return await this.#provisioning.fork(command)
      if (method === "_deskfleet/session/rename") return await renameSession(this.journal, command, this.#isClosed)
      if (method === "_deskfleet/session/read") return await markSessionRead(this.journal, command, this.#isClosed)
      if (method === "_deskfleet/session/unread") return await markSessionUnread(this.journal, command, this.#isClosed)
      await this.journal.saveCommand(command)
      const sessionId = command.sessionId!
      if (method === "_deskfleet/session/configure" || method === "_deskfleet/session/switch-agent"
        || method === "_deskfleet/session/resume" || method === "_deskfleet/session/archive"
        || method === "_deskfleet/session/restore" || method === "_deskfleet/session/delete") {
        await this.#provisioning.ready(sessionId)
      }
      const session = await this.journal.session(sessionId)
      if (this.#closed) throw new Error("Agent service is stopping")
      if (session.lifecycle === "deleting" && method !== "_deskfleet/session/delete") throw new Error("Session deletion is in progress")
      if (method === "_deskfleet/session/archive" || method === "_deskfleet/session/restore") return await this.#transitions.transition(command)
      if (method === "_deskfleet/session/delete") return await this.#transitions.delete(command)
      requireActiveSession(session)
      if (method === "_deskfleet/session/configure") {
        if (params.provider !== undefined && params.provider !== session.provider) throw new Error("A Session's Agent cannot be changed")
        validateAgentConfigurationSelection(params)
        const result = await this.#runtime(sessionId).configure(params as AgentConfigurationSelection)
        await this.journal.complete(command, result)
        return result
      }
      if (method === "_deskfleet/session/switch-agent") {
        const provider = requiredString(params.provider, "Agent provider")
        validateProviderId(provider)
        const runtime = this.#runtime(sessionId)
        await runtime.switchAgent(provider)
        // Start the replacement so its configuration replaces the previous Agent's catalog.
        if (!this.#closed) await runtime.start().catch(() => {})
        const snapshot = await this.journal.read(sessionId)
        await this.journal.complete(command, snapshot)
        return snapshot
      }
      if (method === "_deskfleet/input/submit") return await this.#conversation.submit(command)
      if (method === "_deskfleet/input/steer" || method === "_deskfleet/input/withdraw" || method === "_deskfleet/input/retry") return await this.#conversation.updateInput(command)
      if (method === "_deskfleet/permission/respond") return await this.#conversation.decide(command)
      if (method === "_deskfleet/session/yolo") return await this.#conversation.setYolo(command)
      if (method === "_deskfleet/elicitation/respond") {
        recordId(params.elicitationId, "Question ID")
        // The audit keeps only a fingerprint; the Agent receives the answer itself.
        return await this.#runtime(sessionId).elicitations.respond(command, params.response)
      }
      if (method === "_deskfleet/turn/cancel") return await this.#conversation.cancel(command)
      if (method === "_deskfleet/session/resume") {
        this.#provisioning.allowStart(sessionId)
        if (session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
        await this.#runtime(sessionId).start()
      } else if (method === "_deskfleet/session/stop") {
        this.#provisioning.stopBeforeStart(sessionId)
        await this.#runtime(sessionId).stop()
      } else throw new Error("Unknown Agent operation")
      const snapshot = await this.journal.read(sessionId)
      await this.journal.complete(command, snapshot)
      return snapshot
    } catch (error) {
      const saved = await this.journal.command(operationId)
      if (!saved || saved.status === "accepted") {
        await this.journal.saveCommand({ ...(saved ?? command), status: "failed", error: errorMessage(error), completedAt: timestamp() })
      }
      throw error
    }
  }

  /** A repeated operation returns its recorded outcome, or resumes a transition it left unfinished. */
  async #replay(existing: AgentCommand, method: AgentMethod, auditParams: Record<string, unknown>, actor: AgentActor, operationId: string): Promise<unknown> {
    if (existing.method !== method || canonicalJson(existing.actor) !== canonicalJson(actor) || canonicalJson(existing.params) !== canonicalJson(auditParams)) {
      await this.journal.saveCommand({
        id: await this.journal.id(), operationId, actor, method, params: auditParams, isCanonical: false,
        sessionId: existing.sessionId,
        conflictingCommandId: existing.id, status: "rejected", error: "Operation ID was reused with different parameters or identity",
        receivedAt: timestamp(), completedAt: timestamp(),
      })
      throw new Error("Operation ID was reused with different parameters or identity")
    }
    if (existing.status === "completed") return isSnapshotReference(existing.result) ? this.journal.read(existing.result.sessionId) : existing.result
    if (existing.sessionId && (method === "_deskfleet/session/create"
      || method === "_deskfleet/session/fork" && existing.sessionId !== existing.params.sessionId)) return this.journal.read(existing.sessionId)
    if ((method === "_deskfleet/session/archive" || method === "_deskfleet/session/restore") && existing.status === "accepted" && existing.sessionId) return this.#transitions.transition(existing)
    if (method === "_deskfleet/session/delete" && existing.status === "accepted" && existing.sessionId) {
      if ((await this.journal.list()).some(session => session.id === existing.sessionId)) return this.#transitions.delete(existing)
      await this.journal.complete(existing, null)
      return null
    }
    if (existing.status === "accepted" && existing.result) return existing.result
    throw new Error(existing.error ?? "This operation was already accepted; refresh its recorded state before continuing")
  }

  #runtime(sessionId: string): AgentRuntime {
    let runtime = this.#runtimes.get(sessionId)
    if (!runtime) {
      if (this.#closed) throw new Error("Agent service is stopping")
      runtime = new AgentRuntime(this.journal, this.#catalog, this.#resolveProvider, sessionId, this.#mcp, this.#terminals, this.#quotas)
      this.#runtimes.set(sessionId, runtime)
    }
    return runtime
  }

  async #track<T>(pending: Promise<T>): Promise<T> {
    this.#inflight.add(pending)
    try { return await pending } finally { this.#inflight.delete(pending) }
  }

  /** The directories of a Workspace's main Worktree, in their configured order. */
  async #workspaceDirectories(workspaceId: string) {
    const workspace = (await this.#catalog.native.snapshot()).workspaces.find(value => value.id === workspaceId)
    return workspace?.worktrees.find(worktree => !worktree.sessionId)?.directories ?? []
  }

  /** Waits for provisioning; only a ready Session has directories to work in. */
  async #worktreeDirectories(sessionId: string): Promise<string[]> {
    const checkedId = recordId(sessionId, "Session ID")
    await this.#provisioning.ready(checkedId)
    const session = await this.journal.session(checkedId)
    if (session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
    const directories = (await this.#catalog.sessionWorktree(checkedId))?.directories.map(directory => directory.path) ?? []
    if (!directories[0]) throw new Error("Session worktree is unavailable")
    return directories
  }
}
