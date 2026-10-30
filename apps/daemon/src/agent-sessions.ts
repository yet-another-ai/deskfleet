import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { readAgentConfiguration } from "./agent-configuration.ts"
import { AgentConfigurationProbes } from "./agent-configuration-probes.ts"
import { validateAgentConfigurationParams, validateAgentConfigurationSelection, type AgentConfigurationParams, type AgentConfigurationSelection } from "./agent-configuration-protocol.ts"
import type { ContentBlock } from "@agentclientprotocol/sdk/unstable"
import { codexProvider } from "./agents/codex.ts"
import type { AgentProvider } from "./agents/acp.ts"
import type { DaemonCatalog } from "./catalog.ts"
import { AgentJournal, errorMessage, requireActiveSession, timestamp, type AgentPersistence } from "./agent-store.ts"
import { AgentRuntime, type ResolveAgentProvider } from "./agent-runtime.ts"
import { consumedTurns, SessionAdmissions, unavailableAgentQuotas, type AgentQuotaAuthority } from "./agent-quotas.ts"
import { copyForkHistory } from "./agent-fork-history.ts"
import { savedAgentConfiguration } from "./agent-session-configuration.ts"
import type { AgentProviders } from "./agent-providers.ts"
import type { AgentMcp } from "./agent-mcp.ts"
import type { TerminalSessions } from "./terminals.ts"
import { GitInspection } from "./git-inspection.ts"
import { ComposerReferences } from "./composer-references.ts"
import type {
  AgentActor, AgentCommand, AgentEvent, AgentInput, AgentMethod, AgentPermission, AgentReceipt, AgentSnapshot,
} from "./agent-protocol.ts"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected request parameters")
  return value as Record<string, unknown>
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`Missing ${field}`)
  return value
}
function id(value: unknown, field: string): string {
  const result = string(value, field)
  if (!/^[1-9][0-9]*$/u.test(result)) throw new Error(`Invalid ${field}`)
  return result
}
function content(value: unknown): ContentBlock[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("A message is required")
  let hasText = false
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Only nonempty text messages are supported")
    const block = item as Record<string, unknown>
    if (block.type === "text") {
      if (typeof block.text !== "string" || !block.text.trim()) throw new Error("Only nonempty text messages are supported")
      hasText = true
      continue
    }
    if (block.type === "image") {
      if (typeof block.mimeType !== "string" || !/^image\/[a-z0-9.+-]+$/iu.test(block.mimeType)
        || typeof block.data !== "string" || !block.data.length || !/^[A-Za-z0-9+/]+={0,2}$/u.test(block.data)) {
        throw new Error("Invalid image attachment")
      }
      continue
    }
    if (block.type === "resource") {
      const resource = block.resource
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) throw new Error("Invalid text resource attachment")
      const record = resource as Record<string, unknown>
      if (typeof record.uri !== "string" || !record.uri.length || record.uri.length > 2048 || record.uri.includes("\0")
        || typeof record.text !== "string" || !record.text.trim()
        || (record.mimeType !== undefined && record.mimeType !== null && (typeof record.mimeType !== "string" || !record.mimeType.length || record.mimeType.length > 256))) {
        throw new Error("Invalid text resource attachment")
      }
      hasText = true
      continue
    }
    if (block.type === "resource_link") {
      if (typeof block.uri !== "string" || !/^file:\/\/\//iu.test(block.uri) || block.uri.length > 4096 || block.uri.includes("\0")
        || typeof block.name !== "string" || !block.name.trim() || block.name.length > 512 || block.name.includes("\0")
        || (block.mimeType !== undefined && block.mimeType !== null && (typeof block.mimeType !== "string" || !block.mimeType.length || block.mimeType.length > 256))
        || (block.size !== undefined && block.size !== null && (typeof block.size !== "number" || !Number.isSafeInteger(block.size) || block.size < 0))) {
        throw new Error("Invalid file attachment")
      }
      continue
    }
    throw new Error("Only nonempty text messages are supported")
  }
  if (!hasText) throw new Error("Only nonempty text messages are supported")
  return value as ContentBlock[]
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
const liveTurn = (state: string) => ["starting", "running", "cancelling"].includes(state)
/** A provider conversation can only continue in a new run when the agent supports resume. */
const resumable = (snapshot: AgentSnapshot) => !snapshot.session.providerSessionId || !!snapshot.session.capabilities?.resume

