import * as acp from "@agentclientprotocol/sdk/unstable"
import type { AgentCommand, AgentElicitation, AgentSnapshot } from "./agent-protocol.ts"
import { AgentJournal, requireActiveSession, timestamp } from "./agent-store.ts"
import { elicitationUrl, redactElicitationRequest, redactElicitationResponse, validateElicitationResponse } from "./agent-elicitation-protocol.ts"

interface RuntimeState {
  generation?: number
  turnId?: string
  running: boolean
  connected: boolean
}
interface PendingElicitation {
  signal: AbortSignal
  resolve(response: acp.CreateElicitationResponse): void
}
interface UrlElicitation {
  generation: number
  id?: string
  completedAt?: string
}

/** Questions are durable; their provider RPC waiters belong only to this run. */
export class AgentElicitations {
  readonly #journal: AgentJournal
  readonly #sessionId: string
  readonly #state: () => RuntimeState
  readonly #pending = new Map<string, PendingElicitation>()
  readonly #urls = new Map<string, UrlElicitation>()

  constructor(journal: AgentJournal, sessionId: string, state: () => RuntimeState) {
    this.#journal = journal
    this.#sessionId = sessionId
    this.#state = state
  }

  async request(request: acp.CreateElicitationRequest, signal: AbortSignal, generation: number): Promise<acp.CreateElicitationResponse> {
    const providerSessionId = "sessionId" in request ? request.sessionId : undefined
    if (typeof providerSessionId !== "string" || !acp.CreateElicitationRequest.isForm(request) && !acp.CreateElicitationRequest.isUrl(request)
      || acp.CreateElicitationRequest.isUrl(request) && !elicitationUrl(request)) return { action: "cancel" }
    const url: UrlElicitation | undefined = acp.CreateElicitationRequest.isUrl(request) ? { generation } : undefined
    if (url && acp.CreateElicitationRequest.isUrl(request)) this.#urls.set(request.elicitationId, url)
    const turnId = this.#state().turnId
    const elicitation: AgentElicitation = {
      id: await this.#journal.id(), sessionId: this.#sessionId, runGeneration: generation,
      turnId, request: redactElicitationRequest(request), state: "pending", createdAt: timestamp(),
    }
    if (url) url.id = elicitation.id
    let resolve!: PendingElicitation["resolve"]
    const answer = new Promise<acp.CreateElicitationResponse>(done => { resolve = done })
    let response: acp.CreateElicitationResponse | undefined
    this.#pending.set(elicitation.id, { signal, resolve })
    try {
      const saved = await this.#journal.serial(this.#sessionId, async () => {
        const snapshot = await this.#journal.read(this.#sessionId)
        if (providerSessionId !== snapshot.session.providerSessionId || !this.#isLive(elicitation, snapshot)) return false
        if (url?.completedAt) elicitation.completedAt = url.completedAt
        await this.#journal.commit(snapshot, { elicitations: [elicitation], events: [this.#journal.event(this.#sessionId, "elicitation", elicitation)] })
        return true
      })
      if (!saved) return { action: "cancel" }
      const abort = () => { void this.cancel(elicitation.id).catch(error => console.error("Question cancellation failed", error)) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted || !this.#state().running || this.#state().generation !== generation) abort()
      try { response = await answer; return response } finally { signal.removeEventListener("abort", abort) }
    } finally {
      this.#pending.delete(elicitation.id)
      if (url && acp.CreateElicitationRequest.isUrl(request) && this.#urls.get(request.elicitationId) === url) {
        if (response?.action !== "accept" || url.completedAt) this.#urls.delete(request.elicitationId)
      }
    }
  }

