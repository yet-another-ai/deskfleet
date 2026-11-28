import { isSubagentNotification } from "@deskfleet/protocol/agent-session-scope"
import type { AgentEvent, AgentEventDraft, AgentPreview, AgentSnapshot, AgentTurn } from "@deskfleet/protocol/agent"
import {
  boundFeedbackText,
  feedbackAckId,
  feedbackDedupeHash,
  feedbackFinalLogicalId,
  feedbackMilestoneId,
  feedbackToolActivityId,
  feedbackWorkerActivityId,
  SUPER_FEEDBACK_ACK_MAX_TEXT,
  SUPER_FEEDBACK_ACTIVITY_MAX_TEXT,
  SUPER_FEEDBACK_MAX_TEXT,
  type SuperFeedbackItem,
  type SuperFeedbackProcessBranch,
} from "./feedback-helpers.ts"

export type WorkerMessagePhase = "commentary" | "partial_answer" | "final_answer"
export type WorkerMessagePurpose = "ack" | "activity" | "milestone" | "final_answer"

export interface WorkerAcpChunkMeta {
  messageId?: string
  phase?: WorkerMessagePhase
  purpose?: WorkerMessagePurpose
  submissionId?: string
}

export interface WorkerSegmentRecord {
  id: string
  messageId?: string
  phase?: WorkerMessagePhase
  purpose?: WorkerMessagePurpose
  submissionId?: string
  text: string
  truncated?: boolean
  startSeq: string
  lastSeq: string
  createdAt: string
  updatedAt: string
  /** True when a boundary event (tool/permission/elicitation/plan/new messageId) appeared after this segment. */
  closed?: boolean
  /** True only when closed by an execution boundary (tool/plan/permission/elicitation), not merely a peer untagged messageId. */
  closedByBoundary?: boolean
  /** True once a milestone/ack segment has been durably published (streaming or completed) into room feedback. */
  published?: boolean
  /** True once a milestone/ack segment has reached a confirmed boundary (`completed`) or terminal abort (`aborted`). */
  finalized?: boolean
}

