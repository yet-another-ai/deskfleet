import { isSubagentNotification } from "@deskfleet/protocol/agent-session-scope"
import type { AgentActor, AgentEvent, AgentPreview, AgentSessionRecord } from "@deskfleet/protocol/agent"
import type { SuperWorkspaceId } from "@deskfleet/protocol/super-agent"
import {
  boundFeedbackText,
  buildFallbackAck,
  feedbackAckId,
  feedbackDedupeHash,
  feedbackFinalLogicalId,
  feedbackMilestoneId,
  feedbackToolActivityId,
  feedbackWorkerActivityId,
  parseSuperWorkerReport,
  SUPER_FEEDBACK_ACK_MAX_TEXT,
  SUPER_FEEDBACK_ACTIVITY_MAX_TEXT,
  SUPER_FEEDBACK_MAX_TEXT,
  type SuperCoordinatorPublicFeedback,
  type SuperCoordinatorPublicMessage,
  type SuperFeedbackItem,
  type SuperWorkerReportReceipt,
} from "./feedback-helpers.ts"
import {
  predictPreviewSeq,
  WorkerFeedbackAttribution,
  type BoundWorkerContext,
} from "./feedback-attribution.ts"
import { persistRoomFeedbackItem, persistRoomProcessBranch, type SuperFeedbackHub } from "./feedback.ts"
import { roomFor, type DispatchIntent, type SuperRoom, type SuperUserState } from "./state.ts"
import {
  classifyLivePreviewEvents,
  deterministicReportKey,
  ensureTurnOutput,
  extractAcpChunkMeta,
  safeToolLabel,
} from "./worker-projection.ts"
import { activeTurn, type SuperEventProjectionFeedback, type SuperWorkers } from "./worker.ts"

function applyBoundWorkerPreview(params: {
  uid: string
  bound: BoundWorkerContext
  preview: AgentPreview
  sessions: ReadonlyMap<string, AgentSessionRecord>
  hub: SuperFeedbackHub
  attribution: WorkerFeedbackAttribution
}): void {
  const { uid, bound, preview, sessions, hub, attribution } = params
  const rootProviderSessionId = sessions.get(preview.sessionId)?.providerSessionId
  const firstTurnId = preview.events.find(event => event.turnId)?.turnId
  const hasCommittedAck = (bound.room.feedbackItems ?? []).some(item =>
    item.kind === "ack"
    && item.sourceMessageId === bound.sourceMessageId
    && item.revision === bound.revision
    && (item.status !== "streaming" || item.turnId !== firstTurnId))
  const deltas = classifyLivePreviewEvents(preview, rootProviderSessionId, bound.sourceMessageId, bound.revision, hasCommittedAck)
  const deltasByIndex = new Map(deltas.map(chunk => [chunk.eventIndex, chunk]))
  for (const [idx, draft] of preview.events.entries()) {
    const predicted = predictPreviewSeq(preview.baseSeq, preview.offset, idx)
    const turnId = draft.turnId ?? firstTurnId ?? "turn"
    const chunk = deltasByIndex.get(idx)
    if (!chunk) {
      if (draft.kind === "acp" && "update" in draft.payload) {
        const update = draft.payload.update
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update" || update.sessionUpdate === "plan" || update.sessionUpdate === "plan_update") {
          attribution.closeAnonActivitySegment(preview.sessionId, turnId, predicted)
        } else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" && extractAcpChunkMeta(update).messageId) {
          attribution.closeAnonActivitySegment(preview.sessionId, turnId, predicted)
        }
      }
      continue
    }
    let itemId = chunk.itemId
    if (chunk.kind === "activity" && !chunk.messageId) {
      if (predicted !== undefined) {
        const segKey = attribution.resolveAnonActivitySegment(preview.sessionId, turnId, predicted)
        itemId = feedbackWorkerActivityId(preview.sessionId, turnId, segKey)
      }
    } else {
      attribution.closeAnonActivitySegment(preview.sessionId, turnId, predicted)
    }
    if (!attribution.recordPreviewChunk(preview.sessionId, preview.streamId, preview.baseSeq, preview.offset, chunk.eventIndex, itemId)) {
      continue
    }
    hub.appendDelta(uid, bound.room.workspaceId, {
      itemId,
      kind: chunk.kind,
      sourceMessageId: bound.sourceMessageId,
      revision: bound.revision,
      delta: chunk.delta,
      status: "streaming",
      ticketId: bound.ticket.id,
      sessionId: preview.sessionId,
      ...(bound.intent.inputId ? { inputId: bound.intent.inputId } : {}),
      ...(draft.turnId ?? firstTurnId ? { turnId: draft.turnId ?? firstTurnId } : {}),
      ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
      ...(chunk.logicalId ? { logicalId: chunk.logicalId } : {}),
      ...(chunk.activityKind ? { activityKind: chunk.activityKind } : {}),
      createdAt: chunk.createdAt,
    })
  }
}