  /** Consent resolves the request; this later notification completes the browser flow. */
  async complete(notification: acp.CompleteElicitationNotification, generation: number): Promise<void> {
    const url = this.#urls.get(notification.elicitationId)
    const live = () => this.#state().connected && this.#state().generation === generation && url?.generation === generation
    if (!url || !live() || url.completedAt) return
    url.completedAt = timestamp()
    if (!url.id) return // The create callback can still be allocating its durable ID.
    await this.#journal.serial(this.#sessionId, async () => {
      if (!live()) return
      const snapshot = await this.#journal.read(this.#sessionId)
      const previous = snapshot.elicitations.find(row => row.id === url.id)
      if (!previous) return // Creation will include the completion observed above.
      if (!acp.CreateElicitationRequest.isUrl(previous.request) || !("sessionId" in previous.request)
        || previous.request.sessionId !== snapshot.session.providerSessionId || previous.runGeneration !== generation
        || previous.completedAt || previous.state !== "pending" && previous.response?.action !== "accept") return
      const completed = { ...previous, completedAt: url.completedAt }
      await this.#journal.commit(snapshot, { elicitations: [completed], events: [this.#journal.event(this.#sessionId, "elicitation", completed)] })
      if (previous.state !== "pending") this.#urls.delete(notification.elicitationId)
    })
  }

  #isLive(elicitation: AgentElicitation, snapshot: AgentSnapshot): boolean {
    const state = this.#state()
    const pending = this.#pending.get(elicitation.id)
    return !!pending && !pending.signal.aborted && state.running && state.generation === elicitation.runGeneration
      && snapshot.session.lifecycle === "ready" && snapshot.session.archiveState === "active"
      && (!elicitation.turnId || snapshot.turns.some(turn => turn.id === elicitation.turnId && ["starting", "running"].includes(turn.state)))
  }

  async respond(command: AgentCommand, value: unknown): Promise<AgentElicitation> {
    return this.#journal.serial(this.#sessionId, async () => {
      const snapshot = await this.#journal.read(this.#sessionId)
      requireActiveSession(snapshot.session)
      const previous = snapshot.elicitations.find(row => row.id === command.params.elicitationId)
      if (!previous) throw new Error("Question was not found")
      const response = validateElicitationResponse(previous.request, value)
      let result = previous
      if (previous.state === "pending") {
        const { completedAt: _completedAt, ...uncompleted } = previous
        result = this.#isLive(previous, snapshot)
          ? { ...(response.action === "accept" ? previous : uncompleted), state: "resolved", response: redactElicitationResponse(previous.request, response),
              decisionCommandId: command.id, actor: command.actor, resolvedAt: timestamp() }
          : { ...uncompleted, state: "cancelled", response: { action: "cancel" }, resolvedAt: timestamp() }
      }
      const changed = result !== previous
      const completed = { ...command, status: "completed" as const, result, completedAt: timestamp() }
      await this.#journal.commit(snapshot, {
        elicitations: changed ? [result] : [],
        command: completed,
        events: changed ? [this.#journal.event(this.#sessionId, "elicitation", result)] : [this.#journal.event(this.#sessionId, "command", completed)],
      })
      if (changed) {
        this.#pending.get(result.id)?.resolve(result.state === "resolved" ? response : { action: "cancel" })
        this.#pending.delete(result.id)
      }
      return result
    })
  }

  async cancel(id?: string, turnId?: string): Promise<void> {
    await this.#journal.serial(this.#sessionId, async () => {
      const snapshot = await this.#journal.read(this.#sessionId)
      const elicitations = snapshot.elicitations.filter(row => row.state === "pending" && (!id || row.id === id) && (!turnId || row.turnId === turnId))
        .map(({ completedAt: _completedAt, ...row }) => ({ ...row, state: "cancelled" as const, response: { action: "cancel" as const }, resolvedAt: timestamp() }))
      if (elicitations.length) await this.#journal.commit(snapshot, { elicitations,
        events: elicitations.map(row => this.#journal.event(this.#sessionId, "elicitation", row)),
      })
      for (const row of elicitations) {
        this.#pending.get(row.id)?.resolve({ action: "cancel" })
        this.#pending.delete(row.id)
        if (acp.CreateElicitationRequest.isUrl(row.request)) this.#urls.delete(row.request.elicitationId)
      }
      if (!id && !turnId) this.#urls.clear()
    })
  }
}