export interface WorkerTurnOutputState {
  turnId: string
  fromSeq?: string
  throughSeq?: string
  segments: WorkerSegmentRecord[]
  activeSegmentId?: string
  activityCount: number
  /** True if any explicit milestone/report or tool call happened during this turn. */
  sawBoundary: boolean
  /** Tool call IDs already counted toward activityCount. */
  seenTools: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

export function extractAcpChunkMeta(update: unknown): WorkerAcpChunkMeta {
  if (!isRecord(update)) return {}
  const meta = isRecord(update._meta) ? update._meta : undefined
  const deskfleet = meta && isRecord(meta.deskfleet) ? meta.deskfleet : undefined
  const codex = meta && isRecord(meta.codex) ? meta.codex : undefined

  const messageId = typeof update.messageId === "string" && update.messageId.trim()
    ? update.messageId
    : typeof deskfleet?.messageId === "string" && deskfleet.messageId.trim()
      ? deskfleet.messageId
      : typeof meta?.messageId === "string" && meta.messageId.trim()
        ? meta.messageId
        : undefined

  const rawPhase = update.phase ?? deskfleet?.phase ?? codex?.phase ?? meta?.phase
  const phase: WorkerMessagePhase | undefined =
    rawPhase === "commentary" || rawPhase === "partial_answer" || rawPhase === "final_answer"
      ? rawPhase
      : undefined

  const rawPurpose = deskfleet?.purpose ?? deskfleet?.publicPurpose
  const purpose: WorkerMessagePurpose | undefined =
    rawPurpose === "ack" || rawPurpose === "activity" || rawPurpose === "milestone" || rawPurpose === "final_answer"
      ? rawPurpose
      : undefined

  const submissionId = typeof deskfleet?.submissionId === "string" && deskfleet.submissionId.trim()
    ? deskfleet.submissionId
    : typeof deskfleet?.dedupeKey === "string" && deskfleet.dedupeKey.trim()
      ? deskfleet.dedupeKey
      : undefined

  return {
    ...(messageId ? { messageId } : {}),
    ...(phase ? { phase } : {}),
    ...(purpose ? { purpose } : {}),
    ...(submissionId ? { submissionId } : {}),
  }
}

/** Extract a safe, bounded human-readable action label from an ACP tool_call / tool_call_update without leaking raw args or outputs. */
export function safeToolLabel(update: Record<string, unknown>): string {
  const title = typeof update.title === "string" ? update.title.replace(/\s+/gu, " ").trim() : ""
  if (title) return title.slice(0, 160)
  const kind = typeof update.kind === "string" ? update.kind.replace(/\s+/gu, " ").trim() : ""
  if (kind) return kind.slice(0, 80)
  return ""
}

export function ensureTurnOutput(
  current: WorkerTurnOutputState | undefined,
  legacy: { turnId: string; text: string } | undefined,
  turnId: string,
  seq?: string,
  createdAt = new Date().toISOString(),
): WorkerTurnOutputState {
  if (current?.turnId === turnId) return current
  const segments: WorkerSegmentRecord[] = []
  if (legacy?.turnId === turnId && legacy.text) {
    segments.push({
      id: "legacy",
      text: legacy.text,
      startSeq: seq ?? "0",
      lastSeq: seq ?? "0",
      createdAt,
      updatedAt: createdAt,
    })
  }
  return {
    turnId,
    fromSeq: seq,
    throughSeq: seq,
    segments,
    activeSegmentId: segments.at(-1)?.id,
    activityCount: 0,
    sawBoundary: false,
    seenTools: [],
  }
}

export interface WorkerProjectedFeedback {
  /** Complete public items (`ack` / `milestone`) to persist transactionally. */
  persistedItems: SuperFeedbackItem[]
  /** Transient live activity or streaming final_preview items for the real-time hub. */
  liveItems: SuperFeedbackItem[]
}

/**
 * Ingest a single committed Worker journal event into turn-scoped segments,
 * preserving message boundaries (native `messageId` or tool/event boundaries)
 * and separating commentary, milestones, and final answer fragments.
 */
export function stepWorkerTurnOutput(params: {
  state: WorkerTurnOutputState
  event: AgentEvent
  snapshot: AgentSnapshot
  sourceMessageId?: string
  revision: number
  ticketId: string
  sessionId: string
  inputId?: string
  hasRequestAck: boolean
}): WorkerProjectedFeedback {
  const { state, event, snapshot, sourceMessageId, revision, ticketId, sessionId, inputId, hasRequestAck } = params
  const persistedItems: SuperFeedbackItem[] = []
  const liveItems: SuperFeedbackItem[] = []
  state.fromSeq ??= event.seq
  state.throughSeq = event.seq

  const confirmClosedSegment = (closed: WorkerSegmentRecord | undefined, updatedAt: string, seq: string) => {
    if (!closed || closed.finalized || !sourceMessageId) return
    const item = buildPublicSegmentItem({
      segment: closed,
      status: "completed",
      sourceMessageId,
      revision,
      ticketId,
      sessionId,
      turnId: state.turnId,
      inputId,
      hasRequestAck,
      seq,
      updatedAt,
    })
    if (item) {
      closed.published = true
      closed.finalized = true
      persistedItems.push(item)
    }
  }

  if (event.kind === "permission" || event.kind === "elicitation") {
    confirmClosedSegment(closeActiveSegment(state, true), event.createdAt, event.seq)
    state.sawBoundary = true
    return { persistedItems, liveItems }
  }
  if (event.kind !== "acp" || !("update" in event.payload)) return { persistedItems, liveItems }
  if (isSubagentNotification(event.payload)) return { persistedItems, liveItems }
  if (snapshot.session.providerSessionId && event.payload.sessionId !== snapshot.session.providerSessionId) {
    return { persistedItems, liveItems }
  }
  const update = event.payload.update
  if (update.sessionUpdate === "agent_thought_chunk") return { persistedItems, liveItems }

  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    confirmClosedSegment(closeActiveSegment(state, true), event.createdAt, event.seq)
    state.sawBoundary = true
    const raw = update as unknown as Record<string, unknown>
    const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : `seq-${event.seq}`
    if (!state.seenTools.includes(toolCallId)) {
      state.seenTools.push(toolCallId)
      state.activityCount++
    }
    if (sourceMessageId) {
      const explicitLabel = safeToolLabel(raw)
      const label = explicitLabel || "Running tool"
      const status = raw.status === "completed" ? "completed"
        : raw.status === "failed" ? "failed"
          : raw.status === "cancelled" ? "cancelled"
            : "in_progress"
      liveItems.push({
        itemId: feedbackToolActivityId(sessionId, state.turnId, toolCallId),
        kind: "activity",
        sourceMessageId,
        revision,
        ticketId,
        sessionId,
        ...(inputId ? { inputId } : {}),
        turnId: state.turnId,
        text: label,
        // A title-less update only carries status; consumers keep the title of the tool already shown.
        ...(!explicitLabel && update.sessionUpdate === "tool_call_update" ? { updateOnly: true } : {}),
        activityKind: "tool",
        activityStatus: status,
        status: status === "in_progress" ? "streaming" : "completed",
        seq: Number(event.seq) || 0,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      })
    }
    return { persistedItems, liveItems }
  }

