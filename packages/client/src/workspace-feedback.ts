import type {
  SuperFeedbackEvent,
  SuperFeedbackItem,
  SuperFeedbackProcessIndex,
  SuperFeedbackProcessResult,
  SuperFeedbackPush,
  SuperMessage,
  SuperSnapshot,
  SuperWorkspaceId,
} from "@deskfleet/protocol/super-agent"

export interface LoadedRequestProcess {
  sourceMessageId?: string
  revision: number
  items: SuperFeedbackItem[]
  hasMore: boolean
  nextAfterSeq?: string
  loading: boolean
  error?: string
}

export interface WorkspaceRequestFeedback {
  sourceMessageId: string
  revision: number
  ack?: SuperFeedbackItem
  milestones: SuperFeedbackItem[]
  /** Live final answer previews not yet superseded by a formal Worker result message. */
  finalPreviews: SuperFeedbackItem[]
  activities: SuperFeedbackItem[]
  process?: SuperFeedbackProcessIndex
  /** True only when there is actual readable activity/process history to expand. */
  hasProcess: boolean
  loadingProcess: boolean
  hasMoreProcess: boolean
  nextAfterSeq?: string
  processError?: string
}

export interface FeedbackState {
  workspaceId: SuperWorkspaceId
  cursor: number
  previewGeneration: string
  items: Map<string, SuperFeedbackItem>
  processes: Map<string, SuperFeedbackProcessIndex>
  loadedProcesses: Map<string, LoadedRequestProcess>
  loadedProcessesByRevision?: Map<string, LoadedRequestProcess>
}

/** Generic placeholder that hosts emit for a tool whose update carries no title. */
const LEGACY_UPDATE_TITLE = "Running tool"

export function createFeedbackState(workspaceId: SuperWorkspaceId): FeedbackState {
  return {
    workspaceId,
    cursor: 0,
    previewGeneration: "",
    items: new Map(),
    processes: new Map(),
    loadedProcesses: new Map(),
    loadedProcessesByRevision: new Map(),
  }
}

export function clearFeedbackState(state: FeedbackState): void {
  state.cursor = 0
  state.previewGeneration = ""
  state.items.clear()
  state.processes.clear()
  state.loadedProcesses.clear()
  state.loadedProcessesByRevision?.clear()
}

export function loadedProcessKey(sourceMessageId: string, revision: number): string {
  return JSON.stringify([sourceMessageId, revision])
}

export function getLoadedProcess(
  state: FeedbackState,
  sourceMessageId: string,
  revision: number,
): LoadedRequestProcess | undefined {
  const exact = state.loadedProcessesByRevision?.get(loadedProcessKey(sourceMessageId, revision))
  if (exact) return exact
  const legacy = state.loadedProcesses.get(sourceMessageId)
  return legacy && legacy.revision === revision ? legacy : undefined
}

export function setLoadedProcess(
  state: FeedbackState,
  sourceMessageId: string,
  revision: number,
  value: Omit<LoadedRequestProcess, "sourceMessageId" | "revision">,
): void {
  const entry: LoadedRequestProcess = {
    ...value,
    sourceMessageId,
    revision,
  }
  state.loadedProcessesByRevision ??= new Map()
  state.loadedProcessesByRevision.set(loadedProcessKey(sourceMessageId, revision), entry)
  const existing = state.loadedProcesses.get(sourceMessageId)
  if (!existing || revision >= existing.revision) {
    state.loadedProcesses.set(sourceMessageId, entry)
  }
}

export function applySnapshotFeedback(
  state: FeedbackState,
  snapshot: SuperSnapshot,
  options: { replace?: boolean } = {},
): void {
  if (!snapshot.supportsReplyFeedback || !snapshot.feedback) {
    clearFeedbackState(state)
    return
  }
  const fb = snapshot.feedback
  const generationChanged = !!state.previewGeneration && state.previewGeneration !== fb.previewGeneration
  const replacing = options.replace === true || generationChanged
  state.previewGeneration = fb.previewGeneration
  state.cursor = replacing ? fb.cursor : Math.max(state.cursor, fb.cursor)
  const nextItems = new Map<string, SuperFeedbackItem>()
  for (const item of fb.items) nextItems.set(item.itemId, { ...item })
  // Keep any in-flight live items from the same preview generation with a strictly newer cursor/offset.
  if (!replacing) {
    for (const [id, existing] of state.items) {
      const fromSnap = nextItems.get(id)
      if (!fromSnap && existing.seq > fb.cursor) nextItems.set(id, existing)
      else if (fromSnap && existing.revision === fromSnap.revision && (existing.deltaOffset ?? existing.text.length) > (fromSnap.deltaOffset ?? fromSnap.text.length) && fromSnap.status === "streaming") {
        nextItems.set(id, existing)
      }
    }
  }
  state.items = nextItems
  const nextProcesses = new Map<string, SuperFeedbackProcessIndex>()
  for (const proc of fb.processes) nextProcesses.set(proc.sourceMessageId, { ...proc, branches: proc.branches.map(b => ({ ...b })) })
  state.processes = nextProcesses
}

