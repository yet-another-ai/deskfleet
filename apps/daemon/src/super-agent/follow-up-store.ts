import { randomUUID } from "node:crypto"
import type { NativeCatalog } from "@deskfleet/native"
import type {
  FollowUpActionRecord, FollowUpAuthState, FollowUpRunRecord, FollowUpRunsPage,
  FollowUpSourceKind, FollowUpSourceRecord, FollowUpSourceState,
} from "@deskfleet/protocol/super-agent-follow-up"

export function defaultAuthState(now = new Date().toISOString()): FollowUpAuthState {
  return {
    authVersion: 0,
    globalDisabled: false,
    autoEnrollOrdinarySessions: true,
    ordinarySessionRuleMode: "active",
    grants: {},
    revokedAllAtVersion: 0,
    updatedAt: now,
  }
}

export const RUN_STATE_RANK: Record<FollowUpRunRecord["status"], number> = {
  claimed: 0,
  running: 1,
  attention: 1,
  completed: 2,
  failed: 2,
  interrupted: 2,
  skipped: 2,
  restricted: 2,
}

export function isTerminalRunStatus(status: FollowUpRunRecord["status"]): boolean {
  return RUN_STATE_RANK[status] >= 2
}

/**
 * Enforce monotonic run progression so late/replayed `claimed`/`running` events
 * can NEVER regress a terminal or already-delivered run record.
 */
export function mergeRunRecordMonotonic(
  existing: FollowUpRunRecord | undefined,
  incoming: Omit<FollowUpRunRecord, "id"> & { id?: string },
): FollowUpRunRecord {
  if (!existing) {
    return { ...structuredClone(incoming), id: incoming.id ?? randomUUID() }
  }
  const existingRank = RUN_STATE_RANK[existing.status]
  const incomingRank = RUN_STATE_RANK[incoming.status]
  if (incomingRank < existingRank || (incomingRank === existingRank && existing.delivered && !incoming.delivered)) {
    // Preserve terminal / delivered state, summary, detail, messageId, and evidence; only backfill missing IDs.
    return {
      ...structuredClone(existing),
      sessionId: existing.sessionId ?? incoming.sessionId,
      inputId: existing.inputId ?? incoming.inputId,
      turnId: existing.turnId ?? incoming.turnId,
      provider: existing.provider ?? incoming.provider,
      detail: existing.detail ?? incoming.detail,
      updatedAt: existing.updatedAt >= incoming.updatedAt ? existing.updatedAt : incoming.updatedAt,
    }
  }
  const next = structuredClone(incoming)
  return {
    ...next,
    id: existing.id,
    createdAt: existing.createdAt,
    sessionId: next.sessionId ?? existing.sessionId,
    inputId: next.inputId ?? existing.inputId,
    turnId: next.turnId ?? existing.turnId,
    provider: next.provider ?? existing.provider,
    detail: next.detail ?? existing.detail,
    delivered: existing.delivered || next.delivered,
    deliveredMessageId: next.deliveredMessageId ?? existing.deliveredMessageId,
    ticketId: next.ticketId ?? existing.ticketId,
    evidenceRefs: next.evidenceRefs ?? existing.evidenceRefs,
  }
}

