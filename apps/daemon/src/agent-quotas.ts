import type { AgentCommand, AgentSessionRecord, AgentSnapshot, AgentTurn } from "./agent-protocol.ts"
import type { AgentJournal } from "./agent-store.ts"

export interface SessionAdmission {
  admissionId: string
  generation: string
  status: "reserved" | "committed" | "released"
  sessionId: string | null
}
export interface AdmissionRequest {
  operationId: string
  kind: "create" | "fork" | "restore"
  sessionId?: string
}
export interface AgentQuotaAuthority {
  turnLimit(): Promise<number | null>
  reserve(request: AdmissionRequest): Promise<SessionAdmission>
  list(): Promise<SessionAdmission[]>
  confirm(generation: string, sessionId: string): Promise<void>
  cancel(generation: string): Promise<void>
  release(generation: string, sessionId: string): Promise<void>
}
type QuotaRequest = (method: "GET" | "POST", path: string, body?: unknown) => Promise<unknown>

const unavailable = async (): Promise<never> => { throw new Error("Connect this machine to its Team before starting new work") }
export const unavailableAgentQuotas: AgentQuotaAuthority = {
  turnLimit: unavailable, reserve: unavailable, list: unavailable,
  confirm: unavailable, cancel: unavailable, release: unavailable,
}

/** Every dispatch reads current server authority; peer lifetime never caches a paid plan. */
export class CentralAgentQuotas implements AgentQuotaAuthority {
  readonly #request: QuotaRequest
  constructor(request: QuotaRequest) { this.#request = request }

  async turnLimit(): Promise<number | null> {
    const value = await this.#request("GET", "/api/daemon/entitlements") as { maxTurnsPerSession?: unknown }
    const limit = value.maxTurnsPerSession
    if (limit !== null && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)) throw new Error("Invalid Team turn allowance")
    return limit as number | null
  }
  async reserve(request: AdmissionRequest): Promise<SessionAdmission> {
    return admission(await this.#request("POST", "/api/daemon/session-admissions", request))
  }
  async list(): Promise<SessionAdmission[]> {
    const value = await this.#request("GET", "/api/daemon/session-admissions") as { admissions?: unknown }
    if (!Array.isArray(value.admissions)) throw new Error("Invalid Team Session admissions")
    return value.admissions.map(admission)
  }
  async confirm(generation: string, sessionId: string): Promise<void> {
    await this.#request("POST", `/api/daemon/session-admissions/${encodeURIComponent(generation)}/confirm`, { generation, sessionId })
  }
  async cancel(generation: string): Promise<void> {
    await this.#request("POST", `/api/daemon/session-admissions/${encodeURIComponent(generation)}/cancel`, { generation })
  }
  async release(generation: string, sessionId: string): Promise<void> {
    await this.#request("POST", "/api/daemon/session-admissions/release", { generation, sessionId })
  }
}

function admission(value: unknown): SessionAdmission {
  const record = value as SessionAdmission | undefined
  if (!record || typeof record.admissionId !== "string" || record.generation !== record.admissionId
    || !["reserved", "committed", "released"].includes(record.status)
    || (record.sessionId !== null && typeof record.sessionId !== "string")) throw new Error("Invalid Team Session admission")
  return record
}

export function consumedTurns(snapshot: AgentSnapshot): number {
  return (snapshot.session.inheritedTurnCount ?? 0) + snapshot.turns.filter(turn => turn.consumed === true).length
}

export class TurnAdmissionBlocked extends Error {}

/** The journal transaction reserves the turn before the provider can observe it. */
export async function consumeTurn(journal: AgentJournal, authority: AgentQuotaAuthority, turn: AgentTurn): Promise<void> {
  let limit: number | null
  try { limit = await authority.turnLimit() }
  catch (error) { throw new TurnAdmissionBlocked(error instanceof Error ? error.message : "Team allowance is unavailable") }
  await journal.serial(turn.sessionId, async () => {
    const snapshot = await journal.read(turn.sessionId)
    const current = snapshot.turns.find(value => value.id === turn.id)
    if (!current || current.state !== "running" || snapshot.session.archiveState !== "active") throw new Error("Agent stopped before provider dispatch")
    if (current.consumed) return
    if (limit !== null && consumedTurns(snapshot) >= limit) throw new TurnAdmissionBlocked(`This Session has reached its ${limit}-turn allowance. Upgrade the Team to continue.`)
    const consumed = { ...current, consumed: true }
    const session = { ...snapshot.session, turnLimitReason: undefined }
    await journal.commit(snapshot, { session, turns: [consumed], events: [
      journal.event(turn.sessionId, "turn", consumed), journal.event(turn.sessionId, "session", session),
    ] })
  })
}

export async function pauseTurn(journal: AgentJournal, turn: AgentTurn, command: AgentCommand, reason: string): Promise<void> {
  await journal.serial(turn.sessionId, async () => {
    const snapshot = await journal.read(turn.sessionId)
    const previous = snapshot.inputs.find(input => input.id === turn.initialInputId)
    const current = snapshot.turns.find(value => value.id === turn.id)
    if (!previous || !current || current.consumed) throw new Error("Cannot pause an already dispatched turn")
    const input = { ...previous, state: "pending" as const, requestedDelivery: "backlog" as const,
      dispatchCommandId: undefined, dispatcher: undefined, turnId: undefined, requestedTurnId: undefined,
      actualDelivery: undefined, error: reason }
    const stopped = { ...current, state: "failed" as const, endedAt: new Date().toISOString(), error: reason }
    const session = { ...snapshot.session, turnLimitReason: reason }
    await journal.commit(snapshot, { session, inputs: [input], turns: [stopped],
      command: { ...command, status: "rejected", completedAt: stopped.endedAt, error: reason }, events: [
        journal.event(turn.sessionId, "input", input), journal.event(turn.sessionId, "turn", stopped),
        journal.event(turn.sessionId, "session", session),
      ],
    })
  })
}

/** Central capacity is reconciled from durable local outcomes, never a timeout. */
export class SessionAdmissions {
  readonly #journal: AgentJournal
  readonly #authority: AgentQuotaAuthority
  readonly #active = new Set<string>()
  #reconciling?: Promise<void>

