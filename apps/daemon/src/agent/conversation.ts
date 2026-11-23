import {
  autoApprovePermission,
  type AgentCommand, type AgentInput, type AgentPermission, type AgentReceipt, type AgentSnapshot,
} from "@deskfleet/protocol/agent"
import { truncateGeneratedTitle } from "@deskfleet/protocol/titles"
import type { DaemonCatalog } from "../machine/catalog.ts"
import { messageContent, recordId, requiredString } from "./params.ts"
import type { SessionProvisioning } from "./provisioning.ts"
import type { AgentRuntime } from "./runtime.ts"
import { errorMessage, liveTurn, requireActiveSession, timestamp, type AgentJournal } from "./store.ts"

export interface SessionConversationHost {
  readonly journal: AgentJournal
  readonly catalog: DaemonCatalog
  readonly provisioning: SessionProvisioning
  closed(): boolean
  /** The Session's runtime, created when it has none. */
  runtime(sessionId: string): AgentRuntime
}

/** A provider conversation can only continue in a new run when the agent supports resume. */
const resumable = (snapshot: AgentSnapshot) => !snapshot.session.providerSessionId || !!snapshot.session.capabilities?.resume

function receipt(command: AgentCommand, inputId?: string): AgentReceipt {
  return { operationId: command.operationId, commandId: command.id, sessionId: command.sessionId!, ...(inputId ? { inputId } : {}) }
}

/**
 * Inputs, permission decisions, YOLO mode, and turn cancellation steer a
 * Session's Agent. Each is committed to the journal before the runtime acts.
 */
export class SessionConversation {
  readonly #host: SessionConversationHost