function applyBoundWorkerAcpEvent(params: {
  uid: string
  bound: BoundWorkerContext
  event: AgentEvent
  hub: SuperFeedbackHub
  attribution: WorkerFeedbackAttribution
}): boolean {
  const { uid, bound, event, hub, attribution } = params
  if (event.kind !== "acp" || !("update" in event.payload)) return false
  const update = event.payload.update
  const turnId = event.turnId ?? bound.intent.deliveredTurnId ?? bound.intent.turnId ?? "turn"
  let eventSeq: bigint | undefined
  try { eventSeq = BigInt(event.seq) } catch { eventSeq = undefined }
  const openStreamingPublic = (bound.room.feedbackItems ?? []).find(item =>
    (item.kind === "milestone" || item.kind === "ack")
    && item.status === "streaming"
    && item.sourceMessageId === bound.sourceMessageId
    && item.revision === bound.revision
    && item.sessionId === event.sessionId
    && item.turnId === turnId)

  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    attribution.closeAnonActivitySegment(event.sessionId, turnId, eventSeq)
    const raw = update as unknown as Record<string, unknown>
    const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : `seq-${event.seq}`
    const status = raw.status === "completed" ? "completed"
      : raw.status === "failed" ? "failed"
        : raw.status === "cancelled" ? "cancelled"
          : "in_progress"
    hub.upsertItem(uid, bound.room.workspaceId, {
      itemId: feedbackToolActivityId(event.sessionId, turnId, toolCallId),
      kind: "activity",
      sourceMessageId: bound.sourceMessageId,
      revision: bound.revision,
      ticketId: bound.ticket.id,
      sessionId: event.sessionId,
      ...(bound.intent.inputId ? { inputId: bound.intent.inputId } : {}),
      turnId,
      text: safeToolLabel(raw) || "Running tool",
      ...(!safeToolLabel(raw) && update.sessionUpdate === "tool_call_update" ? { updateOnly: true } : {}),
      activityKind: "tool",
      activityStatus: status,
      status: status === "in_progress" ? "streaming" : "completed",
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    })
    return !!openStreamingPublic
  }

  if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
    attribution.closeAnonActivitySegment(event.sessionId, turnId, eventSeq)
    const summary = update.entries
      .map(entry => typeof entry?.content === "string" ? entry.content.trim() : "")
      .filter(Boolean)
      .slice(0, 5)
      .join(" · ")
    if (summary) {
      hub.upsertItem(uid, bound.room.workspaceId, {
        itemId: feedbackWorkerActivityId(event.sessionId, turnId, "plan"),
        kind: "activity",
        sourceMessageId: bound.sourceMessageId,
        revision: bound.revision,
        ticketId: bound.ticket.id,
        sessionId: event.sessionId,
        ...(bound.intent.inputId ? { inputId: bound.intent.inputId } : {}),
        turnId,
        text: boundFeedbackText(summary, SUPER_FEEDBACK_ACTIVITY_MAX_TEXT).text,
        activityKind: "plan",
        status: "completed",
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      })
    }
    return !!openStreamingPublic
  }

  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    const meta = extractAcpChunkMeta(update)
    if (meta.purpose === "milestone" || meta.phase === "partial_answer" || meta.purpose === "ack") {
      attribution.closeAnonActivitySegment(event.sessionId, turnId, eventSeq)
      return true
    }
    if (meta.purpose === "final_answer" || meta.phase === "final_answer") {
      attribution.closeAnonActivitySegment(event.sessionId, turnId, eventSeq)
      const logicalId = feedbackFinalLogicalId(event.sessionId, turnId)
      if (!attribution.consumeCommittedChunk(event.sessionId, event.seq, logicalId)) {
        hub.appendDelta(uid, bound.room.workspaceId, {
          itemId: logicalId,
          kind: "final_preview",
          sourceMessageId: bound.sourceMessageId,
          revision: bound.revision,
          delta: update.content.text,
          status: "streaming",
          ticketId: bound.ticket.id,
          sessionId: event.sessionId,
          ...(bound.intent.inputId ? { inputId: bound.intent.inputId } : {}),
          turnId,
          ...(meta.messageId ? { messageId: meta.messageId } : {}),
          logicalId,
          createdAt: event.createdAt,
        })
      }
      return !!openStreamingPublic
    }
    if (meta.phase === "commentary" || meta.purpose === "activity") {
      let itemId: string
      if (meta.messageId) {
        attribution.closeAnonActivitySegment(event.sessionId, turnId, eventSeq)
        itemId = feedbackWorkerActivityId(event.sessionId, turnId, `msg:${meta.messageId}`)
      } else {
        const previewed = attribution.previewedItemForSeq(event.sessionId, event.seq)
        const segKey = eventSeq !== undefined
          ? attribution.resolveAnonActivitySegment(event.sessionId, turnId, eventSeq)
          : `seq:${event.seq}`
        itemId = previewed ?? feedbackWorkerActivityId(event.sessionId, turnId, segKey)
      }
      if (!attribution.consumeCommittedChunk(event.sessionId, event.seq, itemId)) {
        hub.appendDelta(uid, bound.room.workspaceId, {
          itemId,
          kind: "activity",
          sourceMessageId: bound.sourceMessageId,
          revision: bound.revision,
          delta: update.content.text,
          status: "streaming",
          ticketId: bound.ticket.id,
          sessionId: event.sessionId,
          ...(bound.intent.inputId ? { inputId: bound.intent.inputId } : {}),
          turnId,
          ...(meta.messageId ? { messageId: meta.messageId } : {}),
          activityKind: "commentary",
          createdAt: event.createdAt,
        })
      }
    } else if (meta.messageId) {
      attribution.closeAnonActivitySegment(event.sessionId, turnId, eventSeq)
    }
    return Boolean(openStreamingPublic && (!openStreamingPublic.messageId || meta.messageId !== openStreamingPublic.messageId))
  }

  return false
}