export interface FollowUpStore {
  init(): Promise<void>
  users(): string[]
  getAuth(userId: string): FollowUpAuthState | undefined
  updateAuth<R>(userId: string, edit: (state: FollowUpAuthState) => R): Promise<R>
  listSources(userId?: string, workspaceId?: string): FollowUpSourceRecord[]
  getSource(userId: string, workspaceId: string, sourceKind: FollowUpSourceKind, sourceId: string): FollowUpSourceRecord | undefined
  updateSource<R>(
    userId: string,
    workspaceId: string,
    sourceKind: FollowUpSourceKind,
    sourceId: string,
    initial: () => FollowUpSourceState,
    edit: (state: FollowUpSourceState) => R,
  ): Promise<{ record: FollowUpSourceRecord; result: R }>
  getRun(
    userId: string,
    workspaceId: string,
    sourceKind: FollowUpSourceKind,
    sourceId: string,
    runKey: string,
  ): Promise<FollowUpRunRecord | undefined>
  listRuns(query: {
    userId: string
    workspaceId?: string
    sourceKind?: FollowUpSourceKind
    sourceId?: string
    cursor?: { createdAt: string; id: string }
    limit?: number
  }): Promise<FollowUpRunsPage>
  upsertRun(run: Omit<FollowUpRunRecord, "id"> & { id?: string }): Promise<FollowUpRunRecord>
  listActions(
    userId: string,
    status?: FollowUpActionRecord["status"],
    limit?: number,
    cursor?: { createdAt: string; id: string },
  ): Promise<FollowUpActionRecord[]>
  upsertAction(action: Omit<FollowUpActionRecord, "id"> & { id?: string }): Promise<FollowUpActionRecord>
  close(): Promise<void>
}

type NativeFollowUpCatalog = Pick<
  NativeCatalog,
  | "superAgentFollowUpAuths"
  | "saveSuperAgentFollowUpAuth"
  | "superAgentFollowUpSources"
  | "saveSuperAgentFollowUpSource"
  | "superAgentFollowUpRuns"
  | "upsertSuperAgentFollowUpRun"
  | "superAgentFollowUpActions"
  | "upsertSuperAgentFollowUpAction"
>

const sourceKey = (userId: string, workspaceId: string, sourceKind: FollowUpSourceKind, sourceId: string) =>
  JSON.stringify([userId, workspaceId, sourceKind, sourceId])

/** Registration-scoped SQLite store using incremental tables and CAS revisions. */
export class LocalFollowUpStore implements FollowUpStore {
  readonly #catalog: NativeFollowUpCatalog
  readonly #auth = new Map<string, { revision: number; value: FollowUpAuthState }>()
  readonly #sources = new Map<string, FollowUpSourceRecord>()
  #pending: Promise<void> = Promise.resolve()

  constructor(catalog: NativeFollowUpCatalog) { this.#catalog = catalog }

  async init(): Promise<void> {
    const [authRows, sourceRows] = await Promise.all([
      this.#catalog.superAgentFollowUpAuths(),
      this.#catalog.superAgentFollowUpSources(undefined, undefined),
    ])
    for (const row of authRows) {
      this.#auth.set(row.userId, { revision: row.revision, value: JSON.parse(row.stateJson) as FollowUpAuthState })
    }
    for (const row of sourceRows) {
      const record: FollowUpSourceRecord = {
        id: row.id,
        userId: row.userId,
        workspaceId: row.workspaceId,
        sourceKind: row.sourceKind as FollowUpSourceKind,
        sourceId: row.sourceId,
        revision: row.revision,
        state: JSON.parse(row.stateJson) as FollowUpSourceState,
        updatedAt: row.updatedAt,
      }
      this.#sources.set(sourceKey(record.userId, record.workspaceId, record.sourceKind, record.sourceId), record)
    }
  }

  users(): string[] {
    const all = new Set<string>(this.#auth.keys())
    for (const src of this.#sources.values()) all.add(src.userId)
    return [...all]
  }

  getAuth(userId: string): FollowUpAuthState | undefined {
    const row = this.#auth.get(userId)
    return row ? structuredClone(row.value) : undefined
  }

  #serial<R>(work: () => Promise<R>): Promise<R> {
    const next = this.#pending.then(work)
    this.#pending = next.then(() => {}, () => {})
    return next
  }

  updateAuth<R>(userId: string, edit: (state: FollowUpAuthState) => R): Promise<R> {
    return this.#serial(async () => {
      const row = this.#auth.get(userId)
      const revision = row?.revision ?? 0
      const state = row ? structuredClone(row.value) : defaultAuthState()
      const result = edit(state)
      await this.#catalog.saveSuperAgentFollowUpAuth(userId, revision, state.authVersion, JSON.stringify(state))
      this.#auth.set(userId, { revision: revision + 1, value: state })
      return structuredClone(result)
    })
  }

