import type { SuperMessage, SuperSnapshot, SuperTicket, SuperWorkerRequest, SuperWorkspaceId } from "./super-agent.ts"

const LEGACY_MISSING_WORKER = "No configured worker provider is available for this ticket."

export interface SaVisibleMarkerRef {
  key: string
  order: number
  messageId: string
  createdAt?: string
}

export interface SaVisibleMarker extends SaVisibleMarkerRef {
  kind: "reply" | "error" | "attention" | "follow_up"
}

export type SuperWorkspaceActivity = "permission" | "question" | "working" | false

export interface SuperWorkspaceSummary {
  workspaceId: SuperWorkspaceId
  latestVisible?: SaVisibleMarkerRef
  lastRead?: SaVisibleMarkerRef
  activeErrorKeys?: string[]
  readErrorKeys?: string[]
  working: SuperWorkspaceActivity
  /** True when SA itself is routing, directly answering, dispatching, or holding a pending request without relying solely on a Worker child row. */
  saActive: boolean
  /** Worker session IDs currently running SA-delegated work in this workspace. */
  activeDelegatedSessionIds: string[]
  /** Highest Worker completion sequence already represented by an SA reply/result in this workspace. */
  delegatedCompletedSeqs: Record<string, string>
}

export interface SuperMachineSummary {
  workspaces: SuperWorkspaceSummary[]
  /** The signed-in user's private default-agent worker workspace ID, if provisioned. */
  privateWorkspaceId?: string
  generatedAt: string
}

export interface SuperMarkReadParams {
  workspaceId: SuperWorkspaceId
  key: string
  order: number
  messageId: string
  errorKeys?: string[]
}

function isMissingWorkerMessage(message: SuperMessage): boolean {
  return message.failureCode === "worker_unconfigured"
    || message.reason === LEGACY_MISSING_WORKER
    || (message.text === LEGACY_MISSING_WORKER && message.role === "worker")
}

function maxSeqString(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  try {
    return BigInt(right) > BigInt(left) ? right : left
  } catch {
    return right
  }
}

/**
 * Extract ordered unread-eligible SA visible markers from a workspace room's durable messages.
 * Formal replies, clarifications, user-actionable errors, and background follow-up reports produce markers.
 * Streaming feedback drafts, folded dispatch/delivery markers, user prompts, user stops, and Worker-only terminal states do not.
 */
export function extractSaVisibleMarkers(
  messages: readonly SuperMessage[],
  tickets: readonly SuperTicket[],
): SaVisibleMarker[] {
  const byId = new Map(messages.map(message => [message.id, message]))
  const ticketMap = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const operations = new Set<string>()
  for (const message of messages) {
    const source = message.sourceMessageId ? byId.get(message.sourceMessageId) : undefined
    const ticket = message.ticketId ? ticketMap.get(message.ticketId) : undefined
    if (!source || source.role !== "user" || !ticket) continue
    const dispatch = message.kind === "dispatch" || (message.role === "assistant" && message.reason !== undefined && message.text === ticket.title)
    const repeatedWorkerError = message.workerEvent === "error" && message.text === source.reason
      && (source.state === "failed" || source.state === "uncertain")
    const delivery = message.kind === "delivery" || repeatedWorkerError || (message.role === "worker" && !message.workerEvent && (
      isMissingWorkerMessage(message) || message.text === source.reason || (ticket.status === "blocked" && message.text === ticket.summary)
      || message.text === "The worker journal confirmed the original delivery."
    ))
    if (dispatch || delivery) operations.add(message.id)
  }

  const markers: Array<{ marker: SaVisibleMarker; index: number }> = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (operations.has(message.id)) continue
    const order = typeof message.visibleSeq === "number" && Number.isFinite(message.visibleSeq) && message.visibleSeq > 0
      ? message.visibleSeq
      : index + 1
    if (message.role === "user") {
      if (message.state === "failed" || message.state === "uncertain") {
        markers.push({
          index,
          marker: {
            key: `${message.id}:error:${message.revision ?? 0}`,
            messageId: message.id,
            order,
            createdAt: message.createdAt,
            kind: "error",
          },
        })
      }
      continue
    }
    if (message.role === "assistant") {
      if (message.kind === "dispatch" || message.kind === "delivery") continue
      markers.push({
        index,
        marker: {
          key: message.id,
          messageId: message.id,
          order,
          createdAt: message.createdAt,
          kind: message.provenance?.origin === "sa_follow_up" ? "follow_up" : "reply",
        },
      })
      continue
    }
    if (message.role === "worker") {
      if (message.kind === "delivery" || message.stopState === "stopped") continue
      if (message.workerEvent === "result") {
        markers.push({
          index,
          marker: {
            key: message.id,
            messageId: message.id,
            order,
            createdAt: message.createdAt,
            kind: message.provenance?.origin === "sa_follow_up" ? "follow_up" : "reply",
          },
        })
      } else if (message.workerEvent === "error") {
        markers.push({
          index,
          marker: {
            key: message.id,
            messageId: message.id,
            order,
            createdAt: message.createdAt,
            kind: "error",
          },
        })
      } else if (message.workerEvent === "question") {
        markers.push({
          index,
          marker: {
            key: message.id,
            messageId: message.id,
            order,
            createdAt: message.createdAt,
            kind: "attention",
          },
        })
      }
    }
  }
  markers.sort((left, right) => left.marker.order - right.marker.order || left.index - right.index)
  return markers.map(entry => entry.marker)
}