/**
 * Push uncommitted Worker text preview chunks into the in-memory feedback hub
 * without touching SQLite. Independent manual turns are never attributed to old SA requests;
 * crossing-receipt chunks are buffered until receipt confirmation.
 */
export function observeLiveWorkerPreview(params: {
  preview: AgentPreview
  watchers: Iterable<string>
  sessions: ReadonlyMap<string, AgentSessionRecord>
  getState: (uid: string) => SuperUserState | undefined
  hub: SuperFeedbackHub
  attribution?: WorkerFeedbackAttribution
}): void {
  const { preview, watchers, sessions, getState, hub, attribution = new WorkerFeedbackAttribution() } = params
  const firstTurnId = preview.events.find(event => event.turnId)?.turnId
  const firstInputId = preview.events.find(event => event.inputId)?.inputId
  for (const uid of watchers) {
    const resolved = attribution.resolve(getState(uid), preview.sessionId, firstTurnId, firstInputId)
    if (resolved.status === "matched") {
      applyBoundWorkerPreview({ uid, bound: resolved.bound, preview, sessions, hub, attribution })
    } else if (resolved.status === "pending") {
      attribution.buffer(preview.sessionId, firstTurnId, { kind: "preview", uid, preview, turnId: firstTurnId, inputId: firstInputId })
    }
  }
}

