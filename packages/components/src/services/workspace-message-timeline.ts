import type { SuperMessage, SuperTicket } from "../../../../apps/daemon/src/super-agent-protocol.ts"

const legacyMissingWorker = "No configured worker provider is available for this ticket."

// Older machines sent "review" for an idle ticket after a completed turn.
export const hasTicketStatus = (status?: string) => !!status && status !== "review"

export function missingWorker(message: SuperMessage): boolean {
  return message.failureCode === "worker_unconfigured" || message.reason === legacyMissingWorker || message.text === legacyMissingWorker && message.role === "worker"
}

export function workerSummary(summary: string, unavailable: string): string {
  return summary === legacyMissingWorker ? unavailable : summary
}

interface Dispatch {
  ticket: SuperTicket
  marker: SuperMessage
  delivery?: SuperMessage
}

function sessionLinks(sessionId: string | undefined, jobs: Dispatch[]) {
  const links = new Map<string, string | undefined>()
  if (sessionId) links.set(sessionId, undefined)
  if (jobs.length > 1) {
    for (const { marker, delivery, ticket } of jobs) {
      const id = delivery?.sessionId ?? marker.sessionId ?? ticket.sessionId
      if (id) links.set(id, ticket.title)
    }
  }
  return [...links].map(([id, title]) => ({ id, title }))
}

/** The host retains dispatch records for auditing and quote IDs. The conversation shows their
 * controls on the originating request and transient progress in the agent reply. */
export function workspaceMessageRows(messages: SuperMessage[], tickets: Map<string, SuperTicket>, localStops?: Map<string, LocalWorkspaceStop>) {
  const byId = new Map(messages.map(message => [message.id, message]))
  const operations = new Set<string>()
  const dispatches = new Map<string, Map<string, Dispatch>>()
  const latestWorkerEvent = new Map<string, string>()
  for (const message of messages) {
    if (message.role === "worker" && message.sessionId && message.workerEvent) latestWorkerEvent.set(message.sessionId, message.id)
    const source = message.sourceMessageId && byId.get(message.sourceMessageId)
    const ticket = message.ticketId && tickets.get(message.ticketId)
    if (!source || source.role !== "user" || !ticket) continue
    // Older hosts recorded a routing reason only on the ticket-title notice, never on an answer.
    const dispatch = message.kind === "dispatch" || message.role === "assistant" && message.reason !== undefined && message.text === ticket.title
    const repeatedWorkerError = message.workerEvent === "error" && message.text === source.reason &&
      (source.state === "failed" || source.state === "uncertain")
    const delivery = message.kind === "delivery" || repeatedWorkerError || message.role === "worker" && !message.workerEvent && (
      missingWorker(message) || message.text === source.reason || ticket.status === "blocked" && message.text === ticket.summary ||
      message.text === "The worker journal confirmed the original delivery."
    )
    if (!dispatch && !delivery) continue
    operations.add(message.id)
    let group = dispatches.get(source.id)
    if (!group) dispatches.set(source.id, group = new Map())
    const item = group.get(ticket.id) ?? { ticket, marker: message }
    if (dispatch) item.marker = message
    if (delivery) item.delivery = message
    group.set(ticket.id, item)
  }
  const progress = replyProgress(messages, tickets, dispatches, operations, localStops)
  return messages.filter(message => !operations.has(message.id)).map(message => {
    const jobs = [...(dispatches.get(message.id)?.values() ?? [])]
    const onlyJob = jobs.length === 1 ? jobs[0] : undefined
    const source = message.sourceMessageId ? byId.get(message.sourceMessageId) : undefined
    const ticketId = message.ticketId ?? (message.role === "assistant" ? source?.ticketId : undefined)
    const ticket = ticketId ? tickets.get(ticketId) : onlyJob?.ticket
    const failed = message.state === "failed"
    const perTicketFailures = jobs.length > 1 && jobs.some(job => job.delivery)
    const workerMissing = failed && (missingWorker(message) || jobs.some(job => job.delivery && missingWorker(job.delivery)))
    // A coordinator can fail during a correction after a previous dispatch note was recorded.
    // Only a worker delivery failure supersedes the coordinator retry controls.
    const workerFailure = failed && (workerMissing || jobs.some(job => job.delivery && (!message.reason || job.delivery.text === message.reason)))
    const summary = ticket?.summary
    const detailSummary = summary && summary !== ticket?.scope && summary !== message.reason && !(workerMissing && summary === legacyMissingWorker) ? summary : undefined
    // DeskFleet forks the current session. A past turn or a coordinator reply is not a fork point.
    const fork = message.workerEvent === "result" && message.sessionId && message.turnId
      && latestWorkerEvent.get(message.sessionId) === message.id && !ticket?.archiveState && !hasTicketStatus(ticket?.status)
      ? { sessionId: message.sessionId, turnId: message.turnId } : undefined
    const sessions = sessionLinks(message.sessionId ?? onlyJob?.delivery?.sessionId ?? onlyJob?.marker.sessionId ?? ticket?.sessionId, jobs)
    return { message, fork, progress: progress.get(message.id), ticket, sessions, detailSummary, jobs, workerMissing, workerFailure, perTicketFailures }
  })
}