  if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
    confirmClosedSegment(closeActiveSegment(state, true), event.createdAt, event.seq)
    state.sawBoundary = true
    state.activityCount++
    if (sourceMessageId) {
      const summary = update.entries
        .map(entry => typeof entry?.content === "string" ? entry.content.trim() : "")
        .filter(Boolean)
        .slice(0, 5)
        .join(" · ")
      if (summary) {
        liveItems.push({
          itemId: feedbackWorkerActivityId(sessionId, state.turnId, "plan"),
          kind: "activity",
          sourceMessageId,
          revision,
          ticketId,
          sessionId,
          ...(inputId ? { inputId } : {}),
          turnId: state.turnId,
          text: boundFeedbackText(summary, SUPER_FEEDBACK_ACTIVITY_MAX_TEXT).text,
          activityKind: "plan",
          status: "completed",
          seq: Number(event.seq) || 0,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        })
      }
    }
    return { persistedItems, liveItems }
  }

  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
    return { persistedItems, liveItems }
  }

  const meta = extractAcpChunkMeta(update)
  let segment: WorkerSegmentRecord | undefined
  if (meta.messageId) {
    segment = state.segments.find(item => item.messageId === meta.messageId)
    if (!segment) {
      confirmClosedSegment(closeActiveSegment(state), event.createdAt, event.seq)
      segment = {
        id: `msg:${meta.messageId}`,
        messageId: meta.messageId,
        phase: meta.phase,
        purpose: meta.purpose,
        submissionId: meta.submissionId,
        text: "",
        startSeq: event.seq,
        lastSeq: event.seq,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      }
      state.segments.push(segment)
    } else {
      if (state.activeSegmentId && state.activeSegmentId !== segment.id) {
        confirmClosedSegment(closeActiveSegment(state), event.createdAt, event.seq)
      }
      if (meta.phase && !segment.phase) segment.phase = meta.phase
      if (meta.purpose && !segment.purpose) segment.purpose = meta.purpose
      if (meta.submissionId && !segment.submissionId) segment.submissionId = meta.submissionId
      if (segment.closed) {
        segment.closed = false
        segment.finalized = false
      }
    }
  } else {
    const active = state.activeSegmentId ? state.segments.find(item => item.id === state.activeSegmentId && !item.closed && !item.messageId) : undefined
    const sameSemantics = active && (!meta.phase || !active.phase || active.phase === meta.phase)
      && (!meta.purpose || !active.purpose || active.purpose === meta.purpose)
    if (sameSemantics) {
      segment = active
      if (meta.phase && !segment.phase) segment.phase = meta.phase
      if (meta.purpose && !segment.purpose) segment.purpose = meta.purpose
    } else {
      confirmClosedSegment(closeActiveSegment(state), event.createdAt, event.seq)
      segment = {
        id: `seg:${event.seq}`,
        phase: meta.phase,
        purpose: meta.purpose,
        submissionId: meta.submissionId,
        text: "",
        startSeq: event.seq,
        lastSeq: event.seq,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      }
      state.segments.push(segment)
    }
  }
  state.activeSegmentId = segment.id
  const bounded = boundFeedbackText(segment.text + update.content.text, SUPER_FEEDBACK_MAX_TEXT)
  segment.text = bounded.text
  if (bounded.truncated) segment.truncated = true
  segment.lastSeq = event.seq
  segment.updatedAt = event.createdAt

  if (!sourceMessageId) return { persistedItems, liveItems }
  const trimmed = segment.text.trim()
  if (!trimmed) return { persistedItems, liveItems }

  if (segment.purpose === "milestone" || segment.phase === "partial_answer") {
    const item = buildPublicSegmentItem({
      segment,
      status: "streaming",
      sourceMessageId,
      revision,
      ticketId,
      sessionId,
      turnId: state.turnId,
      inputId,
      hasRequestAck,
      seq: segment.startSeq,
      updatedAt: segment.updatedAt,
    })
    if (item) {
      persistedItems.push(item)
      segment.published = true
    }
  } else if (segment.purpose === "ack") {
    if (!hasRequestAck || segment.published) {
      const item = buildPublicSegmentItem({
        segment,
        status: "streaming",
        sourceMessageId,
        revision,
        ticketId,
        sessionId,
        turnId: state.turnId,
        inputId,
        hasRequestAck: false,
        seq: segment.startSeq,
        updatedAt: segment.updatedAt,
      })
      if (item) {
        persistedItems.push(item)
        segment.published = true
      }
    } else {
      state.activityCount = Math.max(state.activityCount, countActivitySegments(state))
      liveItems.push(commentaryActivityItem(segment, sourceMessageId, revision, ticketId, sessionId, state.turnId, inputId))
    }
  } else if (segment.purpose === "final_answer" || segment.phase === "final_answer") {
    liveItems.push({
      itemId: feedbackFinalLogicalId(sessionId, state.turnId),
      kind: "final_preview",
      sourceMessageId,
      revision,
      ticketId,
      sessionId,
      ...(inputId ? { inputId } : {}),
      turnId: state.turnId,
      ...(segment.messageId ? { messageId: segment.messageId } : {}),
      logicalId: feedbackFinalLogicalId(sessionId, state.turnId),
      text: segment.text,
      ...(segment.truncated ? { truncated: true } : {}),
      status: "streaming",
      seq: Number(event.seq) || 0,
      createdAt: segment.createdAt,
      updatedAt: segment.updatedAt,
    })
  } else if (segment.phase === "commentary" || segment.purpose === "activity") {
    state.activityCount = Math.max(state.activityCount, countActivitySegments(state))
    liveItems.push(commentaryActivityItem(segment, sourceMessageId, revision, ticketId, sessionId, state.turnId, inputId))
  } else if (state.segments.length > 1 || state.sawBoundary) {
    // Earlier segments before tools or newer segments become collapsible activity;
    // untagged live text is never prematurely promoted to final_preview.
    state.activityCount = Math.max(state.activityCount, countActivitySegments(state))
  }

  return { persistedItems, liveItems }
}