/**
 * Observe committed ACP events for watched SA Workers.
 * Routine tools/commentary/final-preview go straight to the in-memory hub with ZERO state writes;
 * returns user IDs that need immediate durable replay (e.g. milestones, worker acks, or their closing boundaries).
 */
export function observeLiveWorkerAcpEvent(params: {
  event: AgentEvent
  watchers: Iterable<string>
  sessions: ReadonlyMap<string, AgentSessionRecord>
  getState: (uid: string) => SuperUserState | undefined
  hub: SuperFeedbackHub
  attribution?: WorkerFeedbackAttribution
}): string[] {
  const { event, watchers, sessions, getState, hub, attribution = new WorkerFeedbackAttribution() } = params
  if (event.kind !== "acp" || !("update" in event.payload)) return []
  if (isSubagentNotification(event.payload)) return []
  const rootProviderSessionId = sessions.get(event.sessionId)?.providerSessionId
  if (rootProviderSessionId && event.payload.sessionId !== rootProviderSessionId) return []
  const update = event.payload.update
  if (update.sessionUpdate === "agent_thought_chunk") return []

  const needsDurableReplay: string[] = []
  for (const uid of watchers) {
    const resolved = attribution.resolve(getState(uid), event.sessionId, event.turnId, event.inputId)
    if (resolved.status === "matched") {
      if (applyBoundWorkerAcpEvent({ uid, bound: resolved.bound, event, hub, attribution })) needsDurableReplay.push(uid)
    } else if (resolved.status === "pending") {
      attribution.buffer(event.sessionId, event.turnId, { kind: "acp", uid, event, turnId: event.turnId, inputId: event.inputId })
    }
  }
  return needsDurableReplay
}

/** Re-evaluate buffered crossing-receipt live events once receipt/turn/snapshot correlation arrives. */
export function reconcilePendingWorkerFeedback(params: {
  sessionId: string
  filterUid?: string
  sessions: ReadonlyMap<string, AgentSessionRecord>
  getState: (uid: string) => SuperUserState | undefined
  hub: SuperFeedbackHub
  attribution: WorkerFeedbackAttribution
}): string[] {
  const { sessionId, filterUid, sessions, getState, hub, attribution } = params
  if (!attribution.hasPending(sessionId)) return []
  const replayUsers = new Set<string>()
  attribution.drain(sessionId, item => {
    const resolved = attribution.resolve(getState(item.uid), sessionId, item.turnId, item.inputId)
    if (resolved.status !== "matched") return resolved.status
    if (item.kind === "preview") {
      applyBoundWorkerPreview({ uid: item.uid, bound: resolved.bound, preview: item.preview, sessions, hub, attribution })
    } else if (applyBoundWorkerAcpEvent({ uid: item.uid, bound: resolved.bound, event: item.event, hub, attribution })) {
      replayUsers.add(item.uid)
    }
    return "matched"
  }, filterUid)
  return [...replayUsers]
}

/**
 * Handle an explicit public message emitted by a foreground coordinator adapter or evidence pass.
 * Activity stays in memory; complete `ack` and `milestone` items are persisted once and pushed immediately.
 */