type WorkspaceRow = ReturnType<typeof workspaceMessageRows>[number]
interface TranscriptGroup {
  id: string
  approvals?: "recorded" | "handled"
  rows: WorkspaceRow[]
}

export function groupWorkspaceApprovals(rows: WorkspaceRow[]): TranscriptGroup[] {
  const following = new Map<string, { key: string; source?: string }>()
  const handled = new Set<string>()
  const receiptKeys = new Map<string, string>()
  // Early receipts omitted their turn and source IDs. Walking back from each
  // Worker's next result also groups old history without rewriting the journal.
  for (let index = rows.length - 1; index >= 0; index--) {
    const { message } = rows[index]!
    if (message.role !== "worker" || (message.workerEvent !== "permission" && message.workerEvent !== "result")) continue
    const scope = JSON.stringify([message.sessionId, message.ticketId, !message.sessionId && !message.ticketId ? message.id : undefined])
    const next = following.get(scope)
    const source = message.sourceMessageId
    const sameSource = !source || !next?.source || source === next.source
    let key: string
    if (message.turnId) key = JSON.stringify([scope, "turn", message.turnId])
    else if (message.workerEvent === "permission" && next && sameSource) key = next.key
    else key = JSON.stringify([scope, "message", source ?? message.id])
    following.set(scope, { key, source: source ?? (next?.key === key ? next.source : undefined) })
    if (message.workerEvent === "result") handled.add(key)
    else receiptKeys.set(message.id, key)
  }
  const groups: TranscriptGroup[] = []
  const approvals = new Map<string, TranscriptGroup>()
  for (const row of rows) {
    const { message } = row
    const key = receiptKeys.get(message.id)
    if (!key) { groups.push({ id: message.id, rows: [row] }); continue }
    let group = approvals.get(key)
    if (!group) {
      group = { id: message.id, approvals: handled.has(key) ? "handled" : "recorded", rows: [] }
      approvals.set(key, group)
      groups.push(group)
    }
    // A completed legacy turn has no recorded verdict in the chat text. Show
    // its original command without implying that the user still owes a decision.
    const command = group.approvals === "handled" && message.text.startsWith("Permission requested\n")
      ? message.text.slice("Permission requested\n".length).replace(/\nOpen the worker session to respond\.$/u, "") : undefined
    group.rows.push(command ? { ...row, message: { ...message, text: command } } : row)
  }
  return groups
}

interface ProgressStep {
  state: "routing" | "dispatching" | "queued" | "working" | "attention" | "waiting" | "stopping" | "stopped" | "unconfirmed"
  title?: string
  ticketId?: string
  canStop?: boolean
  sharedTurn?: boolean
  turnId?: string
}

export interface LocalWorkspaceStop { revision: number; ticketId?: string; state: "stopping" | "unconfirmed" }
export interface WorkspaceReplyProgress {
  sourceId: string
  revision: number
  steps: ProgressStep[]
}
export const stoppableSteps = (progress: WorkspaceReplyProgress) => progress.steps.filter(step => step.canStop && step.state !== "stopping" && step.state !== "stopped")

const scopedId = (scope: string, id: string) => JSON.stringify([scope, id])

function indexReplies(messages: SuperMessage[], operations: Set<string>) {
  const replies = new Map<string, string>()
  const completed = new Set<string>()
  const lastUnattributedResult = new Map<string, number>()
  const attention = new Map<string, SuperMessage>()
  const lastDispatch = new Map<string, number>()
  const position = new Map(messages.map((message, index) => [message.id, index]))
  const completedInputs = new Set<string>()
  const completedTurns = new Set<string>()
  for (const [index, message] of messages.entries()) {
    const { sourceMessageId, ticketId, sessionId } = message
    if (operations.has(message.id)) {
      if (ticketId && message.role === "assistant") lastDispatch.set(ticketId, index)
      continue
    }
    if (sourceMessageId && (message.role === "assistant" || message.role === "worker" && message.workerEvent !== "permission" && !replies.has(sourceMessageId))) {
      replies.set(sourceMessageId, message.id)
    }
    if (message.role !== "worker" || !ticketId) continue
    if (message.workerEvent === "permission" || message.workerEvent === "question") attention.set(ticketId, message)
    if (message.workerEvent && message.workerEvent !== "result") continue
    const prompt = attention.get(ticketId)
    if (prompt && ((sourceMessageId && prompt.sourceMessageId === sourceMessageId) || (message.turnId && prompt.turnId === message.turnId))) attention.delete(ticketId)
    if (!sourceMessageId) lastUnattributedResult.set(ticketId, index)
    if (sourceMessageId) completed.add(scopedId(ticketId, sourceMessageId))
    if (sessionId && message.inputId) completedInputs.add(scopedId(sessionId, message.inputId))
    if (sessionId && message.turnId) completedTurns.add(scopedId(sessionId, message.turnId))
  }
  return { replies, completed, completedInputs, completedTurns, lastUnattributedResult, lastDispatch, position, attention }
}

