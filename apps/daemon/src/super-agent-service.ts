import { organizeHistory, projectWorkers } from "./super-agent-history.ts"
import type { CatalogSnapshot } from "@deskfleet/native"
import type { SuperHistory } from "./super-agent-protocol.ts"
import { effectiveCoordinatorProfile, validateCoordinatorProfile } from "./super-agent-profiles.ts"
import { attachmentInfo, previewSuperAttachments, superAttachments, type SuperAttachmentStore } from "./super-agent-attachments.ts"
import { aborted, isDeepStrictEqual } from "node:util"
import { composerSkillText } from "./composer-reference-protocol.ts"
import { selectedReferences, selectedSkills, workspaceMentions, workspaceReferenceEvidence } from "./super-agent-mentions.ts"
import { randomUUID } from "node:crypto"
import { executeGit, GitPolicyError } from "./git-execution.ts"
import { parseWorkerReference } from "../../../packages/client/src/worker-reference.ts"
import { HistoricalSessionUnavailable, inspectHistoricalWorker, resolveWorkerTarget, type WorkerRegistration } from "./super-agent-target.ts"
import type { AgentActor, AgentReceipt, AgentSessionRecord } from "./agent-protocol.ts"
import type { AgentConfiguration } from "./agent-configuration-protocol.ts"
import { createSuperEvidence, superHistoryExcerpt } from "./super-agent-evidence.ts"
import { allowsStoppedResume, attachedKeys, frontendContext, quotedAttachmentSource, stoppedTicketContinuationError, ticketOfQuote, routeSuperMessage, type SuperDecisionModel, type SuperRouteResult } from "./super-agent-router.ts"
import { superRequestObject as object, superResourceId as identifier, parseSuperCommandTarget as commandTarget, superMessageText as text, superWorkerCommandName, superWorkerCommandTarget, type SuperCoordinatorOptions, type SuperHistorySource, type SuperSend, type SuperSnapshot, type SuperWorkerRequest, type SuperWorkspaceId } from "./super-agent-protocol.ts"
import { dispatchRecovery, emptyState, errorText, missingCoordinatorProvider, missingWorkerProvider, note, publicRoom, roomFor, userFocus, type DispatchIntent, type SuperRoom, type SuperStateStore, type SuperUserState } from "./super-agent-state.ts"
import { activeTurn, deliverSuperIntent, projectSuperEvents, type SuperWorkers } from "./super-agent-worker.ts"
import { routeWorkerCommand, sameCommandTarget } from "./super-agent-command.ts"
import { observeWorkerInputs, requestWorkspaceStop, stopWorkspaceDispatch, withdrawDispatch } from "./super-agent-stop.ts"
import { leaveArchivedTicket, roomWithArchives, ticketLifecycle } from "./super-agent-archive.ts"
import { archivedTicketError } from "./super-agent-protocol.ts"

export type { SuperUserState } from "./super-agent-state.ts"
import type { SuperWorkspace } from "./super-agent-protocol.ts"
interface Dependencies {
  historyCatalog?: () => Promise<CatalogSnapshot>
  historyChanged?: () => void
  agents: SuperWorkers
  registration?: () => WorkerRegistration | undefined
  attachments?: SuperAttachmentStore
  defaultCoordinator?: string
  coordinatorOptions: (id: string, model?: string) => Promise<SuperCoordinatorOptions>
  coordinatorModel: (id: string) => SuperDecisionModel
  store: SuperStateStore
  authorize: (actor: AgentActor) => Promise<AgentActor>
  workspaces: (userId: string, includeDefaultWorker?: boolean) => Promise<SuperWorkspace[]>
  providers: () => { id: string; name: string; template?: string }[]
  ensureDefaultWorkspace: (userId: string) => Promise<string>
  route?: typeof routeSuperMessage
}