export interface FeedbackPushOutcome {
  changed: boolean
  resyncRequired: boolean
  snapshotDirty: boolean
}

export function applyFeedbackEvent(
  state: FeedbackState,
  event: SuperFeedbackEvent,
  cursor: number,
  revisions: ReadonlyMap<string, number>,
): FeedbackPushOutcome {
  if (event.type === "snapshot_dirty") {
    return { changed: false, resyncRequired: false, snapshotDirty: true }
  }
  if (event.type === "process_update") {
    const currentRev = revisions.get(event.process.sourceMessageId)
    if (currentRev !== undefined && event.process.revision < currentRev) {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    state.processes.set(event.process.sourceMessageId, { ...event.process, branches: event.process.branches.map(b => ({ ...b })) })
    return { changed: true, resyncRequired: false, snapshotDirty: false }
  }
  if (event.type === "item_upsert") {
    const item = event.item
    const currentRev = revisions.get(item.sourceMessageId)
    if (currentRev !== undefined && item.revision < currentRev) {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    const existing = state.items.get(item.itemId)
    if (existing && existing.revision > item.revision) {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    // Never revert an aborted/stopped item back to streaming, nor regress a completed/longer streaming item backwards.
    if (existing && existing.revision === item.revision) {
      if (existing.status === "aborted" && item.status === "streaming") {
        return { changed: false, resyncRequired: false, snapshotDirty: false }
      }
      if (existing.status === "completed" && item.status === "streaming" && !(item.messageId && existing.messageId === item.messageId && item.text.length > existing.text.length && item.text.startsWith(existing.text))) {
        return { changed: false, resyncRequired: false, snapshotDirty: false }
      }
      if (existing.status === "streaming" && item.status === "streaming" && existing.text.startsWith(item.text) && existing.text.length > item.text.length) {
        return { changed: false, resyncRequired: false, snapshotDirty: false }
      }
    }
    const { updateOnly, ...incoming } = item
    // A title-less tool status update (or an older host's generic placeholder) keeps the known title.
    const keepTitle = !!existing?.text && existing.text !== LEGACY_UPDATE_TITLE && incoming.activityKind === "tool"
      && (updateOnly === true || !incoming.text.trim() || incoming.text === LEGACY_UPDATE_TITLE)
    const text = keepTitle ? existing!.text : incoming.text
    state.items.set(item.itemId, { ...incoming, text, seq: existing?.seq || item.seq || cursor, deltaOffset: keepTitle ? text.length : item.deltaOffset ?? text.length })
    return { changed: true, resyncRequired: false, snapshotDirty: false }
  }
  if (event.type === "item_status") {
    const currentRev = revisions.get(event.sourceMessageId)
    if (currentRev !== undefined && event.revision < currentRev) {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    const existing = state.items.get(event.itemId)
    if (!existing || existing.revision > event.revision) {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    if (existing.status === "aborted" && event.status === "streaming") {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    state.items.set(event.itemId, {
      ...existing,
      status: event.status,
      updatedAt: event.updatedAt,
      ...(event.truncated !== undefined ? { truncated: event.truncated || undefined } : {}),
    })
    return { changed: true, resyncRequired: false, snapshotDirty: false }
  }
  if (event.type === "item_delta") {
    const currentRev = revisions.get(event.sourceMessageId)
    if (currentRev !== undefined && event.revision < currentRev) {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    const existing = state.items.get(event.itemId)
    if (existing && existing.revision > event.revision) {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    if (existing && existing.revision === event.revision && existing.status === "aborted") {
      return { changed: false, resyncRequired: false, snapshotDirty: false }
    }
    const priorText = existing && existing.revision === event.revision ? existing.text : ""
    if (event.offset > priorText.length) {
      // Missing preceding chunk -> force snapshot resync rather than silently creating a gap.
      return { changed: false, resyncRequired: true, snapshotDirty: false }
    }
    const overlap = priorText.length - event.offset
    const suffix = overlap >= event.delta.length ? "" : event.delta.slice(overlap)
    const text = priorText + suffix
    state.items.set(event.itemId, {
      itemId: event.itemId,
      kind: event.kind,
      sourceMessageId: event.sourceMessageId,
      revision: event.revision,
      ...(event.ticketId ?? existing?.ticketId ? { ticketId: event.ticketId ?? existing?.ticketId } : {}),
      ...(event.sessionId ?? existing?.sessionId ? { sessionId: event.sessionId ?? existing?.sessionId } : {}),
      ...(event.turnId ?? existing?.turnId ? { turnId: event.turnId ?? existing?.turnId } : {}),
      ...(event.inputId ?? existing?.inputId ? { inputId: event.inputId ?? existing?.inputId } : {}),
      ...(event.messageId ?? existing?.messageId ? { messageId: event.messageId ?? existing?.messageId } : {}),
      ...(event.logicalId ?? existing?.logicalId ? { logicalId: event.logicalId ?? existing?.logicalId } : {}),
      ...(event.activityKind ?? existing?.activityKind ? { activityKind: event.activityKind ?? existing?.activityKind } : {}),
      ...(event.activityStatus ?? existing?.activityStatus ? { activityStatus: event.activityStatus ?? existing?.activityStatus } : {}),
      text,
      status: event.status ?? existing?.status ?? "streaming",
      seq: existing?.seq ?? cursor,
      deltaOffset: text.length,
      createdAt: existing?.createdAt ?? event.updatedAt,
      updatedAt: event.updatedAt,
    })
    return { changed: suffix.length > 0 || !existing || event.status !== existing.status, resyncRequired: false, snapshotDirty: false }
  }
  return { changed: false, resyncRequired: false, snapshotDirty: false }
}

export function applyFeedbackPush(
  state: FeedbackState,
  push: SuperFeedbackPush,
  expectedWorkspaceId: SuperWorkspaceId,
  expectedSubscriptionId: string | undefined,
  revisions: ReadonlyMap<string, number>,
): FeedbackPushOutcome {
  if (push.workspaceId !== expectedWorkspaceId || !expectedSubscriptionId || push.subscriptionId !== expectedSubscriptionId) {
    return { changed: false, resyncRequired: false, snapshotDirty: false }
  }
  if (state.previewGeneration && push.previewGeneration !== state.previewGeneration) {
    return { changed: false, resyncRequired: true, snapshotDirty: false }
  }
  if (push.cursor <= state.cursor) {
    return { changed: false, resyncRequired: false, snapshotDirty: false }
  }
  if (state.cursor > 0 && push.cursor > state.cursor + 1) {
    return { changed: false, resyncRequired: true, snapshotDirty: false }
  }
  state.previewGeneration ||= push.previewGeneration
  state.cursor = push.cursor
  return applyFeedbackEvent(state, push.event, push.cursor, revisions)
}

/**
 * Merge one process-page item into what this client already loaded. A later page may only carry a status
 * update for an item shown earlier: keep its first position and title, applying a new title only when the
 * host explicitly provided one. A status-only update without a loaded start is not shown on its own.
 */
function mergeProcessPageItem(prior: SuperFeedbackItem | undefined, next: SuperFeedbackItem): SuperFeedbackItem | undefined {
  const { updateOnly, ...incoming } = next
  if (!prior) return updateOnly ? undefined : incoming
  const statusOnly = updateOnly === true || !incoming.text.trim() || (incoming.activityKind === "tool" && incoming.text === LEGACY_UPDATE_TITLE)
  return { ...prior, ...incoming, text: statusOnly ? prior.text : incoming.text, seq: prior.seq, createdAt: prior.createdAt }
}

export function mergeLoadedProcess(state: FeedbackState, result: SuperFeedbackProcessResult, append = false): void {
  const prior = append ? getLoadedProcess(state, result.sourceMessageId, result.revision) : undefined
  const byId = new Map<string, SuperFeedbackItem>()
  if (prior && prior.revision === result.revision) {
    for (const item of prior.items) byId.set(item.itemId, item)
  }
  for (const item of result.items) {
    const merged = mergeProcessPageItem(byId.get(item.itemId), item)
    if (merged) byId.set(item.itemId, merged)
  }
  const items = [...byId.values()].sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
  setLoadedProcess(state, result.sourceMessageId, result.revision, {
    items,
    hasMore: result.hasMore,
    nextAfterSeq: result.nextAfterSeq,
    loading: false,
  })
}

/**
 * Group feedback items per originating user message, reconciling live `final_preview`
 * entries against formally delivered Worker `result` messages so C appears exactly once.
 */
export function buildRequestFeedbackMap(
  messages: readonly SuperMessage[],
  state: FeedbackState | undefined,
): Map<string, WorkspaceRequestFeedback> {
  const map = new Map<string, WorkspaceRequestFeedback>()
  if (!state) return map

  const userRevisions = new Map<string, number>()
  const formalLogicalIds = new Set<string>()
  const formalSessionTurns = new Set<string>()
  for (const message of messages) {
    if (message.role === "user") userRevisions.set(message.id, message.revision ?? 0)
    if (message.role === "worker" && message.workerEvent === "result") {
      if (message.logicalId) formalLogicalIds.add(message.logicalId)
      if (message.sessionId && message.turnId) formalSessionTurns.add(JSON.stringify([message.sessionId, message.turnId]))
    }
  }

  const ensure = (sourceMessageId: string): WorkspaceRequestFeedback => {
    let entry = map.get(sourceMessageId)
    if (!entry) {
      entry = {
        sourceMessageId,
        revision: userRevisions.get(sourceMessageId) ?? 0,
        milestones: [],
        finalPreviews: [],
        activities: [],
        hasProcess: false,
        loadingProcess: false,
        hasMoreProcess: false,
      }
      map.set(sourceMessageId, entry)
    }
    return entry
  }

  for (const item of state.items.values()) {
    const rev = userRevisions.get(item.sourceMessageId)
    if (rev !== undefined && item.revision !== rev) continue
    const entry = ensure(item.sourceMessageId)
    if (item.kind === "ack") {
      if (!entry.ack || item.status !== "streaming" || (item.deltaOffset ?? item.text.length) >= (entry.ack.deltaOffset ?? entry.ack.text.length)) {
        entry.ack = item
      }
    } else if (item.kind === "milestone") {
      entry.milestones.push(item)
    } else if (item.kind === "final_preview") {
      const mergedIntoFormal = (item.logicalId && formalLogicalIds.has(item.logicalId))
        || (item.sessionId && item.turnId && formalSessionTurns.has(JSON.stringify([item.sessionId, item.turnId])))
      if (!mergedIntoFormal) entry.finalPreviews.push(item)
    } else if (item.kind === "activity") {
      entry.activities.push(item)
    }
  }

  for (const [sourceMessageId, proc] of state.processes) {
    const rev = userRevisions.get(sourceMessageId)
    if (rev !== undefined && proc.revision !== rev) continue
    const entry = ensure(sourceMessageId)
    entry.process = proc
  }

  const loadedSources = new Set<string>()
  for (const [key, loaded] of state.loadedProcesses) loadedSources.add(loaded.sourceMessageId ?? key)
  for (const loaded of state.loadedProcessesByRevision?.values() ?? []) {
    if (loaded.sourceMessageId) loadedSources.add(loaded.sourceMessageId)
  }
  for (const sourceMessageId of loadedSources) {
    const rev = userRevisions.get(sourceMessageId)
    const loaded = rev !== undefined
      ? getLoadedProcess(state, sourceMessageId, rev)
      : state.loadedProcesses.get(sourceMessageId)
    if (!loaded) continue
    if (rev !== undefined && loaded.revision !== rev) continue
    const entry = ensure(sourceMessageId)
    entry.loadingProcess = loaded.loading
    entry.hasMoreProcess = loaded.hasMore
    entry.nextAfterSeq = loaded.nextAfterSeq
    entry.processError = loaded.error
    const byId = new Map(entry.activities.map(item => [item.itemId, item]))
    for (const item of loaded.items) if (!byId.has(item.itemId)) byId.set(item.itemId, item)
    entry.activities = [...byId.values()]
  }

  for (const entry of map.values()) {
    entry.milestones.sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
    entry.finalPreviews.sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
    entry.activities.sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt))
    entry.hasProcess = entry.activities.length > 0 || (entry.process?.activityCount ?? 0) > 0
  }

  return map
}