function closeActiveSegment(state: WorkerTurnOutputState, byBoundary = false): WorkerSegmentRecord | undefined {
  if (!state.activeSegmentId) return undefined
  const active = state.segments.find(item => item.id === state.activeSegmentId)
  if (active) {
    active.closed = true
    if (byBoundary) active.closedByBoundary = true
  }
  state.activeSegmentId = undefined
  return active
}

function looksLikeTentativeNarration(text: string): boolean {
  const trimmed = text.replace(/\s+/gu, " ").trim()
  if (!trimmed || trimmed.length > 96) return false
  if (/[…:：]$/u.test(trimmed) || /\.{3}$/u.test(trimmed)) return true
  return /^(?:让我|我先|我再|接下来我?|下面我?|正在|先去|再去|继续|稍等|等一下)[，,\s]?(?:查|看|检查|核对|确认|排查|测试|分析|验证|对比|复核|处理)/u.test(trimmed)
    || /^(?:let me|i(?:'ll| will| am going to) (?:check|verify|inspect|look|double[- ]check|re-?check|review)|checking\b|re-?checking\b)/iu.test(trimmed)
    || /^(?:もう一度|これから|念のため|まず)(?:確認|チェック|調査)/u.test(trimmed)
}

function buildPublicSegmentItem(params: {
  segment: WorkerSegmentRecord; status: "streaming" | "completed" | "aborted"
  sourceMessageId: string; revision: number; ticketId: string; sessionId: string
  turnId: string; inputId?: string; hasRequestAck: boolean; seq: string; updatedAt: string
}): SuperFeedbackItem | undefined {
  const { segment, status, sourceMessageId, revision, ticketId, sessionId, turnId, inputId, hasRequestAck, seq, updatedAt } = params
  const trimmed = segment.text.trim()
  if (!trimmed) return undefined
  const base = {
    sourceMessageId, revision, ticketId, sessionId, turnId, status, seq: Number(seq) || 0,
    ...(inputId ? { inputId } : {}), ...(segment.messageId ? { messageId: segment.messageId } : {}),
    createdAt: segment.createdAt, updatedAt,
  }
  if (segment.purpose === "milestone" || segment.phase === "partial_answer") {
    const dedupeKey = segment.submissionId ?? `worker:${sessionId}:${turnId}:${segment.messageId ?? segment.id}`
    return {
      ...base, itemId: feedbackMilestoneId(sourceMessageId, dedupeKey), kind: "milestone", dedupeKey,
      text: trimmed, ...(segment.truncated ? { truncated: true } : {}), deltaOffset: trimmed.length,
    }
  }
  if (segment.purpose === "ack" && (!hasRequestAck || segment.published)) {
    const bounded = boundFeedbackText(trimmed, SUPER_FEEDBACK_ACK_MAX_TEXT)
    return {
      ...base, itemId: feedbackAckId(sourceMessageId, revision), kind: "ack", dedupeKey: `ack:${sourceMessageId}:${revision}`,
      text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}), deltaOffset: bounded.text.length,
    }
  }
  return undefined
}

