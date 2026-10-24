import type { ContentBlock } from "@agentclientprotocol/sdk"
import { codexProvider } from "./agents/codex.ts"
import type { AgentProvider } from "./agents/acp.ts"
import type { DaemonCatalog } from "./catalog.ts"
import { AgentJournal, errorMessage, timestamp, type AgentPersistence } from "./agent-store.ts"
import { AgentRuntime } from "./agent-runtime.ts"
import { GitInspection } from "./git-inspection.ts"
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
  for (const block of value) {
    if (!block || block.type !== "text" || typeof block.text !== "string" || !block.text.trim()) throw new Error("Only nonempty text messages are supported")
  }
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
  readonly #provider: AgentProvider
  readonly #git = new GitInspection()
  readonly #runtimes = new Map<string, AgentRuntime>()
  readonly #operations = new Map<string, Promise<unknown>>()
  #closed = false

  constructor(catalog: DaemonCatalog, native: AgentPersistence, provider: AgentProvider = codexProvider) {
    this.#catalog = catalog
    this.journal = new AgentJournal(native)
    this.#provider = provider
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
        const inputs = snapshot.inputs.filter(input => input.state === "dispatching")
          .map(input => ({ ...input, state: "uncertain" as const, error: "Daemon restarted before delivery was confirmed" }))
        const permissions = snapshot.permissions.filter(permission => permission.state === "pending")
          .map(permission => ({ ...permission, state: "cancelled" as const, resolvedAt: timestamp() }))
        const recovered = session.lifecycle === "provisioning"
          ? { ...session, lifecycle: "provision_failed" as const, error: "Session creation was interrupted", updatedAt: timestamp() } : undefined
        const events = [
          ...runs.map(row => this.journal.event(session.id, "run", row)),
          ...turns.map(row => this.journal.event(session.id, "turn", row)),
          ...inputs.map(row => this.journal.event(session.id, "input", row)),
          ...permissions.map(row => this.journal.event(session.id, "permission", row)),
          ...(recovered ? [this.journal.event(session.id, "session", recovered)] : []),
        ]
        if (events.length) await this.journal.commit(snapshot, { session: recovered, runs, turns, inputs, permissions, events })
      })
    }
  }

  onEvent(listener: (event: AgentEvent) => void): () => void { return this.journal.onEvent(listener) }
  actor(): AgentActor { return this.journal.actor() }
  #runtime(sessionId: string): AgentRuntime {
    let runtime = this.#runtimes.get(sessionId)
    if (!runtime) {
      if (this.#closed) throw new Error("Agent service is stopping")
      runtime = new AgentRuntime(this.journal, this.#catalog, this.#provider, sessionId)
      this.#runtimes.set(sessionId, runtime)
    }
    return runtime
  }

  async handle(method: AgentMethod, value: unknown, actor: AgentActor): Promise<unknown> {
    if (this.#closed) throw new Error("Agent service is stopping")
    const params = object(value)
    if (method === "_deskfleet/session/list") return this.journal.list()
    if (method === "_deskfleet/session/subscribe") return this.journal.read(id(params.sessionId, "Session ID"))
    if (method === "_deskfleet/session/history") {
      const sessionId = id(params.sessionId, "Session ID")
      const cursor = string(params.afterSeq, "history cursor")
      if (!/^[0-9]+$/u.test(cursor)) throw new Error("Invalid history cursor")
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) <= 0)) throw new Error("Invalid history page size")
      await this.journal.read(sessionId)
      return this.journal.history(sessionId, cursor, params.limit as number | undefined)
    }
    if (method === "_deskfleet/command/get") {
      return this.journal.command(string(params.operationId, "operation ID"))
    }
    if (method === "_deskfleet/git/status" || method === "_deskfleet/git/diff") {
      const sessionId = id(params.sessionId, "Session ID")
      const { session } = await this.journal.read(sessionId)
      if (session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
      const worktree = await this.#catalog.sessionWorktree(sessionId)
      if (!worktree?.directories.length) throw new Error("Session worktree is unavailable")
      const directories = worktree.directories.map(directory => directory.path)
      if (method === "_deskfleet/git/status") return this.#git.status(sessionId, directories)
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
    const existing = await this.journal.command(operationId)
    if (existing) {
      if (existing.method !== method || canonical(existing.actor) !== canonical(actor) || canonical(existing.params) !== canonical(params)) {
        await this.journal.commit(undefined, { command: {
          id: await this.journal.id(), operationId, actor, method, params, isCanonical: false,
          conflictingCommandId: existing.id, status: "rejected", error: "Operation ID was reused with different parameters or identity",
          receivedAt: timestamp(), completedAt: timestamp(),
        } })
        throw new Error("Operation ID was reused with different parameters or identity")
      }
      if (existing.status === "completed") return existing.result
      if (method === "_deskfleet/session/create" && existing.sessionId) return this.journal.read(existing.sessionId)
      if (method === "_deskfleet/session/delete" && existing.status === "accepted" && existing.sessionId) {
        if ((await this.journal.list()).some(session => session.id === existing.sessionId)) return this.#delete(existing)
        await this.#complete(existing, null)
        return null
      }
      if (existing.status === "accepted" && existing.result) return existing.result
      throw new Error(existing.error ?? "This operation was already accepted; refresh its recorded state before continuing")
    }
    const command: AgentCommand = {
      id: await this.journal.id(), operationId, actor, method, params,
      isCanonical: true, status: "accepted", receivedAt: timestamp(),
      ...(method === "_deskfleet/session/create" ? { workspaceId: id(params.workspaceId, "Workspace ID") } : { sessionId: id(params.sessionId, "Session ID") }),
    }
    try {
      if (method === "_deskfleet/session/create") return await this.#create(command)
      await this.journal.commit(undefined, { command })
      const sessionId = command.sessionId!
      const session = (await this.journal.read(sessionId)).session
      if (this.#closed) throw new Error("Agent service is stopping")
      if (session.lifecycle === "deleting" && method !== "_deskfleet/session/delete") throw new Error("Session deletion is in progress")
      if (method === "_deskfleet/input/submit") return await this.#submit(command)
      if (method === "_deskfleet/input/steer" || method === "_deskfleet/input/withdraw" || method === "_deskfleet/input/retry") return await this.#inputAction(command)
      if (method === "_deskfleet/permission/respond") return await this.#decide(command)
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
        await this.journal.commit(undefined, { command: { ...(saved ?? command), status: "failed", error: errorMessage(error), completedAt: timestamp() } })
      }
      throw error
    }
  }

  async #complete(command: AgentCommand, result: unknown): Promise<void> {
    await this.journal.commit(undefined, { command: { ...command, status: "completed", result, completedAt: timestamp() } })
  }

  #receipt(command: AgentCommand, inputId?: string): AgentReceipt {
    return { operationId: command.operationId, commandId: command.id, sessionId: command.sessionId!, ...(inputId ? { inputId } : {}) }
  }

  async #create(command: AgentCommand): Promise<AgentSnapshot> {
    if (command.params.provider !== undefined && command.params.provider !== "codex") throw new Error("Unknown Agent provider")
    const context = command.params.context
    if (context !== "worktree" && context !== "directory") throw new Error("Invalid Session context")
    const title = typeof command.params.title === "string" ? command.params.title.trim().slice(0, 200) : ""
    const session = await this.journal.create(command, command.workspaceId!, title, context)
    command.sessionId = session.id
    try {
      await this.#catalog.provisionSession(session.id, session.workspaceId, context)
      await this.journal.serial(session.id, async () => {
        const snapshot = await this.journal.read(session.id)
        const ready = { ...snapshot.session, lifecycle: "ready" as const, updatedAt: timestamp() }
        await this.journal.commit(snapshot, { session: ready, events: [this.journal.event(session.id, "session", ready)] })
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
      if (snapshot.session.lifecycle !== "ready") throw new Error("This Session has no usable execution context")
      if (!runtime.running && !resumable(snapshot)) throw new Error("This agent cannot resume the saved conversation")
      const input: AgentInput = {
        id: inputId, sessionId, submissionCommandId: command.id, author: command.actor, content: blocks,
        acceptedSeq: String(BigInt(snapshot.session.lastEventSeq) + 1n), state: delivery === "steer" ? "dispatching" : "pending", requestedDelivery: delivery,
        requestedTurnId: command.params.turnId === undefined ? undefined : id(command.params.turnId, "Turn ID"), createdAt: timestamp(),
        ...(delivery === "steer" ? { dispatchCommandId: command.id, dispatcher: command.actor } : {}),
      }
      const title = snapshot.session.title || blocks.map(block => block.type === "text" ? block.text : "").join(" ").slice(0, 100)
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
    if (runtime.running || this.#closed) void runtime.pump()
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
      const previous = snapshot.inputs.find(input => input.id === inputId)
      if (!previous) throw new Error("Input was not found")
      let input = previous
      if (command.method === "_deskfleet/input/retry") {
        if (input.state !== "failed") throw new Error("Only a confirmed unconsumed input can be retried")
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
      const previous = snapshot.permissions.find(permission => permission.id === permissionId)
      if (!previous) throw new Error("Permission request was not found")
      if (!previous.request.options.some(option => option.optionId === optionId)) throw new Error("Unknown permission option")
      if (previous.state !== "pending") {
        await this.journal.commit(snapshot, { command: { ...command, status: "completed", result: previous, completedAt: timestamp() } })
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
      const previous = snapshot.turns.find(turn => turn.id === turnId)
      if (!previous) throw new Error("Turn was not found")
      const turn = liveTurn(previous.state) ? { ...previous, state: "cancelling" as const } : previous
      await this.journal.commit(snapshot, { turns: [turn], command: { ...command, status: "completed", result: receipt, completedAt: timestamp() }, events: [this.journal.event(sessionId, "turn", turn)] })
    })
    await this.#runtime(sessionId).cancel(turnId)
    return receipt
  }

  async #delete(command: AgentCommand): Promise<null> {
    const sessionId = command.sessionId!
    await this.journal.serial(sessionId, async () => {
      const snapshot = await this.journal.read(sessionId)
      const session = { ...snapshot.session, lifecycle: "deleting" as const, updatedAt: timestamp() }
      await this.journal.commit(snapshot, { session, events: [this.journal.event(sessionId, "session", session)] })
    })
    await this.#runtime(sessionId).stop()
    await this.#catalog.handle({ method: "workspaceSessionDestroy", params: { sessionId } })
    this.#runtimes.delete(sessionId)
    await this.#complete(command, null)
    return null
  }

  async close(): Promise<void> {
    this.#closed = true
    const stopping = Promise.allSettled([...this.#runtimes.values()].map(runtime => runtime.stop()))
    await Promise.allSettled(this.#operations.values())
    // A Resume accepted before shutdown may have been waiting for an earlier
    // Stop. Once accepted commands settle, close any generation they restarted.
    const restarted = await Promise.allSettled([...this.#runtimes.values()].map(runtime => runtime.stop()))
    const errors = [...await stopping, ...restarted].flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, "Could not stop Agent sessions")
  }
}
