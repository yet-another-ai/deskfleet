import type { AgentEvent, AgentInput, AgentPreview, AgentSnapshot, AgentTurn } from "@deskfleet/protocol/agent"
import type { DispatchIntent, SuperRoom, SuperUserState } from "./state.ts"

export interface BoundWorkerContext {
  room: SuperRoom
  ticket: SuperRoom["tickets"][number]
  intent: DispatchIntent
  sourceMessageId: string
  revision: number
}

export type AttributionResolution =
  | { status: "matched"; bound: BoundWorkerContext }
  | { status: "pending" }
  | { status: "unmatched" }

export type PendingWorkerLiveItem =
  | { kind: "preview"; uid: string; preview: AgentPreview; turnId?: string; inputId?: string }
  | { kind: "acp"; uid: string; event: AgentEvent; turnId?: string; inputId?: string }

interface TrackedTurn {
  initialInputId?: string
  active: boolean
  inputIds: Set<string>
}

interface TrackedInput {
  turnId?: string
  actualDelivery?: "turn_start" | "steer"
  submissionCommandId?: string
}

interface PreviewSeqRange {
  streamId: string
  itemId: string
  startSeq: bigint
  endSeq: bigint
}

interface AnonActivitySegment {
  segmentId: string
  lastSeq: bigint
}

interface SessionCorrelation {
  turns: Map<string, TrackedTurn>
  inputs: Map<string, TrackedInput>
  pending: Map<string, PendingWorkerLiveItem[]>
  /** Coalesced contiguous uncommitted preview seq ranges so long batches never evict early chunks. */
  previewRanges: PreviewSeqRange[]
  /** Highest committed ACP event seq already applied per item to reject duplicate replay previews. */
  committedSeq: Map<string, bigint>
  /** Open anonymous commentary segment (`seg:<startSeq>`) per turn so preview & commit share one itemId. */
  activeAnonActivity: Map<string, AnonActivitySegment>
}

const MAX_PENDING_TURNS_PER_SESSION = 16
const MAX_PENDING_ITEMS_PER_TURN = 128
const MAX_TRACKED_TURNS_PER_SESSION = 64
const MAX_TRACKED_INPUTS_PER_SESSION = 128
const MAX_PREVIEW_RANGES_PER_SESSION = 256
const MAX_ANON_SEGMENTS_PER_SESSION = 64

export function predictPreviewSeq(baseSeq: string, offset: number, idx: number): bigint | undefined {
  try {
    return BigInt(baseSeq || "0") + BigInt(offset) + BigInt(idx) + 1n
  } catch {
    return undefined
  }
}

const isLiveTurnState = (state: AgentTurn["state"]) =>
  state === "starting" || state === "running" || state === "cancelling"

function buildBound(room: SuperRoom, ticket: SuperRoom["tickets"][number], intent: DispatchIntent): BoundWorkerContext {
  const source = room.messages.find(message => message.id === intent.messageId && message.role === "user")
  return {
    room,
    ticket,
    intent,
    sourceMessageId: intent.messageId,
    revision: source?.revision ?? 0,
  }
}

/**
 * Tracks per-session Worker turn/input correlation and buffers live events whose
 * SA dispatch receipt has not yet been checkpointed, while strictly refusing to
 * misattribute independent manual Worker turns onto earlier SA requests.
 */
export class WorkerFeedbackAttribution {
  readonly #sessions = new Map<string, SessionCorrelation>()