  listSources(userId?: string, workspaceId?: string): FollowUpSourceRecord[] {
    const out: FollowUpSourceRecord[] = []
    for (const record of this.#sources.values()) {
      if (userId !== undefined && record.userId !== userId) continue
      if (workspaceId !== undefined && record.workspaceId !== workspaceId) continue
      out.push(structuredClone(record))
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  }

  getSource(userId: string, workspaceId: string, sourceKind: FollowUpSourceKind, sourceId: string): FollowUpSourceRecord | undefined {
    const record = this.#sources.get(sourceKey(userId, workspaceId, sourceKind, sourceId))
    return record ? structuredClone(record) : undefined
  }

  updateSource<R>(
    userId: string,
    workspaceId: string,
    sourceKind: FollowUpSourceKind,
    sourceId: string,
    initial: () => FollowUpSourceState,
    edit: (state: FollowUpSourceState) => R,
  ): Promise<{ record: FollowUpSourceRecord; result: R }> {
    return this.#serial(async () => {
      const key = sourceKey(userId, workspaceId, sourceKind, sourceId)
      const existing = this.#sources.get(key)
      const id = existing?.id ?? randomUUID()
      const revision = existing?.revision ?? 0
      const state = existing ? structuredClone(existing.state) : initial()
      const result = edit(state)
      const updatedAt = new Date().toISOString()
      const saved = await this.#catalog.saveSuperAgentFollowUpSource({
        id, userId, workspaceId, sourceKind, sourceId, revision,
        stateJson: JSON.stringify(state), updatedAt,
      })
      const record: FollowUpSourceRecord = {
        id: saved.id, userId: saved.userId, workspaceId: saved.workspaceId,
        sourceKind: saved.sourceKind as FollowUpSourceKind, sourceId: saved.sourceId,
        revision: saved.revision, state, updatedAt: saved.updatedAt,
      }
      this.#sources.set(key, record)
      return { record: structuredClone(record), result: structuredClone(result) }
    })
  }

  async getRun(
    userId: string,
    workspaceId: string,
    sourceKind: FollowUpSourceKind,
    sourceId: string,
    runKey: string,
  ): Promise<FollowUpRunRecord | undefined> {
    const exactLookup = (this.#catalog as unknown as {
      superAgentFollowUpRun?: (
        userId: string,
        workspaceId: string,
        sourceKind: string,
        sourceId: string,
        runKey: string,
      ) => Promise<{ id: string; recordJson: string } | null | undefined>
    }).superAgentFollowUpRun
    if (typeof exactLookup === "function") {
      const row = await exactLookup.call(this.#catalog, userId, workspaceId, sourceKind, sourceId, runKey)
      return row ? { ...(JSON.parse(row.recordJson) as FollowUpRunRecord), id: row.id } : undefined
    }
    let cursor: { createdAt: string; id: string } | undefined
    for (;;) {
      const rows = await this.#catalog.superAgentFollowUpRuns(
        userId, workspaceId, sourceKind, sourceId, cursor?.createdAt, cursor?.id, 200,
      )
      for (const row of rows) {
        if (row.runKey === runKey) {
          return { ...(JSON.parse(row.recordJson) as FollowUpRunRecord), id: row.id }
        }
      }
      if (rows.length < 200) break
      const last = rows.at(-1)!
      cursor = { createdAt: last.createdAt, id: last.id }
    }
    return undefined
  }

  async listRuns(query: {
    userId: string
    workspaceId?: string
    sourceKind?: FollowUpSourceKind
    sourceId?: string
    cursor?: { createdAt: string; id: string }
    limit?: number
  }): Promise<FollowUpRunsPage> {
    const limit = Math.max(1, Math.min(200, query.limit ?? 20))
    const rows = await this.#catalog.superAgentFollowUpRuns(
      query.userId,
      query.workspaceId,
      query.sourceKind,
      query.sourceId,
      query.cursor?.createdAt,
      query.cursor?.id,
      limit + 1,
    )
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const runs = pageRows.map(row => ({ ...(JSON.parse(row.recordJson) as FollowUpRunRecord), id: row.id }))
    const last = pageRows.at(-1)
    return {
      runs,
      ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}),
    }
  }

  upsertRun(input: Omit<FollowUpRunRecord, "id"> & { id?: string }): Promise<FollowUpRunRecord> {
    return this.#serial(async () => {
      const existing = await this.getRun(input.userId, input.workspaceId, input.sourceKind, input.sourceId, input.runKey)
      const record = mergeRunRecordMonotonic(existing, input)
      const saved = await this.#catalog.upsertSuperAgentFollowUpRun({
        id: record.id,
        userId: record.userId,
        workspaceId: record.workspaceId,
        sourceKind: record.sourceKind,
        sourceId: record.sourceId,
        runKey: record.runKey,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        recordJson: JSON.stringify(record),
      })
      return { ...record, id: saved.id }
    })
  }

  async listActions(
    userId: string,
    status?: FollowUpActionRecord["status"],
    limit = 100,
    cursor?: { createdAt: string; id: string },
  ): Promise<FollowUpActionRecord[]> {
    const fn = this.#catalog.superAgentFollowUpActions as (
      userId: string,
      status?: string | null,
      limit?: number,
      beforeCreatedAt?: string | null,
      beforeId?: string | null,
    ) => Promise<{ id: string; recordJson: string }[]>
    const rows = await fn.call(
      this.#catalog,
      userId,
      status,
      Math.max(1, Math.min(500, limit)),
      cursor?.createdAt,
      cursor?.id,
    )
    return rows.map(row => ({ ...(JSON.parse(row.recordJson) as FollowUpActionRecord), id: row.id }))
  }

  upsertAction(input: Omit<FollowUpActionRecord, "id"> & { id?: string }): Promise<FollowUpActionRecord> {
    return this.#serial(async () => {
      const id = input.id ?? randomUUID()
      const record: FollowUpActionRecord = { ...structuredClone(input), id }
      const saved = await this.#catalog.upsertSuperAgentFollowUpAction({
        id,
        userId: record.userId,
        workspaceId: record.workspaceId,
        sourceKind: record.sourceKind,
        sourceId: record.sourceId,
        actionKey: record.actionKey,
        status: record.status,
        authVersion: record.authVersion,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        recordJson: JSON.stringify(record),
      })
      return { ...record, id: saved.id }
    })
  }

  close(): Promise<void> { return this.#pending }
}