/** Finalize any open streaming public segments as `aborted` when a Worker run crashes before emitting a terminal turn event. */
export function abortOpenTurnPublicSegments(params: {
  state: WorkerTurnOutputState | undefined; ticketId: string; sessionId: string
  sourceMessageId?: string; revision: number; inputId?: string; updatedAt: string
}): SuperFeedbackItem[] {
  const { state, ticketId, sessionId, sourceMessageId, revision, inputId, updatedAt } = params
  if (!state || !sourceMessageId) return []
  const aborted: SuperFeedbackItem[] = []
  for (const seg of state.segments) {
    if (seg.finalized) continue
    if (seg.purpose !== "milestone" && seg.phase !== "partial_answer" && !(seg.purpose === "ack" && seg.published)) continue
    const item = buildPublicSegmentItem({
      segment: seg, status: "aborted", sourceMessageId, revision, ticketId, sessionId,
      turnId: state.turnId, inputId, hasRequestAck: false, seq: seg.startSeq, updatedAt,
    })
    if (item) { seg.closed = true; seg.finalized = true; seg.published = true; aborted.push(item) }
  }
  state.activeSegmentId = undefined
  return aborted
}

function countActivitySegments(state: WorkerTurnOutputState): number {
  let count = state.seenTools.length
  for (const segment of state.segments) {
    if (segment.phase === "commentary" || segment.purpose === "activity" || (segment.closed && !segment.published && segment.phase !== "final_answer" && segment.purpose !== "final_answer")) {
      count++
    }
  }
  return count
}

function commentaryActivityItem(
  segment: WorkerSegmentRecord,
  sourceMessageId: string,
  revision: number,
  ticketId: string,
  sessionId: string,
  turnId: string,
  inputId?: string,
): SuperFeedbackItem {
  const bounded = boundFeedbackText(segment.text.trim(), SUPER_FEEDBACK_ACTIVITY_MAX_TEXT)
  return {
    itemId: feedbackWorkerActivityId(sessionId, turnId, segment.id),
    kind: "activity",
    sourceMessageId,
    revision,
    ticketId,
    sessionId,
    ...(inputId ? { inputId } : {}),
    turnId,
    ...(segment.messageId ? { messageId: segment.messageId } : {}),
    text: bounded.text,
    ...(bounded.truncated ? { truncated: true } : {}),
    activityKind: "commentary",
    status: segment.closed ? "completed" : "streaming",
    seq: Number(segment.startSeq) || 0,
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt,
  }
}

export interface FinalizedWorkerTurn {
  text: string
  logicalId: string
  truncated: boolean
  unboundedOutcome: boolean
  /** Any un-persisted milestone segments that completed right before the terminal turn event. */
  milestones: SuperFeedbackItem[]
  processBranch: SuperFeedbackProcessBranch
}

/**
 * Resolve the single formal delivery payload at a Worker turn's terminal state.
 * Keeps explicit `final_answer` segments in order, never merges earlier opening `A`
 * or delivered milestone `B` into `ABC`, and preserves full beginning context when long.
 */