export function createCoordinatorPublicPublisher(params: {
  uid: string
  workspaceId: SuperWorkspaceId
  sourceMessageId: string
  revision: number
  signal: AbortSignal
  hub: SuperFeedbackHub
  persistItem: (item: SuperFeedbackItem) => Promise<void>
  track: (job: Promise<void>) => void
}): (message: SuperCoordinatorPublicMessage) => void {
  const { uid, workspaceId, sourceMessageId, revision, signal, hub, persistItem, track } = params
  const ackBuffers = new Map<string, string>()
  let ackPersisted = false
  return message => {
    if (signal.aborted) return
    const now = new Date().toISOString()
    if (message.purpose === "activity") {
      const itemId = `coord-activity:${sourceMessageId}:${revision}:${message.itemId ?? feedbackDedupeHash([message.text])}`
      if (message.delta) {
        hub.appendDelta(uid, workspaceId, {
          itemId,
          kind: "activity",
          sourceMessageId,
          revision,
          delta: message.text,
          status: message.done ? "completed" : "streaming",
          activityKind: "phase",
          activityStatus: message.done ? "completed" : "in_progress",
          createdAt: now,
        })
      } else {
        hub.upsertItem(uid, workspaceId, {
          itemId,
          kind: "activity",
          sourceMessageId,
          revision,
          text: boundFeedbackText(message.text.trim(), SUPER_FEEDBACK_ACTIVITY_MAX_TEXT).text,
          activityKind: "phase",
          activityStatus: message.done === false ? "in_progress" : "completed",
          status: message.done === false ? "streaming" : "completed",
          createdAt: now,
          updatedAt: now,
        })
      }
      return
    }

    if (message.purpose === "ack") {
      const itemId = feedbackAckId(sourceMessageId, revision)
      if (message.delta) {
        const next = (ackBuffers.get(itemId) ?? "") + message.text
        ackBuffers.set(itemId, next)
        hub.appendDelta(uid, workspaceId, {
          itemId,
          kind: "ack",
          sourceMessageId,
          revision,
          delta: message.text,
          status: message.done ? "completed" : "streaming",
          createdAt: now,
        })
        if (!message.done) return
      }
      const rawText = (message.delta ? ackBuffers.get(itemId) ?? "" : message.text).trim()
      if (!rawText || ackPersisted) return
      ackPersisted = true
      const bounded = boundFeedbackText(rawText, SUPER_FEEDBACK_ACK_MAX_TEXT)
      const item: SuperFeedbackItem = {
        itemId,
        kind: "ack",
        sourceMessageId,
        revision,
        dedupeKey: `ack:${sourceMessageId}:${revision}`,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
        status: "completed",
        seq: 0,
        createdAt: now,
        updatedAt: now,
      }
      const published = hub.upsertItem(uid, workspaceId, item)
      track(persistItem(published))
      return
    }

    if (message.purpose === "milestone") {
      const dedupeKey = message.dedupeKey ?? `coord:${sourceMessageId}:${revision}:${message.itemId ?? feedbackDedupeHash([message.text])}`
      const itemId = feedbackMilestoneId(sourceMessageId, dedupeKey)
      if (message.delta) {
        const next = (ackBuffers.get(itemId) ?? "") + message.text
        ackBuffers.set(itemId, next)
        hub.appendDelta(uid, workspaceId, {
          itemId,
          kind: "milestone",
          sourceMessageId,
          revision,
          delta: message.text,
          status: message.done ? "completed" : "streaming",
          createdAt: now,
        })
        if (!message.done) return
      }
      const rawText = (message.delta ? ackBuffers.get(itemId) ?? "" : message.text).trim()
      if (!rawText) return
      const bounded = boundFeedbackText(rawText, SUPER_FEEDBACK_MAX_TEXT)
      const item: SuperFeedbackItem = {
        itemId,
        kind: "milestone",
        sourceMessageId,
        revision,
        dedupeKey,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
        status: "completed",
        seq: 0,
        createdAt: now,
        updatedAt: now,
      }
      const published = hub.upsertItem(uid, workspaceId, item)
      track(persistItem(published))
    }
  }
}

/**
 * Restricted explicit reporting entry for an SA-bound Worker (via MCP `deskfleet_sa_report`).
 * Host fills all target/ownership coordinates strictly from the bound SA intent and active turn.
 */
