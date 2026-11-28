import { randomUUID } from "node:crypto"
import type { SuperWorkspaceId } from "@deskfleet/protocol/super-agent"
import { recordRoomRecentTicketAccent } from "./accent.ts"
import type { SuperRoom } from "./state.ts"
import {
  boundFeedbackText,
  SUPER_FEEDBACK_ACTIVITY_MAX_TEXT,
  type SuperFeedbackEvent,
  keepKnownToolTitle,
  type SuperFeedbackItem,
  type SuperFeedbackProcessBranch,
  type SuperFeedbackProcessIndex,
  type SuperFeedbackPush,
  type SuperFeedbackSnapshot,
  type SuperFeedbackStatus,
  type SuperFeedbackSubscribeResult,
} from "./feedback-helpers.ts"
export { reconstructRequestProcess } from "./feedback-process.ts"

const MAX_ROOM_EVENT_LOG = 512
const MAX_ROOM_LIVE_ITEMS = 256
const MAX_PERSISTED_FEEDBACK_ITEMS = 400
const MAX_PERSISTED_PROCESSES = 200
const DELTA_COALESCE_MS = 24

interface BufferedPush {
  cursor: number
  event: SuperFeedbackEvent
}

interface RoomSubscriber {
  subscriptionId: string
  push: (payload: SuperFeedbackPush) => void
}

interface PendingDelta {
  key: string
  itemId: string
  sourceMessageId: string
  revision: number
  kind: SuperFeedbackItem["kind"]
  offset: number
  delta: string
  status?: SuperFeedbackStatus
  updatedAt: string
  ticketId?: string
  sessionId?: string
  turnId?: string
  inputId?: string
  messageId?: string
  logicalId?: string
  activityKind?: SuperFeedbackItem["activityKind"]
  activityStatus?: SuperFeedbackItem["activityStatus"]
}

interface RoomFeed {
  workspaceId: SuperWorkspaceId
  cursor: number
  previewGeneration: string
  log: BufferedPush[]
  liveItems: Map<string, SuperFeedbackItem>
  liveProcesses: Map<string, SuperFeedbackProcessIndex>
  subscribers: Map<string, RoomSubscriber>
  pendingDeltas: Map<string, PendingDelta>
  flushTimer?: ReturnType<typeof setTimeout>
}

export interface SuperFeedbackMetrics {
  publicItemsEmitted: number
  deltasReceived: number
  deltasPushed: number
  resyncsRequested: number
  snapshotDirtyPushed: number
}

function roomKey(userId: string, workspaceId: SuperWorkspaceId): string {
  return JSON.stringify([userId, workspaceId])
}

/**
 * In-memory real-time feedback hub for SA rooms.
 * Keeps transient previews, tool progress, and streaming deltas off the SQLite hot path
 * while offering monotone cursor catch-up and clean subscription teardown.
 */