/** Durable collaboration belongs to the daemon, not to a client connection. */
export class AgentSessions {
  readonly journal: AgentJournal
  readonly #catalog: DaemonCatalog
  readonly #resolveProvider: ResolveAgentProvider
  readonly #mcp?: AgentMcp
  readonly #terminals?: TerminalSessions
  readonly #quotas: AgentQuotaAuthority
  readonly #admissions: SessionAdmissions
  readonly #git = new GitInspection()
  readonly #references: ComposerReferences
  readonly #runtimes = new Map<string, AgentRuntime>()
  readonly #operations = new Map<string, Promise<unknown>>()
  readonly #transitions = new Map<string, Promise<unknown>>()
  readonly #archiveListeners = new Set<(worktreeId: string) => Promise<void>>()
  readonly #discovery = new Set<Promise<unknown>>()
  readonly #configurationProbes = new AgentConfigurationProbes()
  readonly #unsubscribeProviders?: () => void
  readonly #closing = new AbortController()
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
    this.#unsubscribeProviders = providers?.onChanged(() => {
      void this.#configurationProbes.invalidate().catch(error => console.error("Could not close Agent configuration probes", error))
    })
  }

  async init(): Promise<void> {
    await this.journal.init()
    for (const session of await this.journal.list()) {
      await this.journal.serial(session.id, async () => {
        const snapshot = await this.journal.read(session.id)
        const runs = snapshot.runs.filter(run => ["starting", "running", "stopping"].includes(run.state))
          .map(run => ({ ...run, state: "interrupted" as const, endedAt: timestamp() }))
        const turns = snapshot.turns.filter(turn => liveTurn(turn.state))
          .map(turn => ({ ...turn, state: "interrupted" as const, endedAt: timestamp() }))
        const inputs = snapshot.inputs.filter(input => input.state === "dispatching").map(input => {
          const unsent = snapshot.turns.some(turn => turn.id === input.turnId && !turn.consumed)
          return { ...input, state: unsent ? "failed" as const : "uncertain" as const,
            error: unsent ? "Daemon restarted before provider dispatch" : "Daemon restarted before delivery was confirmed" }
        })
        const permissions = snapshot.permissions.filter(permission => permission.state === "pending")
          .map(permission => ({ ...permission, state: "cancelled" as const, resolvedAt: timestamp() }))
        const elicitations = snapshot.elicitations.filter(row => row.state === "pending")
          .map(({ completedAt: _completedAt, ...row }) => ({ ...row, state: "cancelled" as const, response: { action: "cancel" as const }, resolvedAt: timestamp() }))
        const recovered = session.lifecycle === "provisioning"
          ? { ...session, lifecycle: "provision_failed" as const, error: "Session creation was interrupted", updatedAt: timestamp() } : undefined
        const events = [
          ...runs.map(row => this.journal.event(session.id, "run", row)),
          ...turns.map(row => this.journal.event(session.id, "turn", row)),
          ...inputs.map(row => this.journal.event(session.id, "input", row)),
          ...permissions.map(row => this.journal.event(session.id, "permission", row)),
          ...elicitations.map(row => this.journal.event(session.id, "elicitation", row)),
          ...(recovered ? [this.journal.event(session.id, "session", recovered)] : []),
        ]
        if (events.length) await this.journal.commit(snapshot, { session: recovered, runs, turns, inputs, permissions, elicitations, events })
      })
    }
  }

  onEvent(listener: (event: AgentEvent) => void): () => void { return this.journal.onEvent(listener) }
  reconcileAdmissions(): Promise<void> { return this.#admissions.reconcile() }

  async #gitDirectories(sessionId: string): Promise<string[]> {
    const session = await this.journal.session(id(sessionId, "Session ID"))
    if (session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
    const worktree = await this.#catalog.sessionWorktree(sessionId)
    if (!worktree?.directories.length) throw new Error("Session worktree is unavailable")
    return worktree.directories.map(directory => directory.path)
  }

  async watchGit(sessionId: string, _actor: AgentActor, listener: (error?: string) => void): Promise<() => void> {
    if (this.#closed) throw new Error("Agent service is stopping")
    id(sessionId, "Session ID")
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
      const directories = await this.#gitDirectories(sessionId)
      const session = await this.journal.session(sessionId)
      if (session.archiveState !== "active") throw new Error("This Session has no active Git observation")
      stopWatch = await this.#git.watch(directories, error => { if (!stopped) listener(error) })
      if (stopped) { stopWatch(); throw new Error("Git observation was cancelled") }
      return stop
    } catch (error) { stop(); throw error }
  }

  async sessionDirectory(sessionId: string): Promise<string> {
    const session = await this.journal.session(id(sessionId, "Session ID"))
    if (session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
    const worktree = await this.#catalog.sessionWorktree(sessionId)
    const directory = worktree?.directories[0]?.path
    if (!directory) throw new Error("Session worktree is unavailable")
    return directory
  }
  async sessionAttachmentDirectory(sessionId: string): Promise<string> {
    const session = await this.journal.session(id(sessionId, "Session ID"))
    requireActiveSession(session)
    if (session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
    return this.#catalog.attachments.directory(sessionId)
  }
  onSessionArchive(listener: (worktreeId: string) => Promise<void>): () => void {
    this.#archiveListeners.add(listener)
    return () => this.#archiveListeners.delete(listener)
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
  actor(): AgentActor { return this.journal.actor() }
  #runtime(sessionId: string): AgentRuntime {
    let runtime = this.#runtimes.get(sessionId)
    if (!runtime) {
      if (this.#closed) throw new Error("Agent service is stopping")
      runtime = new AgentRuntime(this.journal, this.#catalog, this.#resolveProvider, sessionId, this.#mcp, this.#terminals, this.#quotas)
      this.#runtimes.set(sessionId, runtime)
    }
    return runtime
  }

  async handle(method: AgentMethod, value: unknown, actor: AgentActor): Promise<unknown> {
    if (this.#closed) throw new Error("Agent service is stopping")
    const params = object(value)
    if (method === "_deskfleet/agent/configuration") {
      validateAgentConfigurationParams(params)
      const request = params as unknown as AgentConfigurationParams
      const scope = canonical(actor)
      if (request.release) {
        await this.#configurationProbes.release(scope, request.probeId!)
        return null
      }
      let cwd = homedir()
      if (params.workspaceId !== undefined) {
        const workspace = (await this.#catalog.native.snapshot()).workspaces.find(workspace => workspace.id === params.workspaceId)
        const directory = workspace?.worktrees.find(worktree => !worktree.sessionId)?.directories[0]
        if (!directory) throw new Error("Unknown local workspace")
        cwd = directory.path
      }
      const launch = this.#resolveProvider(request.provider)
      const pending = request.probeId
        ? this.#configurationProbes.read(scope, request, cwd, launch)
        : readAgentConfiguration(request, cwd, { ...launch, signal: this.#closing.signal })
      this.#discovery.add(pending)
      try { return await pending } finally { this.#discovery.delete(pending) }
    }
    if (method === "_deskfleet/session/configuration") {
      const sessionId = id(params.sessionId, "Session ID")
      if (params.composer !== undefined && typeof params.composer !== "boolean") throw new Error("Invalid composer discovery flag")
      await this.journal.session(sessionId)
      const pending = this.#runtime(sessionId).configuration(this.#closing.signal, params.composer === true)
      this.#discovery.add(pending)
      try { return await pending } finally { this.#discovery.delete(pending) }
    }
    if (method === "_deskfleet/composer/references" || method === "_deskfleet/composer/resolve") {
      const sessionReference = method === "_deskfleet/composer/references" ? params.kind === "session"
        : Array.isArray(params.references) && params.references.some(reference => reference?.kind === "session")
      let allowSessionReferences = !!this.#mcp && actor.kind === "user" && !!actor.userId && !!actor.deviceId
      if (allowSessionReferences && sessionReference && params.sessionId !== undefined) {
        const creation = (await this.journal.commands(id(params.sessionId, "Session ID")))
          .find(command => command.isCanonical && (command.method === "_deskfleet/session/create" || command.method === "_deskfleet/session/fork"))
        // Existing providers inherit their initiating actor's MCP delegation,
        // even when a different authenticated viewer later opens the Session.
        allowSessionReferences = creation?.actor.kind === "user" && !!creation.actor.userId && !!creation.actor.deviceId
      }
      if (method === "_deskfleet/composer/references") return this.#references.search(params, allowSessionReferences)
      if (!allowSessionReferences && sessionReference) {
        throw new Error("Session references require the built-in MCP server and an authenticated user")
      }
      return this.#references.resolve(params)
    }
    if (method === "_deskfleet/session/list") return this.journal.list()
    if (method === "_deskfleet/session/subscribe") return this.journal.read(id(params.sessionId, "Session ID"))
    if (method === "_deskfleet/session/history") {
      const sessionId = id(params.sessionId, "Session ID")
      const cursor = string(params.afterSeq, "history cursor")
      if (!/^[0-9]+$/u.test(cursor)) throw new Error("Invalid history cursor")
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) <= 0)) throw new Error("Invalid history page size")
      return this.journal.history(sessionId, cursor, params.limit as number | undefined)
    }
    if (method === "_deskfleet/command/get") {
      return this.journal.command(string(params.operationId, "operation ID"))
    }
    if (method === "_deskfleet/git/branches") {
      const workspaceId = id(params.workspaceId, "Workspace ID")
      const workspace = (await this.#catalog.native.snapshot()).workspaces.find(value => value.id === workspaceId)
      const directory = workspace?.worktrees.find(worktree => !worktree.sessionId)?.directories[0]
      if (!directory) throw new Error("Unknown local workspace")
      return this.#git.branches(workspaceId, directory.path)
    }
    if (method === "_deskfleet/git/status" || method === "_deskfleet/git/diff") {
      const sessionId = id(params.sessionId, "Session ID")
      const directories = await this.#gitDirectories(sessionId)
      if (method === "_deskfleet/git/status") {
        if (params.force !== undefined && typeof params.force !== "boolean") throw new Error("Invalid Git refresh flag")
        return this.#git.status(sessionId, directories, params.force === true)
      }
      const kind = params.kind
      if (kind !== "staged" && kind !== "unstaged" && kind !== "untracked") throw new Error("Invalid Git diff kind")
      return this.#git.diff({
        sessionId,
        repositoryId: string(params.repositoryId, "repository ID"),
        path: string(params.path, "file path"),
        kind,
      }, directories)
    }
    const operationId = string(params.operationId, "operation ID")
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(operationId)) throw new Error("Invalid operation ID")
    // Requests sharing an id are checked after the first completes; no caller
    // can adopt another actor's in-flight operation merely by guessing its id.
    const predecessor = this.#operations.get(operationId) ?? Promise.resolve()
    const pending = predecessor.catch(() => {}).then(() => this.#command(method, params, actor, operationId))
    this.#operations.set(operationId, pending)
    void pending.finally(() => { if (this.#operations.get(operationId) === pending) this.#operations.delete(operationId) }).catch(() => {})
    return pending
  }

  async #command(method: AgentMethod, params: Record<string, unknown>, actor: AgentActor, operationId: string): Promise<unknown> {
    // Bind retries to the same answers without placing secret response values
    // in the command audit, including rejected or malformed submissions.
    const auditParams = method === "_deskfleet/elicitation/respond"
      ? { ...params, response: { fingerprint: createHash("sha256").update(canonical(params.response)).digest("hex") } } : params
    const existing = await this.journal.command(operationId)
    if (existing) {
      if (existing.method !== method || canonical(existing.actor) !== canonical(actor) || canonical(existing.params) !== canonical(auditParams)) {
        await this.journal.saveCommand({
          id: await this.journal.id(), operationId, actor, method, params: auditParams, isCanonical: false,
          sessionId: existing.sessionId,
          conflictingCommandId: existing.id, status: "rejected", error: "Operation ID was reused with different parameters or identity",
          receivedAt: timestamp(), completedAt: timestamp(),
        })
        throw new Error("Operation ID was reused with different parameters or identity")
      }
      if (existing.status === "completed") return existing.result
      if (existing.sessionId && (method === "_deskfleet/session/create"
        || method === "_deskfleet/session/fork" && existing.sessionId !== existing.params.sessionId)) return this.journal.read(existing.sessionId)
      if ((method === "_deskfleet/session/archive" || method === "_deskfleet/session/restore") && existing.status === "accepted" && existing.sessionId) return this.#transition(existing)
      if (method === "_deskfleet/session/delete" && existing.status === "accepted" && existing.sessionId) {
        if ((await this.journal.list()).some(session => session.id === existing.sessionId)) return this.#delete(existing)
        await this.#complete(existing, null)
        return null
      }
      if (existing.status === "accepted" && existing.result) return existing.result
      throw new Error(existing.error ?? "This operation was already accepted; refresh its recorded state before continuing")
    }
    const command: AgentCommand = {
      id: await this.journal.id(), operationId, actor, method, params: auditParams,
      isCanonical: true, status: "accepted", receivedAt: timestamp(),
      ...(method === "_deskfleet/session/create"
        ? (params.workspaceId === undefined ? {} : { workspaceId: id(params.workspaceId, "Workspace ID") })
        : { sessionId: id(params.sessionId, "Session ID") }),
    }
    try {
      if (method === "_deskfleet/session/create") return await this.#create(command)
      if (method === "_deskfleet/session/fork") return await this.#fork(command)
      if (method === "_deskfleet/session/rename") return await this.#rename(command)
      if (method === "_deskfleet/session/read") return await this.#markRead(command)
      await this.journal.saveCommand(command)
      const sessionId = command.sessionId!
      const session = await this.journal.session(sessionId)
      if (this.#closed) throw new Error("Agent service is stopping")
      if (session.lifecycle === "deleting" && method !== "_deskfleet/session/delete") throw new Error("Session deletion is in progress")
      if (method === "_deskfleet/session/archive" || method === "_deskfleet/session/restore") return await this.#transition(command)
      if (method !== "_deskfleet/session/delete") requireActiveSession(session)
      if (method === "_deskfleet/session/configure") {
        if (params.provider !== undefined && params.provider !== session.provider) throw new Error("A Session's Agent cannot be changed")
        validateAgentConfigurationSelection(params)
        const result = await this.#runtime(sessionId).configure(params as AgentConfigurationSelection)
        await this.#complete(command, result)
        return result
      }
      if (method === "_deskfleet/input/submit") return await this.#submit(command)
      if (method === "_deskfleet/input/steer" || method === "_deskfleet/input/withdraw" || method === "_deskfleet/input/retry") return await this.#inputAction(command)
      if (method === "_deskfleet/permission/respond") return await this.#decide(command)
      if (method === "_deskfleet/elicitation/respond") {
        id(params.elicitationId, "Question ID")
        return await this.#runtime(sessionId).elicitations.respond(command, params.response)
      }
      if (method === "_deskfleet/turn/cancel") return await this.#cancel(command)
      if (method === "_deskfleet/session/resume") {
        if (session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
        await this.#runtime(sessionId).start()
      } else if (method === "_deskfleet/session/stop") {
        await this.#runtime(sessionId).stop()
      } else if (method === "_deskfleet/session/delete") {
        return await this.#delete(command)
      } else throw new Error("Unknown Agent operation")
      const snapshot = await this.journal.read(sessionId)
      await this.#complete(command, snapshot)
      return snapshot
    } catch (error) {
      const saved = await this.journal.command(operationId)
      if (!saved || saved.status === "accepted") {
        await this.journal.saveCommand({ ...(saved ?? command), status: "failed", error: errorMessage(error), completedAt: timestamp() })
      }
      throw error
    }
  }

  async #complete(command: AgentCommand, result: unknown): Promise<void> {
    await this.journal.saveCommand({ ...command, status: "completed", result, completedAt: timestamp() })
  }

  async #rename(command: AgentCommand): Promise<AgentSnapshot> {
    const title = string(command.params.title, "Session title").trim()
    if (!title || title.length > 200 || title.includes("\0")) throw new Error("Session titles must contain between 1 and 200 characters")
    const sessionId = command.sessionId!
    return this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      if (this.#closed) throw new Error("Agent service is stopping")
      if (snapshot.session.lifecycle === "deleting") throw new Error("Session deletion is in progress")
      const session = { ...snapshot.session, title, titleCustomized: true, updatedAt: timestamp(),
        lastEventSeq: String(BigInt(snapshot.session.lastEventSeq) + 1n) }
      const result = { ...snapshot, session }
      await this.journal.commit(snapshot, {
        session,
        command: { ...command, status: "completed", result, completedAt: timestamp() },
        events: [this.journal.event(sessionId, "session", session, { commandId: command.id })],
      })
      return result
    })
  }

  async #markRead(command: AgentCommand): Promise<AgentSnapshot> {
    if (command.actor.kind !== "user" || !command.actor.userId) throw new Error("Only a person can mark a Session as read")
    const throughSeq = string(command.params.throughSeq, "read watermark")
    if (!/^(0|[1-9][0-9]*)$/u.test(throughSeq)) throw new Error("Invalid read watermark")
    const sessionId = command.sessionId!
    return this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      if (this.#closed) throw new Error("Agent service is stopping")
      if (snapshot.session.lifecycle === "deleting") throw new Error("Session deletion is in progress")
      if (BigInt(throughSeq) > BigInt(snapshot.session.lastEventSeq)) throw new Error("Read watermark exceeds Session history")
      const advanced = BigInt(throughSeq) > BigInt(snapshot.session.lastReadSeq ?? "0")
      const session = advanced ? { ...snapshot.session, lastReadSeq: throughSeq,
        lastEventSeq: String(BigInt(snapshot.session.lastEventSeq) + 1n) } : snapshot.session
      const result = { ...snapshot, session }
      await this.journal.commit(snapshot, {
        ...(advanced ? { session } : {}),
        command: { ...command, status: "completed", result, completedAt: timestamp() },
        ...(advanced ? { events: [this.journal.event(sessionId, "session", session, { commandId: command.id })] } : {}),
      })
      return result
    })
  }

  #receipt(command: AgentCommand, inputId?: string): AgentReceipt {
    return { operationId: command.operationId, commandId: command.id, sessionId: command.sessionId!, ...(inputId ? { inputId } : {}) }
  }

  async #create(command: AgentCommand): Promise<AgentSnapshot> {
    const provider = string(command.params.provider, "Agent provider")
    this.#resolveProvider(provider)
    validateAgentConfigurationSelection(command.params)
    const context = command.params.context
    if (context !== "worktree" && context !== "directory") throw new Error("Invalid Session context")
    if (!command.workspaceId && context !== "directory") throw new Error("Sessions without a workspace use the home directory")
    const baseBranch = command.params.baseBranch === undefined ? undefined : string(command.params.baseBranch, "base branch").trim()
    if (baseBranch !== undefined && (!baseBranch || context !== "worktree")) throw new Error("Invalid base branch")
    const title = typeof command.params.title === "string" ? command.params.title.trim().slice(0, 200) : ""
    const session = await this.#admissions.allocate(command, "create", admissionGeneration =>
      this.journal.create(command, command.workspaceId, title, context, provider, { admissionGeneration }))
    command.sessionId = session.id
    try {
      await this.#catalog.provisionSession(session.id, session.workspaceId, context, baseBranch)
      await this.journal.serial(session.id, async () => {
        const snapshot = await this.journal.read(session.id)
        const ready = { ...snapshot.session, lifecycle: "ready" as const, updatedAt: timestamp() }
        await this.journal.commit(snapshot, { session: ready, events: [this.journal.event(session.id, "session", ready), this.journal.event(session.id, "command", command)] })
      })
      // Provider failures are persisted by the runtime and can be resumed.
      if (!this.#closed) await this.#runtime(session.id).start().catch(() => {})
    } catch (error) {
      await this.journal.serial(session.id, async () => {
        const snapshot = await this.journal.read(session.id)
        const failed = { ...snapshot.session, lifecycle: "provision_failed" as const, error: errorMessage(error), updatedAt: timestamp() }
        await this.journal.commit(snapshot, { session: failed, events: [this.journal.event(session.id, "session", failed)] })
      })
    }
    const snapshot = await this.journal.read(session.id)
    await this.#complete(command, snapshot)
    this.#catalog.changed()
    return snapshot
  }

  async #fork(command: AgentCommand): Promise<AgentSnapshot> {
    const context = command.params.context
    if (context !== "worktree" && context !== "directory") throw new Error("Invalid Session context")
    const sourceId = command.sessionId!
    const sourceSession = await this.journal.session(sourceId)
    if (!sourceSession.workspaceId && context !== "directory") throw new Error("Sessions without a workspace use the home directory")
    return this.#runtime(sourceId).withFork(async source => {
      this.#resolveProvider(source.session.provider)
      const title = typeof command.params.title === "string" ? command.params.title.trim().slice(0, 200) : source.session.title
      const creation = { ...command, sessionId: undefined, workspaceId: source.session.workspaceId }
      const child = await this.#admissions.allocate(command, "fork", admissionGeneration =>
        this.journal.create(creation, source.session.workspaceId, title, context, source.session.provider,
          { admissionGeneration, inheritedTurnCount: consumedTurns(source) }))
      command.sessionId = child.id
      command.workspaceId = child.workspaceId
      try {
        await this.#catalog.provisionSession(child.id, child.workspaceId, context)
        await copyForkHistory(this.journal, source, child.id)
        await this.journal.serial(child.id, async () => {
          const snapshot = await this.journal.read(child.id)
          await this.journal.commit(snapshot, { events: [this.journal.event(child.id, "command", command)] })
        })
        if (this.#closed) throw new Error("Agent service is stopping")
        const saved = await savedAgentConfiguration(this.journal, sourceId)
        await this.#runtime(child.id).start(saved.selection, source.session.providerSessionId!)
      } catch (error) {
        await this.#runtimes.get(child.id)?.stop().catch(() => {})
        await this.journal.serial(child.id, async () => {
          const snapshot = await this.journal.read(child.id)
          const failed = { ...snapshot.session, lifecycle: "provision_failed" as const, error: errorMessage(error), updatedAt: timestamp() }
          await this.journal.commit(snapshot, { session: failed, events: [this.journal.event(child.id, "session", failed)] })
        })
      }
      const snapshot = await this.journal.read(child.id)
      await this.#complete(command, snapshot)
      this.#catalog.changed()
      return snapshot
    })
  }

  async #submit(command: AgentCommand): Promise<AgentReceipt> {
    const sessionId = command.sessionId!
    const blocks = content(command.params.content)
    const delivery = command.params.delivery
    if (delivery !== "backlog" && delivery !== "steer") throw new Error("Invalid input delivery")
    const runtime = this.#runtime(sessionId)
    if (delivery === "steer" && !runtime.running) throw new Error("Resume the Agent before steering")
    const inputId = await this.journal.id()
    const receipt = this.#receipt(command, inputId)
    await this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      requireActiveSession(snapshot.session)
      if (snapshot.session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
      if (!runtime.running && !resumable(snapshot)) throw new Error("This agent cannot resume the saved conversation")
      const input: AgentInput = {
        id: inputId, sessionId, submissionCommandId: command.id, author: command.actor, content: blocks,
        acceptedSeq: String(BigInt(snapshot.session.lastEventSeq) + 1n), state: delivery === "steer" ? "dispatching" : "pending", requestedDelivery: delivery,
        requestedTurnId: command.params.turnId === undefined ? undefined : id(command.params.turnId, "Turn ID"), createdAt: timestamp(),
        ...(delivery === "steer" ? { dispatchCommandId: command.id, dispatcher: command.actor } : {}),
      }
      const titleSource = blocks.map(block => block.type === "text" ? block.text : block.type === "resource" && "text" in block.resource ? block.resource.text : "").filter(Boolean).join(" ").trim()
      const title = snapshot.session.title || (titleSource.split(/\r?\n/u)[0] ?? "").slice(0, 100)
      const session = { ...snapshot.session, title, updatedAt: timestamp() }
      await this.journal.commit(snapshot, { session, inputs: [input], command: { ...command, status: delivery === "steer" ? "accepted" : "completed", result: receipt, completedAt: delivery === "steer" ? undefined : timestamp() }, events: [
        this.journal.event(sessionId, "input", input), this.journal.event(sessionId, "session", session),
      ] })
    })
    if (delivery === "steer") this.#steerLater(command, inputId, command.params.turnId as string | undefined)
    else this.#deliver(sessionId)
    return receipt
  }

  /** A new user request resumes a stopped or interrupted agent; startup then drains the backlog. */
  #deliver(sessionId: string): void {
    const runtime = this.#runtime(sessionId)
    if (runtime.running || this.#closed) runtime.resumeBacklog()
    // Startup failures are persisted on the run; the input stays queued for the next request.
    else void runtime.start().catch(() => {})
  }

  #steerLater(command: AgentCommand, inputId: string, turnId?: string): void {
    void (async () => {
      const dispatch: AgentCommand = { ...command, result: this.#receipt(command, inputId) }
      try { await this.#runtime(command.sessionId!).steer(inputId, dispatch, turnId) }
      catch (error) {
        await this.journal.serial(command.sessionId!, async () => {
          const snapshot = await this.journal.read(command.sessionId!)
          const previous = snapshot.inputs.find(input => input.id === inputId)
          if (!previous || previous.state !== "dispatching" || previous.dispatchCommandId !== command.id) return
          const input = { ...previous, state: "failed" as const, error: errorMessage(error) }
          await this.journal.commit(snapshot, { inputs: [input], command: { ...dispatch, status: "failed", error: input.error, completedAt: timestamp() }, events: [this.journal.event(command.sessionId!, "input", input)] })
        })
      }
    })().catch(error => console.error("Agent steering failed", error))
  }

  async #inputAction(command: AgentCommand): Promise<AgentReceipt> {
    const sessionId = command.sessionId!
    const inputId = id(command.params.inputId, "Input ID")
    const receipt = this.#receipt(command, inputId)
    await this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      requireActiveSession(snapshot.session)
      const previous = snapshot.inputs.find(input => input.id === inputId)
      if (!previous) throw new Error("Input was not found")
      let input = previous
      if (command.method === "_deskfleet/input/retry") {
        const quotaPaused = input.state === "pending" && snapshot.session.turnLimitReason && input.error
        if (input.state !== "failed" && !quotaPaused) throw new Error("Only a confirmed unconsumed input can be retried")
        input = { ...input, state: "pending", error: undefined, requestedDelivery: "backlog" }
      } else if (command.method === "_deskfleet/input/withdraw") {
        if (!["pending", "failed"].includes(input.state)) throw new Error("This input has already been handled")
        input = { ...input, state: "withdrawn" }
      } else {
        if (input.state !== "pending") throw new Error("This input has already been handled")
        id(command.params.turnId, "Turn ID")
        if (!this.#runtime(sessionId).running) throw new Error("Resume the Agent before steering")
        input = { ...input, state: "dispatching", requestedDelivery: "steer", requestedTurnId: command.params.turnId as string, dispatchCommandId: command.id, dispatcher: command.actor }
      }
      const steering = command.method === "_deskfleet/input/steer"
      await this.journal.commit(snapshot, { inputs: [input], command: { ...command, status: steering ? "accepted" : "completed", result: receipt, completedAt: steering ? undefined : timestamp() }, events: [this.journal.event(sessionId, "input", input)] })
    })
    if (command.method === "_deskfleet/input/steer") this.#steerLater(command, inputId, command.params.turnId as string)
    else if (command.method === "_deskfleet/input/retry") this.#deliver(sessionId)
    else void this.#runtime(sessionId).pump()
    return receipt
  }

  async #decide(command: AgentCommand): Promise<AgentPermission> {
    const sessionId = command.sessionId!
    const permissionId = id(command.params.permissionId, "Permission ID")
    const optionId = string(command.params.optionId, "permission option")
    let selected = false
    const result = await this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      requireActiveSession(snapshot.session)
      const previous = snapshot.permissions.find(permission => permission.id === permissionId)
      if (!previous) throw new Error("Permission request was not found")
      if (!previous.request.options.some(option => option.optionId === optionId)) throw new Error("Unknown permission option")
      if (previous.state !== "pending") {
        const completed = { ...command, status: "completed" as const, result: previous, completedAt: timestamp() }
        await this.journal.commit(snapshot, { command: completed, events: [this.journal.event(sessionId, "command", completed)] })
        return previous
      }
      const permission: AgentPermission = { ...previous, state: "resolved", optionId, decisionCommandId: command.id, actor: command.actor, resolvedAt: timestamp() }
      await this.journal.commit(snapshot, { permissions: [permission], command: { ...command, status: "completed", result: permission, completedAt: timestamp() }, events: [this.journal.event(sessionId, "permission", permission)] })
      selected = true
      return permission
    })
    if (selected) this.#runtime(sessionId).resolvePermission(permissionId, optionId)
    return result
  }

  async #cancel(command: AgentCommand): Promise<AgentReceipt> {
    const sessionId = command.sessionId!
    const turnId = id(command.params.turnId, "Turn ID")
    const receipt = this.#receipt(command)
    await this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      requireActiveSession(snapshot.session)
      const previous = snapshot.turns.find(turn => turn.id === turnId)
      if (!previous) throw new Error("Turn was not found")
      const turn = liveTurn(previous.state) ? { ...previous, state: "cancelling" as const } : previous
      await this.journal.commit(snapshot, { turns: [turn], command: { ...command, status: "completed", result: receipt, completedAt: timestamp() }, events: [this.journal.event(sessionId, "turn", turn)] })
    })
    await this.#runtime(sessionId).cancel(turnId)
    return receipt
  }

  #transition(command: AgentCommand): Promise<AgentSnapshot> {
    const sessionId = command.sessionId!
    const previous = this.#transitions.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      if (command.method === "_deskfleet/session/archive") await this.#archive(sessionId)
      else await this.journal.serial(sessionId, async () => {
        const snapshot = await this.journal.read(sessionId)
        if (snapshot.session.archiveState === "archiving") throw new Error("Finish archiving this Session before restoring it")
        if (snapshot.session.archiveState === "active") return
        await this.#admissions.allocate(command, "restore", async admissionGeneration => {
          const session = { ...snapshot.session, admissionGeneration, archiveState: "active" as const, updatedAt: timestamp() }
          await this.journal.commit(snapshot, { session, events: [this.journal.event(sessionId, "session", session)] })
          return session
        })
      })
      const snapshot = await this.journal.read(sessionId)
      await this.#admissions.synchronize(snapshot.session)
      await this.#complete(command, snapshot)
      return snapshot
    })
    this.#transitions.set(sessionId, next)
    void next.finally(() => { if (this.#transitions.get(sessionId) === next) this.#transitions.delete(sessionId) }).catch(() => {})
    return next
  }

  async #archive(sessionId: string): Promise<void> {
    const needed = await this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      if (snapshot.session.archiveState === "archived") return false
      if (!["ready", "provision_failed"].includes(snapshot.session.lifecycle)) throw new Error("Wait for Session provisioning or deletion before archiving")
      const session = { ...snapshot.session, archiveState: "archiving" as const, updatedAt: timestamp() }
      await this.journal.commit(snapshot, { session, events: [this.journal.event(sessionId, "session", session)] })
      return true
    })
    if (!needed) return
    const worktree = await this.#catalog.sessionWorktree(sessionId)
    const closures = [this.#runtime(sessionId).stop()]
    if (worktree) for (const listener of this.#archiveListeners) closures.push(Promise.resolve().then(() => listener(worktree.id)))
    const results = await Promise.allSettled(closures)
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Session resources could not all be closed; retry archive")
    await this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      const session = { ...snapshot.session, archiveState: "archived" as const, updatedAt: timestamp() }
      await this.journal.commit(snapshot, { session, events: [this.journal.event(sessionId, "session", session)] })
    })
  }

  async #delete(command: AgentCommand): Promise<null> {
    const sessionId = command.sessionId!
    await this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      const session = { ...snapshot.session, lifecycle: "deleting" as const, updatedAt: timestamp() }
      await this.journal.commit(snapshot, { session, events: [this.journal.event(sessionId, "session", session)] })
    })
    await this.#runtime(sessionId).stop()
    const deleted = await this.journal.session(sessionId)
    await this.#catalog.handle({ method: "workspaceSessionDestroy", params: { sessionId } })
    await this.#admissions.releaseDeleted(deleted)
    this.#runtimes.delete(sessionId)
    await this.#complete(command, null)
    return null
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#unsubscribeProviders?.()
    this.#closing.abort(new Error("Agent service is stopping"))
    this.#git.close()
    const stopping = Promise.allSettled([this.#configurationProbes.close(), ...[...this.#runtimes.values()].map(runtime => runtime.stop())])
    await Promise.allSettled(this.#discovery)
    await Promise.allSettled(this.#operations.values())
    // A Resume accepted before shutdown may have been waiting for an earlier
    // Stop. Once accepted commands settle, close any generation they restarted.
    const restarted = await Promise.allSettled([...this.#runtimes.values()].map(runtime => runtime.stop()))
    const errors = [...await stopping, ...restarted].flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Could not stop Agent sessions")
  }
}