  constructor(host: SessionConversationHost) { this.#host = host }

  async submit(command: AgentCommand): Promise<AgentReceipt> {
    const { journal, catalog, provisioning } = this.#host
    const sessionId = command.sessionId!
    const blocks = messageContent(command.params.content)
    const delivery = command.params.delivery
    if (delivery !== "backlog" && delivery !== "steer") throw new Error("Invalid input delivery")
    const runtime = this.#host.runtime(sessionId)
    if (delivery === "steer" && !runtime.running) throw new Error("Resume the Agent before steering")
    const inputId = await journal.id()
    const result = receipt(command, inputId)
    await journal.serial(sessionId, async () => {
      const snapshot = await journal.read(sessionId)
      requireActiveSession(snapshot.session)
      const stillProvisioning = snapshot.session.lifecycle === "provisioning" && provisioning.inProgress(sessionId)
      if (snapshot.session.lifecycle !== "ready" && !(delivery === "backlog" && stillProvisioning)) {
        throw new Error("This Session has no usable execution context")
      }
      if (!runtime.running && !resumable(snapshot)) throw new Error("This agent cannot resume the saved conversation")
      const adopted = await catalog.attachments.adoptDrafts(sessionId, blocks)
      if (stillProvisioning && snapshot.inputs.length > 0) provisioning.allowStart(sessionId)
      const input: AgentInput = {
        id: inputId, sessionId, submissionCommandId: command.id, author: command.actor, content: adopted,
        acceptedSeq: String(BigInt(snapshot.session.lastEventSeq) + 1n), state: delivery === "steer" ? "dispatching" : "pending", requestedDelivery: delivery,
        requestedTurnId: command.params.turnId === undefined ? undefined : recordId(command.params.turnId, "Turn ID"), createdAt: timestamp(),
        ...(delivery === "steer" ? { dispatchCommandId: command.id, dispatcher: command.actor } : {}),
      }
      const titleSource = adopted.map(block => block.type === "text" ? block.text : block.type === "resource" && "text" in block.resource ? block.resource.text : "").filter(Boolean).join(" ").trim()
      const title = snapshot.session.title || truncateGeneratedTitle(titleSource.split(/\r?\n/u)[0] ?? "")
      const session = { ...snapshot.session, title, lastMessageAt: input.createdAt, updatedAt: timestamp() }
      await journal.commit(snapshot, { session, inputs: [input], command: { ...command, status: delivery === "steer" ? "accepted" : "completed", result, completedAt: delivery === "steer" ? undefined : timestamp() }, events: [
        journal.event(sessionId, "input", input), journal.event(sessionId, "session", session),
      ] })
    })
    if (delivery === "steer") this.#steerLater(command, inputId, command.params.turnId as string | undefined)
    else if (!provisioning.inProgress(sessionId)) this.#deliver(sessionId)
    return result
  }

  /** Steers, withdraws, or retries an input the Agent has not consumed. */
  async updateInput(command: AgentCommand): Promise<AgentReceipt> {
    const { journal } = this.#host
    const sessionId = command.sessionId!
    const inputId = recordId(command.params.inputId, "Input ID")
    const result = receipt(command, inputId)
    await journal.serial(sessionId, async () => {
      const snapshot = await journal.read(sessionId)
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
        recordId(command.params.turnId, "Turn ID")
        if (!this.#host.runtime(sessionId).running) throw new Error("Resume the Agent before steering")
        input = { ...input, state: "dispatching", requestedDelivery: "steer", requestedTurnId: command.params.turnId as string, dispatchCommandId: command.id, dispatcher: command.actor }
      }
      const steering = command.method === "_deskfleet/input/steer"
      await journal.commit(snapshot, { inputs: [input], command: { ...command, status: steering ? "accepted" : "completed", result, completedAt: steering ? undefined : timestamp() }, events: [journal.event(sessionId, "input", input)] })
    })
    if (command.method === "_deskfleet/input/steer") this.#steerLater(command, inputId, command.params.turnId as string)
    else if (command.method === "_deskfleet/input/retry") this.#deliver(sessionId)
    else void this.#host.runtime(sessionId).pump()
    return result
  }

  async decide(command: AgentCommand): Promise<AgentPermission> {
    const { journal } = this.#host
    const sessionId = command.sessionId!
    const permissionId = recordId(command.params.permissionId, "Permission ID")
    const optionId = requiredString(command.params.optionId, "permission option")
    let selected = false
    const result = await journal.serial(sessionId, async () => {
      const snapshot = await journal.read(sessionId)
      requireActiveSession(snapshot.session)
      const previous = snapshot.permissions.find(permission => permission.id === permissionId)
      if (!previous) throw new Error("Permission request was not found")
      if (!previous.request.options.some(option => option.optionId === optionId)) throw new Error("Unknown permission option")
      if (previous.state !== "pending") {
        const completed = { ...command, status: "completed" as const, result: previous, completedAt: timestamp() }
        await journal.commit(snapshot, { command: completed, events: [journal.event(sessionId, "command", completed)] })
        return previous
      }
      const permission: AgentPermission = { ...previous, state: "resolved", optionId, decisionCommandId: command.id, actor: command.actor, resolvedAt: timestamp() }
      await journal.commit(snapshot, { permissions: [permission], command: { ...command, status: "completed", result: permission, completedAt: timestamp() }, events: [journal.event(sessionId, "permission", permission)] })
      selected = true
      return permission
    })
    if (selected) this.#host.runtime(sessionId).resolvePermission(permissionId, optionId)
    return result
  }

  /** Enabling YOLO also approves the permission requests already waiting. */
  async setYolo(command: AgentCommand): Promise<AgentSnapshot> {
    const { journal } = this.#host
    const sessionId = command.sessionId!
    const enabled = command.params.enabled
    if (typeof enabled !== "boolean") throw new Error("Invalid YOLO flag")

    const pendingResolutions: { id: string; optionId: string }[] = []
    const snapshot = await journal.serial(sessionId, async () => {
      const current = await journal.read(sessionId)
      requireActiveSession(current.session)

      const now = timestamp()
      const session = enabled
        ? { ...current.session, yolo: true, yoloActor: command.actor, updatedAt: now }
        : { ...current.session, yolo: false, yoloActor: undefined, updatedAt: now }

      const resolvedPermissions = enabled
        ? current.permissions
            .map(previous => autoApprovePermission(previous, now, { actor: command.actor, decisionCommandId: command.id }))
            .filter((permission): permission is AgentPermission => permission !== undefined)
        : []

      for (const permission of resolvedPermissions) {
        if (permission.optionId) {
          pendingResolutions.push({ id: permission.id, optionId: permission.optionId })
        }
      }

      const events = [
        journal.event(sessionId, "session", session, { commandId: command.id }),
        ...resolvedPermissions.map(permission =>
          journal.event(sessionId, "permission", permission, { commandId: command.id }),
        ),
      ]

      await journal.commit(current, {
        session,
        ...(resolvedPermissions.length > 0 ? { permissions: resolvedPermissions } : {}),
        events,
      })
      return await journal.read(sessionId)
    })

    await journal.complete(command, snapshot)
    for (const resolution of pendingResolutions) {
      this.#host.runtime(sessionId).resolvePermission(resolution.id, resolution.optionId)
    }
    return snapshot
  }

  async cancel(command: AgentCommand): Promise<AgentReceipt> {
    const { journal } = this.#host
    const sessionId = command.sessionId!
    const turnId = recordId(command.params.turnId, "Turn ID")
    const result = receipt(command)
    await journal.serial(sessionId, async () => {
      const snapshot = await journal.read(sessionId)
      requireActiveSession(snapshot.session)
      const previous = snapshot.turns.find(turn => turn.id === turnId)
      if (!previous) throw new Error("Turn was not found")
      const turn = liveTurn(previous) ? { ...previous, state: "cancelling" as const } : previous
      await journal.commit(snapshot, { turns: [turn], command: { ...command, status: "completed", result, completedAt: timestamp() }, events: [journal.event(sessionId, "turn", turn)] })
    })
    await this.#host.runtime(sessionId).cancel(turnId)
    return result
  }

  /** A new user request resumes a stopped or interrupted agent; startup then drains the backlog. */
  #deliver(sessionId: string): void {
    const runtime = this.#host.runtime(sessionId)
    if (runtime.running || this.#host.closed()) runtime.resumeBacklog()
    // Startup failures are persisted on the run; the input stays queued for the next request.
    else void runtime.start().catch(() => {})
  }

  #steerLater(command: AgentCommand, inputId: string, turnId?: string): void {
    const { journal } = this.#host
    void (async () => {
      const dispatch: AgentCommand = { ...command, result: receipt(command, inputId) }
      try { await this.#host.runtime(command.sessionId!).steer(inputId, dispatch, turnId) }
      catch (error) {
        await journal.serial(command.sessionId!, async () => {
          const snapshot = await journal.read(command.sessionId!)
          const previous = snapshot.inputs.find(input => input.id === inputId)
          if (!previous || previous.state !== "dispatching" || previous.dispatchCommandId !== command.id) return
          const input = { ...previous, state: "failed" as const, error: errorMessage(error) }
          await journal.commit(snapshot, { inputs: [input], command: { ...dispatch, status: "failed", error: input.error, completedAt: timestamp() }, events: [journal.event(command.sessionId!, "input", input)] })
        })
      }
    })().catch(error => console.error("Agent steering failed", error))
  }
}