export class SuperFeedbackHub {
  readonly #rooms = new Map<string, RoomFeed>()
  readonly #metrics: SuperFeedbackMetrics = {
    publicItemsEmitted: 0,
    deltasReceived: 0,
    deltasPushed: 0,
    resyncsRequested: 0,
    snapshotDirtyPushed: 0,
  }

  metrics(): SuperFeedbackMetrics {
    return { ...this.#metrics }
  }

  #room(userId: string, workspaceId: SuperWorkspaceId): RoomFeed {
    const key = roomKey(userId, workspaceId)
    let feed = this.#rooms.get(key)
    if (!feed) {
      feed = {
        workspaceId,
        cursor: 0,
        previewGeneration: randomUUID(),
        log: [],
        liveItems: new Map(),
        liveProcesses: new Map(),
        subscribers: new Map(),
        pendingDeltas: new Map(),
      }
      this.#rooms.set(key, feed)
    }
    return feed
  }

  #publish(feed: RoomFeed, event: SuperFeedbackEvent): number {
    const cursor = ++feed.cursor
    feed.log.push({ cursor, event })
    if (feed.log.length > MAX_ROOM_EVENT_LOG) feed.log.splice(0, feed.log.length - MAX_ROOM_EVENT_LOG)
    for (const subscriber of feed.subscribers.values()) {
      try {
        subscriber.push({
          subscriptionId: subscriber.subscriptionId,
          workspaceId: feed.workspaceId,
          cursor,
          previewGeneration: feed.previewGeneration,
          event,
        })
      } catch {
        // Individual viewer channel failures are owned by AgentChannel / AuthorizedPeers.
      }
    }
    return cursor
  }

  #flushDeltas(feed: RoomFeed): void {
    if (feed.flushTimer) {
      clearTimeout(feed.flushTimer)
      feed.flushTimer = undefined
    }
    if (!feed.pendingDeltas.size) return
    const batch = [...feed.pendingDeltas.values()]
    feed.pendingDeltas.clear()
    for (const pending of batch) {
      this.#metrics.deltasPushed++
      this.#publish(feed, {
        type: "item_delta",
        itemId: pending.itemId,
        sourceMessageId: pending.sourceMessageId,
        revision: pending.revision,
        kind: pending.kind,
        offset: pending.offset,
        delta: pending.delta,
        status: pending.status,
        updatedAt: pending.updatedAt,
        ...(pending.ticketId ? { ticketId: pending.ticketId } : {}),
        ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
        ...(pending.inputId ? { inputId: pending.inputId } : {}),
        ...(pending.messageId ? { messageId: pending.messageId } : {}),
        ...(pending.logicalId ? { logicalId: pending.logicalId } : {}),
        ...(pending.activityKind ? { activityKind: pending.activityKind } : {}),
        ...(pending.activityStatus ? { activityStatus: pending.activityStatus } : {}),
      })
    }
  }

  #scheduleFlush(feed: RoomFeed): void {
    if (feed.flushTimer) return
    feed.flushTimer = setTimeout(() => this.#flushDeltas(feed), DELTA_COALESCE_MS)
    feed.flushTimer.unref()
  }

  #trimLiveItems(feed: RoomFeed): void {
    while (feed.liveItems.size > MAX_ROOM_LIVE_ITEMS) {
      const oldest = feed.liveItems.keys().next().value
      if (oldest === undefined) break
      feed.liveItems.delete(oldest)
    }
  }

  upsertItem(userId: string, workspaceId: SuperWorkspaceId, item: Omit<SuperFeedbackItem, "seq"> & { seq?: number }): SuperFeedbackItem {
    const feed = this.#room(userId, workspaceId)
    this.#flushDeltas(feed)
    const previous = feed.liveItems.get(item.itemId)
    if (previous && previous.revision > item.revision) return previous
    if (previous && previous.revision === item.revision) {
      if (previous.status === "aborted" && item.status === "streaming") return previous
      if (previous.status === "completed" && item.status === "streaming" && !(item.messageId && previous.messageId === item.messageId && item.text.length > previous.text.length && item.text.startsWith(previous.text))) {
        return previous
      }
      if (previous.status === "streaming" && item.status === "streaming" && previous.text.startsWith(item.text) && previous.text.length > item.text.length) {
        return previous
      }
    }
    const { updateOnly: _statusOnly, ...incoming } = item
    const text = keepKnownToolTitle(previous, item)
    const next: SuperFeedbackItem = {
      ...incoming,
      text,
      seq: previous?.seq ?? item.seq ?? feed.cursor + 1,
      deltaOffset: text.length,
    }
    feed.liveItems.set(next.itemId, next)
    this.#trimLiveItems(feed)
    if (!previous) this.#metrics.publicItemsEmitted++
    this.#publish(feed, { type: "item_upsert", item: structuredClone(next) })
    return next
  }

  appendDelta(
    userId: string,
    workspaceId: SuperWorkspaceId,
    input: {
      itemId: string
      kind: SuperFeedbackItem["kind"]
      sourceMessageId: string
      revision: number
      delta: string
      status?: SuperFeedbackStatus
      ticketId?: string
      sessionId?: string
      inputId?: string
      turnId?: string
      messageId?: string
      logicalId?: string
      activityKind?: SuperFeedbackItem["activityKind"]
      activityStatus?: SuperFeedbackItem["activityStatus"]
      createdAt?: string
      updatedAt?: string
    },
  ): SuperFeedbackItem | undefined {
    if (!input.delta) return undefined
    const feed = this.#room(userId, workspaceId)
    const now = input.updatedAt ?? new Date().toISOString()
    const existing = feed.liveItems.get(input.itemId)
    if (existing && existing.revision > input.revision) return existing
    const limit = input.kind === "activity" ? SUPER_FEEDBACK_ACTIVITY_MAX_TEXT : undefined
    const priorText = existing?.text ?? ""
    const offset = priorText.length
    const combined = priorText + input.delta
    const bounded = boundFeedbackText(combined, limit)
    const effectiveDelta = bounded.text.slice(offset)
    const next: SuperFeedbackItem = existing
      ? { ...existing, text: bounded.text, truncated: existing.truncated || bounded.truncated || undefined, status: input.status ?? existing.status, deltaOffset: bounded.text.length, updatedAt: now, ...(input.activityStatus ? { activityStatus: input.activityStatus } : {}) }
      : {
          itemId: input.itemId, kind: input.kind, sourceMessageId: input.sourceMessageId, revision: input.revision,
          ...(input.ticketId ? { ticketId: input.ticketId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.inputId ? { inputId: input.inputId } : {}), ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.messageId ? { messageId: input.messageId } : {}), ...(input.logicalId ? { logicalId: input.logicalId } : {}),
          ...(input.activityKind ? { activityKind: input.activityKind } : {}), ...(input.activityStatus ? { activityStatus: input.activityStatus } : {}),
          text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}), status: input.status ?? "streaming",
          seq: feed.cursor + 1, deltaOffset: bounded.text.length, createdAt: input.createdAt ?? now, updatedAt: now,
        }
    feed.liveItems.set(next.itemId, next)
    this.#trimLiveItems(feed)
    if (!existing) this.#metrics.publicItemsEmitted++
    if (!effectiveDelta) return next
    this.#metrics.deltasReceived++
    const pendingKey = `${input.itemId}:${input.revision}`
    const pending = feed.pendingDeltas.get(pendingKey)
    if (pending && pending.offset + pending.delta.length === offset) {
      pending.delta += effectiveDelta; pending.updatedAt = now
      if (input.status) pending.status = input.status
    } else {
      if (pending) this.#flushDeltas(feed)
      feed.pendingDeltas.set(pendingKey, {
        key: pendingKey, itemId: next.itemId, sourceMessageId: next.sourceMessageId, revision: next.revision,
        kind: next.kind, offset, delta: effectiveDelta, status: next.status, updatedAt: now,
        ticketId: next.ticketId, sessionId: next.sessionId, turnId: next.turnId, inputId: next.inputId,
        messageId: next.messageId, logicalId: next.logicalId, activityKind: next.activityKind, activityStatus: next.activityStatus,
      })
    }
    if (input.status && input.status !== "streaming") this.#flushDeltas(feed)
    else this.#scheduleFlush(feed)
    return next
  }

  setItemStatus(
    userId: string,
    workspaceId: SuperWorkspaceId,
    itemId: string,
    sourceMessageId: string,
    revision: number,
    status: SuperFeedbackStatus,
    truncated?: boolean,
  ): void {
    const feed = this.#room(userId, workspaceId)
    this.#flushDeltas(feed)
    const now = new Date().toISOString()
    const existing = feed.liveItems.get(itemId)
    if (existing) {
      if (existing.revision > revision) return
      existing.status = status
      existing.updatedAt = now
      if (truncated !== undefined) existing.truncated = truncated || undefined
    }
    this.#publish(feed, { type: "item_status", itemId, sourceMessageId, revision, status, updatedAt: now, ...(truncated !== undefined ? { truncated } : {}) })
  }

  abortRequestPreviews(userId: string, workspaceId: SuperWorkspaceId, sourceMessageId: string, revision: number, ticketId?: string): void {
    const feed = this.#rooms.get(roomKey(userId, workspaceId))
    if (!feed) return
    this.#flushDeltas(feed)
    const now = new Date().toISOString()
    for (const item of feed.liveItems.values()) {
      if (item.sourceMessageId !== sourceMessageId || item.revision !== revision) continue
      if (ticketId && item.ticketId !== ticketId) continue
      if (item.status !== "streaming") continue
      item.status = "aborted"
      item.updatedAt = now
      this.#publish(feed, { type: "item_status", itemId: item.itemId, sourceMessageId, revision, status: "aborted", updatedAt: now })
    }
  }

  updateProcess(userId: string, workspaceId: SuperWorkspaceId, process: SuperFeedbackProcessIndex): void {
    const feed = this.#room(userId, workspaceId)
    this.#flushDeltas(feed)
    feed.liveProcesses.set(process.sourceMessageId, structuredClone(process))
    this.#publish(feed, { type: "process_update", process: structuredClone(process) })
  }

  notifySnapshotDirty(userId: string, workspaceId: SuperWorkspaceId, sourceMessageId?: string): void {
    const feed = this.#rooms.get(roomKey(userId, workspaceId))
    if (!feed) return
    this.#flushDeltas(feed)
    this.#metrics.snapshotDirtyPushed++
    this.#publish(feed, { type: "snapshot_dirty", ...(sourceMessageId ? { sourceMessageId } : {}) })
  }

  /** Rotate preview generation (e.g. after a service reset) so reconnecting viewers resync cleanly. */
  resetPreviewGeneration(userId: string, workspaceId: SuperWorkspaceId): void {
    const feed = this.#rooms.get(roomKey(userId, workspaceId))
    if (!feed) return
    this.#flushDeltas(feed)
    feed.previewGeneration = randomUUID()
    feed.log = []
  }

  snapshot(userId: string, room: SuperRoom): SuperFeedbackSnapshot {
    const feed = this.#room(userId, room.workspaceId)
    this.#flushDeltas(feed)
    const revisions = new Map(room.messages.filter(m => m.role === "user").map(m => [m.id, m.revision ?? 0]))
    const merged = new Map<string, SuperFeedbackItem>()
    for (const persisted of room.feedbackItems ?? []) {
      const currentRev = revisions.get(persisted.sourceMessageId)
      if (currentRev !== undefined && persisted.revision < currentRev) continue
      merged.set(persisted.itemId, structuredClone(persisted))
    }
    for (const live of feed.liveItems.values()) {
      const currentRev = revisions.get(live.sourceMessageId)
      if (currentRev !== undefined && live.revision < currentRev) continue
      const existing = merged.get(live.itemId)
      if (!existing) {
        merged.set(live.itemId, structuredClone(live))
      } else if (live.kind === "activity" || live.kind === "final_preview") {
        // Live activity/previews win over any stale entry with the same ID.
        if (live.revision >= existing.revision) merged.set(live.itemId, structuredClone(live))
      } else if (existing.status === "streaming" && (live.status !== "streaming" || (live.text.length > existing.text.length && live.text.startsWith(existing.text)))) {
        merged.set(live.itemId, structuredClone(live))
      }
    }
    const processes = new Map<string, SuperFeedbackProcessIndex>()
    for (const proc of room.feedbackProcesses ?? []) {
      const currentRev = revisions.get(proc.sourceMessageId)
      if (currentRev !== undefined && proc.revision < currentRev) continue
      processes.set(proc.sourceMessageId, structuredClone(proc))
    }
    for (const [sourceId, proc] of feed.liveProcesses) {
      const currentRev = revisions.get(sourceId)
      if (currentRev !== undefined && proc.revision < currentRev) continue
      const prior = processes.get(sourceId)
      if (!prior || proc.revision > prior.revision) {
        processes.set(sourceId, structuredClone(proc))
      } else if (proc.revision === prior.revision) {
        processes.set(sourceId, mergeProcessIndex(prior, proc))
      }
    }
    // Count live activity items so the UI knows immediately when "查看进展" has readable content.
    const liveActivityCounts = new Map<string, number>()
    for (const item of merged.values()) {
      if (item.kind !== "activity") continue
      const key = `${item.sourceMessageId}:${item.revision}`
      liveActivityCounts.set(key, (liveActivityCounts.get(key) ?? 0) + 1)
    }
    for (const [key, count] of liveActivityCounts) {
      const splitIndex = key.lastIndexOf(":")
      const sourceMessageId = key.slice(0, splitIndex)
      const revision = Number(key.slice(splitIndex + 1))
      const existing = processes.get(sourceMessageId)
      if (!existing || existing.revision < revision) {
        processes.set(sourceMessageId, { sourceMessageId, revision, activityCount: count, branches: [] })
      } else if (existing.revision === revision && count > existing.activityCount) {
        existing.activityCount = count
      }
    }
    const items = [...merged.values()].sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
    return {
      cursor: feed.cursor,
      previewGeneration: feed.previewGeneration,
      items,
      processes: [...processes.values()],
    }
  }

  subscribe(
    userId: string,
    workspaceId: SuperWorkspaceId,
    options: { afterCursor?: number; previewGeneration?: string },
    push: (payload: SuperFeedbackPush) => void,
  ): { initial: SuperFeedbackSubscribeResult; unsubscribe: () => void } {
    const feed = this.#room(userId, workspaceId)
    this.#flushDeltas(feed)
    const subscriptionId = randomUUID()
    let resyncRequired = false
    let events: BufferedPush[] = []
    if (options.previewGeneration && options.previewGeneration !== feed.previewGeneration) {
      resyncRequired = true
      this.#metrics.resyncsRequested++
    } else if (options.afterCursor !== undefined) {
      if (options.afterCursor > feed.cursor) {
        resyncRequired = true
        this.#metrics.resyncsRequested++
      } else if (options.afterCursor < feed.cursor) {
        const earliest = feed.log[0]?.cursor
        if (earliest === undefined || options.afterCursor + 1 < earliest) {
          resyncRequired = true
          this.#metrics.resyncsRequested++
        } else {
          events = feed.log.filter(entry => entry.cursor > options.afterCursor!).map(entry => structuredClone(entry))
        }
      }
    }
    const subscriber: RoomSubscriber = { subscriptionId, push }
    feed.subscribers.set(subscriptionId, subscriber)
    return {
      initial: {
        subscriptionId,
        workspaceId,
        cursor: feed.cursor,
        previewGeneration: feed.previewGeneration,
        resyncRequired,
        events,
      },
      unsubscribe: () => {
        feed.subscribers.delete(subscriptionId)
      },
    }
  }

  liveActivityForRequest(userId: string, workspaceId: SuperWorkspaceId, sourceMessageId: string, revision: number): SuperFeedbackItem[] {
    const feed = this.#rooms.get(roomKey(userId, workspaceId))
    if (!feed) return []
    this.#flushDeltas(feed)
    return [...feed.liveItems.values()]
      .filter(item => item.kind === "activity" && item.sourceMessageId === sourceMessageId && item.revision === revision)
      .sort((a, b) => a.seq - b.seq)
      .map(item => structuredClone(item))
  }

  close(): void {
    for (const feed of this.#rooms.values()) {
      if (feed.flushTimer) clearTimeout(feed.flushTimer)
      feed.flushTimer = undefined
      feed.subscribers.clear()
      feed.pendingDeltas.clear()
    }
    this.#rooms.clear()
  }
}