/** In-memory follow-up store matching SQLite uniqueness, CAS, and pagination semantics for unit tests. */
export class MemoryFollowUpStore implements FollowUpStore {
  readonly #auth = new Map<string, FollowUpAuthState>()
  readonly #sources = new Map<string, FollowUpSourceRecord>()
  readonly #runs = new Map<string, FollowUpRunRecord>()
  readonly #actions = new Map<string, FollowUpActionRecord>()

  async init(): Promise<void> {}
  users(): string[] {
    const all = new Set<string>(this.#auth.keys())
    for (const s of this.#sources.values()) all.add(s.userId)
    return [...all]
  }
  getAuth(userId: string): FollowUpAuthState | undefined {
    const value = this.#auth.get(userId)
    return value ? structuredClone(value) : undefined
  }
  async updateAuth<R>(userId: string, edit: (state: FollowUpAuthState) => R): Promise<R> {
    const state = this.#auth.get(userId) ? structuredClone(this.#auth.get(userId)!) : defaultAuthState()
    const result = edit(state)
    this.#auth.set(userId, state)
    return structuredClone(result)
  }
  listSources(userId?: string, workspaceId?: string): FollowUpSourceRecord[] {
    return [...this.#sources.values()]
      .filter(r => (userId === undefined || r.userId === userId) && (workspaceId === undefined || r.workspaceId === workspaceId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .map(r => structuredClone(r))
  }
  getSource(userId: string, workspaceId: string, sourceKind: FollowUpSourceKind, sourceId: string): FollowUpSourceRecord | undefined {
    const found = this.#sources.get(sourceKey(userId, workspaceId, sourceKind, sourceId))
    return found ? structuredClone(found) : undefined
  }
  async updateSource<R>(
    userId: string, workspaceId: string, sourceKind: FollowUpSourceKind, sourceId: string,
    initial: () => FollowUpSourceState, edit: (state: FollowUpSourceState) => R,
  ): Promise<{ record: FollowUpSourceRecord; result: R }> {
    const key = sourceKey(userId, workspaceId, sourceKind, sourceId)
    const existing = this.#sources.get(key)
    const state = existing ? structuredClone(existing.state) : initial()
    const result = edit(state)
    const record: FollowUpSourceRecord = {
      id: existing?.id ?? randomUUID(), userId, workspaceId, sourceKind, sourceId,
      revision: (existing?.revision ?? 0) + 1, state, updatedAt: new Date().toISOString(),
    }
    this.#sources.set(key, record)
    return { record: structuredClone(record), result: structuredClone(result) }
  }
  async getRun(
    userId: string,
    workspaceId: string,
    sourceKind: FollowUpSourceKind,
    sourceId: string,
    runKey: string,
  ): Promise<FollowUpRunRecord | undefined> {
    const found = this.#runs.get(JSON.stringify([userId, workspaceId, sourceKind, sourceId, runKey]))
    return found ? structuredClone(found) : undefined
  }
  async listRuns(query: {
    userId: string; workspaceId?: string; sourceKind?: FollowUpSourceKind; sourceId?: string
    cursor?: { createdAt: string; id: string }; limit?: number
  }): Promise<FollowUpRunsPage> {
    const limit = Math.max(1, Math.min(200, query.limit ?? 20))
    const sorted = [...this.#runs.values()]
      .filter(r => r.userId === query.userId
        && (query.workspaceId === undefined || r.workspaceId === query.workspaceId)
        && (query.sourceKind === undefined || r.sourceKind === query.sourceKind)
        && (query.sourceId === undefined || r.sourceId === query.sourceId)
        && (!query.cursor || r.createdAt < query.cursor.createdAt || (r.createdAt === query.cursor.createdAt && r.id < query.cursor.id)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const hasMore = sorted.length > limit
    const runs = (hasMore ? sorted.slice(0, limit) : sorted).map(r => structuredClone(r))
    const last = runs.at(-1)
    return { runs, ...(hasMore && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}) }
  }
  async upsertRun(input: Omit<FollowUpRunRecord, "id"> & { id?: string }): Promise<FollowUpRunRecord> {
    const key = JSON.stringify([input.userId, input.workspaceId, input.sourceKind, input.sourceId, input.runKey])
    const existing = this.#runs.get(key)
    const record = mergeRunRecordMonotonic(existing, input)
    this.#runs.set(key, record)
    return structuredClone(record)
  }
  async listActions(
    userId: string,
    status?: FollowUpActionRecord["status"],
    limit = 100,
    cursor?: { createdAt: string; id: string },
  ): Promise<FollowUpActionRecord[]> {
    return [...this.#actions.values()]
      .filter(a => a.userId === userId
        && (status === undefined || a.status === status)
        && (!cursor || a.createdAt < cursor.createdAt || (a.createdAt === cursor.createdAt && a.id < cursor.id)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(a => structuredClone(a))
  }
  async upsertAction(input: Omit<FollowUpActionRecord, "id"> & { id?: string }): Promise<FollowUpActionRecord> {
    const key = JSON.stringify([input.userId, input.actionKey])
    const existing = this.#actions.get(key)
    const record: FollowUpActionRecord = { ...structuredClone(input), id: existing?.id ?? input.id ?? randomUUID() }
    this.#actions.set(key, record)
    return structuredClone(record)
  }
  async close(): Promise<void> {}
}
