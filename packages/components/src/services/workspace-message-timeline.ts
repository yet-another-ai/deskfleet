import { isConfirmedStoppedTurn, messageMatchesTicketFocus, resolveCanonicalMessageTicketIds, resolveSupersededStoppedTurns, type SuperCoordinatorPhase, type SuperMessage, type SuperMessageTicketLinks, type SuperTicket } from "@deskfleet/protocol/super-agent"
import type { WorkspaceRequestFeedback } from "./workspace-feedback.ts"

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
export function workspaceMessageRows(
  messages: SuperMessage[],
  tickets: Map<string, SuperTicket>,
  localStops?: Map<string, LocalWorkspaceStop>,
  feedbackMap?: Map<string, WorkspaceRequestFeedback>,
  messageTicketLinks?: Readonly<SuperMessageTicketLinks>,
) {
  const byId = new Map(messages.map(message => [message.id, message]))
  const knownTicketIds = new Set(tickets.keys())
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
    const ticketIds = resolveCanonicalMessageTicketIds({
      message,
      snapshotLinks: messageTicketLinks,
      sourceMessage: source,
      dispatchTicketIds: jobs.map(job => job.ticket.id),
      knownTicketIds,
    })
    const linkedTickets = ticketIds
      .map(id => tickets.get(id))
      .filter((item): item is SuperTicket => !!item)
    const ticket = linkedTickets.length === 1 ? linkedTickets[0] : undefined
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
    const feedback = message.role === "user" ? feedbackMap?.get(message.id) : undefined
    return { message, fork, progress: progress.get(message.id), feedback, ticket, ticketIds, linkedTickets, sessions, detailSummary, jobs, workerMissing, workerFailure, perTicketFailures }
  })
}

export type WorkspaceRow = ReturnType<typeof workspaceMessageRows>[number]

/** Filter rendered SA rows strictly by the canonical per-row ticket association list (never by color slot). */
export function filterWorkspaceRowsByTicket(rows: readonly WorkspaceRow[], focusedTicketId: string | undefined): WorkspaceRow[] {
  if (!focusedTicketId) return [...rows]
  return rows.filter(row => messageMatchesTicketFocus(row.ticketIds, focusedTicketId))
}

/** Narrow a multi-ticket request's live feedback items to the focused ticket without mutating underlying state. */
export function filterFeedbackForFocusedTicket(
  feedback: WorkspaceRequestFeedback | undefined,
  focusedTicketId: string | undefined,
): WorkspaceRequestFeedback | undefined {
  if (!feedback || !focusedTicketId) return feedback
  const ack = feedback.ack && (!feedback.ack.ticketId || feedback.ack.ticketId === focusedTicketId) ? feedback.ack : undefined
  const milestones = feedback.milestones.filter(item => !item.ticketId || item.ticketId === focusedTicketId)
  const finalPreviews = feedback.finalPreviews.filter(item => !item.ticketId || item.ticketId === focusedTicketId)
  const activities = feedback.activities.filter(item => !item.ticketId || item.ticketId === focusedTicketId)
  return { ...feedback, ack, milestones, finalPreviews, activities }
}

/** Narrow a multi-ticket request's progress steps to the focused ticket without mutating underlying state. */
export function filterProgressForFocusedTicket(
  progress: WorkspaceReplyProgress | undefined,
  focusedTicketId: string | undefined,
): WorkspaceReplyProgress | undefined {
  if (!progress || !focusedTicketId) return progress
  const steps = progress.steps.filter(step => !step.ticketId || step.ticketId === focusedTicketId)
  if (!steps.length) return undefined
  return { ...progress, steps }
}

export function previousUserMessageId(rows: readonly Pick<WorkspaceRow, "message">[], messageId: string): string | undefined {
  const index = rows.findIndex(row => row.message.id === messageId)
  if (index <= 0) return undefined
  for (let i = index - 1; i >= 0; i--) {
    const candidate = rows[i]!.message
    if (candidate.role === "user") return candidate.id
  }
  return undefined
}

export interface TranscriptGroup {
  id: string
  approvals?: "recorded" | "handled"
  rows: WorkspaceRow[]
}

export interface StoppedTurnMeta {
  sourceMessageId: string
  supersededById?: string
  actionAnchor: { kind: "progress" | "workerResult"; messageId: string }
}