/** Ticket status is shared across turns. A result closes only its originating work;
 * a new turn on the same ticket must not reopen progress on historical replies. */
function replyProgress(messages: SuperMessage[], tickets: Map<string, SuperTicket>, dispatches: Map<string, Map<string, Dispatch>>, operations: Set<string>, localStops?: Map<string, LocalWorkspaceStop>) {
  const index = indexReplies(messages, operations)
  const result = new Map<string, WorkspaceReplyProgress>()
  const concurrent = new Map<string, { step: ProgressStep; ownsTurn: boolean }[]>()
  for (const source of messages) {
    if (source.role !== "user") continue
    const steps: ProgressStep[] = []
    if (source.state === "routing" || source.state === "stopped") steps.push({ state: source.state, canStop: source.state === "routing" })
    else {
      const jobs = dispatches.get(source.id)
      if (source.state !== "assigned") {
        if (!jobs || (source.state !== "failed" && source.state !== "uncertain")) continue
        const hasPendingStop = [...jobs.values()].some(job => job.marker.stopState || (source.state === "uncertain" && job.marker.canStop))
        if (jobs.size === 1 && !hasPendingStop) continue
      }
      // Older snapshots may have the ticket link without its dispatch record.
      const assigned = source.ticketId ? [source.ticketId] : [...(jobs?.keys() ?? [])]
      for (const id of assigned) {
        const ticket = tickets.get(id)
        const dispatch = jobs?.get(id)
        if (!ticket || ticket.archiveState || index.completed.has(scopedId(id, source.id))) continue
        const marker = dispatch?.marker
        const target = { ticketId: id, title: assigned.length > 1 ? ticket.title : undefined, canStop: marker?.canStop, sharedTurn: marker?.sharedTurn, turnId: marker?.turnId }
        if (marker?.stopState) {
          if (marker.stopState !== "finished") steps.push({ ...target, state: marker.stopState })
          continue
        }
        if (marker?.dispatching) {
          steps.push({ ...target, state: "dispatching" })
          continue
        }
        if (source.state === "uncertain" && marker?.canStop && dispatch?.delivery) {
          steps.push({ ...target, state: "waiting" })
          continue
        }
        if (ticket.status !== "queued" && ticket.status !== "working" && ticket.status !== "attention") continue
        if (source.state !== "assigned" && dispatch?.delivery) continue
        const turnId = dispatch?.marker.turnId ?? source.turnId
        const inputId = dispatch?.marker.inputId ?? source.inputId
        if (ticket.sessionId && ((inputId && index.completedInputs.has(scopedId(ticket.sessionId, inputId)))
          || (turnId && index.completedTurns.has(scopedId(ticket.sessionId, turnId))))) continue
        // An old, unattributed result carries no reliable owner. Avoid reviving
        // an unidentifiable request when a later dispatch starts on its ticket.
        const lastEnd = index.lastUnattributedResult.get(id)
        const start = index.position.get(dispatch?.marker.id ?? source.id)!
        if (!inputId && !turnId && lastEnd !== undefined && start < lastEnd && lastEnd < (index.lastDispatch.get(id) ?? -1)) continue
        const prompt = index.attention.get(id)
        const ownsTurn = !!prompt && (prompt.sourceMessageId === source.id
          || !!turnId && prompt.turnId === turnId || !!inputId && prompt.inputId === inputId)
        const step: ProgressStep = {
          state: ticket.status === "attention" && prompt && !ownsTurn ? "waiting" : ticket.status,
          ...target,
        }
        steps.push(step)
        const group = concurrent.get(id) ?? []
        group.push({ step, ownsTurn })
        concurrent.set(id, group)
      }
    }
    const revision = source.revision ?? 0
    const local = localStops?.get(source.id)
    if (local?.revision === revision) {
      for (const step of steps) if (step.canStop && step.state !== "stopped" && (!local.ticketId || step.ticketId === local.ticketId)) step.state = local.state
    }
    const anchor = source.state === "routing" || source.state === "stopped" ? source.id : index.replies.get(source.id) ?? source.id
    if (steps.length) result.set(anchor, { sourceId: source.id, revision, steps })
  }
  // A working ticket can already have another input in its backlog. Without
  // turn-specific evidence, acknowledge pending work without claiming it is running.
  for (const group of concurrent.values()) {
    if (group.length < 2) continue
    for (const { step, ownsTurn } of group) {
      if (!ownsTurn && (step.state === "working" || step.state === "attention")) step.state = "waiting"
    }
  }
  return result
}
