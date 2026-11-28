import type { AgentSessionRecord } from "@deskfleet/protocol/agent"
import {
  createEmptyAccentSlotCounts,
  isValidAccentSlot,
  recordRecentAccentSlotValue,
  SA_ACCENT_RECENT_LIMIT,
  SA_ACCENT_SLOT_COUNT,
  selectTicketAccentSlot,
} from "@deskfleet/protocol/super-agent"
import { ticketLifecycle } from "./archive.ts"
import type { StoredSuperTicket, SuperRoom } from "./state.ts"

type WorkerLifecycle = Pick<AgentSessionRecord, "archiveState" | "context" | "lifecycle">

function isArchivedTicket(ticket: StoredSuperTicket, workers?: ReadonlyMap<string, WorkerLifecycle>): boolean {
  return Boolean(workers ? ticketLifecycle(ticket, workers).archiveState : ticket.archiveState)
}

function hasValidCounts(counts: unknown): counts is number[] {
  return Array.isArray(counts) && counts.length === SA_ACCENT_SLOT_COUNT
}

/**
 * Initialize workspace-local 48-slot occupancy counts and recent-7 ring buffer on a room
 * without modifying any existing ticket's `accentSlot` or scanning message history.
 */
export function ensureRoomAccentState(room: SuperRoom, workers?: ReadonlyMap<string, WorkerLifecycle>): number[] {
  room.recentAccentSlots ??= []
  if (!hasValidCounts(room.accentSlotCounts)) {
    const counts = createEmptyAccentSlotCounts()
    for (const ticket of room.tickets) {
      if (!isValidAccentSlot(ticket.accentSlot)) continue
      if (isArchivedTicket(ticket, workers)) {
        ticket.accentCounted = false
      } else {
        counts[ticket.accentSlot] = (counts[ticket.accentSlot] ?? 0) + 1
        ticket.accentCounted = true
      }
    }
    room.accentSlotCounts = counts
    return counts
  }
  if (workers) syncRoomAccentOccupancy(room, workers)
  return room.accentSlotCounts
}

/** Reconcile bound/unbound ticket archive states against the room's 48 occupancy counts idempotently. */
export function syncRoomAccentOccupancy(room: SuperRoom, workers?: ReadonlyMap<string, WorkerLifecycle>): boolean {
  if (!hasValidCounts(room.accentSlotCounts)) {
    ensureRoomAccentState(room, workers)
    return true
  }
  const counts = room.accentSlotCounts
  let changed = false
  for (const ticket of room.tickets) {
    if (!isValidAccentSlot(ticket.accentSlot)) continue
    const archived = isArchivedTicket(ticket, workers)
    const counted = ticket.accentCounted !== false
    if (archived && counted) {
      counts[ticket.accentSlot] = Math.max(0, (counts[ticket.accentSlot] ?? 0) - 1)
      ticket.accentCounted = false
      changed = true
    } else if (!archived && !counted) {
      counts[ticket.accentSlot] = (counts[ticket.accentSlot] ?? 0) + 1
      ticket.accentCounted = true
      changed = true
    }
  }
  return changed
}

/** Return true when any stored ticket in the room is missing a valid permanent `accentSlot`. */
export function roomNeedsTicketAccentBackfill(room: Pick<SuperRoom, "tickets">): boolean {
  return room.tickets.some(ticket => !isValidAccentSlot(ticket.accentSlot))
}

/**
 * Deterministically backfill missing `accentSlot`s on legacy tickets in stored order using the exact
 * 48-color rule, without altering any ticket that already has a valid `accentSlot` and without
 * scanning message history. Updates workspace active occupancy counts (excluding archived tickets).
 */
export function backfillRoomTicketAccents(room: SuperRoom, workers?: ReadonlyMap<string, WorkerLifecycle>): boolean {
  if (!roomNeedsTicketAccentBackfill(room)) return false
  const counts = ensureRoomAccentState(room, workers)
  const existingRecent = (room.recentAccentSlots ?? []).filter(isValidAccentSlot).slice(0, SA_ACCENT_RECENT_LIMIT)
  let selectionRecent = [...existingRecent]
  const backfilledSlots: number[] = []

  for (const ticket of room.tickets) {
    if (isValidAccentSlot(ticket.accentSlot)) continue
    const slot = selectTicketAccentSlot(ticket.id, counts, selectionRecent)
    ticket.accentSlot = slot
    if (!isArchivedTicket(ticket, workers)) {
      counts[slot] = (counts[slot] ?? 0) + 1
      ticket.accentCounted = true
    } else {
      ticket.accentCounted = false
    }
    selectionRecent = recordRecentAccentSlotValue(selectionRecent, slot)
    backfilledSlots.push(slot)
  }

  // Keep any existing recent-7 MRU slots from real messages first, then fill remaining capacity with backfilled slots.
  const mergedRecent: number[] = []
  for (const slot of existingRecent) {
    if (!mergedRecent.includes(slot) && mergedRecent.length < SA_ACCENT_RECENT_LIMIT) mergedRecent.push(slot)
  }
  for (let i = backfilledSlots.length - 1; i >= 0 && mergedRecent.length < SA_ACCENT_RECENT_LIMIT; i--) {
    const slot = backfilledSlots[i]!
    if (!mergedRecent.includes(slot)) mergedRecent.push(slot)
  }
  room.recentAccentSlots = mergedRecent
  return backfilledSlots.length > 0
}