export function pickLatestSaMarker(markers: readonly SaVisibleMarker[]): SaVisibleMarkerRef | undefined {
  const last = markers.at(-1)
  if (!last) return undefined
  return {
    key: last.key,
    order: last.order,
    messageId: last.messageId,
    ...(last.createdAt ? { createdAt: last.createdAt } : {}),
  }
}

export function mergeSaMarkerRef(
  a: SaVisibleMarkerRef | undefined,
  b: SaVisibleMarkerRef | undefined,
): SaVisibleMarkerRef | undefined {
  if (!a) return b
  if (!b) return a
  if (b.order > a.order) return b
  if (a.order > b.order) return a
  return b
}

export function isSaSummaryUnread(
  latestVisible: SaVisibleMarkerRef | undefined,
  lastRead: SaVisibleMarkerRef | undefined,
  _activeErrorKeys?: readonly string[],
  _readErrorKeys?: readonly string[],
): boolean {
  if (!latestVisible) return false
  if (!lastRead) return true
  if (lastRead.key === latestVisible.key) return false
  if (latestVisible.order !== lastRead.order) return latestVisible.order > lastRead.order
  return true
}

export function mergeSaActivity(
  left: SuperWorkspaceActivity,
  right: SuperWorkspaceActivity,
): SuperWorkspaceActivity {
  const rank = (state: SuperWorkspaceActivity): number =>
    state === "permission" ? 3 : state === "question" ? 2 : state === "working" ? 1 : 0
  return rank(right) > rank(left) ? right : left
}

export interface ComputeSaWorkspaceSummaryInput {
  workspaceId: SuperWorkspaceId
  messages: readonly SuperMessage[]
  tickets: readonly SuperTicket[]
  pendingRequests?: readonly (SuperWorkerRequest & { ticketId: string })[]
  lastRead?: SaVisibleMarkerRef
  readErrorKeys?: readonly string[]
  /** Active non-withdrawn non-stop dispatch intents (daemon side). */
  activeIntents?: readonly { ticketId: string; sessionId?: string; phase: string; operation?: string; stop?: unknown }[]
  /** Additional known Worker completion seqs delivered into SA (e.g. from ticket metadata or follow-up runs). */
  extraDelegatedCompletedSeqs?: Readonly<Record<string, string>>
}