  constructor(journal: AgentJournal, authority: AgentQuotaAuthority) {
    this.#journal = journal; this.#authority = authority
  }

  async allocate(command: AgentCommand, kind: AdmissionRequest["kind"], allocate: (generation: string) => Promise<AgentSessionRecord>): Promise<AgentSessionRecord> {
    this.#active.add(command.operationId)
    try {
      await this.reconcile()
      const receipt = await this.#authority.reserve({ operationId: command.operationId, kind,
        ...(kind === "restore" ? { sessionId: command.sessionId } : {}),
      })
      if (receipt.generation !== command.operationId || receipt.status === "released") throw new Error("This Session admission is no longer available")
      let session: AgentSessionRecord
      try { session = await allocate(receipt.generation) }
      catch (error) {
        // A native write may have committed before its response failed. Read the
        // persisted generation before deciding that a reservation is unused.
        try {
          const committed = (await this.#journal.list()).find(value => value.admissionGeneration === receipt.generation)
          if (committed) await this.synchronize(committed)
          else await this.#authority.cancel(receipt.generation)
        } catch (reconciliation) { console.error("Session admission outcome awaits reconciliation", reconciliation) }
        throw error
      }
      // The reservation already occupies capacity. A lost confirmation response
      // must not undo the committed Session or cause a duplicate creation.
      try { await this.synchronize(session) }
      catch (error) { console.error("Session admission confirmation awaits reconciliation", error) }
      return session
    } finally { this.#active.delete(command.operationId) }
  }

  async releaseDeleted(session: AgentSessionRecord): Promise<void> {
    if (!session.admissionGeneration) return
    try { await this.#authority.release(session.admissionGeneration, session.id) }
    catch (error) { console.error("Deleted Session admission awaits reconciliation", error) }
  }

  async synchronize(session: AgentSessionRecord): Promise<void> {
    const generation = session.admissionGeneration
    if (!generation) return
    await this.#authority.confirm(generation, session.id)
    if (session.archiveState === "archived") await this.#authority.release(generation, session.id)
  }

  reconcile(): Promise<void> {
    if (this.#reconciling) return this.#reconciling
    this.#reconciling = (async () => {
      // Allocations already underway can finish while this pass awaits central
      // responses. Do not judge them using the pass's earlier local snapshot.
      const active = new Set(this.#active)
      const admissions = await this.#authority.list()
      const sessions = await this.#journal.list()
      const generations = new Map(sessions.map(session => [session.admissionGeneration, session]))
      const sessionIds = new Set(sessions.map(session => session.id))
      for (const receipt of admissions) {
        if (active.has(receipt.generation) || this.#active.has(receipt.generation) || receipt.status === "released") continue
        const current = generations.get(receipt.generation)
        if (current) await this.synchronize(current)
        else if (receipt.status === "reserved") await this.#authority.cancel(receipt.generation)
        else if (receipt.sessionId) {
          const replaced = sessionIds.has(receipt.sessionId)
          const deleted = !replaced && await this.#journal.native.agentAdmissionDeleted(receipt.generation)
          // A newer restore or a durable deletion intent plus absent local row
          // proves this generation is no longer occupying a local Session.
          if (replaced || deleted) await this.#authority.release(receipt.generation, receipt.sessionId)
        }
      }
    })().finally(() => { this.#reconciling = undefined })
    return this.#reconciling
  }
}