function mergeBranchPair(prior: SuperFeedbackProcessBranch, incoming: SuperFeedbackProcessBranch): SuperFeedbackProcessBranch {
  return {
    ...prior,
    ...incoming,
    sessionId: incoming.sessionId ?? prior.sessionId,
    inputId: incoming.inputId ?? prior.inputId,
    turnId: incoming.turnId ?? prior.turnId,
    fromSeq: prior.fromSeq && incoming.fromSeq
      ? (BigInt(prior.fromSeq) <= BigInt(incoming.fromSeq) ? prior.fromSeq : incoming.fromSeq)
      : (prior.fromSeq ?? incoming.fromSeq),
    throughSeq: prior.throughSeq && incoming.throughSeq
      ? (BigInt(prior.throughSeq) >= BigInt(incoming.throughSeq) ? prior.throughSeq : incoming.throughSeq)
      : (incoming.throughSeq ?? prior.throughSeq),
    activityCount: Math.max(prior.activityCount, incoming.activityCount),
    unboundedOutcome: incoming.unboundedOutcome ?? prior.unboundedOutcome,
  }
}

function mergeBranchInto(branches: SuperFeedbackProcessBranch[], rawIncoming: SuperFeedbackProcessBranch): void {
  const incoming = structuredClone(rawIncoming)
  const sameSession = (a: SuperFeedbackProcessBranch, b: SuperFeedbackProcessBranch) =>
    !a.sessionId || !b.sessionId || a.sessionId === b.sessionId
  let idx = -1
  if (incoming.turnId) {
    idx = branches.findIndex(b => b.ticketId === incoming.ticketId && b.turnId === incoming.turnId)
  }
  if (idx < 0 && incoming.inputId) {
    idx = branches.findIndex(b =>
      b.ticketId === incoming.ticketId
      && b.inputId === incoming.inputId
      && (!b.turnId || !incoming.turnId || b.turnId === incoming.turnId))
  }
  if (idx < 0) {
    if (incoming.turnId || incoming.inputId) {
      // Upgrade an unbound dispatch placeholder for the same ticket/session in place instead of keeping both.
      idx = branches.findIndex(b => b.ticketId === incoming.ticketId && !b.turnId && !b.inputId && sameSession(b, incoming))
    } else {
      // Never duplicate an unbound placeholder when a branch for this ticket/session already exists.
      idx = branches.findIndex(b => b.ticketId === incoming.ticketId && sameSession(b, incoming))
    }
  }
  if (idx < 0) branches.push(incoming)
  else branches[idx] = mergeBranchPair(branches[idx]!, incoming)
}