export async function handleWorkerFeedbackReport(params: {
  sessionId: string
  value: unknown
  actor: AgentActor
  workers: SuperWorkers
  getState: (uid: string) => SuperUserState | undefined
  transaction: <R>(uid: string, edit: (state: SuperUserState) => R) => Promise<R>
  hub: SuperFeedbackHub
  attribution?: WorkerFeedbackAttribution
}): Promise<SuperWorkerReportReceipt> {
  const { sessionId, value, actor, workers, getState, transaction, hub, attribution = new WorkerFeedbackAttribution() } = params
  if (actor.kind !== "user" || !actor.userId || !actor.deviceId) {
    throw new Error("A verified user and device are required")
  }
  const uid = actor.userId
  const parsed = parseSuperWorkerReport(value)
  const snapshot = await workers.journal.read(sessionId)
  attribution.observeSnapshot(snapshot)
  const liveTurn = snapshot.turns.findLast(activeTurn) ?? snapshot.turns.at(-1)
  const fallbackInputId = !liveTurn ? snapshot.inputs.at(-1)?.id : undefined
  const state = getState(uid)
  const resolved = attribution.resolve(state, sessionId, liveTurn?.id, liveTurn?.initialInputId ?? fallbackInputId)
  let bound: BoundWorkerContext | undefined = resolved.status === "matched" ? resolved.bound : undefined
  if (!bound && resolved.status === "pending" && state && liveTurn) {
    const room = state.rooms.find(candidate => candidate.tickets.some(item => item.sessionId === sessionId))
    const ticket = room?.tickets.find(item => item.sessionId === sessionId)
    if (room && ticket) {
      const turnInputIds = new Set<string>([
        ...(liveTurn.initialInputId ? [liveTurn.initialInputId] : []),
        ...snapshot.inputs.filter(inp => inp.turnId === liveTurn.id).map(inp => inp.id),
      ])
      const turnCommandIds = new Set(snapshot.inputs.filter(inp => turnInputIds.has(inp.id)).map(inp => inp.submissionCommandId))
      for (const intent of state.intents) {
        if (intent.roomId !== room.workspaceId || intent.ticketId !== ticket.id || intent.sessionId !== sessionId) continue
        if (intent.phase === "withdrawn" || intent.operation === "stop") continue
        const cmd = await workers.journal.command(intent.submitId)
        if (cmd && turnCommandIds.has(cmd.id)) {
          const source = room.messages.find(message => message.id === intent.messageId && message.role === "user")
          bound = { room, ticket, intent, sourceMessageId: intent.messageId, revision: source?.revision ?? 0 }
          break
        }
      }
    }
  }
  if (!bound) throw new Error("This session is not bound to a Super Agent request")
  if (bound.ticket.executionWorkspaceId && snapshot.session.workspaceId !== bound.ticket.executionWorkspaceId) {
    throw new Error("Worker is outside the ticket workspace")
  }
  const { sourceMessageId, revision, ticket, intent } = bound
  const workspaceId = bound.room.workspaceId
  const turnId = liveTurn?.id ?? intent.deliveredTurnId ?? intent.turnId
  const dedupeKey = deterministicReportKey(sessionId, turnId, parsed.kind, parsed.text, parsed.submissionId)
  const now = new Date().toISOString()

  if (parsed.kind === "activity") {
    const itemId = feedbackWorkerActivityId(sessionId, turnId ?? "turn", dedupeKey)
    const bounded = boundFeedbackText(parsed.text, SUPER_FEEDBACK_ACTIVITY_MAX_TEXT)
    hub.upsertItem(uid, workspaceId, {
      itemId,
      kind: "activity",
      sourceMessageId,
      revision,
      ticketId: ticket.id,
      sessionId,
      ...(intent.inputId ? { inputId: intent.inputId } : {}),
      ...(turnId ? { turnId } : {}),
      dedupeKey,
      text: bounded.text,
      ...(bounded.truncated ? { truncated: true } : {}),
      activityKind: "commentary",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    })
    return { itemId, kind: parsed.kind, status: "accepted", sourceMessageId, revision, ticketId: ticket.id, ...(turnId ? { turnId } : {}) }
  }

  if (parsed.kind === "final_answer") {
    const effectiveTurnId = turnId ?? "turn"
    const logicalId = feedbackFinalLogicalId(sessionId, effectiveTurnId)
    const bounded = boundFeedbackText(parsed.text, SUPER_FEEDBACK_MAX_TEXT)
    const created = await transaction(uid, state => {
      const liveRoom = roomFor(state, workspaceId)
      const liveTicket = liveRoom.tickets.find(item => item.id === ticket.id && item.sessionId === sessionId)
      if (!liveTicket) throw new Error("Ticket binding no longer exists")
      const turnState = ensureTurnOutput(liveTicket.turnOutput, liveTicket.output, effectiveTurnId, snapshot.session.lastEventSeq, now)
      liveTicket.turnOutput = turnState
      const existing = turnState.segments.find(seg => seg.submissionId === dedupeKey && seg.purpose === "final_answer")
      if (existing) return false
      turnState.segments.push({
        id: `report:${dedupeKey}`,
        purpose: "final_answer",
        phase: "final_answer",
        submissionId: dedupeKey,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
        startSeq: snapshot.session.lastEventSeq,
        lastSeq: snapshot.session.lastEventSeq,
        createdAt: now,
        updatedAt: now,
        closed: true,
      })
      return true
    })
    if (created) {
      hub.upsertItem(uid, workspaceId, {
        itemId: logicalId,
        kind: "final_preview",
        sourceMessageId,
        revision,
        ticketId: ticket.id,
        sessionId,
        ...(intent.inputId ? { inputId: intent.inputId } : {}),
        turnId: effectiveTurnId,
        logicalId,
        dedupeKey,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
        status: "completed",
        createdAt: now,
        updatedAt: now,
      })
    }
    return {
      itemId: logicalId,
      kind: parsed.kind,
      status: created ? "accepted" : "duplicate",
      sourceMessageId,
      revision,
      ticketId: ticket.id,
      ...(turnId ? { turnId } : {}),
    }
  }

  // `ack` or `milestone`: persisted transactionally with host idempotency receipt.
  const isAck = parsed.kind === "ack"
  const itemId = isAck ? feedbackAckId(sourceMessageId, revision) : feedbackMilestoneId(sourceMessageId, dedupeKey)
  const bounded = boundFeedbackText(parsed.text, isAck ? SUPER_FEEDBACK_ACK_MAX_TEXT : SUPER_FEEDBACK_MAX_TEXT)
  const draft: SuperFeedbackItem = {
    itemId,
    kind: isAck ? "ack" : "milestone",
    sourceMessageId,
    revision,
    ticketId: ticket.id,
    sessionId,
    ...(intent.inputId ? { inputId: intent.inputId } : {}),
    ...(turnId ? { turnId } : {}),
    dedupeKey: isAck ? `ack:${sourceMessageId}:${revision}` : dedupeKey,
    text: bounded.text,
    ...(bounded.truncated ? { truncated: true } : {}),
    status: "completed",
    seq: 0,
    createdAt: now,
    updatedAt: now,
  }
  const saved = await transaction(uid, state => {
    const liveRoom = roomFor(state, workspaceId)
    return persistRoomFeedbackItem(liveRoom, draft)
  })
  if (saved.changed) {
    hub.upsertItem(uid, workspaceId, saved.item)
  }
  return {
    itemId: saved.item.itemId,
    kind: parsed.kind,
    status: saved.created ? "accepted" : "duplicate",
    sourceMessageId,
    revision,
    ticketId: ticket.id,
    ...(turnId ? { turnId } : {}),
  }
}