export function finalizeWorkerTurnOutput(params: {
  state: WorkerTurnOutputState | undefined
  legacyText: string
  turn: AgentTurn
  ticketId: string
  sessionId: string
  sourceMessageId?: string
  revision: number
  inputId?: string
}): FinalizedWorkerTurn {
  const { state, legacyText, turn, ticketId, sessionId, sourceMessageId, revision, inputId } = params
  const logicalId = feedbackFinalLogicalId(sessionId, turn.id)
  const segments = state?.segments ?? []
  const milestones: SuperFeedbackItem[] = []

  // Confirm or abort any milestone/ack segment that remained open when the turn ended.
  if (sourceMessageId) {
    const terminalStatus = turn.state === "completed" ? "completed" : "aborted"
    for (const seg of segments) {
      if (seg.finalized) continue
      if (seg.purpose !== "milestone" && seg.phase !== "partial_answer" && !(seg.purpose === "ack" && seg.published)) continue
      const item = buildPublicSegmentItem({
        segment: seg,
        status: terminalStatus,
        sourceMessageId,
        revision,
        ticketId,
        sessionId,
        turnId: turn.id,
        inputId,
        hasRequestAck: false,
        seq: seg.startSeq,
        updatedAt: turn.endedAt ?? seg.updatedAt,
      })
      if (item) {
        seg.closed = true
        seg.finalized = true
        seg.published = true
        milestones.push(item)
      }
    }
  }

  let finalSegments: WorkerSegmentRecord[] = []
  let unboundedOutcome = false

  // 1. Prefer explicitly marked final_answer segments in original order.
  const explicitFinals = segments.filter(seg => (seg.purpose === "final_answer" || seg.phase === "final_answer") && seg.text.trim())
  if (explicitFinals.length) {
    finalSegments = explicitFinals
  } else {
    // 2. Otherwise collect all unmarked trailing segments after the last real execution boundary or non-final segment.
    // Multiple distinct untagged messages with no separating tool/purpose boundary cannot be disambiguated safely:
    // preserve all of them and mark `unboundedOutcome` so the user keeps the conclusion and gets the session link.
    const trailing: WorkerSegmentRecord[] = []
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!
      const nonFinal = seg.phase === "commentary" || seg.purpose === "activity" || seg.purpose === "ack"
        || seg.purpose === "milestone" || seg.phase === "partial_answer"
      if (nonFinal) break
      if (seg.closedByBoundary && trailing.length > 0) break
      if (seg.text.trim()) trailing.unshift(seg)
    }
    if (trailing.length) {
      const last = trailing.at(-1)!
      if (last.closedByBoundary && state?.sawBoundary) unboundedOutcome = true
      if (trailing.length > 1) unboundedOutcome = true
      if (trailing.length === 1 && looksLikeTentativeNarration(last.text)) unboundedOutcome = true
      finalSegments = trailing
    } else if (segments.length > 0 || state?.sawBoundary) {
      unboundedOutcome = turn.state === "completed"
    }
  }

  let rawText = finalSegments.map(seg => seg.text.trim()).filter(Boolean).join("\n\n")
  let truncated = finalSegments.some(seg => seg.truncated === true)

  if (!rawText && !segments.length && legacyText.trim()) {
    rawText = legacyText.trim()
  }

  let text = ""
  if (turn.state === "completed") {
    if (rawText) {
      const bounded = boundFeedbackText(rawText, SUPER_FEEDBACK_MAX_TEXT)
      text = bounded.text
      truncated = truncated || bounded.truncated
    } else {
      unboundedOutcome = true
      text = "The worker finished its turn. Its session contains the execution details."
    }
  } else if (turn.state === "cancelled") {
    const partial = rawText || segments.at(-1)?.text.trim() || legacyText.trim()
    const bounded = boundFeedbackText(partial, SUPER_FEEDBACK_MAX_TEXT)
    text = bounded.text
    truncated = truncated || bounded.truncated
  } else {
    text = turn.error || `Worker turn ${turn.state}.`
  }

  const nonFinalActivityCount = Math.max(
    state?.activityCount ?? 0,
    (state?.seenTools.length ?? 0) + segments.filter(seg => !finalSegments.includes(seg) && seg.purpose !== "milestone" && seg.phase !== "partial_answer" && seg.purpose !== "ack").length,
  )

  return {
    text,
    logicalId,
    truncated,
    unboundedOutcome,
    milestones,
    processBranch: {
      ticketId,
      sessionId,
      turnId: turn.id,
      ...(inputId ? { inputId } : {}),
      ...(state?.fromSeq ? { fromSeq: state.fromSeq } : {}),
      ...(state?.throughSeq ? { throughSeq: state.throughSeq } : {}),
      activityCount: nonFinalActivityCount,
      ...(unboundedOutcome ? { unboundedOutcome: true } : {}),
    },
  }
}