/**
 * Atomically assign a permanent `accentSlot` on first creation and increment workspace active occupancy.
 * Backfills any uncolored legacy siblings first so new tickets avoid colliding with them.
 * Never reassigns a ticket that already has a valid `accentSlot`, and never scans message history.
 */
export function allocateTicketAccent(
  room: SuperRoom,
  ticket: StoredSuperTicket,
  workers?: ReadonlyMap<string, WorkerLifecycle>,
): number {
  backfillRoomTicketAccents(room, workers)
  const counts = ensureRoomAccentState(room, workers)
  if (isValidAccentSlot(ticket.accentSlot)) {
    if (!isArchivedTicket(ticket, workers) && ticket.accentCounted !== true) {
      counts[ticket.accentSlot] = (counts[ticket.accentSlot] ?? 0) + 1
      ticket.accentCounted = true
    }
    return ticket.accentSlot
  }
  const slot = selectTicketAccentSlot(ticket.id, counts, room.recentAccentSlots ?? [])
  ticket.accentSlot = slot
  if (!isArchivedTicket(ticket, workers)) {
    counts[slot] = (counts[slot] ?? 0) + 1
    ticket.accentCounted = true
  } else {
    ticket.accentCounted = false
  }
  return slot
}

/** Release active occupancy when archiving a ticket; never modifies `ticket.accentSlot`. */
export function releaseTicketAccentOccupancy(room: SuperRoom, ticket: StoredSuperTicket): boolean {
  if (!isValidAccentSlot(ticket.accentSlot)) return false
  if (!hasValidCounts(room.accentSlotCounts)) ensureRoomAccentState(room)
  if (ticket.accentCounted === false) return false
  const slot = ticket.accentSlot
  room.accentSlotCounts![slot] = Math.max(0, (room.accentSlotCounts![slot] ?? 0) - 1)
  ticket.accentCounted = false
  return true
}

/** Re-add occupancy for a restored ticket's original `accentSlot`; never calls color selection. */
export function restoreTicketAccentOccupancy(room: SuperRoom, ticket: StoredSuperTicket): boolean {
  if (!isValidAccentSlot(ticket.accentSlot)) return false
  if (!hasValidCounts(room.accentSlotCounts)) ensureRoomAccentState(room)
  if (ticket.accentCounted === true) return false
  const slot = ticket.accentSlot
  room.accentSlotCounts![slot] = (room.accentSlotCounts![slot] ?? 0) + 1
  ticket.accentCounted = true
  return true
}

/** Incrementally update the room's recent-7 distinct ticket colors when a new message arrives. */
export function recordRoomRecentTicketAccent(room: SuperRoom, ticketId: string | undefined): void {
  if (!ticketId) return
  const ticket = room.tickets.find(item => item.id === ticketId)
  if (!ticket || !isValidAccentSlot(ticket.accentSlot)) return
  room.recentAccentSlots = recordRecentAccentSlotValue(room.recentAccentSlots ?? [], ticket.accentSlot)
}

/** Read-only snapshot of the room's 48 active slot occupancy counts (never mutates legacy rooms). */
export function roomActiveAccentSlotCounts(room: SuperRoom, workers?: ReadonlyMap<string, WorkerLifecycle>): number[] {
  if (hasValidCounts(room.accentSlotCounts) && !workers) return [...room.accentSlotCounts]
  const counts = createEmptyAccentSlotCounts()
  for (const ticket of room.tickets) {
    if (!isValidAccentSlot(ticket.accentSlot)) continue
    if (!isArchivedTicket(ticket, workers)) {
      counts[ticket.accentSlot] = (counts[ticket.accentSlot] ?? 0) + 1
    }
  }
  return counts
}