  #session(sessionId: string): SessionCorrelation {
    let entry = this.#sessions.get(sessionId)
    if (!entry) {
      entry = {
        turns: new Map(),
        inputs: new Map(),
        pending: new Map(),
        previewRanges: [],
        committedSeq: new Map(),
        activeAnonActivity: new Map(),
      }
      this.#sessions.set(sessionId, entry)
    }
    return entry
  }

  /**
   * Resolve or open the active anonymous commentary segment (`seg:<startSeq>`) for `(sessionId, turnId)`
   * so uncommitted previews, committed journal events, and history reconstruction share one itemId.
   */
  resolveAnonActivitySegment(sessionId: string, turnId: string, seq: bigint): string {
    const entry = this.#session(sessionId)
    const active = entry.activeAnonActivity.get(turnId)
    if (active) {
      if (seq > active.lastSeq) active.lastSeq = seq
      return active.segmentId
    }
    const segmentId = `seg:${seq.toString()}`
    entry.activeAnonActivity.set(turnId, { segmentId, lastSeq: seq })
    while (entry.activeAnonActivity.size > MAX_ANON_SEGMENTS_PER_SESSION) {
      const oldest = entry.activeAnonActivity.keys().next().value
      if (oldest === undefined) break
      entry.activeAnonActivity.delete(oldest)
    }
    return segmentId
  }

  /**
   * Close an open anonymous commentary segment when a tool/plan/permission/message boundary arrives.
   * When `seq` is provided, avoid clobbering a newer segment opened ahead of a slower commit.
   */
  closeAnonActivitySegment(sessionId: string, turnId?: string, seq?: bigint): void {
    const entry = this.#sessions.get(sessionId)
    if (!entry) return
    if (!turnId) {
      entry.activeAnonActivity.clear()
      return
    }
    const active = entry.activeAnonActivity.get(turnId)
    if (!active) return
    if (seq !== undefined && seq < active.lastSeq) return
    entry.activeAnonActivity.delete(turnId)
  }

  /** Look up the exact itemId already used to preview a committed event seq (if any). */
  previewedItemForSeq(sessionId: string, seq: string): string | undefined {
    const entry = this.#sessions.get(sessionId)
    if (!entry) return undefined
    let n: bigint
    try {
      n = BigInt(seq)
    } catch {
      return undefined
    }
    for (let i = entry.previewRanges.length - 1; i >= 0; i--) {
      const range = entry.previewRanges[i]!
      if (n >= range.startSeq && n <= range.endSeq) return range.itemId
    }
    return undefined
  }

  /**
   * Deduplicate uncommitted `AgentPreview` chunks by deterministic journal seq
   * (`baseSeq + offset + idx + 1n`) using coalesced contiguous ranges so long batches
   * (e.g. >512 chunks) never evict earlier chunks before journal commit.
   */
  recordPreviewChunk(sessionId: string, streamId: string, baseSeq: string, offset: number, idx: number, itemId: string): boolean {
    const entry = this.#session(sessionId)
    const predicted = predictPreviewSeq(baseSeq, offset, idx)
    if (predicted === undefined) return true
    const alreadyCommitted = entry.committedSeq.get(itemId)
    if (alreadyCommitted !== undefined && predicted <= alreadyCommitted) return false
    for (const range of entry.previewRanges) {
      if (range.itemId === itemId && predicted >= range.startSeq && predicted <= range.endSeq) {
        return false
      }
    }
    for (let i = entry.previewRanges.length - 1; i >= 0; i--) {
      const range = entry.previewRanges[i]!
      if (range.streamId !== streamId || range.itemId !== itemId) continue
      if (range.endSeq + 1n === predicted) {
        range.endSeq = predicted
        return true
      }
      if (predicted + 1n === range.startSeq) {
        range.startSeq = predicted
        return true
      }
    }
    entry.previewRanges.push({ streamId, itemId, startSeq: predicted, endSeq: predicted })
    if (entry.previewRanges.length > MAX_PREVIEW_RANGES_PER_SESSION) {
      entry.previewRanges.splice(0, entry.previewRanges.length - MAX_PREVIEW_RANGES_PER_SESSION)
    }
    return true
  }

  /**
   * Reconcile a committed ACP text chunk against previously previewed seq ranges for the same item.
   * Returns true if the chunk was ALREADY emitted during live preview (caller should NOT append again).
   */
  consumeCommittedChunk(sessionId: string, seq: string, itemId: string): boolean {
    const entry = this.#session(sessionId)
    let n: bigint
    try {
      n = BigInt(seq)
    } catch {
      return false
    }
    const prev = entry.committedSeq.get(itemId)
    if (prev === undefined || n > prev) entry.committedSeq.set(itemId, n)
    for (let i = 0; i < entry.previewRanges.length; i++) {
      const range = entry.previewRanges[i]!
      if (range.itemId !== itemId || n < range.startSeq || n > range.endSeq) continue
      if (range.startSeq === range.endSeq) {
        entry.previewRanges.splice(i, 1)
      } else if (n === range.startSeq) {
        range.startSeq = n + 1n
      } else if (n === range.endSeq) {
        range.endSeq = n - 1n
      } else {
        entry.previewRanges.splice(
          i,
          1,
          { streamId: range.streamId, itemId: range.itemId, startSeq: range.startSeq, endSeq: n - 1n },
          { streamId: range.streamId, itemId: range.itemId, startSeq: n + 1n, endSeq: range.endSeq },
        )
      }
      return true
    }
    return false
  }

  #recordTurn(entry: SessionCorrelation, turn: AgentTurn): void {
    const existing = entry.turns.get(turn.id)
    const inputIds = existing?.inputIds ?? new Set<string>()
    if (turn.initialInputId) inputIds.add(turn.initialInputId)
    entry.turns.set(turn.id, {
      initialInputId: turn.initialInputId || existing?.initialInputId,
      active: isLiveTurnState(turn.state),
      inputIds,
    })
    while (entry.turns.size > MAX_TRACKED_TURNS_PER_SESSION) {
      const oldest = entry.turns.keys().next().value
      if (oldest === undefined) break
      entry.turns.delete(oldest)
    }
  }

  #recordInput(entry: SessionCorrelation, input: AgentInput): void {
    entry.inputs.set(input.id, {
      turnId: input.turnId,
      actualDelivery: input.actualDelivery,
      submissionCommandId: input.submissionCommandId,
    })
    if (input.turnId) {
      const turn = entry.turns.get(input.turnId)
      if (turn) turn.inputIds.add(input.id)
      else entry.turns.set(input.turnId, { active: true, inputIds: new Set([input.id]) })
    }
    while (entry.inputs.size > MAX_TRACKED_INPUTS_PER_SESSION) {
      const oldest = entry.inputs.keys().next().value
      if (oldest === undefined) break
      entry.inputs.delete(oldest)
    }
  }

  observeEvent(event: AgentEvent): void {
    if (event.kind === "turn") {
      const turn = event.payload as AgentTurn
      this.#recordTurn(this.#session(event.sessionId), turn)
      if (!isLiveTurnState(turn.state)) {
        this.closeAnonActivitySegment(event.sessionId, turn.id)
      }
    } else if (event.kind === "input") {
      this.#recordInput(this.#session(event.sessionId), event.payload as AgentInput)
    } else if (event.kind === "permission" || event.kind === "elicitation") {
      let seq: bigint | undefined
      try { seq = BigInt(event.seq) } catch { seq = undefined }
      this.closeAnonActivitySegment(event.sessionId, event.turnId, seq)
    }
  }

  observeSnapshot(snapshot: AgentSnapshot): void {
    const entry = this.#session(snapshot.session.id)
    for (const turn of snapshot.turns) this.#recordTurn(entry, turn)
    for (const input of snapshot.inputs) this.#recordInput(entry, input)
  }

  resolve(
    state: SuperUserState | undefined,
    sessionId: string,
    turnId?: string,
    inputId?: string,
  ): AttributionResolution {
    if (!state) return { status: "unmatched" }
    const room = state.rooms.find(candidate => candidate.tickets.some(item => item.sessionId === sessionId))
    const ticket = room?.tickets.find(item => item.sessionId === sessionId)
    if (!room || !ticket) return { status: "unmatched" }
    const intents = state.intents.filter(item =>
      item.roomId === room.workspaceId
      && item.ticketId === ticket.id
      && item.sessionId === sessionId
      && item.phase !== "withdrawn"
      && item.operation !== "stop")
    if (!intents.length) return { status: "unmatched" }
    // Without any turn or input identifier we cannot prove ownership; never guess an earlier SA request.
    if (!turnId && !inputId) return { status: "unmatched" }

    const corr = this.#sessions.get(sessionId)
    const knownTurn = turnId ? corr?.turns.get(turnId) : undefined
    const resolvedInputId = inputId ?? knownTurn?.initialInputId

    // 1. Primary correlation: exact input ID (including turn.initialInputId).
    if (resolvedInputId) {
      const byInput = intents.find(item => item.inputId === resolvedInputId)
      if (byInput) return { status: "matched", bound: buildBound(room, ticket, byInput) }
    }

    // 2. Confirmed turn correlation (including shared/steered turns where an SA input joined an existing turn).
    if (turnId) {
      const byDeliveredTurn = intents.find(item => item.deliveredTurnId === turnId)
      if (byDeliveredTurn) return { status: "matched", bound: buildBound(room, ticket, byDeliveredTurn) }
      if (knownTurn?.inputIds.size) {
        const byTurnInput = intents.find(item => !!item.inputId && knownTurn.inputIds.has(item.inputId))
        if (byTurnInput) return { status: "matched", bound: buildBound(room, ticket, byTurnInput) }
      }
      if (corr) {
        for (const [trackedInputId, tracked] of corr.inputs) {
          if (tracked.turnId !== turnId || !tracked.actualDelivery) continue
          const byTracked = intents.find(item => item.inputId === trackedInputId)
          if (byTracked) return { status: "matched", bound: buildBound(room, ticket, byTracked) }
        }
      }
    }

    // 3. Crossing-receipt check: only buffer while an in-flight SA dispatch for this session could still own this turn.
    const awaitingReceipt = intents.some(item => item.phase === "planned" || item.phase === "working")
    const awaitingTurnBinding = !resolvedInputId && intents.some(item =>
      item.phase === "sent" && !!item.inputId && !item.deliveredTurnId)
    if (knownTurn && !knownTurn.active && !awaitingReceipt) {
      return { status: "unmatched" }
    }
    if (awaitingReceipt || awaitingTurnBinding) {
      return { status: "pending" }
    }
    return { status: "unmatched" }
  }

  buffer(sessionId: string, turnId: string | undefined, item: PendingWorkerLiveItem): void {
    const entry = this.#session(sessionId)
    const key = turnId ?? "__no_turn__"
    let list = entry.pending.get(key)
    if (!list) {
      list = []
      entry.pending.set(key, list)
      while (entry.pending.size > MAX_PENDING_TURNS_PER_SESSION) {
        const oldest = entry.pending.keys().next().value
        if (oldest === undefined) break
        entry.pending.delete(oldest)
      }
    }
    list.push(item)
    if (list.length > MAX_PENDING_ITEMS_PER_TURN) {
      list.splice(0, list.length - MAX_PENDING_ITEMS_PER_TURN)
    }
  }

  hasPending(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId)
    return !!entry && entry.pending.size > 0
  }

  drain(
    sessionId: string,
    evaluate: (item: PendingWorkerLiveItem) => "matched" | "pending" | "unmatched",
    filterUid?: string,
  ): void {
    const entry = this.#sessions.get(sessionId)
    if (!entry || !entry.pending.size) return
    for (const [key, list] of [...entry.pending.entries()]) {
      const remaining: PendingWorkerLiveItem[] = []
      for (const item of list) {
        if (filterUid && item.uid !== filterUid) {
          remaining.push(item)
          continue
        }
        const outcome = evaluate(item)
        if (outcome === "pending") remaining.push(item)
      }
      if (remaining.length) entry.pending.set(key, remaining)
      else entry.pending.delete(key)
    }
  }

  clear(): void {
    this.#sessions.clear()
  }
}