export type TranscriptEntry =
  | { kind: "group"; id: string; group: TranscriptGroup }
  | {
      kind: "foldedStoppedTurn"
      id: string
      reason: "superseded" | "manual"
      revisedById?: string
      rows: WorkspaceRow[]
      groups: TranscriptGroup[]
    }

export type WorkspaceLocateTarget =
  | { kind: "message"; id: string; approvalGroupId?: string; foldedTurnId?: string; foldedTurnReason?: "superseded" | "manual" }
  | { kind: "feedback"; id: string; feedbackKind: "ack" | "milestone"; foldedTurnId?: string; foldedTurnReason?: "superseded" | "manual" }

/**
 * Identify confirmed-stopped user turns, their explicit re-edit superseding message (if any),
 * and the single canonical UI anchor where "已停止" is rendered for each stopped turn.
 */
export function resolveWorkspaceStoppedTurns(
  messages: readonly SuperMessage[],
  rows: readonly WorkspaceRow[],
  tickets: ReadonlyMap<string, SuperTicket>,
  localStops?: ReadonlyMap<string, LocalWorkspaceStop>,
): Map<string, StoppedTurnMeta> {
  const superseded = resolveSupersededStoppedTurns(messages, tickets)
  const progressRowBySource = new Map<string, WorkspaceRow>()
  const stoppedWorkerResultBySource = new Map<string, string>()
  for (const row of rows) {
    if (row.progress) progressRowBySource.set(row.progress.sourceId, row)
    if (
      row.message.role === "worker"
      && row.message.workerEvent === "result"
      && row.message.stopState === "stopped"
      && row.message.sourceMessageId
    ) {
      stoppedWorkerResultBySource.set(row.message.sourceMessageId, row.message.id)
    }
  }
  const result = new Map<string, StoppedTurnMeta>()
  for (const row of rows) {
    if (row.message.role !== "user") continue
    const local = localStops?.get(row.message.id)
    const hasPendingLocalStop = !!local && local.revision === (row.message.revision ?? 0)
    if (!isConfirmedStoppedTurn(messages, tickets, row.message.id, { hasPendingLocalStop })) continue
    const progressRow = progressRowBySource.get(row.message.id)
    const hasStoppedProgress = !!progressRow?.progress?.steps.length && progressRow.progress.steps.every(step => step.state === "stopped")
    const workerResultId = stoppedWorkerResultBySource.get(row.message.id)
    const actionAnchor = hasStoppedProgress
      ? { kind: "progress" as const, messageId: progressRow.message.id }
      : workerResultId
        ? { kind: "workerResult" as const, messageId: workerResultId }
        : undefined
    if (!actionAnchor) continue
    result.set(row.message.id, {
      sourceMessageId: row.message.id,
      ...(superseded.has(row.message.id) ? { supersededById: superseded.get(row.message.id) } : {}),
      actionAnchor,
    })
  }
  return result
}

function rowTurnId(row: WorkspaceRow): string | undefined {
  if (row.message.role === "user") return row.message.id
  return row.message.sourceMessageId
}

/**
 * Fold superseded or manually-collapsed stopped turns strictly by real `sourceMessageId`
 * association, preserving interleaved unrelated turns in place without swallowing them.
 */
