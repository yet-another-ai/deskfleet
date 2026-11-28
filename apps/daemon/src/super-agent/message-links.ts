import {
  dedupeTicketIds,
  type SuperMessageTicketLinks,
} from "@deskfleet/protocol/super-agent"
import type { SuperRouteAction } from "./router.ts"
import { superTaskText, type StoredSuperMessage, type SuperRoom } from "./state.ts"

/** Identify folded dispatch notice rows stored for auditing and quote IDs. */
export function isFoldedDispatchMessage(
  room: Pick<SuperRoom, "tickets">,
  message: Pick<StoredSuperMessage, "role" | "kind" | "reason" | "text" | "ticketId" | "sourceMessageId">,
  ticketTitles?: ReadonlyMap<string, string>,
): boolean {
  if (message.role !== "assistant" || !message.sourceMessageId || !message.ticketId) return false
  if (message.kind === "dispatch") return true
  if (message.kind || message.reason === undefined) return false
  const title = ticketTitles ? ticketTitles.get(message.ticketId) : room.tickets.find(t => t.id === message.ticketId)?.title
  return title !== undefined && message.text === title
}

/** Identify folded dispatch or worker delivery operation rows that do not represent conversation content. */
export function isFoldedOperationMessage(
  room: Pick<SuperRoom, "tickets">,
  message: Pick<StoredSuperMessage, "role" | "kind" | "reason" | "text" | "ticketId" | "sourceMessageId">,
  ticketTitles?: ReadonlyMap<string, string>,
): boolean {
  return message.kind === "delivery" || isFoldedDispatchMessage(room, message, ticketTitles)
}

/**
 * Pure read-only resolver building the canonical message -> ticketIds[] association map for a room.
 * Combines authoritative `room.messageLinks` overrides with legacy `ticketId`, split `dispatch` markers,
 * and assistant `sourceMessageId` Q&A inheritance. Never mutates room state or accent counters.
 */
export function resolveRoomMessageLinks(room: Pick<SuperRoom, "messages" | "tickets" | "messageLinks">): SuperMessageTicketLinks {
  const knownTicketIds = new Set(room.tickets.map(ticket => ticket.id))
  const ticketTitles = new Map(room.tickets.map(ticket => [ticket.id, ticket.title]))
  const explicitLinks = room.messageLinks
  const hasExplicit = (id: string) => !!explicitLinks && Object.prototype.hasOwnProperty.call(explicitLinks, id)

  const dispatchTicketsBySource = new Map<string, string[]>()
  for (const message of room.messages) {
    if (!isFoldedDispatchMessage(room, message, ticketTitles) || !message.sourceMessageId || !message.ticketId) continue
    if (!knownTicketIds.has(message.ticketId)) continue
    let list = dispatchTicketsBySource.get(message.sourceMessageId)
    if (!list) dispatchTicketsBySource.set(message.sourceMessageId, list = [])
    if (!list.includes(message.ticketId)) list.push(message.ticketId)
  }

  const userLinks = new Map<string, string[]>()
  for (const message of room.messages) {
    if (message.role !== "user") continue
    const ids = hasExplicit(message.id)
      ? dedupeTicketIds(explicitLinks![message.id], knownTicketIds)
      : dedupeTicketIds([...(dispatchTicketsBySource.get(message.id) ?? []), message.ticketId], knownTicketIds)
    userLinks.set(message.id, ids)
  }

  const result: SuperMessageTicketLinks = {}
  for (const message of room.messages) {
    let ids: string[]
    if (hasExplicit(message.id)) {
      ids = dedupeTicketIds(explicitLinks![message.id], knownTicketIds)
    } else if (message.role === "user") {
      ids = userLinks.get(message.id) ?? []
    } else if (message.role === "assistant") {
      if (message.ticketId) {
        ids = dedupeTicketIds([message.ticketId], knownTicketIds)
      } else if (message.sourceMessageId) {
        ids = userLinks.get(message.sourceMessageId) ?? []
      } else {
        ids = []
      }
    } else {
      ids = dedupeTicketIds([message.ticketId], knownTicketIds)
    }
    if (ids.length > 0 || hasExplicit(message.id)) {
      result[message.id] = ids
    }
  }
  return result
}

/**
 * Expand a discussion message ID to its paired Q&A round (`[userQuestion, ...directAssistantReplies]`).
 * Returns `[]` for worker reports, folded operations, or already-dispatched worker execution turns
 * so execution history is never misattributed onto a different newly created ticket.
 */
export function expandDiscussionRound(room: Pick<SuperRoom, "messages" | "tickets">, messageId: string): string[] {
  const target = room.messages.find(item => item.id === messageId)
  if (!target || target.role === "worker") return []
  const ticketTitles = new Map(room.tickets.map(ticket => [ticket.id, ticket.title]))
  if (isFoldedOperationMessage(room, target, ticketTitles)) return []

  if (target.role === "user") {
    if (target.state === "assigned" || target.state === "transferred") return []
    const replies = room.messages
      .filter(item =>
        item.role === "assistant"
        && item.sourceMessageId === target.id
        && !isFoldedOperationMessage(room, item, ticketTitles))
      .map(item => item.id)
    return [target.id, ...replies]
  }

  // target.role === "assistant"
  if (target.sourceMessageId) {
    const parent = room.messages.find(item => item.id === target.sourceMessageId && item.role === "user")
    if (parent) {
      if (parent.state === "assigned" || parent.state === "transferred") return []
      const replies = room.messages
        .filter(item =>
          item.role === "assistant"
          && item.sourceMessageId === parent.id
          && !isFoldedOperationMessage(room, item, ticketTitles))
        .map(item => item.id)
      return dedupeTicketIds([parent.id, ...replies])
    }
  }
  return [target.id]
}

