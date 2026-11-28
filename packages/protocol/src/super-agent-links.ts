import type { SuperMessage, SuperWorkspaceId } from "./super-agent.ts"

/**
 * Canonical message-to-ticket association map shared by both message coloring and ticket focus filtering.
 * Presence of a messageId key (including an empty array `[]`) is authoritative for that message.
 */
export type SuperMessageTicketLinks = Record<string, string[]>

export interface SuperLinkMessageParams {
  workspaceId: SuperWorkspaceId
  messageId: string
  ticketIds: string[]
}

export interface SuperCreateTicketParams {
  workspaceId: SuperWorkspaceId
  messageId: string
  title: string
  scope?: string
}

/** Deduplicate ticket IDs in original order and optionally filter to known room tickets. */
export function dedupeTicketIds(
  ids: readonly (string | undefined)[] | undefined,
  knownTicketIds?: ReadonlySet<string>,
): string[] {
  if (!ids?.length) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of ids) {
    if (typeof raw !== "string" || !raw) continue
    if (knownTicketIds && !knownTicketIds.has(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    result.push(raw)
  }
  return result
}

export type CanonicalLinkMessage = Pick<SuperMessage, "id" | "role" | "ticketId" | "ticketIds" | "sourceMessageId">

/**
 * Single canonical resolver for a message's associated ticket IDs.
 * Both SA message coloring and SA ticket focus filtering MUST read through this function
 * so a message can never be colored for ticket A while disappearing when focusing A.
 */
export function resolveCanonicalMessageTicketIds(params: {
  message: CanonicalLinkMessage
  snapshotLinks?: Readonly<Record<string, readonly string[]>>
  sourceMessage?: CanonicalLinkMessage
  dispatchTicketIds?: readonly string[]
  knownTicketIds?: ReadonlySet<string>
}): string[] {
  const { message, snapshotLinks, sourceMessage, dispatchTicketIds, knownTicketIds } = params
  if (snapshotLinks && Object.prototype.hasOwnProperty.call(snapshotLinks, message.id)) {
    return dedupeTicketIds(snapshotLinks[message.id], knownTicketIds)
  }
  if (Array.isArray(message.ticketIds)) {
    return dedupeTicketIds(message.ticketIds, knownTicketIds)
  }
  const fallback: (string | undefined)[] = []
  if (dispatchTicketIds?.length) fallback.push(...dispatchTicketIds)
  if (message.ticketId) fallback.push(message.ticketId)
  if (!fallback.length && message.role === "assistant" && sourceMessage) {
    fallback.push(
      ...resolveCanonicalMessageTicketIds({
        message: sourceMessage,
        snapshotLinks,
        knownTicketIds,
      }),
    )
  }
  return dedupeTicketIds(fallback, knownTicketIds)
}

/** Determine whether a message's canonical ticket association list matches a focused ticket view. */
export function messageMatchesTicketFocus(
  ticketIds: readonly string[],
  focusedTicketId: string | undefined,
): boolean {
  if (!focusedTicketId) return true
  return ticketIds.includes(focusedTicketId)
}

function linkObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}

function linkIdentifier(value: unknown, label = "resource ID"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f]/u.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

export function parseSuperLinkMessage(value: unknown): SuperLinkMessageParams {
  const obj = linkObject(value)
  const workspaceId = obj.workspaceId === null ? null : linkIdentifier(obj.workspaceId, "workspace ID")
  const messageId = linkIdentifier(obj.messageId, "message ID")
  if (!Array.isArray(obj.ticketIds) || obj.ticketIds.length > 32) {
    throw new Error("Invalid ticket ID list")
  }
  const ticketIds = dedupeTicketIds(obj.ticketIds.map(id => linkIdentifier(id, "ticket ID")))
  return { workspaceId, messageId, ticketIds }
}

export function parseSuperCreateTicket(value: unknown): SuperCreateTicketParams {
  const obj = linkObject(value)
  const workspaceId = obj.workspaceId === null ? null : linkIdentifier(obj.workspaceId, "workspace ID")
  const messageId = linkIdentifier(obj.messageId, "message ID")
  if (typeof obj.title !== "string" || !obj.title.trim() || obj.title.length > 200) {
    throw new Error("A ticket title of at most 200 characters is required")
  }
  let scope: string | undefined
  if (obj.scope !== undefined) {
    if (typeof obj.scope !== "string" || obj.scope.length > 6000) {
      throw new Error("Ticket scope must be at most 6,000 characters")
    }
    const trimmed = obj.scope.trim()
    if (trimmed) scope = trimmed
  }
  return {
    workspaceId,
    messageId,
    title: obj.title.trim(),
    ...(scope ? { scope } : {}),
  }
}
