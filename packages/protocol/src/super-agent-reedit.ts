import type { SuperAttachmentRequest, SuperMessage, SuperTicket } from "./super-agent.ts"

const LEGACY_MISSING_WORKER = "No configured worker provider is available for this ticket."

export type StoppedTurnTicketLike = Pick<SuperTicket, "id" | "title" | "status" | "summary" | "archiveState">

function toTicketMap(
  tickets: ReadonlyMap<string, StoppedTurnTicketLike> | readonly StoppedTurnTicketLike[],
): ReadonlyMap<string, StoppedTurnTicketLike> {
  if (!Array.isArray(tickets)) return tickets as ReadonlyMap<string, StoppedTurnTicketLike>
  return new Map(tickets.map(ticket => [ticket.id, ticket]))
}

function isFoldedDispatchRow(
  message: SuperMessage,
  ticketTitles: ReadonlyMap<string, string>,
): boolean {
  if (message.role !== "assistant" || !message.sourceMessageId || !message.ticketId) return false
  if (message.kind === "dispatch") return true
  if (message.kind || message.reason === undefined) return false
  const title = ticketTitles.get(message.ticketId)
  return title !== undefined && message.text === title
}

function isFoldedDeliveryRow(
  message: SuperMessage,
  source: SuperMessage,
  ticket?: StoppedTurnTicketLike,
): boolean {
  if (message.kind === "delivery") return true
  const repeatedWorkerError = message.workerEvent === "error" && message.text === source.reason
    && (source.state === "failed" || source.state === "uncertain")
  if (repeatedWorkerError) return true
  if (message.role === "worker" && !message.workerEvent) {
    const missing = message.failureCode === "worker_unconfigured"
      || message.reason === LEGACY_MISSING_WORKER
      || message.text === LEGACY_MISSING_WORKER
    if (
      missing
      || message.text === source.reason
      || (ticket?.status === "blocked" && message.text === ticket.summary)
      || message.text === "The worker journal confirmed the original delivery."
    ) return true
  }
  return false
}

/**
 * Determine whether `sourceMessageId` identifies a user request whose turn is durably
 * confirmed as stopped (never stopping/unconfirmed/running/queued/failed/completed).
 */
export function isConfirmedStoppedTurn(
  messages: readonly SuperMessage[],
  tickets: ReadonlyMap<string, StoppedTurnTicketLike> | readonly StoppedTurnTicketLike[],
  sourceMessageId: string,
  options?: { hasPendingLocalStop?: boolean },
): boolean {
  if (options?.hasPendingLocalStop) return false
  const source = messages.find(message => message.id === sourceMessageId && message.role === "user")
  if (!source) return false
  if (
    source.state === "routing"
    || source.state === "answered"
    || source.state === "failed"
    || source.state === "uncertain"
    || source.state === "transferred"
  ) return false

  const ticketMap = toTicketMap(tickets)
  const ticketTitles = new Map<string, string>()
  for (const [id, ticket] of ticketMap) ticketTitles.set(id, ticket.title)

  const dispatches = new Map<string, SuperMessage>()
  const stoppedResults: SuperMessage[] = []

  for (const message of messages) {
    if (message.sourceMessageId !== source.id) continue
    const ticket = message.ticketId ? ticketMap.get(message.ticketId) : undefined
    if (isFoldedDispatchRow(message, ticketTitles) && message.ticketId) {
      dispatches.set(message.ticketId, message)
      continue
    }
    if (isFoldedDeliveryRow(message, source, ticket)) continue
    if (message.role === "assistant") return false
    if (message.role === "worker") {
      if (message.workerEvent === "result") {
        if (message.stopState === "stopped") stoppedResults.push(message)
        else return false
      } else if (message.workerEvent === "error") {
        return false
      }
    }
  }

  for (const marker of dispatches.values()) {
    if (marker.stopState === "stopping" || marker.stopState === "unconfirmed" || marker.stopState === "finished") {
      return false
    }
  }

  if (source.state === "stopped") {
    for (const [ticketId, marker] of dispatches) {
      const hasStoppedResult = stoppedResults.some(result => result.ticketId === ticketId)
      if (marker.stopState !== "stopped" && !(hasStoppedResult && !marker.dispatching)) return false
    }
    return true
  }

  if (dispatches.size > 0) {
    for (const [ticketId, marker] of dispatches) {
      const hasStoppedResult = stoppedResults.some(result => result.ticketId === ticketId)
      if (marker.stopState !== "stopped" && !(hasStoppedResult && !marker.dispatching)) return false
    }
    if (source.ticketId && !dispatches.has(source.ticketId)) {
      if (!stoppedResults.some(result => result.ticketId === source.ticketId)) return false
    }
    return true
  }

  if (!stoppedResults.length) return false
  if (source.ticketId && !stoppedResults.some(result => result.ticketId === source.ticketId)) return false
  return true
}

/**
 * Resolve confirmed-stopped user turns explicitly superseded by a later accepted re-edit message
 * (`message.reEditOf`). Never infers replacement from message adjacency or text similarity.
 */
export function resolveSupersededStoppedTurns(
  messages: readonly SuperMessage[],
  tickets: ReadonlyMap<string, StoppedTurnTicketLike> | readonly StoppedTurnTicketLike[],
): Map<string, string> {
  const superseded = new Map<string, string>()
  const confirmed = new Map<string, boolean>()
  const isStopped = (id: string) => {
    let value = confirmed.get(id)
    if (value === undefined) {
      value = isConfirmedStoppedTurn(messages, tickets, id)
      confirmed.set(id, value)
    }
    return value
  }
  for (const message of messages) {
    if (message.role !== "user" || !message.reEditOf || message.reEditOf === message.id) continue
    if (isStopped(message.reEditOf)) superseded.set(message.reEditOf, message.id)
  }
  return superseded
}

export function parseSuperReusedAttachments(value: unknown): SuperAttachmentRequest[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 99) throw new Error("Invalid reused workspace attachments")
  const result: SuperAttachmentRequest[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid reused workspace attachment")
    const obj = raw as Record<string, unknown>
    if (typeof obj.messageId !== "string" || !obj.messageId.trim() || obj.messageId.length > 256 || /[\x00-\x1f]/u.test(obj.messageId)) {
      throw new Error("Invalid attachment source message ID")
    }
    if (typeof obj.index !== "number" || !Number.isSafeInteger(obj.index) || obj.index < 0 || obj.index >= 99) {
      throw new Error("Invalid attachment index")
    }
    result.push({ messageId: obj.messageId, index: obj.index })
  }
  return result
}