export interface LivePreviewDelta {
  eventIndex: number
  kind: "activity" | "milestone" | "final_preview" | "ack"
  itemId: string
  logicalId?: string
  dedupeKey?: string
  messageId?: string
  delta: string
  activityKind?: "commentary"
  createdAt: string
}

/**
 * Classify a live uncommitted `AgentPreview` chunk for immediate streaming
 * without mutating SQLite. Only explicit `final_answer` enters `final_preview`;
 * `commentary` enters `activity`; explicit `milestone` / `partial_answer` enters `milestone`.
 */
export function classifyLivePreviewEvents(
  preview: AgentPreview,
  rootProviderSessionId: string | undefined,
  sourceMessageId: string,
  revision: number,
  hasRequestAck: boolean,
): LivePreviewDelta[] {
  const results: LivePreviewDelta[] = []
  for (const [idx, draft] of preview.events.entries()) {
    const item = classifySingleDraft(draft, preview, idx, rootProviderSessionId, sourceMessageId, revision, hasRequestAck)
    if (item) results.push(item)
  }
  return results
}

function classifySingleDraft(
  event: AgentEventDraft,
  preview: AgentPreview,
  idx: number,
  rootProviderSessionId: string | undefined,
  sourceMessageId: string,
  revision: number,
  hasRequestAck: boolean,
): LivePreviewDelta | undefined {
  if (event.kind !== "acp" || !event.turnId || !("update" in event.payload)) return undefined
  if (isSubagentNotification(event.payload)) return undefined
  if (rootProviderSessionId && event.payload.sessionId !== rootProviderSessionId) return undefined
  const update = event.payload.update
  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return undefined
  const delta = update.content.text
  if (!delta) return undefined
  const meta = extractAcpChunkMeta(update)
  const segmentKey = meta.messageId ? `msg:${meta.messageId}` : `preview:${preview.streamId}:${preview.baseSeq}`

  if (meta.purpose === "milestone" || meta.phase === "partial_answer") {
    const dedupeKey = meta.submissionId ?? `worker:${preview.sessionId}:${event.turnId}:${meta.messageId ?? segmentKey}`
    return {
      eventIndex: idx,
      kind: "milestone",
      itemId: feedbackMilestoneId(sourceMessageId, dedupeKey),
      dedupeKey,
      ...(meta.messageId ? { messageId: meta.messageId } : {}),
      delta,
      createdAt: event.createdAt,
    }
  }
  if (meta.purpose === "ack" && !hasRequestAck) {
    return {
      eventIndex: idx,
      kind: "ack",
      itemId: feedbackAckId(sourceMessageId, revision),
      dedupeKey: `ack:${sourceMessageId}:${revision}`,
      ...(meta.messageId ? { messageId: meta.messageId } : {}),
      delta,
      createdAt: event.createdAt,
    }
  }
  if (meta.purpose === "final_answer" || meta.phase === "final_answer") {
    const logicalId = feedbackFinalLogicalId(preview.sessionId, event.turnId)
    return {
      eventIndex: idx,
      kind: "final_preview",
      itemId: logicalId,
      logicalId,
      ...(meta.messageId ? { messageId: meta.messageId } : {}),
      delta,
      createdAt: event.createdAt,
    }
  }
  if (meta.phase === "commentary" || meta.purpose === "activity") {
    return {
      eventIndex: idx,
      kind: "activity",
      itemId: feedbackWorkerActivityId(preview.sessionId, event.turnId, segmentKey),
      ...(meta.messageId ? { messageId: meta.messageId } : {}),
      delta,
      activityKind: "commentary",
      createdAt: event.createdAt,
    }
  }
  // Untagged live chunks without an explicit phase/purpose cannot be proved to be a final answer;
  // keep them out of main chat until a trusted boundary or turn completion confirms them.
  return undefined
}

export function deterministicReportKey(sessionId: string, turnId: string | undefined, kind: string, text: string, submissionId?: string): string {
  if (submissionId) return `report:${submissionId}`
  return `report:${feedbackDedupeHash([sessionId, turnId ?? "no-turn", kind, text])}`
}