/**
 * Commit validated coordinator milestone, single opening confirmation (with verified
 * fallback if omitted), and initial process branch indices inside `#apply`'s transaction.
 */
export function recordAppliedRouteFeedback(params: {
  room: SuperRoom
  source: SuperRoom["messages"][number]
  focus: string | undefined
  intents: DispatchIntent[]
  publicFeedback?: SuperCoordinatorPublicFeedback
}): SuperFeedbackItem[] {
  const { room, source, focus, intents, publicFeedback } = params
  const created: SuperFeedbackItem[] = []
  const revision = source.revision ?? 0
  const now = new Date().toISOString()
  if (publicFeedback?.milestone) {
    const dedupeKey = `apply:${source.id}:${revision}:${feedbackDedupeHash([publicFeedback.milestone])}`
    const bounded = boundFeedbackText(publicFeedback.milestone, SUPER_FEEDBACK_MAX_TEXT)
    const saved = persistRoomFeedbackItem(room, {
      itemId: feedbackMilestoneId(source.id, dedupeKey),
      kind: "milestone",
      sourceMessageId: source.id,
      revision,
      ...(focus ? { ticketId: focus } : {}),
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      dedupeKey,
      text: bounded.text,
      ...(bounded.truncated ? { truncated: true } : {}),
      status: "completed",
      seq: 0,
      createdAt: now,
      updatedAt: now,
    })
    if (saved.created) created.push(saved.item)
  }
  const workIntents = intents.filter(item => item.operation !== "stop")
  if (!workIntents.length) return created
  const hasAck = (room.feedbackItems ?? []).some(item => item.kind === "ack" && item.sourceMessageId === source.id && item.revision === revision)
  if (!hasAck) {
    const targets = workIntents.map(item => {
      const targetTicket = room.tickets.find(t => t.id === item.ticketId)
      return { title: targetTicket?.title ?? "", deliverable: targetTicket?.latestAcceptance ?? targetTicket?.scope }
    })
    const ackText = publicFeedback?.ack || buildFallbackAck(source.text, targets)
    if (ackText) {
      const bounded = boundFeedbackText(ackText, SUPER_FEEDBACK_ACK_MAX_TEXT)
      const saved = persistRoomFeedbackItem(room, {
        itemId: feedbackAckId(source.id, revision),
        kind: "ack",
        sourceMessageId: source.id,
        revision,
        ...(focus ? { ticketId: focus } : {}),
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        dedupeKey: `ack:${source.id}:${revision}`,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
        status: "completed",
        seq: 0,
        createdAt: now,
        updatedAt: now,
      })
      if (saved.created) created.push(saved.item)
    }
  }
  for (const item of workIntents) {
    const turnId = item.deliveredTurnId
    persistRoomProcessBranch(room, source.id, revision, {
      ticketId: item.ticketId,
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      ...(item.inputId ? { inputId: item.inputId } : {}),
      ...(turnId ? { turnId } : {}),
      activityCount: 0,
    })
  }
  return created
}

/** Publish committed replay feedback, aborted turn states, and process index updates to subscribed viewers. */
export function publishProjectedWorkerFeedback(params: {
  uid: string
  workspaceId: SuperWorkspaceId
  room: SuperRoom
  projected: SuperEventProjectionFeedback | undefined
  hub: SuperFeedbackHub
}): void {
  const { uid, workspaceId, room, projected, hub } = params
  if (projected) {
    for (const item of projected.persisted) hub.upsertItem(uid, workspaceId, item)
    for (const item of projected.live) hub.upsertItem(uid, workspaceId, item)
    if (projected.abortedTurn) {
      hub.abortRequestPreviews(uid, workspaceId, projected.abortedTurn.sourceMessageId, projected.abortedTurn.revision, projected.abortedTurn.ticketId)
    }
    if (projected.processBranch) {
      const savedProcess = room.feedbackProcesses?.find(item => item.sourceMessageId === projected.processBranch!.sourceMessageId)
      if (savedProcess) hub.updateProcess(uid, workspaceId, savedProcess)
    }
  }
  hub.notifySnapshotDirty(uid, workspaceId, projected?.processBranch?.sourceMessageId)
}
