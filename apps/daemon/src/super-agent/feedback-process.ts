import { isSubagentNotification } from "@deskfleet/protocol/agent-session-scope"
import type { AgentEvent, AgentInput, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { DispatchIntent, SuperRoom } from "./state.ts"
import {
  boundFeedbackText,
  feedbackToolActivityId,
  feedbackWorkerActivityId,
  keepKnownToolTitle,
  SUPER_FEEDBACK_ACTIVITY_MAX_TEXT,
  type SuperFeedbackItem,
  type SuperFeedbackProcessBranch,
  type SuperFeedbackProcessResult,
} from "./feedback-helpers.ts"
import { extractAcpChunkMeta, safeToolLabel } from "./worker-projection.ts"
import type { SuperWorkers } from "./worker.ts"

const MAX_JOURNAL_SCAN_EVENTS = 20_000
const JOURNAL_SCAN_PAGE_SIZE = 200
const BRANCH_SEQ_STRIDE = 1_000_000_000

interface DecodedProcessCursor {
  mode: "offset" | "resume"
  branchIdx: number
  itemSkip: number
  journalSeq?: string
}

interface VerifiedProcessBranch {
  branch: SuperFeedbackProcessBranch
  sessionId: string
  turnId: string
  snapshot: AgentSnapshot
  minSeq?: bigint
  steerInputId?: string
  requireSteerBoundary?: boolean
  /** Pass the steer boundary only on the input event that recorded actual delivery to the Worker. */
  steerBoundaryDelivered?: boolean
  /** A delivered legacy record whose receipt event is missing keeps the accepted-input floor. */
  steerFallbackToFloor?: boolean
}

function validPositiveSeq(value?: string): string | undefined {
  return value && /^\d+$/u.test(value) && BigInt(value) > 0n ? value : undefined
}

function maxPositiveSeq(a?: string, b?: string): string | undefined {
  const va = validPositiveSeq(a)
  const vb = validPositiveSeq(b)
  if (va && vb) return BigInt(va) >= BigInt(vb) ? va : vb
  return va ?? vb
}

interface LeadingCommentarySkip {
  active: boolean
  messageId?: string
}

function decodeProcessCursor(afterSeq?: string): DecodedProcessCursor {
  if (!afterSeq) return { mode: "offset", branchIdx: 0, itemSkip: 0 }
  if (afterSeq.length === 22 && afterSeq.startsWith("1")) {
    const branchIdx = Number.parseInt(afterSeq.slice(1, 3), 10) || 0
    const itemSkip = Number.parseInt(afterSeq.slice(3, 7), 10) || 0
    const rawSeq = BigInt(afterSeq.slice(7, 22))
    return { mode: "resume", branchIdx, itemSkip, ...(rawSeq > 0n ? { journalSeq: rawSeq.toString() } : {}) }
  }
  return { mode: "offset", branchIdx: 0, itemSkip: Math.max(0, Number.parseInt(afterSeq, 10) || 0) }
}

function encodeResumeCursor(branchIdx: number, itemSkip: number, journalSeq: string): string {
  const b = String(Math.min(99, Math.max(0, branchIdx))).padStart(2, "0")
  const s = String(Math.min(9999, Math.max(0, itemSkip))).padStart(4, "0")
  const q = BigInt(journalSeq || "0").toString().padStart(15, "0").slice(-15)
  return `1${b}${s}${q}`
}

function eventTurnId(event: AgentEvent): string | undefined {
  if (event.turnId) return event.turnId
  if (event.kind === "turn" && "id" in event.payload && typeof event.payload.id === "string") return event.payload.id
  if (event.payload && typeof event.payload === "object" && "turnId" in event.payload && typeof event.payload.turnId === "string") {
    return event.payload.turnId
  }
  return undefined
}

function turnIdForInput(snapshot: AgentSnapshot, inputId: string | undefined): string | undefined {
  if (!inputId) return undefined
  const byTurn = snapshot.turns.find(turn => turn.initialInputId === inputId)
  if (byTurn) return byTurn.id
  return snapshot.inputs.find(input => input.id === inputId)?.turnId
}

/**
 * Resolve only branches whose ownership can be verified to a concrete turnId
 * (via branch.turnId, branch.inputId -> snapshot, or request intents -> snapshot).
 * Unbound placeholder branches never trigger a blind full-session scan.
 */
async function resolveVerifiedBranches(params: {
  room: SuperRoom
  sourceMessageId: string
  branches: readonly SuperFeedbackProcessBranch[]
  intents: readonly DispatchIntent[]
  workers: SuperWorkers
}): Promise<VerifiedProcessBranch[]> {
  const { room, sourceMessageId, branches, intents, workers } = params
  const snapshotCache = new Map<string, AgentSnapshot | null>()
  const readSnapshot = async (sessionId: string): Promise<AgentSnapshot | null> => {
    if (snapshotCache.has(sessionId)) return snapshotCache.get(sessionId)!
    try {
      const snap = await workers.journal.read(sessionId)
      snapshotCache.set(sessionId, snap)
      return snap
    } catch {
      snapshotCache.set(sessionId, null)
      return null
    }
  }

  const deduped = new Map<string, VerifiedProcessBranch>()
  const applySteerBoundary = (
    target: VerifiedProcessBranch,
    matchingIntents: readonly DispatchIntent[],
  ) => {
    const { branch, turnId, snapshot } = target
    const resolvedInputId = branch.inputId
      ?? matchingIntents.find(item => item.deliveredTurnId === turnId && item.inputId)?.inputId
      ?? matchingIntents.find(item => item.inputId && turnIdForInput(snapshot, item.inputId) === turnId)?.inputId
      ?? matchingIntents.find(item => item.inputId)?.inputId
    const inputRecord = resolvedInputId ? snapshot.inputs.find(inp => inp.id === resolvedInputId) : undefined
    const turnRecord = snapshot.turns.find(t => t.id === turnId)
    const isSteered = Boolean(
      (inputRecord && (inputRecord.actualDelivery === "steer" || (turnRecord && turnRecord.initialInputId !== inputRecord.id)))
      || matchingIntents.some(item => item.operation === "steer" && (!turnRecord || !item.inputId || turnRecord.initialInputId !== item.inputId)),
    )
    if (!isSteered) return
    const acceptedSeq = validPositiveSeq(inputRecord?.acceptedSeq)
    const steerFloor = maxPositiveSeq(branch.fromSeq, acceptedSeq)
    if (resolvedInputId) {
      branch.inputId ??= resolvedInputId
      target.steerInputId = resolvedInputId
    }
    if (steerFloor) {
      branch.fromSeq = steerFloor
      target.minSeq = BigInt(steerFloor)
    }
    // The host accepts a steer before the Worker receives it. Original-turn activity in between belongs
    // to the original request, so a real delivery receipt (the input event turning `delivered`) is the boundary.
    const deliveredBySteer = inputRecord?.state === "delivered" && inputRecord.actualDelivery === "steer"
    const awaitingDelivery = inputRecord?.state === "pending" || inputRecord?.state === "dispatching"
    if (target.steerInputId && inputRecord && (deliveredBySteer || awaitingDelivery)) {
      target.requireSteerBoundary = true
      target.steerBoundaryDelivered = true
      target.steerFallbackToFloor = deliveredBySteer && !!steerFloor
    } else {
      target.requireSteerBoundary = !steerFloor
      target.steerBoundaryDelivered = false
      target.steerFallbackToFloor = false
    }
  }

  const addVerified = (
    branch: SuperFeedbackProcessBranch,
    sessionId: string,
    turnId: string,
    snapshot: AgentSnapshot,
    matchingIntents: readonly DispatchIntent[],
  ) => {
    const key = `${sessionId}:${turnId}`
    const existing = deduped.get(key)
    if (!existing) {
      const created: VerifiedProcessBranch = { branch: { ...branch, sessionId, turnId }, sessionId, turnId, snapshot }
      applySteerBoundary(created, matchingIntents)
      deduped.set(key, created)
      return
    }
    const prior = existing.branch
    existing.branch = {
      ...prior,
      ...branch,
      sessionId,
      turnId,
      inputId: branch.inputId ?? prior.inputId,
      fromSeq: prior.fromSeq && branch.fromSeq
        ? (BigInt(prior.fromSeq) <= BigInt(branch.fromSeq) ? prior.fromSeq : branch.fromSeq)
        : (prior.fromSeq ?? branch.fromSeq),
      throughSeq: prior.throughSeq && branch.throughSeq
        ? (BigInt(prior.throughSeq) >= BigInt(branch.throughSeq) ? prior.throughSeq : branch.throughSeq)
        : (branch.throughSeq ?? prior.throughSeq),
      activityCount: Math.max(prior.activityCount, branch.activityCount),
      unboundedOutcome: branch.unboundedOutcome ?? prior.unboundedOutcome,
    }
    applySteerBoundary(existing, matchingIntents)
  }

  for (const branch of branches) {
    if (!branch.sessionId) continue
    const snapshot = await readSnapshot(branch.sessionId)
    if (!snapshot) continue
    const ticket = room.tickets.find(t => t.id === branch.ticketId)
    if (ticket?.executionWorkspaceId && snapshot.session.workspaceId !== ticket.executionWorkspaceId) continue

    const matchingIntents = intents.filter(item =>
      item.roomId === room.workspaceId
      && item.messageId === sourceMessageId
      && item.ticketId === branch.ticketId
      && item.sessionId === branch.sessionId
      && item.phase !== "withdrawn"
      && item.operation !== "stop")

    const directTurnId = branch.turnId ?? turnIdForInput(snapshot, branch.inputId)
    if (directTurnId) {
      addVerified(branch, branch.sessionId, directTurnId, snapshot, matchingIntents)
      continue
    }

    // Legacy/in-flight placeholder without turnId/inputId: resolve strictly via verified intents or formal messages for this exact request.
    const resolvedTurns = new Set<string>()
    for (const intent of matchingIntents) {
      const resolved = intent.deliveredTurnId ?? turnIdForInput(snapshot, intent.inputId)
      if (resolved) resolvedTurns.add(resolved)
    }
    if (!resolvedTurns.size) {
      for (const msg of room.messages) {
        if (msg.sourceMessageId === sourceMessageId && msg.ticketId === branch.ticketId && msg.sessionId === branch.sessionId && msg.turnId) {
          resolvedTurns.add(msg.turnId)
        }
      }
    }
    for (const turnId of resolvedTurns) {
      addVerified(branch, branch.sessionId, turnId, snapshot, matchingIntents)
    }
  }

  return [...deduped.values()]
}

async function peekPriorCommentarySegment(params: {
  workers: SuperWorkers
  sessionId: string
  atSeq: string
  turnId: string
  rootProviderSessionId?: string
}): Promise<LeadingCommentarySkip | undefined> {
  const { workers, sessionId, atSeq, turnId, rootProviderSessionId } = params
  let prevCursor: string
  try {
    const n = BigInt(atSeq)
    if (n <= 0n) return undefined
    prevCursor = String(n - 1n)
  } catch {
    return undefined
  }
  const peeked = await workers.journal.history(sessionId, prevCursor, 1)
  const event = peeked[0]
  if (!event || event.seq !== atSeq || eventTurnId(event) !== turnId) return undefined
  if (event.kind !== "acp" || !("update" in event.payload)) return undefined
  if (isSubagentNotification(event.payload) || (rootProviderSessionId && event.payload.sessionId !== rootProviderSessionId)) return undefined
  const update = event.payload.update
  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return undefined
  const meta = extractAcpChunkMeta(update)
  if (meta.phase === "commentary" || meta.purpose === "activity") {
    return { active: true, messageId: meta.messageId }
  }
  return undefined
}

/**
 * Reconstruct safe, bounded process activity items for a single request from
 * its verified bound Worker turn(s) on demand (supports restart recovery,
 * strict turn isolation, and pagination across both dense and >20,000-event logs).
 */
export async function reconstructRequestProcess(params: {
  room: SuperRoom
  sourceMessageId: string
  workers: SuperWorkers
  liveActivities: SuperFeedbackItem[]
  intents?: readonly DispatchIntent[]
  afterSeq?: string
  limit?: number
}): Promise<SuperFeedbackProcessResult> {
  const { room, sourceMessageId, workers, liveActivities, intents = [], afterSeq, limit = 80 } = params
  const source = room.messages.find(m => m.id === sourceMessageId && m.role === "user")
  const revision = source?.revision ?? 0
  const index = room.feedbackProcesses?.find(item => item.sourceMessageId === sourceMessageId && item.revision === revision)
  const cursorState = decodeProcessCursor(afterSeq)
  const verifiedBranches = await resolveVerifiedBranches({
    room,
    sourceMessageId,
    branches: index?.branches ?? [],
    intents,
    workers,
  })

  const items = new Map<string, SuperFeedbackItem>()
  const branchOrdinals = new Map<string, number>()
  let scannedTotal = 0
  let exhaustedAllBranches = true
  let resumeBranchIdx = verifiedBranches.length
  let resumeJournalSeq = "0"

  for (let bIdx = cursorState.branchIdx; bIdx < verifiedBranches.length; bIdx++) {
    const entry = verifiedBranches[bIdx]!
    const { branch, sessionId, turnId, snapshot } = entry
    const through = branch.throughSeq ? BigInt(branch.throughSeq) : undefined
    const isResumedBranch = cursorState.mode === "resume" && bIdx === cursorState.branchIdx && !!cursorState.journalSeq
    let cursor = isResumedBranch
      ? cursorState.journalSeq!
      : branch.fromSeq && BigInt(branch.fromSeq) > 0n
        ? String(BigInt(branch.fromSeq) - 1n)
        : "0"

    const skipLeading = isResumedBranch
      ? await peekPriorCommentarySegment({
        workers,
        sessionId,
        atSeq: cursor,
        turnId,
        rootProviderSessionId: snapshot.session.providerSessionId,
      })
      : undefined

    const branchEvents: AgentEvent[] = []
    let reachedBranchEnd = false
    let lastScannedSeq = cursor
    let passedSteerBoundary = !entry.requireSteerBoundary || isResumedBranch
    // Same-turn events after host acceptance but before the delivery receipt, held until the boundary is known.
    const heldBeforeBoundary: AgentEvent[] = []
    const releaseHeld = (all: boolean) => {
      for (const held of heldBeforeBoundary) {
        if (all || (entry.steerInputId && held.inputId === entry.steerInputId)) branchEvents.push(held)
      }
      heldBeforeBoundary.length = 0
    }

    while (scannedTotal < MAX_JOURNAL_SCAN_EVENTS) {
      const pageSize = Math.min(JOURNAL_SCAN_PAGE_SIZE, MAX_JOURNAL_SCAN_EVENTS - scannedTotal)
      const page = await workers.journal.history(sessionId, cursor, pageSize)
      if (!page.length) {
        reachedBranchEnd = true
        break
      }
      scannedTotal += page.length
      let hitThrough = false
      for (const event of page) {
        const eventSeq = BigInt(event.seq)
        if (through !== undefined && eventSeq > through) {
          hitThrough = true
          break
        }
        if (!passedSteerBoundary) {
          const input = event.kind === "input" ? event.payload as AgentInput : undefined
          if (input && input.id === entry.steerInputId && (!entry.steerBoundaryDelivered || input.state === "delivered")) {
            passedSteerBoundary = true
            // Only activity verifiably tagged with the appended input may precede its delivery receipt.
            releaseHeld(false)
          } else if (entry.steerBoundaryDelivered && (entry.minSeq === undefined || eventSeq >= entry.minSeq) && eventTurnId(event) === turnId) {
            heldBeforeBoundary.push(event)
          }
          continue
        }
        if (entry.minSeq !== undefined && eventSeq < entry.minSeq) continue
        if (eventTurnId(event) === turnId) branchEvents.push(event)
      }
      const lastSeq = page.at(-1)!.seq
      lastScannedSeq = lastSeq
      if (hitThrough || lastSeq === cursor || page.length < pageSize || (through !== undefined && BigInt(lastSeq) >= through)) {
        reachedBranchEnd = true
        break
      }
      cursor = lastSeq
    }
    if (!passedSteerBoundary) {
      // No receipt in this scan: a delivered legacy record keeps its accepted floor; an undelivered steer shows nothing yet.
      releaseHeld(reachedBranchEnd && entry.steerFallbackToFloor === true)
    }

    const projected = projectSafeJournalActivities(branchEvents, snapshot, {
      sourceMessageId,
      revision,
      ticketId: branch.ticketId,
      sessionId,
      turnId,
      inputId: branch.inputId,
      skipLeading,
    })
    if (isResumedBranch) {
      await restoreCrossWindowToolStarts({ workers, entry, items: projected, beforeSeq: cursorState.journalSeq! })
    }
    for (const item of projected) {
      if (!items.has(item.itemId)) {
        items.set(item.itemId, item)
        branchOrdinals.set(item.itemId, bIdx)
      }
    }

    if (!reachedBranchEnd) {
      exhaustedAllBranches = false
      resumeBranchIdx = bIdx
      resumeJournalSeq = lastScannedSeq
      break
    }
  }

  let maxSeq = 0
  for (const existing of items.values()) if (existing.seq > maxSeq) maxSeq = existing.seq
  let liveOrder = 0
  for (const live of liveActivities) {
    const existing = items.get(live.itemId)
    if (existing) {
      if (live.updatedAt >= existing.updatedAt) {
        const { updateOnly: _statusOnly, ...overlay } = structuredClone(live)
        items.set(live.itemId, { ...overlay, text: keepKnownToolTitle(existing, live), seq: existing.seq, createdAt: existing.createdAt })
      }
    } else if (exhaustedAllBranches && cursorState.mode === "offset") {
      items.set(live.itemId, { ...structuredClone(live), seq: maxSeq + (++liveOrder) })
    }
  }

  const ordered = [...items.values()].sort((a, b) =>
    a.sessionId && a.sessionId === b.sessionId
      ? (a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
      : (a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq))

  const useOrdinalSeq = exhaustedAllBranches && cursorState.mode === "offset"
  const pageSlice = ordered.slice(cursorState.itemSkip, cursorState.itemSkip + limit)
  const pageItems = pageSlice.map((item, idx) => ({
    ...item,
    seq: useOrdinalSeq
      ? cursorState.itemSkip + idx + 1
      : ((branchOrdinals.get(item.itemId) ?? 0) * BRANCH_SEQ_STRIDE) + item.seq,
  }))

  const nextItemSkip = cursorState.itemSkip + pageItems.length
  const hasMoreInWindow = nextItemSkip < ordered.length
  if (hasMoreInWindow) {
    const nextAfterSeq = cursorState.mode === "resume"
      ? encodeResumeCursor(cursorState.branchIdx, nextItemSkip, cursorState.journalSeq ?? "0")
      : String(nextItemSkip)
    return { sourceMessageId, revision, items: pageItems, hasMore: true, nextAfterSeq }
  }
  if (!exhaustedAllBranches) {
    return {
      sourceMessageId,
      revision,
      items: pageItems,
      hasMore: true,
      nextAfterSeq: encodeResumeCursor(resumeBranchIdx, 0, resumeJournalSeq),
    }
  }
  return { sourceMessageId, revision, items: pageItems, hasMore: false }
}

/**
 * A resumed page can carry only the completion of a tool whose start is on an earlier page. Look that start up
 * in the same branch (bounded scan) so the status-only item carries the tool's title and first position. Current
 * clients keep their loaded item anyway; clients that replace a loaded item wholesale (build 32 and earlier) then
 * still show the right name in the right place. The item keeps `updateOnly` so new clients merge status only.
 */
async function restoreCrossWindowToolStarts(params: {
  workers: SuperWorkers
  entry: VerifiedProcessBranch
  items: SuperFeedbackItem[]
  beforeSeq: string
}): Promise<void> {
  const { workers, entry, items, beforeSeq } = params
  const prefix = feedbackToolActivityId(entry.sessionId, entry.turnId, "")
  const pending = new Map<string, { item: SuperFeedbackItem; seq?: number; createdAt?: string; title?: string }>()
  for (const item of items) {
    if (item.updateOnly && item.activityKind === "tool" && item.itemId.startsWith(prefix)) pending.set(item.itemId.slice(prefix.length), { item })
  }
  if (!pending.size) return
  const end = BigInt(beforeSeq)
  const root = entry.snapshot.session.providerSessionId
  let cursor = entry.branch.fromSeq && BigInt(entry.branch.fromSeq) > 0n ? String(BigInt(entry.branch.fromSeq) - 1n) : "0"
  let scanned = 0
  let unresolved = pending.size
  scan: while (unresolved > 0 && scanned < MAX_JOURNAL_SCAN_EVENTS) {
    const page = await workers.journal.history(entry.sessionId, cursor, JOURNAL_SCAN_PAGE_SIZE)
    if (!page.length) break
    scanned += page.length
    for (const event of page) {
      const eventSeq = BigInt(event.seq)
      if (eventSeq > end) break scan
      if (entry.minSeq !== undefined && eventSeq < entry.minSeq) continue
      if (event.kind !== "acp" || !("update" in event.payload) || eventTurnId(event) !== entry.turnId) continue
      if (isSubagentNotification(event.payload) || (root && event.payload.sessionId !== root)) continue
      const update = event.payload.update
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue
      const raw = update as unknown as Record<string, unknown>
      const found = typeof raw.toolCallId === "string" ? pending.get(raw.toolCallId) : undefined
      if (!found || found.title) continue
      if (found.seq === undefined) {
        found.seq = Number(event.seq)
        found.createdAt = event.createdAt
      }
      const label = safeToolLabel(raw)
      if (label) {
        found.title = label
        unresolved -= 1
      }
    }
    if (page.at(-1)!.seq === cursor) break
    cursor = page.at(-1)!.seq
  }
  for (const found of pending.values()) {
    if (found.seq === undefined) continue
    found.item.seq = found.seq
    found.item.createdAt = found.createdAt ?? found.item.createdAt
    if (found.title) found.item.text = found.title
  }
}

function projectSafeJournalActivities(
  events: AgentEvent[],
  snapshot: AgentSnapshot,
  scope: {
    sourceMessageId: string
    revision: number
    ticketId: string
    sessionId: string
    turnId?: string
    inputId?: string
    skipLeading?: LeadingCommentarySkip
  },
): SuperFeedbackItem[] {
  const result = new Map<string, SuperFeedbackItem>()
  const rootProviderSessionId = snapshot.session.providerSessionId
  let localSegmentId: string | undefined
  let activeMessageId: string | undefined
  let seqCounter = 0
  const skipLeading = scope.skipLeading ? { ...scope.skipLeading } : undefined

  let lastNonFinalBoundary = -1
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    if (event.kind === "permission" || event.kind === "elicitation") { lastNonFinalBoundary = i; continue }
    if (event.kind !== "acp" || !("update" in event.payload)) continue
    if (isSubagentNotification(event.payload) || (rootProviderSessionId && event.payload.sessionId !== rootProviderSessionId)) continue
    const update = event.payload.update
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update" || update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
      lastNonFinalBoundary = i; continue
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const meta = extractAcpChunkMeta(update)
      if (meta.phase === "commentary" || meta.purpose === "activity" || meta.purpose === "milestone" || meta.phase === "partial_answer" || meta.purpose === "ack") {
        lastNonFinalBoundary = i
      }
    }
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!
    if (event.kind === "permission" || event.kind === "elicitation") {
      localSegmentId = undefined
      activeMessageId = undefined
      if (skipLeading) skipLeading.active = false
      continue
    }
    if (event.kind !== "acp" || !("update" in event.payload)) continue
    if (isSubagentNotification(event.payload) || (rootProviderSessionId && event.payload.sessionId !== rootProviderSessionId)) continue
    const update = event.payload.update
    const turnId = event.turnId ?? scope.turnId ?? "turn"
    const eventSeq = Number(event.seq) || ++seqCounter

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      localSegmentId = undefined
      activeMessageId = undefined
      if (skipLeading) skipLeading.active = false
      const raw = update as unknown as Record<string, unknown>
      const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : `seq-${event.seq}`
      const itemId = feedbackToolActivityId(scope.sessionId, turnId, toolCallId)
      const label = safeToolLabel(raw)
      const status = raw.status === "completed" ? "completed" : raw.status === "failed" ? "failed" : raw.status === "cancelled" ? "cancelled" : "in_progress"
      const prior = result.get(itemId)
      // A status-only update whose start lies in an earlier window must not invent a generic title;
      // the client merges its status into the item (title, first position) it already loaded.
      const explicitTitle = typeof raw.title === "string" && raw.title.trim().length > 0
      const updateOnly = !explicitTitle && (prior ? prior.updateOnly === true : update.sessionUpdate === "tool_call_update")
      result.set(itemId, {
        itemId, kind: "activity", sourceMessageId: scope.sourceMessageId, revision: scope.revision,
        ticketId: scope.ticketId, sessionId: scope.sessionId, turnId, ...(scope.inputId ? { inputId: scope.inputId } : {}),
        ...(updateOnly ? { updateOnly: true } : {}),
        text: updateOnly ? "" : label || prior?.text || "Running tool", activityKind: "tool", activityStatus: status,
        status: status === "in_progress" ? "streaming" : "completed",
        seq: prior?.seq ?? eventSeq, createdAt: prior?.createdAt ?? event.createdAt, updatedAt: event.createdAt,
      })
      continue
    }

    if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      localSegmentId = undefined
      activeMessageId = undefined
      if (skipLeading) skipLeading.active = false
      const summary = update.entries.map(entry => typeof entry?.content === "string" ? entry.content.trim() : "").filter(Boolean).slice(0, 5).join(" · ")
      if (summary) {
        const itemId = feedbackWorkerActivityId(scope.sessionId, turnId, "plan")
        const prior = result.get(itemId)
        result.set(itemId, {
          itemId, kind: "activity", sourceMessageId: scope.sourceMessageId, revision: scope.revision,
          ticketId: scope.ticketId, sessionId: scope.sessionId, turnId, ...(scope.inputId ? { inputId: scope.inputId } : {}),
          text: boundFeedbackText(summary, SUPER_FEEDBACK_ACTIVITY_MAX_TEXT).text, activityKind: "plan", status: "completed",
          seq: prior?.seq ?? eventSeq, createdAt: prior?.createdAt ?? event.createdAt, updatedAt: event.createdAt,
        })
      }
      continue
    }

    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      const meta = extractAcpChunkMeta(update)
      if (meta.purpose === "final_answer" || meta.phase === "final_answer" || meta.purpose === "milestone" || meta.phase === "partial_answer" || meta.purpose === "ack") {
        localSegmentId = undefined
        activeMessageId = undefined
        if (skipLeading) skipLeading.active = false
        continue
      }
      if (skipLeading?.active) {
        const explicitCommentary = meta.phase === "commentary" || meta.purpose === "activity"
        const sameStream = explicitCommentary && (skipLeading.messageId ? meta.messageId === skipLeading.messageId : !meta.messageId)
        if (sameStream) continue
        skipLeading.active = false
      }
      if (!(meta.phase === "commentary" || meta.purpose === "activity" || i < lastNonFinalBoundary)) continue
      const segmentId = meta.messageId ? `msg:${meta.messageId}` : activeMessageId === undefined && localSegmentId ? localSegmentId : (localSegmentId = `seg:${event.seq}`)
      activeMessageId = meta.messageId
      const itemId = feedbackWorkerActivityId(scope.sessionId, turnId, segmentId)
      const prior = result.get(itemId)
      const combined = boundFeedbackText((prior?.text ?? "") + update.content.text, SUPER_FEEDBACK_ACTIVITY_MAX_TEXT)
      result.set(itemId, {
        itemId, kind: "activity", sourceMessageId: scope.sourceMessageId, revision: scope.revision,
        ticketId: scope.ticketId, sessionId: scope.sessionId, turnId, ...(scope.inputId ? { inputId: scope.inputId } : {}),
        ...(meta.messageId ? { messageId: meta.messageId } : {}),
        text: combined.text, ...(combined.truncated ? { truncated: true } : {}),
        activityKind: "commentary", status: "completed",
        seq: prior?.seq ?? eventSeq, createdAt: prior?.createdAt ?? event.createdAt, updatedAt: event.createdAt,
      })
    }
  }
  return [...result.values()].sort((a, b) => a.seq - b.seq)
}