function mergeProcessIndex(a: SuperFeedbackProcessIndex, b: SuperFeedbackProcessIndex): SuperFeedbackProcessIndex {
  const branches: SuperFeedbackProcessBranch[] = []
  for (const branch of a.branches) mergeBranchInto(branches, branch)
  for (const branch of b.branches) mergeBranchInto(branches, branch)
  const branchTotal = branches.reduce((sum, item) => sum + item.activityCount, 0)
  return {
    sourceMessageId: a.sourceMessageId,
    revision: Math.max(a.revision, b.revision),
    activityCount: Math.max(a.activityCount, b.activityCount, branchTotal),
    branches,
  }
}

/** Persist or update a public item (`ack` or `milestone`) transactionally with streaming/boundary progression. */
export function persistRoomFeedbackItem(room: SuperRoom, item: SuperFeedbackItem): { item: SuperFeedbackItem; created: boolean; changed: boolean } {
  room.feedbackItems ??= []
  const existing = room.feedbackItems.find(entry =>
    entry.itemId === item.itemId || (item.dedupeKey && entry.sourceMessageId === item.sourceMessageId && entry.kind === item.kind && entry.dedupeKey === item.dedupeKey))
  if (existing) {
    if (existing.revision > item.revision) return { item: existing, created: false, changed: false }
    if (existing.revision < item.revision) {
      Object.assign(existing, structuredClone(item))
      return { item: existing, created: false, changed: true }
    }
    if (existing.status === "streaming") {
      if (item.status !== "streaming") {
        const nextText = item.text || existing.text
        Object.assign(existing, { text: nextText, status: item.status, updatedAt: item.updatedAt, truncated: item.truncated ?? existing.truncated, deltaOffset: nextText.length })
        return { item: existing, created: false, changed: true }
      }
      if (item.text !== existing.text && (item.text.length >= existing.text.length || !existing.text.startsWith(item.text))) {
        Object.assign(existing, { text: item.text, updatedAt: item.updatedAt, truncated: item.truncated ?? existing.truncated, deltaOffset: item.text.length })
        return { item: existing, created: false, changed: true }
      }
      return { item: existing, created: false, changed: false }
    }
    if (item.messageId && existing.messageId === item.messageId && item.text.length > existing.text.length && item.text.startsWith(existing.text)) {
      const nextStatus = item.status === "aborted" ? "aborted" : existing.status
      Object.assign(existing, { text: item.text, status: nextStatus, updatedAt: item.updatedAt, truncated: item.truncated ?? existing.truncated, deltaOffset: item.text.length })
      return { item: existing, created: false, changed: true }
    }
    return { item: existing, created: false, changed: false }
  }
  const copy = structuredClone(item)
  room.feedbackItems.push(copy)
  if (copy.ticketId && (copy.kind === "milestone" || copy.kind === "ack")) {
    recordRoomRecentTicketAccent(room, copy.ticketId)
  }
  if (room.feedbackItems.length > MAX_PERSISTED_FEEDBACK_ITEMS) {
    room.feedbackItems.splice(0, room.feedbackItems.length - MAX_PERSISTED_FEEDBACK_ITEMS)
  }
  return { item: copy, created: true, changed: true }
}

/** Record or merge a durable process index entry for a request inside an existing state transaction. */
export function persistRoomProcessBranch(
  room: SuperRoom,
  sourceMessageId: string,
  revision: number,
  branch: SuperFeedbackProcessBranch,
): SuperFeedbackProcessIndex {
  room.feedbackProcesses ??= []
  const idx = room.feedbackProcesses.findIndex(item => item.sourceMessageId === sourceMessageId)
  const incoming: SuperFeedbackProcessIndex = {
    sourceMessageId,
    revision,
    activityCount: branch.activityCount,
    branches: [branch],
  }
  if (idx < 0) {
    room.feedbackProcesses.push(incoming)
    if (room.feedbackProcesses.length > MAX_PERSISTED_PROCESSES) {
      room.feedbackProcesses.splice(0, room.feedbackProcesses.length - MAX_PERSISTED_PROCESSES)
    }
    return incoming
  }
  const current = room.feedbackProcesses[idx]!
  const next = current.revision < revision ? incoming : mergeProcessIndex(current, incoming)
  room.feedbackProcesses[idx] = next
  return next
}