function knownWorkspace(catalog: SuperWorkspace[], id: string): SuperWorkspace {
  const project = catalog.find(item => item.id === id)
  if (!project) throw new Error("Workspace not found in this registration")
  return project
}
function bindWorker(room: SuperRoom, ticket: SuperRoom["tickets"][number], session: AgentSessionRecord) {
  if (ticket.sessionId && ticket.sessionId !== session.id) throw new Error("The ticket already has a different worker")
  ticket.sessionId = session.id
  ticket.lastEventSeq ??= session.lastEventSeq
  for (const message of room.messages) if (message.ticketId === ticket.id && !message.sessionId) message.sessionId = session.id
}
/** A personal front desk inside an existing authenticated machine registration. Workers retain their normal lifecycle. */
export class SuperAgentService {
  readonly #deps: Dependencies
  readonly #queues = new Map<string, Promise<void>>()
  readonly #live = new Set<Promise<void>>()
  readonly #watchers = new Map<string, Set<string>>()
  readonly #workerSessions = new Map<string, AgentSessionRecord>()
  readonly #replays = new Map<string, { dirty: boolean }>()
  readonly #pendingRequests = new Map<string, { ticketId: string; requests: SuperWorkerRequest[] }>()
  readonly #failedReplays = new Set<string>()
  readonly #stop = new AbortController()
  readonly #routes = new Map<string, AbortController>()
  #unsubscribe?: () => void
  constructor(deps: Dependencies) { this.#deps = deps }

  #coordinator(state: SuperUserState | undefined, configured = this.#deps.providers()) {
    if (state?.coordinatorProviderId !== undefined) return configured.find(provider => provider.id === state.coordinatorProviderId)
    const preferred = configured.filter(provider => (provider.template ?? provider.id) === this.#deps.defaultCoordinator)
    return preferred.length === 1 ? preferred[0] : configured.length === 1 ? configured[0] : undefined
  }
  #transaction<R>(uid: string, edit: (state: SuperUserState) => R) {
    return this.#deps.store.update(uid, () => ({ ...emptyState(), coordinatorProviderId: this.#coordinator(undefined)?.id }), edit)
  }
  #room(uid: string, workspaceId: SuperWorkspaceId) {
    const room = this.#deps.store.get(uid)?.rooms.find(room => room.workspaceId === workspaceId)
      ?? roomFor(emptyState(), workspaceId, this.#deps.providers()[0]?.id || "")
    return roomWithArchives(room, this.#workerSessions)
  }
  #defaultProvider(room: SuperRoom) {
    const configured = this.#deps.providers()
    return configured.find(p => p.id === room.provider)?.id || configured[0]?.id || ""
  }
  async #snapshot(uid: string, workspaceId: SuperWorkspaceId) {
    const state = this.#deps.store.get(uid)
    const room = roomWithArchives(state?.rooms.find(item => item.workspaceId === workspaceId) ?? roomFor(emptyState(), workspaceId), this.#workerSessions)
    const providers = this.#deps.providers()
    const coordinator = this.#coordinator(state, providers)
    const snapshot = publicRoom(room, coordinator?.id, this.#defaultProvider(room), state?.intents ?? [])
    snapshot.pendingRequests = room.tickets.flatMap(ticket => {
      const pending = !ticket.archiveState && ticket.sessionId && this.#pendingRequests.get(JSON.stringify([uid, ticket.sessionId]))
      return pending && pending.ticketId === ticket.id ? pending.requests.map(request => ({ ...request, ticketId: ticket.id })) : []
    })
    if (coordinator) {
      snapshot.coordinatorOverrides = state?.coordinatorOverrides?.[coordinator.id] ?? {}
      snapshot.coordinatorOptions = await this.#deps.coordinatorOptions(coordinator.id, snapshot.coordinatorOverrides.model)
      snapshot.coordinatorSelection = effectiveCoordinatorProfile(coordinator.template ?? coordinator.id, snapshot.coordinatorOverrides, snapshot.coordinatorOptions)
      const measurement = room.coordinatorMeasurement
      if (measurement && measurement.coordinator === coordinator.id && measurement.selection.model === snapshot.coordinatorSelection.model
        && measurement.selection.reasoningEffort === snapshot.coordinatorSelection.reasoningEffort) snapshot.coordinatorUsage = measurement.usage
    }
    snapshot.supportsWorkerReferences = true
    snapshot.supportsWorkerCommands = true
    snapshot.supportsStop = true
    snapshot.supportsTicketArchive = true
    snapshot.supportsComposerMentions = true
    snapshot.supportsAttachmentPreviews = !!this.#deps.attachments
    snapshot.supportsAttachments = !!this.#deps.attachments
    snapshot.workerProviders = providers.map(({ id, name }) => ({ id, name }))
    // Older clients consume these fields separately. Registration grants both roles.
    snapshot.coordinatorProviders = snapshot.workerProviders
    return snapshot
  }
  #track(job: Promise<void>) {
    this.#live.add(job)
    void job.catch(error => console.error("Workspace agent:", errorText(error))).finally(() => this.#live.delete(job))
  }
  #queue(key: string, fn: () => Promise<void>) {
    const next = (this.#queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => { if (!this.#stop.signal.aborted) await fn() })
    this.#queues.set(key, next)
    this.#track(next.finally(() => { if (this.#queues.get(key) === next) this.#queues.delete(key) }))
  }
  #watch(uid: string, sessionId: string) {
    const users = this.#watchers.get(sessionId) || new Set<string>()
    users.add(uid); this.#watchers.set(sessionId, users)
  }
  async init() {
    this.#unsubscribe = this.#deps.agents.onEvent(event => {
      if (event.kind === "command" || event.kind === "acp") return
      if (event.kind === "session") {
        const session = event.payload as AgentSessionRecord
        const previous = this.#workerSessions.get(session.id)
        this.#workerSessions.set(session.id, session)
        if (session.archiveState !== "active" && previous?.archiveState === "active") {
          for (const uid of this.#watchers.get(session.id) ?? []) this.#track(this.#transaction(uid, state => {
            for (const room of state.rooms) {
              const ticket = room.tickets.find(item => item.sessionId === session.id)
              if (ticket) leaveArchivedTicket(state, room, ticket.id)
            }
          }))
        }
      }
      for (const uid of this.#watchers.get(event.sessionId) || []) this.#replay(uid, event.sessionId)
    })
    for (const session of await this.#deps.agents.journal.list()) {
      if (!this.#workerSessions.has(session.id)) this.#workerSessions.set(session.id, session)
    }
    for (const uid of this.#deps.store.users()) {
      let state = this.#deps.store.get(uid)
      if (!state) continue
      // A Worker may have been archived from the regular UI while this front desk was offline.
      const inactive = state.rooms.flatMap(room => room.tickets.filter(ticket => ticketLifecycle(ticket, this.#workerSessions).archiveState
        && (room.focusTicketId === ticket.id || room.pendingQuestion?.ticketId === ticket.id || room.recentTicketIds.includes(ticket.id)
          || state!.intents.some(intent => intent.ticketId === ticket.id && !intent.stop && (intent.phase === "planned" || intent.phase === "working"))))
        .map(ticket => ({ workspaceId: room.workspaceId, ticketId: ticket.id })))
      if (inactive.length) {
        await this.#transaction(uid, saved => {
          for (const { workspaceId, ticketId } of inactive) leaveArchivedTicket(saved, roomFor(saved, workspaceId), ticketId)
        })
        state = this.#deps.store.get(uid)!
      }
      for (const room of state.rooms) {
        for (const ticket of room.tickets) if (ticket.sessionId) {
          this.#watch(uid, ticket.sessionId)
          if (ticketLifecycle(ticket, this.#workerSessions).workerContext) this.#replay(uid, ticket.sessionId)
        }
        for (const message of room.messages) if (message.role === "user" && message.state === "routing") this.#scheduleRoute(uid, room.workspaceId, message.id)
      }
      for (const intent of state.intents) {
        if (intent.stop) {
          if (intent.stop.state === "stopping" || intent.stop.state === "unconfirmed") this.#scheduleStop(uid, intent)
          continue
        }
        if (intent.phase === "planned" || intent.phase === "working") this.#scheduleDispatch(uid, intent)
        if (intent.phase === "uncertain") this.#track(this.#reconcile(uid, intent))
      }
    }
  }
  async close() {
    this.#stop.abort(); this.#unsubscribe?.()
    while (this.#live.size) await Promise.allSettled([...this.#live])
  }

  handle(method: "_deskfleet/super-agent/history", value: unknown, actor: AgentActor): Promise<SuperHistory>
  handle(method: string, value: unknown, actor: AgentActor): Promise<SuperSnapshot>
  async handle(method: string, value: unknown, actor: AgentActor): Promise<SuperSnapshot | SuperHistory> {
    if (this.#stop.signal.aborted) throw new Error("Workspace agent is stopping")
    if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and device are required")
    if (method === "_deskfleet/super-agent/history") return organizeHistory(this.#deps, object(value).assign === undefined ? actor : await this.#deps.authorize(actor), value)
    const uid = actor.userId
    const arg = object(value)
    const workspaceId = arg.workspaceId === null ? null : identifier(arg.workspaceId)
    if (workspaceId !== null) knownWorkspace(await this.#deps.workspaces(uid), workspaceId)
    if (method === "_deskfleet/super-agent/snapshot") {
      const snapshot = await this.#snapshot(uid, workspaceId)
      if (arg.attachment !== undefined) {
        const { messageId, index } = object(arg.attachment)
        const id = identifier(messageId)
        const message = this.#room(uid, workspaceId).messages.find(item => item.role === "user" && item.id === id)
        if (!this.#deps.attachments || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 ||
          !message?.attachments?.[index] || !message.attachmentKeys?.length) throw new Error("Attachment unavailable in this conversation")
        snapshot.attachmentPreview = { messageId: id, index, content: await this.#deps.attachments.preview(uid, message.attachmentKeys, index) }
      }
      for (const ticket of snapshot.tickets) {
        if (ticket.sessionId && ticket.workerContext && this.#failedReplays.has(JSON.stringify([uid, ticket.sessionId]))) this.#replay(uid, ticket.sessionId)
      }
      return snapshot
    }
    if (method === "_deskfleet/super-agent/settings") {
      const provider = arg.provider === undefined ? undefined : identifier(arg.provider)
      const coordinator = arg.coordinator === undefined ? undefined : identifier(arg.coordinator)
      const selection = arg.workerSelection === undefined ? undefined : object(arg.workerSelection)
      const selected = selection && {
        provider: identifier(selection.provider),
        model: selection.model === undefined ? undefined : identifier(selection.model),
        reasoningEffort: selection.reasoningEffort === undefined ? undefined : identifier(selection.reasoningEffort),
      }
      const autoApprove = arg.workerAutoApprove
      if (autoApprove !== undefined && typeof autoApprove !== "boolean") throw new Error("Invalid Worker auto-approval setting")
      const rawMode = arg.workerMode === undefined ? undefined : object(arg.workerMode)
      const workerMode = rawMode && { provider: identifier(rawMode.provider), mode: rawMode.mode === null ? null : identifier(rawMode.mode) }
      if (workerMode || autoApprove !== undefined) {
        const authority = await this.#deps.authorize(actor)
        if (workerMode?.mode) {
          const room = this.#room(uid, workspaceId)
          if (workerMode.provider !== (provider ?? this.#defaultProvider(room))) throw new Error("The default worker has changed")
          const choices = selected ?? (room.provider === workerMode.provider ? room.workerSelection : undefined)
          const config = await this.#deps.agents.handle("_deskfleet/agent/configuration", {
            provider: workerMode.provider, workspaceId: workspaceId ?? undefined, model: choices?.model,
            reasoningEffort: choices?.reasoningEffort, cache: true, includeMatrix: false,
          }, authority) as AgentConfiguration | null
          if (config?.provider.id !== workerMode.provider || !config.modes?.options.some(choice => choice.id === workerMode.mode)) throw new Error("The execution Agent does not offer this mode")
        }
      }
      const front = arg.coordinatorSelection === undefined ? undefined : object(arg.coordinatorSelection)
      const frontSelection = front && {
        model: front.model === undefined ? undefined : identifier(front.model),
        reasoningEffort: front.reasoningEffort === undefined ? undefined : identifier(front.reasoningEffort),
      }
      if (front && frontSelection) {
        const id = identifier(front.provider)
        if (!this.#deps.providers().some(entry => entry.id === id)) throw new Error("Unknown coordinator provider for this machine")
        validateCoordinatorProfile(frontSelection, await this.#deps.coordinatorOptions(id, frontSelection.model))
      }
      if (provider === undefined && coordinator === undefined && !selected && !front && !workerMode && autoApprove === undefined) throw new Error("Select a coordinator or worker provider")
      await this.#transaction(uid, state => {
        if (coordinator) {
          if (!this.#deps.providers().some(entry => entry.id === coordinator)) throw new Error("Unknown coordinator provider for this machine")
          state.coordinatorProviderId = coordinator
        }
        if (provider && !this.#deps.providers().some(entry => entry.id === provider)) throw new Error("Unknown worker provider")
        if (front && frontSelection) {
          const current = this.#coordinator(state)?.id
          if (!current || front.provider !== current) throw new Error("The coordinator has changed")
          state.coordinatorProviderId = current
          state.coordinatorOverrides ??= {}
          state.coordinatorOverrides[current] = frontSelection
        }
        if (!provider && !selected && !workerMode && autoApprove === undefined) return
        const room = roomFor(state, workspaceId)
        if (provider && room.provider !== provider) {
          room.provider = provider
          delete room.workerSelection
        }
        if (selected) {
          if (selected.provider !== this.#defaultProvider(room)) throw new Error("The default worker has changed")
          room.provider = selected.provider
          room.workerSelection = { ...room.workerSelection, model: selected.model, reasoningEffort: selected.reasoningEffort }
        }
        if (workerMode) {
          if (workerMode.provider !== this.#defaultProvider(room)) throw new Error("The default worker has changed")
          room.provider = workerMode.provider
          room.workerSelection ??= {}
          if (workerMode.mode === null) delete room.workerSelection.mode
          else room.workerSelection.mode = workerMode.mode
        }
        if (autoApprove !== undefined) room.workerAutoApprove = autoApprove
      })
    } else if (method === "_deskfleet/super-agent/archiveTicket") {
      const ticketId = identifier(arg.ticketId)
      const sessionId = arg.sessionId === null ? undefined : identifier(arg.sessionId)
      const operationId = identifier(arg.operationId)
      const archived = arg.archived
      if (typeof archived !== "boolean") throw new Error("Choose whether to archive or restore the ticket")
      const authority = await this.#deps.authorize(actor)
      const verifyTarget = (room: SuperRoom) => {
        const ticket = room.tickets.find(item => item.id === ticketId)
        if (!ticket) throw new Error("Unknown ticket in this workspace")
        if (ticket.sessionId !== sessionId) throw new Error("The ticket's Worker has changed. Reopen the ticket and try again.")
        return ticket
      }
      if (sessionId) {
        const ticket = verifyTarget(this.#room(uid, workspaceId))
        const workers = await projectWorkers(this.#deps, uid)
        const { session } = await workers.journal.read(sessionId)
        if (session.workspaceId !== ticket.executionWorkspaceId) throw new Error("Worker is outside the ticket workspace")
        await workers.handle(archived ? "_deskfleet/session/archive" : "_deskfleet/session/restore", { sessionId, operationId }, authority)
      } else await this.#transaction(uid, state => {
        const room = roomFor(state, workspaceId)
        const ticket = verifyTarget(room)
        if (archived) {
          if (state.intents.some(intent => intent.ticketId === ticketId && ["planned", "working", "uncertain"].includes(intent.phase))) {
            throw new Error("Worker assignment is still pending. Stop the request or wait for its outcome before archiving.")
          }
          ticket.archiveState = "archived"
          leaveArchivedTicket(state, room, ticketId)
        } else delete ticket.archiveState
      })
    } else if (method === "_deskfleet/super-agent/send") {
      if (arg.retry !== undefined && typeof arg.retry !== "boolean") throw new Error("Invalid retry option")
      const blocks = superAttachments(arg.attachments)
      const request: SuperSend = {
        workspaceId, messageId: identifier(arg.messageId),
        text: arg.text === "" && (blocks.length || arg.retry) ? "" : text(arg.text),
        replyTo: arg.replyTo === undefined ? undefined : identifier(arg.replyTo),
        command: commandTarget(arg.command),
      }
      request.mentions = workspaceMentions(request.text, arg.mentions)
      const hasSkills = selectedSkills(request.mentions).length > 0
      if (hasSkills && !request.command) throw new Error("Select a Worker provider for this skill.")
      if (request.command && !superWorkerCommandName(request.text) && !hasSkills) throw new Error("Enter a worker slash command or select a skill.")
      if (hasSkills) composerSkillText(request.text, request.mentions!, request.command!.provider)
      const store = this.#deps.attachments
      const key = blocks.length && store ? store.key(request.messageId, blocks) : undefined
      if (blocks.length) {
        if (!store || !key) throw new Error("This machine does not support workspace attachments")
        const existing = this.#deps.store.get(uid)
        const room = existing?.rooms.find(r => r.workspaceId === workspaceId)
        if (existing?.rooms.some(r => r !== room && r.messages.some(m => m.id === request.messageId))) throw new Error("Message ID already used in a different workspace")
        if (request.replyTo && !room?.messages.some(m => m.id === request.replyTo)) throw new Error("Quoted message is outside this workspace conversation")
        const accepted = room?.messages.find(m => m.id === request.messageId)
        if (arg.retry && !accepted) throw new Error("Unknown message to retry")
        if (accepted && (accepted.attachmentKeys?.[0] !== key || accepted.text !== request.text || accepted.replyTo !== request.replyTo)) throw new Error("Message ID already used for a different request")
        await this.#deps.authorize(actor)
        const roots = workspaceId === null ? [] : knownWorkspace(await this.#deps.workspaces(uid), workspaceId).roots
        await store.save(uid, key, blocks, roots)
      }
      const accepted = await this.#transaction(uid, state => {
        const room = roomFor(state, workspaceId, this.#deps.providers()[0]?.id || "")
        const prior = room.messages.find(message => message.id === request.messageId)
        if (prior) {
          if (prior.role !== "user" || prior.text !== request.text || prior.replyTo !== request.replyTo ||
            ((!arg.retry || request.command) && !sameCommandTarget(prior.command, request.command)) ||
            ((!arg.retry || arg.mentions !== undefined) && !isDeepStrictEqual(prior.mentions, request.mentions)) ||
            ((!arg.retry || key !== undefined) && prior.attachmentKeys?.[0] !== key)) throw new Error("Message ID already used for a different request")
          if (arg.retry === true) {
            this.#checkTicketTarget(room, prior.correctedTicketId ?? ticketOfQuote(room, room.messages.find(item => item.id === prior.replyTo)))
            const recovery = prior.state === "failed" && prior.reason === missingWorkerProvider
              ? dispatchRecovery(room, state.intents).get(prior.id) : undefined
            if (recovery) {
              const provider = prior.command?.provider ?? this.#defaultProvider(room)
              if (!this.#deps.providers().some(p => p.id === provider)) throw new Error(missingWorkerProvider)
              for (const intent of recovery) {
                const ticket = room.tickets.find(item => item.id === intent.ticketId)!
                ticket.provider = provider
                ticket.status = "queued"
                if (ticket.summary === intent.error) ticket.summary = ""
                intent.workerSelection = room.provider === provider ? room.workerSelection : undefined
                intent.provider = provider
                intent.actor = actor
                intent.phase = "planned"
                intent.error = undefined
              }
              prior.state = "assigned"
              prior.reason = undefined
              prior.failureCode = undefined
              prior.retryable = undefined
              return recovery
            }
            if (prior.state !== "failed" || !prior.retryable || state.intents.some(intent => intent.messageId === prior.id && intent.roomId === workspaceId)) {
              throw new Error("This message cannot be safely retried.")
            }
            prior.state = "routing"; prior.reason = undefined; prior.retryable = undefined
            prior.actor = actor; prior.revision = (prior.revision || 0) + 1
            return true
          }
          return false
        }
        if (arg.retry === true) throw new Error("Unknown message to retry")
        if (state.rooms.some(other => other !== room && other.messages.some(message => message.id === request.messageId))) {
          throw new Error("Message ID already used in a different workspace")
        }
        if (request.replyTo && !room.messages.some(message => message.id === request.replyTo)) throw new Error("Quoted message is outside this workspace conversation")
        this.#checkTicketTarget(room, ticketOfQuote(room, room.messages.find(item => item.id === request.replyTo)))
        if (request.command) {
          const expected = superWorkerCommandTarget({ ...roomWithArchives(room, this.#workerSessions), provider: this.#defaultProvider(room) }, request.replyTo)
          // Session configuration can already reflect a provider change made in the
          // Worker itself. The live registration and catalog are checked before dispatch.
          if (expected.sessionId) expected.provider = request.command.provider
          if (!sameCommandTarget(request.command, expected)) throw new Error("The command target has changed. Select the worker command again.")
        }
        note(room, request.text, { id: request.messageId, role: "user", state: "routing", replyTo: request.replyTo, actor, revision: 0,
          ...(request.command && { command: request.command }), ...(request.mentions && { mentions: request.mentions }),
          ...(key ? { attachmentKeys: [key], attachments: blocks.map(attachmentInfo) } : {}) })
        return true
      })
      if (Array.isArray(accepted)) {
        for (const intent of accepted) this.#scheduleDispatch(uid, intent)
      } else if (accepted) this.#scheduleRoute(uid, workspaceId, request.messageId)
    } else if (method === "_deskfleet/super-agent/stop") {
      if (typeof arg.revision !== "number" || !Number.isSafeInteger(arg.revision) || arg.revision < 0) throw new Error("Invalid request revision")
      if (arg.sharedTurns !== undefined && (!Array.isArray(arg.sharedTurns) || arg.sharedTurns.length > 6)) throw new Error("Invalid shared turn selection")
      const request = { workspaceId, messageId: identifier(arg.messageId), revision: arg.revision,
        ticketId: arg.ticketId === undefined ? undefined : identifier(arg.ticketId),
        sharedTurns: arg.sharedTurns?.map(value => { const turn = object(value); return { ticketId: identifier(turn.ticketId), turnId: identifier(turn.turnId) } }) }
      const authorized = await this.#deps.authorize(actor)
      const { routeId, intents } = await this.#transaction(uid, state => requestWorkspaceStop(state, request, authorized))
      if (routeId) this.#routes.get(JSON.stringify([uid, routeId]))?.abort()
      for (const intent of intents) this.#scheduleStop(uid, intent)
    } else if (method === "_deskfleet/super-agent/correct") {
      const messageId = identifier(arg.messageId), ticketId = identifier(arg.ticketId)
      await this.#correct(uid, workspaceId, messageId, ticketId, actor)
      this.#scheduleRoute(uid, workspaceId, messageId)
    } else throw new Error("Unknown workspace agent operation")
    return this.#snapshot(uid, workspaceId)
  }

  #checkTicketTarget(room: SuperRoom, id: string | undefined) {
    const ticket = id && room.tickets.find(item => item.id === id)
    if (ticket && ticketLifecycle(ticket, this.#workerSessions).archiveState) throw new Error(archivedTicketError)
  }

  async #correct(uid: string, id: SuperWorkspaceId, messageId: string, ticketId: string, actor: AgentActor) {
    await this.#transaction(uid, state => {
      const room = roomFor(state, id)
      const target = room.tickets.find(ticket => ticket.id === ticketId)
      const original = room.messages.find(message => message.id === messageId && message.role === "user")
      if (!target || !original) throw new Error("Unknown ticket or original message")
      this.#checkTicketTarget(room, ticketId)
      if (original.command) throw new Error("This command is bound to its selected worker. Send a new command to choose another.")
      const intents = state.intents.filter(intent => intent.roomId === id && intent.messageId === messageId)
      if (original.state === "transferred" || original.state === "stopped" || intents.some(intent => intent.stop || !["planned", "withdrawn"].includes(intent.phase))) {
        throw new Error("This message may already have reached its worker. Inspect the linked session and send a new instruction to correct the work; it has not been sent again.")
      }
      for (const intent of intents.filter(item => item.phase === "planned")) {
        withdrawDispatch(state, room, intent)
      }
      original.corrections ??= []
      original.corrections.push({ fromTicketId: original.correctedTicketId || original.ticketId, toTicketId: ticketId, actor, createdAt: new Date().toISOString() })
      original.ticketId = undefined; original.sessionId = undefined
      original.correctedTicketId = ticketId; original.state = "routing"; original.reason = undefined
      original.revision = (original.revision || 0) + 1; original.actor = actor; original.retryable = undefined
    })
  }

  #scheduleRoute(uid: string, workspaceId: SuperWorkspaceId, messageId: string) {
    this.#queue(JSON.stringify(["route", uid, workspaceId]), async () => {
      const room = this.#room(uid, workspaceId)
      const message = room.messages.find(item => item.id === messageId)
      if (message?.state !== "routing" || !message.actor) return
      const revision = message.revision
      const key = JSON.stringify([uid, messageId])
      const controller = new AbortController()
      this.#routes.set(key, controller)
      const signal = AbortSignal.any([this.#stop.signal, controller.signal])
      const historySources: SuperHistorySource[] = []
      let measurement: SuperRoom["coordinatorMeasurement"]
      try {
        this.#checkTicketTarget(room, message.correctedTicketId ?? ticketOfQuote(room, room.messages.find(item => item.id === message.replyTo)))
        const actor = await this.#deps.authorize(message.actor)
        const workers = await projectWorkers(this.#deps, uid)
        const workspaces = await this.#deps.workspaces(uid)
        if (workspaceId !== null) knownWorkspace(workspaces, workspaceId)
        if (message.command) {
          const providers = this.#deps.providers()
          const decision = await routeWorkerCommand(workers, actor, room, message, message.command, providers)
          if (!signal.aborted) await this.#apply(uid, workspaceId, messageId, revision, decision, actor, workspaces, providers, new Map(), new Map(), [])
          return
        }
        const reference = parseWorkerReference(message.text)
        if (reference) {
          const prompt = reference.text || (attachedKeys(room, message).length ? "Review the attached material." : "")
          if (!prompt) throw new Error("Add a task after the worker ID or attach a file.")
          const quoted = room.messages.find(item => item.id === message.replyTo)
          const providers = this.#deps.providers()
          const { decision, historicalWorkspace } = await resolveWorkerTarget({
            target: reference.target, prompt, actor, providers, registration: this.#deps.registration?.(), workers: workers, room,
            projects: workspaces, workspaces: workspaceId === null ? await this.#deps.workspaces(uid, true) : workspaces,
            quotedTicketId: ticketOfQuote(room, quoted), correctedTicketId: message.correctedTicketId, quoteText: quoted?.text,
          })
          const historical = new Map<string, AgentSessionRecord>()
          const sessionId = reference.target.sessionId
          if (historicalWorkspace) historical.set(sessionId, await inspectHistoricalWorker(workers, sessionId, historicalWorkspace, actor))
          if (!signal.aborted) await this.#apply(uid, workspaceId, messageId, revision, decision, actor, workspaces,
            providers, historical, new Map(), [], undefined, { sessionId, prompt })
          return
        }
        const history = workspaceId === null ? [] : (await workers.journal.list()).filter(item => item.workspaceId === workspaceId)
        const providers = this.#deps.providers()
        const context = frontendContext(room, message, workspaces, providers, history)
        const keys = attachedKeys(room, message)
        const references = selectedReferences(message.mentions)
        if (keys.length || references.length) {
          if (keys.length && !this.#deps.attachments) throw new Error("Stored workspace attachments are unavailable")
          const files = keys.length ? await this.#deps.attachments!.load(uid, keys) : []
          const { evidence, files: selectedFiles } = await workspaceReferenceEvidence(workers, actor, room, references, historySources)
          context.attachments = await previewSuperAttachments([...files, ...evidence], selectedFiles)
        }
        const state = this.#deps.store.get(uid)
        const front = this.#coordinator(state, providers)
        if (!front) throw new Error(missingCoordinatorProvider)
        context.coordinator = front.id
        const overrides = state?.coordinatorOverrides?.[front.id] ?? {}
        context.coordinatorSelection = effectiveCoordinatorProfile(front.template ?? front.id, overrides,
          await this.#deps.coordinatorOptions(front.id, overrides.model))
        const evidence = createSuperEvidence({
          listRoots: async id => knownWorkspace(await this.#deps.workspaces(uid), id).roots,
          readTicket: async id => {
            const t = this.#room(uid, workspaceId).tickets.find(t => t.id === id)
            if (!t) throw new Error("Unknown ticket")
            if (t.archiveState) throw new Error(archivedTicketError)
            const { title, scope, latestAcceptance, summary, status, sessionId, lastEventSeq, historySources, referenceTicketId } = t
            return JSON.stringify({ title, scope, latestAcceptance, summary, status, sessionId, lastEventSeq, historySources, referenceTicketId })
          },
          readHistory: async (id, after) => {
            const snapshot = await workers.journal.read(id)
            const expected = workspaceId ?? room.tickets.find(t => t.sessionId === id)?.executionWorkspaceId
            if (!expected || snapshot.session.workspaceId !== expected) throw new Error("Session is outside this workspace")
            const end = BigInt(snapshot.session.lastEventSeq)
            const from = after ?? (end > 100n ? end - 100n : 0n).toString()
            if (!/^\d+$/u.test(from)) throw new Error("Invalid history cursor")
            const page = await workers.journal.history(id, from, 100)
            const excerpt = superHistoryExcerpt(page)
            const shown = JSON.parse(excerpt) as { nextAfterSeq?: string; messages: unknown[] }
            if (shown.messages.length && shown.nextAfterSeq) historySources.push({ sessionId: id, afterSeq: from, throughSeq: shown.nextAfterSeq })
            return excerpt
          },
        })
        const coordinator = context.coordinator
        const selection = context.coordinatorSelection ?? {}
        signal.throwIfAborted()
        const routing = (this.#deps.route || routeSuperMessage)(context, {
          evidence, model: this.#deps.coordinatorModel(coordinator), signal, onUsage: usage => { measurement = { coordinator, selection, usage } },
        })
        // A provider or an in-flight evidence read can finish after abort. Free this project's routing queue now.
        const decision = await Promise.race([routing, aborted(signal, controller).then(() => undefined)])
        if (!decision || signal.aborted) return
        const turnIds = new Map<string, string>(), legacy = new Map<string, AgentSessionRecord>()
        for (const action of decision.actions) {
          if (action.kind === "create" && action.sessionId) {
            if (!workspaceId) throw new Error("Historical worker is outside this workspace")
            const workspace = knownWorkspace(workspaces, workspaceId)
            legacy.set(action.sessionId, await inspectHistoricalWorker(workers, action.sessionId, workspace, actor))
          }
          if (action.kind === "stop" || action.kind === "continue" && action.delivery === "steer") {
            const ticket = room.tickets.find(item => item.id === action.ticketId)
            if (!ticket?.sessionId) throw new Error("Ticket has no active worker to interrupt")
            const snapshot = await workers.journal.read(ticket.sessionId)
            if (snapshot.session.workspaceId !== ticket.executionWorkspaceId) throw new Error("Worker workspace changed")
            const active = snapshot.turns.findLast(activeTurn)
            if (!active) throw new HistoricalSessionUnavailable(ticket.sessionId, "The worker has no active turn to interrupt")
            turnIds.set(ticket.id, active.id)
          }
        }
        await this.#apply(uid, room.workspaceId, messageId, revision, decision, actor, workspaces, providers, legacy, turnIds, historySources, measurement)
      } catch (error) {
        if (signal.aborted) return
        await this.#transaction(uid, state => {
          const failedRoom = roomFor(state, workspaceId)
          const current = failedRoom.messages.find(item => item.id === messageId)
          if (current?.state !== "routing" || current.revision !== revision) return
          if (measurement) failedRoom.coordinatorMeasurement = measurement
          current.state = "failed"
          current.reason = errorText(error)
          current.retryable = true
          if (historySources.length) current.historySources = historySources
          if (error instanceof HistoricalSessionUnavailable) current.sessionId = error.sessionId
        })
      } finally { this.#routes.delete(key) }
    })
  }

  async #apply(uid: string, workspaceId: SuperWorkspaceId, messageId: string, revision: number | undefined, decision: SuperRouteResult,
    actor: AgentActor, catalog: SuperWorkspace[], providers: ReturnType<Dependencies["providers"]>,
    historical: Map<string, AgentSessionRecord>, turns: Map<string, string>, historySources: SuperHistorySource[], measurement?: SuperRoom["coordinatorMeasurement"], direct?: { sessionId: string; prompt: string }) {
    const next = await this.#transaction(uid, state => {
      const room = roomFor(state, workspaceId)
      const source = room.messages.find(message => message.id === messageId)
      const schedule: { intents: DispatchIntent[]; handoff?: { workspaceId: string; messageId: string } } = { intents: [] }
      if (source?.state !== "routing" || source.revision !== revision) return schedule
      this.#checkTicketTarget(room, source.correctedTicketId ?? ticketOfQuote(room, room.messages.find(item => item.id === source.replyTo)))
      if (measurement) room.coordinatorMeasurement = measurement
      if (!decision.actions.length) throw new Error("The front desk could not determine a response")
      source.historySources = historySources.length ? historySources : undefined
      const chosen = new Set<string>()
      const split = decision.actions.filter(action => ["create", "continue", "stop"].includes(action.kind)).length > 1
      let question: SuperRoom["pendingQuestion"]
      for (const action of decision.actions) {
        if (action.kind === "handoff") {
          if (source.mentions?.length) throw new Error("These references belong to the current workspace. Open the destination project and select its references.")
          if (decision.actions.length !== 1 || action.workspaceId === workspaceId || source.sourceMessageId) throw new Error("Invalid or repeated workspace transfer")
          const target = knownWorkspace(catalog, action.workspaceId)
          const destination = roomFor(state, target.id, providers[0]?.id || "")
          const id = randomUUID()
          const keys = attachedKeys(room, source)
          const attachments = [...source.attachments ?? [], ...quotedAttachmentSource(room, source)?.attachments ?? []]
          note(destination, source.text, { id, role: "user", ...(keys.length ? { attachmentKeys: keys, attachments } : {}), sourceMessageId: source.id, sourceWorkspaceId: workspaceId, actor, revision: 0, state: "routing", context: action.context })
          source.targetWorkspaceId = target.id; source.state = "transferred"; source.reason = decision.reason
          schedule.handoff = { workspaceId: target.id, messageId: id }
          return schedule
        }
        let ticket = "ticketId" in action && action.ticketId ? room.tickets.find(item => item.id === action.ticketId) : undefined
        if ("ticketId" in action && action.ticketId && !ticket) throw new Error("Coordinator selected an unknown Ticket")
        if (ticket) this.#checkTicketTarget(room, ticket.id)
        if (action.kind === "answer" || action.kind === "clarify") {
          note(room, text(action.text), { ticketId: ticket?.id, sessionId: ticket?.sessionId, sourceMessageId: source.id, historySources: source.historySources, options: action.options })
          if (ticket) chosen.add(ticket.id)
          if (ticket && action.options?.length) question = { ticketId: ticket.id, options: [...action.options], optionDisposition: action.optionDisposition }
          continue
        }
        if (action.kind !== "create" && action.kind !== "continue" && action.kind !== "stop") throw new Error("Unknown routing action")
        if (action.kind === "create") {
          const old = action.sessionId ? historical.get(action.sessionId) : undefined
          if (old && !this.#workerSessions.has(old.id)) this.#workerSessions.set(old.id, old)
          if (old && this.#workerSessions.get(old.id)?.archiveState !== "active") throw new Error("The historical Worker was archived before it could be assigned.")
          const ownedByAnother = action.sessionId && this.#deps.store.users().some(other => other !== uid &&
            this.#deps.store.get(other)?.rooms.some(r => r.tickets.some(t => t.sessionId === action.sessionId)))
          if (action.sessionId && (!old || ownedByAnother || state.rooms.some(r => r.tickets.some(t => t.sessionId === action.sessionId)))) throw new Error("Historical session is already assigned. Continue its existing ticket.")
          const provider = old?.provider || action.provider || this.#defaultProvider(room)
          if (action.provider && !providers.some(p => p.id === action.provider)) throw new Error("Unknown worker provider")
          ticket = {
            id: randomUUID(), title: text(action.title), scope: text(action.scope), summary: "",
            provider, status: "queued", historySources: source.historySources, updatedAt: new Date().toISOString(), referenceTicketId: ticket?.id,
            sessionId: old?.id, executionWorkspaceId: old?.workspaceId, lastEventSeq: old?.lastEventSeq,
          }
          room.tickets.push(ticket)
        }
        if (!ticket) throw new Error("A worker action requires a ticket")
        if (source.command) {
          if (source.command.sessionId && ticket.sessionId !== source.command.sessionId) throw new Error("The command's worker has changed.")
          ticket.provider = source.command.provider
        }
        if (direct && ticket.sessionId !== direct.sessionId) throw new Error("The selected ticket no longer points to that worker.")
        if (!ticket.sessionId && !source.command && !providers.some(p => p.id === ticket.provider)) ticket.provider = this.#defaultProvider(room)
        if (source.correctedTicketId && ticket.id !== source.correctedTicketId) throw new Error("Routing disagreed with the user's correction. No work was sent.")
        if (chosen.has(ticket.id) && schedule.intents.some(intent => intent.ticketId === ticket!.id)) throw new Error("Duplicate worker action for a ticket")
        const originalText = direct?.prompt ?? source.text
        const quoted = source.replyTo ? room.messages.find(m => m.id === source.replyTo) : undefined
        if (action.kind === "continue" && ticket.status === "stopped") {
          const quote = source.correctedTicketId ? { ticketId: source.correctedTicketId } : quoted ? { ticketId: ticketOfQuote(room, quoted) } : undefined
          if (!allowsStoppedResume(originalText, room.pendingQuestion, room.focusTicketId, quote, ticket.id)) {
            throw new Error(stoppedTicketContinuationError)
          }
        }
        chosen.add(ticket.id)
        const priorAcceptance = ticket.latestAcceptance
        const priorAcceptanceMessageId = ticket.acceptanceMessageId
        if (action.kind === "continue" && action.acceptanceUpdate) {
          ticket.latestAcceptance = text(action.acceptanceUpdate)
          ticket.acceptanceMessageId = source.id
        }
        const workerPrompt = text(action.prompt)
        // Keep the user's authority verbatim. When forwarding a rewritten assignment, make its recipient explicit.
        let prompt = workerPrompt
        if (split) prompt = [workerPrompt, source.context].filter(Boolean).join("\n\n")
        else if (action.kind !== "stop" && (workerPrompt !== originalText || source.context)) {
          prompt = [
            `Original user request to the coordinator:\n${originalText}`,
            source.context && `Handoff context:\n${source.context}`,
            `You are the Worker assigned to this request. Carry out the assignment and return the result within the user's constraints.\n${workerPrompt === originalText ? "" : workerPrompt}`.trimEnd(),
          ].filter(Boolean).join("\n\n")
        }
        // New workers cannot see the front desk. Carry the selected scope and the specific
        // quoted result (or cited ticket summary) alongside their assigned instruction.
        const reference = action.kind === "create" && ticket.referenceTicketId ? room.tickets.find(t => t.id === ticket!.referenceTicketId) : undefined
        const relevantQuote = !split || quoted?.ticketId === ticket.id || (reference && quoted?.ticketId === reference.id)
        const background = ((relevantQuote && quoted?.text) || reference?.summary || "").slice(0, 5000)
        const parts = [prompt]
        if (action.kind === "create" && !prompt.includes(ticket.scope)) parts.push(`Ticket scope:\n${ticket.scope}`)
        if (action.kind !== "stop" && background && !prompt.includes(background)) parts.push(`Quoted background:\n${background}`)
        const keys = action.kind === "stop" ? [] : attachedKeys(room, source, relevantQuote && !source.command)
        const skills = selectedSkills(source.mentions), references = selectedReferences(source.mentions)
        const intent: DispatchIntent = {
          ...(skills.length && { skills }), ...(references.length && { references }),
          ...(keys.length ? { attachmentKeys: keys } : {}),
          id: randomUUID(), roomId: workspaceId, messageId, ticketId: ticket.id, actor, provider: ticket.provider,
          workerSelection: !ticket.sessionId && ticket.provider === room.provider ? room.workerSelection : undefined,
          sessionId: ticket.sessionId, workspaceId: ticket.executionWorkspaceId,
          prompt: source.command ? composerSkillText(source.text, source.mentions ?? [], source.command.provider) : parts.join("\n\n"), commandName: source.command ? superWorkerCommandName(source.text) : undefined,
          createId: randomUUID(), submitId: randomUUID(),
          operation: action.kind === "stop" ? "stop" : action.kind === "continue" && action.delivery === "steer" ? "steer" : "submit",
          adoptHistory: action.kind === "create" && action.sessionId ? true : undefined,
          priorTicketStatus: action.kind === "create" ? undefined : ticket.status ?? null, priorAcceptance, priorAcceptanceMessageId,
          turnId: turns.get(ticket.id), context: action.kind === "create" ? action.context : undefined, phase: "planned",
        }
        state.intents.push(intent); schedule.intents.push(intent)
        ticket.updatedAt = new Date().toISOString()
        if (action.kind !== "stop" && ticket.status !== "working" && ticket.status !== "attention") ticket.status = "queued"
        note(room, ticket.title, { kind: "dispatch", ticketId: ticket.id, sessionId: ticket.sessionId, sourceMessageId: source.id, reason: decision.reason })
      }
      const focus = chosen.size === 1 ? [...chosen][0] : undefined
      userFocus(room, focus); room.pendingQuestion = question
      source.ticketId = focus; source.sessionId = room.tickets.find(item => item.id === focus)?.sessionId
      source.state = schedule.intents.length ? "assigned" : "answered"; source.reason = decision.reason
      return schedule
    })
    if (next.handoff) this.#scheduleRoute(uid, next.handoff.workspaceId, next.handoff.messageId)
    for (const intent of next.intents) {
      if (intent.sessionId) this.#watch(uid, intent.sessionId)
      this.#scheduleDispatch(uid, intent)
    }
  }

  /** Reconcile previously unknown delivery only from durable evidence. This method cannot send work. */
  async #reconcile(uid: string, intent: DispatchIntent) {
    if (!intent.sessionId) return
    const command = await this.#deps.agents.journal.command(intent.submitId)
    if (!command || command.sessionId !== intent.sessionId || command.actor.userId !== uid) return
    const expected = intent.operation === "stop" ? "_deskfleet/turn/cancel" : "_deskfleet/input/submit"
    if (command.method !== expected) return
    const snapshot = await (await projectWorkers(this.#deps, uid)).journal.read(intent.sessionId)
    if (snapshot.session.workspaceId !== intent.workspaceId) return
    const input = snapshot.inputs.find(item => item.submissionCommandId === command.id)
    const receipt = command.result as AgentReceipt | undefined
    if (input?.state === "uncertain") return
    const confirmed = input?.state === "delivered" || command.status === "completed" && receipt?.sessionId === intent.sessionId &&
      (intent.operation === "stop" || !!receipt.inputId)
    const rejected = command.status === "failed" || command.status === "rejected" || input?.state === "failed" || input?.state === "withdrawn"
    if (!confirmed && !rejected) return
    await this.#transaction(uid, state => {
      const live = state.intents.find(item => item.id === intent.id)
      if (live?.phase !== "uncertain") return
      const room = roomFor(state, intent.roomId)
      const ticket = room.tickets.find(item => item.id === intent.ticketId)
      const original = room.messages.find(item => item.id === intent.messageId)
      live.phase = rejected ? "failed" : "sent"
      live.error = rejected ? command.error || input?.error || "The original worker operation was rejected." : undefined
      live.inputId = input?.id || receipt?.inputId
      if (original) { original.state = rejected ? "failed" : "assigned"; original.reason = live.error || "The worker journal confirmed receipt." }
      if (ticket && ticket.status === "blocked" && !rejected) {
        if (snapshot.turns.some(activeTurn)) ticket.status = "working"
        else if (snapshot.inputs.some(i => i.state === "pending" || i.state === "dispatching")) ticket.status = "queued"
        else if (snapshot.turns.at(-1)?.state === "completed") delete ticket.status
        if ([...snapshot.permissions, ...snapshot.elicitations].some(req => req.state === "pending")) ticket.status = "attention"
      }
      note(room, live.error || "The worker journal confirmed the original delivery.", { kind: "delivery", role:"worker", ticketId:intent.ticketId, sessionId:intent.sessionId, sourceMessageId:intent.messageId })
    })
  }

  #scheduleStop(uid: string, intent: DispatchIntent) {
    // A create/submit already on the wire must save its receipt before resolving this request.
    this.#queue(JSON.stringify(["dispatch", uid, intent.ticketId]), async () => {
      const live = this.#deps.store.get(uid)?.intents.find(item => item.id === intent.id)
      if (!live?.stop || !["stopping", "unconfirmed"].includes(live.stop.state)) return
      const result = await projectWorkers(this.#deps, uid)
        .then(workers => stopWorkspaceDispatch(workers, live, this.#deps.authorize))
        .catch(() => ({ state: "unconfirmed" as const, snapshot: undefined, undelivered: false }))
      if (result.state === live.stop.state && (!result.snapshot || !observeWorkerInputs([live], result.snapshot))) return
      await this.#transaction(uid, state => {
        const saved = state.intents.find(item => item.id === live.id)
        if (!saved?.stop || saved.stop.cancelId !== live.stop!.cancelId) return
        saved.stop.state = result.state
        const room = roomFor(state, saved.roomId)
        const ticket = room.tickets.find(item => item.id === saved.ticketId)
        if (!saved.sessionId && ticket && result.snapshot) {
          if (!this.#workerSessions.has(result.snapshot.session.id)) this.#workerSessions.set(result.snapshot.session.id, result.snapshot.session)
          bindWorker(room, ticket, result.snapshot.session)
          saved.sessionId = result.snapshot.session.id
          ticket.executionWorkspaceId = saved.workspaceId
        }
        if (result.undelivered) withdrawDispatch(state, room, saved, result.snapshot)
        if (!result.snapshot) return
        observeWorkerInputs(state.intents, result.snapshot)
        if (result.state === "stopped" && ticket?.status === "queued" && BigInt(ticket.lastEventSeq ?? "0") <= BigInt(result.snapshot.session.lastEventSeq) &&
          !result.snapshot.turns.some(activeTurn) && !result.snapshot.inputs.some(i => i.state === "pending" || i.state === "dispatching") &&
          !state.intents.some(i => i.ticketId === saved.ticketId && !i.stop && (i.phase === "planned" || i.phase === "working"))) {
          ticket.status = "stopped"
          if (room.pendingQuestion?.ticketId === ticket.id) room.pendingQuestion = undefined
        }
      })
      if (!live.sessionId && result.snapshot) {
        this.#watch(uid, result.snapshot.session.id)
        this.#replay(uid, result.snapshot.session.id)
      }
    })
  }

  #scheduleDispatch(uid: string, intent: DispatchIntent) {
    this.#queue(JSON.stringify(["dispatch", uid, intent.ticketId]), async () => {
      const current = () => this.#deps.store.get(uid)?.intents.find(item => item.id === intent.id)
      for (const prior of this.#deps.store.get(uid)?.intents ?? []) {
        if (prior.ticketId === intent.ticketId && prior.phase === "uncertain") await this.#reconcile(uid, prior)
      }
      // The predecessor may have created this Ticket's Session after this intent was enqueued.
      await this.#transaction(uid, state => {
        const live = state.intents.find(i => i.id === intent.id)
        const ticket = roomFor(state, intent.roomId).tickets.find(item => item.id === intent.ticketId)
        if (!live || !ticket || live.phase !== "planned") return
        if (ticketLifecycle(ticket, this.#workerSessions).archiveState) {
          withdrawDispatch(state, roomFor(state, intent.roomId), live)
          return
        }
        const earlier = state.intents.slice(0, state.intents.indexOf(live)).find(i => i.ticketId === ticket.id && i.phase === "uncertain")
        if (earlier && live.operation !== "stop") {
          live.phase = "failed"; live.error = "A previous worker operation has no confirmed outcome. Inspect the original session before sending more work."
          const source = roomFor(state, intent.roomId).messages.find(m => m.id === live.messageId)
          if (source) { source.state = "failed"; source.reason = live.error }
          ticket.status = "blocked"; ticket.summary = live.error
          note(roomFor(state, intent.roomId), live.error, { kind: "delivery", role: "worker", ticketId: ticket.id, sourceMessageId: live.messageId })
          return
        }
        if (!live.sessionId && ticket.sessionId) live.sessionId = ticket.sessionId
      })
      const workers = await projectWorkers(this.#deps, uid)
      await deliverSuperIntent({
        workers, current, authorize: this.#deps.authorize, suspended: () => this.#stop.signal.aborted,
        autoApproveNewWorker: () => this.#room(uid, intent.roomId).workerAutoApprove === true,
        inspectHistory: async (sessionId, authority) => {
          const workspace = knownWorkspace(await this.#deps.workspaces(uid, intent.roomId === null), intent.workspaceId || intent.roomId || "")
          await inspectHistoricalWorker(workers, sessionId, workspace, authority)
        },
        workspace: async () => {
          const selected = current()
          if (!selected || !selected.sessionId && !this.#deps.providers().some(item => item.id === selected.provider)) throw new Error(missingWorkerProvider)
          if (this.#stop.signal.aborted) throw new Error("Workspace agent is stopping")
          const id = intent.roomId || await this.#deps.ensureDefaultWorkspace(uid)
          const workspace = knownWorkspace(await this.#deps.workspaces(uid, intent.roomId === null), id)
          if (selected.workspaceId && selected.workspaceId !== workspace.id) throw new Error("The ticket's execution workspace has changed")
          if (selected.context || selected.sessionId) return { id, context: selected.context || "directory" }
          const gitRoots = await Promise.all(workspace.roots.map(async path => {
            try { await executeGit(["-C", path, "rev-parse", "--verify", "HEAD^{commit}"]); return true }
            catch (error) { if (error instanceof GitPolicyError) throw error; return false }
          }))
          return { id, context: gitRoots.length && gitRoots.every(Boolean) ? "worktree" : "directory" }
        },
        loadAttachments: async keys => {
          if (!this.#deps.attachments) throw new Error("Stored workspace attachments are unavailable")
          return this.#deps.attachments.load(uid, keys)
        },
        checkpoint: async (patch, bound) => {
          await this.#transaction(uid, state => {
            const saved = state.intents.find(item => item.id === intent.id)
            // Archiving can cross a native submit. Its confirmed receipt still belongs in the transcript.
            if (!saved || saved.phase === "withdrawn" && (saved.stop || patch.phase !== "sent" || !saved.sessionId)) throw new Error("Dispatch has been withdrawn")
            Object.assign(saved, patch)
            const room = roomFor(state, saved.roomId)
            const ticket = room.tickets.find(item => item.id === saved.ticketId)!
            if (saved.workspaceId) ticket.executionWorkspaceId = saved.workspaceId
            if (patch.provider && ticket.sessionId === saved.sessionId) ticket.provider = patch.provider
            if (bound) {
              if (!this.#workerSessions.has(bound.id)) this.#workerSessions.set(bound.id, bound)
              bindWorker(room, ticket, bound)
            }
            if (saved.inputId && saved.sessionId) {
              const original = room.messages.find(m => m.id === saved.messageId && m.ticketId === saved.ticketId)
              if (original) original.inputId = saved.inputId
              for (const report of room.messages) {
                if (report.role !== "worker" || report.sessionId !== saved.sessionId || report.inputId !== saved.inputId) continue
                report.sourceMessageId = saved.messageId
                if (original && report.turnId) original.turnId = report.turnId
              }
            }
            if (saved.phase === "failed" || saved.phase === "uncertain") {
              const original = room.messages.find(msg => msg.id === saved.messageId)
              if (original) { original.state = saved.phase; original.reason = saved.error }
              ticket.status = "blocked"; ticket.summary = saved.error || "Dispatch failed"
              note(room, ticket.summary, { kind: "delivery", role: "worker", ticketId: ticket.id, sessionId: ticket.sessionId, sourceMessageId: saved.messageId })
            }
          })
          if (bound) this.#watch(uid, bound.id)
        },
      })
      const saved = current()
      if (saved?.sessionId) this.#replay(uid, saved.sessionId)
    })
  }

  #replay(uid: string, sessionId: string) {
    if (this.#stop.signal.aborted) return
    const key = JSON.stringify([uid, sessionId])
    const prior = this.#replays.get(key)
    if (prior) { prior.dirty = true; return }
    const slot = { dirty: true }
    this.#replays.set(key, slot)
    this.#track((async () => {
      try {
        do {
          slot.dirty = false
          const state = this.#deps.store.get(uid)
          for (const prior of state?.intents ?? []) if (prior.sessionId === sessionId && prior.phase === "uncertain") await this.#reconcile(uid, prior)
          const room = state?.rooms.find(r => r.tickets.some(t => t.sessionId === sessionId))
          const bound = room?.tickets.find(t => t.sessionId === sessionId)
          if (!room || !bound) { this.#pendingRequests.delete(key); return }
          const snapshot = await (await projectWorkers(this.#deps, uid)).journal.read(sessionId)
          if (snapshot.session.workspaceId !== bound.executionWorkspaceId) { this.#pendingRequests.delete(key); return }
          // Rebuild even at a current journal cursor. Polling a room does not read its Workers' histories.
          const requests: SuperWorkerRequest[] = [
            ...snapshot.permissions.filter(item => item.state === "pending").map(item => ({ kind: "permission" as const, item })),
            ...snapshot.elicitations.filter(item => item.state === "pending" || (item.request.mode === "url" && item.response?.action === "accept"
              && !item.completedAt && snapshot.turns.some(turn => turn.id === item.turnId && activeTurn(turn))))
              .map(item => ({ kind: "elicitation" as const, item })),
          ]
          if (requests.length && snapshot.session.archiveState === "active" && snapshot.session.lifecycle === "ready") {
            this.#pendingRequests.set(key, { ticketId: bound.id, requests })
          } else this.#pendingRequests.delete(key)
          let from = bound.lastEventSeq || "0"
          const through = BigInt(snapshot.session.lastEventSeq)
          while (!this.#stop.signal.aborted && BigInt(from) < through) {
            // Events can arrive between reading the snapshot and fetching its history.
            // Apply later events with their own snapshot so an older running turn cannot mask completion.
            const events = await this.#deps.agents.journal.history(sessionId, from, 200)
            const page = events.filter(event => BigInt(event.seq) <= through)
            if (page.length < events.length) slot.dirty = true
            if (!page.length || BigInt(page.at(-1)!.seq) <= BigInt(from)) break
            await this.#transaction(uid, state => {
              const liveRoom = roomFor(state, room.workspaceId)
              const ticket = liveRoom.tickets.find(t => t.id === bound.id && t.sessionId === sessionId)
              if (ticket) {
                ticket.provider = snapshot.session.provider
                observeWorkerInputs(state.intents, snapshot)
                projectSuperEvents(liveRoom, ticket, page, snapshot, state.intents)
                if (BigInt(ticket.lastEventSeq || "0") >= BigInt(snapshot.session.lastEventSeq)) {
                  const active = snapshot.turns.some(activeTurn)
                  const queued = snapshot.inputs.some(input => (input.state === "pending" || input.state === "dispatching") && !input.error) ||
                    state.intents.some(i => i.ticketId === ticket.id && i.operation !== "stop" && (i.phase === "planned" || i.phase === "working"))
                  if ((ticket.status === undefined || ticket.status === "stopped") && (active || queued)) ticket.status = active ? "working" : "queued"
                  if ([...snapshot.permissions, ...snapshot.elicitations].some(item => item.state === "pending")) ticket.status = "attention"
                }
              }
            })
            from = page.at(-1)!.seq
          }
          // A fast turn can finish while the input receipt is still being committed.
          // Its terminal event is already consumed when that commit requests the next replay.
          const last = snapshot.turns.at(-1)
          const pending = snapshot.inputs.some(i => i.state === "pending" || i.state === "dispatching")
          const observed = this.#room(uid, room.workspaceId).tickets.find(t => t.id === bound.id)
          if (last && !activeTurn(last) && !pending && observed?.status === "queued" && from === snapshot.session.lastEventSeq) {
            await this.#transaction(uid, current => {
              const r = roomFor(current, room.workspaceId)
              const t = r.tickets.find(t => t.id === bound.id)
              if (!t || t.status !== "queued" || t.lastEventSeq !== from || current.intents.some(i => i.ticketId === t.id && (i.phase === "planned" || i.phase === "working"))) return
              if (r.messages.some(m => m.workerEvent === "result" && m.sessionId === sessionId && m.turnId === last.id)) {
                t.status = last.state === "completed" ? undefined : last.state === "cancelled" ? "stopped" : "blocked"
                if (t.status === "stopped" && r.pendingQuestion?.ticketId === t.id) r.pendingQuestion = undefined
              }
            })
          }
          const intents = this.#deps.store.get(uid)?.intents ?? []
          // A fast steer can be delivered before the front desk checkpoints its input receipt.
          if (observeWorkerInputs(intents, snapshot)) await this.#transaction(uid, current => observeWorkerInputs(current.intents, snapshot))
          for (const intent of intents) {
            if (intent.sessionId === sessionId && (intent.stop?.state === "stopping" || intent.stop?.state === "unconfirmed")) this.#scheduleStop(uid, intent)
          }
        } while (slot.dirty && !this.#stop.signal.aborted)
        this.#failedReplays.delete(key)
      } catch (error) {
        this.#pendingRequests.delete(key)
        this.#failedReplays.add(key)
        throw error
      } finally { this.#replays.delete(key) }
    })())
  }
}