export function buildWorkspaceTranscript(
  displayedRows: readonly WorkspaceRow[],
  stoppedTurns: ReadonlyMap<string, StoppedTurnMeta>,
  manuallyFoldedIds: ReadonlySet<string>,
): TranscriptEntry[] {
  const foldedMeta = new Map<string, { reason: "superseded" | "manual"; revisedById?: string }>()
  for (const [turnId, meta] of stoppedTurns) {
    if (meta.supersededById) {
      foldedMeta.set(turnId, { reason: "superseded", revisedById: meta.supersededById })
    } else if (manuallyFoldedIds.has(turnId)) {
      foldedMeta.set(turnId, { reason: "manual" })
    }
  }

  const foldedRowsByTurn = new Map<string, WorkspaceRow[]>()
  const unfoldedRows: WorkspaceRow[] = []
  for (const row of displayedRows) {
    const turnId = rowTurnId(row)
    if (turnId && foldedMeta.has(turnId)) {
      let bucket = foldedRowsByTurn.get(turnId)
      if (!bucket) foldedRowsByTurn.set(turnId, bucket = [])
      bucket.push(row)
    } else {
      unfoldedRows.push(row)
    }
  }

  const unfoldedGroups = groupWorkspaceApprovals(unfoldedRows)
  const groupByMessageId = new Map<string, TranscriptGroup>()
  for (const group of unfoldedGroups) {
    for (const row of group.rows) groupByMessageId.set(row.message.id, group)
  }

  const entries: TranscriptEntry[] = []
  const emittedFolded = new Set<string>()
  const emittedGroups = new Set<string>()
  for (const row of displayedRows) {
    const turnId = rowTurnId(row)
    if (turnId && foldedMeta.has(turnId)) {
      if (emittedFolded.has(turnId)) continue
      emittedFolded.add(turnId)
      const meta = foldedMeta.get(turnId)!
      const turnRows = foldedRowsByTurn.get(turnId) ?? []
      entries.push({
        kind: "foldedStoppedTurn",
        id: turnId,
        reason: meta.reason,
        ...(meta.revisedById ? { revisedById: meta.revisedById } : {}),
        rows: turnRows,
        groups: groupWorkspaceApprovals(turnRows),
      })
      continue
    }
    const group = groupByMessageId.get(row.message.id)
    if (!group || emittedGroups.has(group.id)) continue
    emittedGroups.add(group.id)
    entries.push({ kind: "group", id: group.id, group })
  }
  return entries
}

function indexGroupLocateTargets(
  groups: readonly TranscriptGroup[],
  targets: Map<string, WorkspaceLocateTarget>,
  folded?: { id: string; reason: "superseded" | "manual" },
): void {
  const extra = folded ? { foldedTurnId: folded.id, foldedTurnReason: folded.reason } : {}
  for (const group of groups) {
    const approvalGroupId = group.approvals ? group.id : undefined
    for (const row of group.rows) {
      targets.set(row.message.id, { kind: "message", id: row.message.id, approvalGroupId, ...extra })
    }
  }
  for (const group of groups) {
    const approvalGroupId = group.approvals ? group.id : undefined
    for (const row of group.rows) {
      for (const job of row.jobs) {
        if (!targets.has(job.marker.id)) {
          targets.set(job.marker.id, { kind: "message", id: row.message.id, approvalGroupId, ...extra })
        }
        if (job.delivery && !targets.has(job.delivery.id)) {
          targets.set(job.delivery.id, { kind: "message", id: row.message.id, approvalGroupId, ...extra })
        }
      }
      if (row.message.role === "user" && row.feedback) {
        if (row.feedback.ack && !targets.has(row.feedback.ack.itemId)) {
          targets.set(row.feedback.ack.itemId, { kind: "feedback", id: row.feedback.ack.itemId, feedbackKind: "ack", ...extra })
        }
        for (const milestone of row.feedback.milestones) {
          if (!targets.has(milestone.itemId)) {
            targets.set(milestone.itemId, { kind: "feedback", id: milestone.itemId, feedbackKind: "milestone", ...extra })
          }
        }
      }
    }
  }
}

/** Map rendered message, folded dispatch marker, and feedback IDs to exact DOM locate targets. */
export function indexWorkspaceLocateTargets(groups: readonly TranscriptGroup[]): Map<string, WorkspaceLocateTarget> {
  const targets = new Map<string, WorkspaceLocateTarget>()
  indexGroupLocateTargets(groups, targets)
  return targets
}

/** Map all rendered transcript entries (including folded stopped turns) to exact DOM locate targets. */
export function indexWorkspaceTranscriptLocateTargets(entries: readonly TranscriptEntry[]): Map<string, WorkspaceLocateTarget> {
  const targets = new Map<string, WorkspaceLocateTarget>()
  for (const entry of entries) {
    if (entry.kind === "group") {
      indexGroupLocateTargets([entry.group], targets)
    } else {
      indexGroupLocateTargets(entry.groups, targets, { id: entry.id, reason: entry.reason })
    }
  }
  return targets
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
  state: SuperCoordinatorPhase | "dispatching" | "queued" | "working" | "attention" | "waiting" | "stopping" | "stopped" | "unconfirmed"
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
    if (source.state === "routing" || source.state === "stopped") {
      const canStop = source.state === "routing"
      steps.push({ state: canStop ? source.coordinatorPhase ?? "processing" : "stopped", canStop })
    } else {
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