/**
 * Expand a message ID to the editable group updated together by manual link edits or manual ticket creation.
 * - Discussion Q&As (user + direct SA assistant reply) update together so question & answer stay aligned.
 * - Standalone unattributed assistant events (e.g. follow-up reports) or worker reports update individually.
 */
export function expandEditableMessageGroup(room: Pick<SuperRoom, "messages" | "tickets">, messageId: string): string[] {
  const target = room.messages.find(item => item.id === messageId)
  if (!target) return []
  const ticketTitles = new Map(room.tickets.map(ticket => [ticket.id, ticket.title]))
  if (isFoldedOperationMessage(room, target, ticketTitles)) return []

  if (target.role === "worker") return [target.id]

  if (target.role === "user") {
    const directReplies = room.messages
      .filter(item =>
        item.role === "assistant"
        && item.sourceMessageId === target.id
        && !isFoldedOperationMessage(room, item, ticketTitles))
      .map(item => item.id)
    return dedupeTicketIds([target.id, ...directReplies])
  }

  // target.role === "assistant"
  if (target.sourceMessageId) {
    const parent = room.messages.find(item => item.id === target.sourceMessageId && item.role === "user")
    if (parent) {
      const directReplies = room.messages
        .filter(item =>
          item.role === "assistant"
          && item.sourceMessageId === parent.id
          && !isFoldedOperationMessage(room, item, ticketTitles))
        .map(item => item.id)
      return dedupeTicketIds([parent.id, ...directReplies])
    }
  }
  return [target.id]
}

const zhBackgroundReferencePattern =
  /(?:仅|只|作为|当作|当成)\s*(?:背景|参考)|(?:参考|借鉴|参照)[^，。！？!?\n]{0,28}(?:方案|讨论|设计|结论|思路|做法|结果|文档|历史)[^，。！？!?\n]{0,20}(?:[，,、]|\s)*(?:给|为|帮|替|写|新建|创建|做|整理|起草)/u

const enBackgroundReferencePattern =
  /\b(?:for\s+(?:background|reference)\s+only|as\s+(?:a\s+)?(?:background|reference)\b|refer(?:ring|encing)?\s+to\b.{0,40}\b(?:write|create|draft|build|make|for)\b|based\s+on\b.{0,40}\b(?:for\s+another|write\s+(?:an?\s+)?(?:faq|doc|guide|note))\b)/iu

/** Conservative fallback detector when coordinator omits `quoteRole` on a quoted `create` action. */
export function isBackgroundReferenceInstruction(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  return zhBackgroundReferencePattern.test(normalized) || enBackgroundReferencePattern.test(normalized)
}

/**
 * Determine which prior discussion Q&A message IDs should be retroactively linked to a newly created ticket.
 * - Explicit coordinator `sourceDiscussionMessageIds` are expanded to their Q&A rounds.
 * - Explicit `quoteRole === "background"` never transfers prior discussion ownership.
 * - Quoted discussion Q&As with `quoteRole === "source"` (or omitted `quoteRole` without background signals
 *   and without cross-ticket `referenceTicketId`) link that discussion's Q&A round, skipping interleaved turns.
 * - Unquoted requests without explicit `sourceDiscussionMessageIds` stay unlinked (allow manual correction).
 */
export function resolveCreateDiscussionLinks(
  room: Pick<SuperRoom, "messages" | "tickets">,
  source: StoredSuperMessage,
  action: Extract<SuperRouteAction, { kind: "create" }>,
): string[] {
  const collected: string[] = []
  const appendRound = (id: string) => {
    if (id === source.id) return
    for (const memberId of expandDiscussionRound(room, id)) {
      if (memberId !== source.id && !collected.includes(memberId)) collected.push(memberId)
    }
  }

  if (action.sourceDiscussionMessageIds !== undefined) {
    for (const id of action.sourceDiscussionMessageIds) appendRound(id)
    return collected
  }

  if (action.quoteRole === "background") return []

  if (source.replyTo && room.messages.some(item => item.id === source.replyTo)) {
    if (action.quoteRole === "source") {
      appendRound(source.replyTo)
      return collected
    }
    // Omitted quoteRole fallback: a cross-ticket referenceTicketId or explicit background phrasing does NOT transfer links.
    if (action.ticketId) return []
    if (isBackgroundReferenceInstruction(superTaskText(source))) return []
    appendRound(source.replyTo)
    return collected
  }

  return []
}

/** Add `ticketId` to each message's canonical association list without duplicating or moving messages. */
export function appendMessageTicketLinks(room: SuperRoom, messageIds: readonly string[], ticketId: string): void {
  if (!messageIds.length || !ticketId) return
  const resolved = resolveRoomMessageLinks(room)
  room.messageLinks ??= {}
  for (const messageId of messageIds) {
    const existing = resolved[messageId] ?? []
    const next = dedupeTicketIds([...existing, ticketId])
    room.messageLinks[messageId] = next
    resolved[messageId] = next
  }
}

/** Authoritatively set the canonical ticket IDs for each message in `messageIds` (empty clears links). */
export function setMessageTicketLinks(room: SuperRoom, messageIds: readonly string[], ticketIds: readonly string[]): void {
  if (!messageIds.length) return
  const normalized = dedupeTicketIds(ticketIds)
  room.messageLinks ??= {}
  for (const messageId of messageIds) {
    room.messageLinks[messageId] = [...normalized]
  }
}
