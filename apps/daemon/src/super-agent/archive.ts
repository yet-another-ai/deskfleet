import type { AgentSessionRecord } from "@deskfleet/protocol/agent"
import { withdrawDispatch } from "./stop.ts"
import type { StoredSuperTicket, SuperRoom, SuperUserState } from "./state.ts"

type WorkerLifecycle = Pick<AgentSessionRecord, "archiveState" | "context" | "lifecycle">

/** The Worker journal owns bound tickets' archive state, including changes made in the original Session UI. */
export function ticketLifecycle(ticket: StoredSuperTicket, workers: ReadonlyMap<string, WorkerLifecycle>) {
  if (!ticket.sessionId) return { archiveState: ticket.archiveState }
  const worker = workers.get(ticket.sessionId)
  if (!worker || worker.lifecycle === "deleting") return { archiveState: "archived" as const }
  return { archiveState: worker.archiveState === "active" ? undefined : worker.archiveState, workerContext: worker.context }
}

export function roomWithArchives(room: SuperRoom, workers: ReadonlyMap<string, WorkerLifecycle>): SuperRoom {
  const tickets = room.tickets.map(ticket => ({ ...ticket, ...ticketLifecycle(ticket, workers) }))
  const inactive = new Set(tickets.filter(ticket => ticket.archiveState).map(ticket => ticket.id))
  return { ...room, tickets,
    focusTicketId: room.focusTicketId && !inactive.has(room.focusTicketId) ? room.focusTicketId : undefined,
    pendingQuestion: room.pendingQuestion && !inactive.has(room.pendingQuestion.ticketId) ? room.pendingQuestion : undefined,
    recentTicketIds: room.recentTicketIds.filter(id => !inactive.has(id)),
  }
}

/** Archive closes delivery. Any submit already accepted by the Worker can still report its receipt. */
export function leaveArchivedTicket(state: SuperUserState, room: SuperRoom, id: string) {
  if (room.focusTicketId === id) delete room.focusTicketId
  if (room.pendingQuestion?.ticketId === id) delete room.pendingQuestion
  room.recentTicketIds = room.recentTicketIds.filter(recent => recent !== id)
  for (const intent of state.intents) {
    if (intent.roomId !== room.workspaceId || intent.ticketId !== id || intent.stop) continue
    if (intent.phase === "planned" || intent.phase === "working" && intent.sessionId) withdrawDispatch(state, room, intent)
  }
}