/** Compute the lightweight SA summary for one workspace from durable room state. */
export function computeSaWorkspaceSummary(input: ComputeSaWorkspaceSummaryInput): SuperWorkspaceSummary {
  const markers = extractSaVisibleMarkers(input.messages, input.tickets)
  const latestVisible = pickLatestSaMarker(markers)
  const activeErrorKeys = markers.filter(marker => marker.kind === "error").map(marker => marker.key)

  let working: SuperWorkspaceActivity = false
  let saActive = false
  const activeDelegated = new Set<string>()

  for (const request of input.pendingRequests ?? []) {
    const isPending = request.item.state === "pending"
      || (request.kind === "elicitation" && request.item.request.mode === "url" && request.item.response?.action === "accept" && !request.item.completedAt)
    if (!isPending) continue
    saActive = true
    working = mergeSaActivity(working, request.kind === "permission" ? "permission" : "question")
    if (request.item.sessionId) activeDelegated.add(request.item.sessionId)
  }

  for (const message of input.messages) {
    if (message.role === "user" && message.state === "routing") {
      saActive = true
      working = mergeSaActivity(working, "working")
    }
    if (message.role === "assistant" && message.kind === "dispatch" && message.dispatching && !message.stopState) {
      saActive = true
      working = mergeSaActivity(working, "working")
      if (message.sessionId) activeDelegated.add(message.sessionId)
    }
  }

  for (const intent of input.activeIntents ?? []) {
    if (intent.stop || intent.operation === "stop") continue
    if (intent.phase === "planned" || intent.phase === "working") {
      saActive = true
      working = mergeSaActivity(working, "working")
      if (intent.sessionId) activeDelegated.add(intent.sessionId)
    }
  }

  for (const ticket of input.tickets) {
    if (ticket.archiveState) continue
    if (ticket.status === "attention") {
      const latestAttention = input.messages.findLast(
        message => message.role === "worker" && message.ticketId === ticket.id && (message.workerEvent === "permission" || message.workerEvent === "question"),
      )
      working = mergeSaActivity(working, latestAttention?.workerEvent === "question" ? "question" : "permission")
      if (ticket.sessionId) activeDelegated.add(ticket.sessionId)
      else saActive = true
    } else if (ticket.status === "working" || ticket.status === "queued") {
      working = mergeSaActivity(working, "working")
      if (ticket.sessionId) activeDelegated.add(ticket.sessionId)
      else saActive = true
    }
  }

  const delegatedCompletedSeqs: Record<string, string> = {}
  for (const message of input.messages) {
    if (message.role !== "worker" || message.workerEvent !== "result" || !message.sessionId) continue
    const match = /^worker:[^:]+:(\d+)$/u.exec(message.id)
    if (match?.[1]) {
      const next = maxSeqString(delegatedCompletedSeqs[message.sessionId], match[1])
      if (next) delegatedCompletedSeqs[message.sessionId] = next
    }
  }
  for (const [sessionId, seq] of Object.entries(input.extraDelegatedCompletedSeqs ?? {})) {
    if (!sessionId || !/^\d+$/u.test(seq)) continue
    const next = maxSeqString(delegatedCompletedSeqs[sessionId], seq)
    if (next) delegatedCompletedSeqs[sessionId] = next
  }

  return {
    workspaceId: input.workspaceId,
    ...(latestVisible ? { latestVisible } : {}),
    ...(input.lastRead ? { lastRead: input.lastRead } : {}),
    ...(activeErrorKeys.length ? { activeErrorKeys } : {}),
    ...(input.readErrorKeys?.length ? { readErrorKeys: [...input.readErrorKeys] } : {}),
    working,
    saActive,
    activeDelegatedSessionIds: [...activeDelegated],
    delegatedCompletedSeqs,
  }
}

export function computeSaSummaryFromSnapshot(snapshot: SuperSnapshot): SuperWorkspaceSummary {
  return computeSaWorkspaceSummary({
    workspaceId: snapshot.workspaceId,
    messages: snapshot.messages,
    tickets: snapshot.tickets,
    pendingRequests: snapshot.pendingRequests,
    lastRead: snapshot.lastRead,
    readErrorKeys: snapshot.readErrorKeys,
    extraDelegatedCompletedSeqs: snapshot.delegatedCompletedSeqs,
  })
}

export function parseSuperMarkRead(value: unknown): SuperMarkReadParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  const obj = value as Record<string, unknown>
  const workspaceId = obj.workspaceId === null ? null
    : typeof obj.workspaceId === "string" && obj.workspaceId.trim() && obj.workspaceId.length <= 256 && !/[\x00-\x1f]/u.test(obj.workspaceId)
      ? obj.workspaceId
      : (() => { throw new Error("Invalid workspace ID") })()
  const key = typeof obj.key === "string" && obj.key.trim() && obj.key.length <= 512 && !/[\x00-\x1f]/u.test(obj.key)
    ? obj.key
    : (() => { throw new Error("Invalid read marker key") })()
  const messageId = typeof obj.messageId === "string" && obj.messageId.trim() && obj.messageId.length <= 256 && !/[\x00-\x1f]/u.test(obj.messageId)
    ? obj.messageId
    : (() => { throw new Error("Invalid message ID") })()
  const order = typeof obj.order === "number" && Number.isSafeInteger(obj.order) && obj.order >= 0
    ? obj.order
    : (() => { throw new Error("Invalid read marker order") })()
  let errorKeys: string[] | undefined
  if (obj.errorKeys !== undefined) {
    if (!Array.isArray(obj.errorKeys) || obj.errorKeys.length > 200) throw new Error("Invalid error keys")
    errorKeys = obj.errorKeys.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 512 && !/[\x00-\x1f]/u.test(item))
  }
  return { workspaceId, key, order, messageId, ...(errorKeys?.length ? { errorKeys } : {}) }
}
