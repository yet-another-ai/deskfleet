import * as acp from "@agentclientprotocol/sdk"
import type { AgentCommand, AgentElicitation, AgentSnapshot } from "./agent-protocol.ts"
import { AgentJournal, timestamp } from "./agent-store.ts"
import { redactElicitationRequest, redactElicitationResponse, validateElicitationResponse } from "./agent-elicitation-protocol.ts"

interface RuntimeState {
  generation?: number
  turnId?: string
  running: boolean
}
interface PendingElicitation {
  signal: AbortSignal
  resolve(response: acp.CreateElicitationResponse): void
}

/** Questions are durable; their provider RPC waiters belong only to this run. */
export class AgentElicitations {
  readonly #journal: AgentJournal
  readonly #sessionId: string
  readonly #state: () => RuntimeState
  readonly #pending = new Map<string, PendingElicitation>()

  constructor(journal: AgentJournal, sessionId: string, state: () => RuntimeState) {
    this.#journal = journal
    this.#sessionId = sessionId
    this.#state = state
  }

  async request(request: acp.CreateElicitationRequest, signal: AbortSignal, generation: number): Promise<acp.CreateElicitationResponse> {
    if (!acp.CreateElicitationRequest.isForm(request) || !("sessionId" in request)) return { action: "cancel" }
    const turnId = this.#state().turnId
    const elicitation: AgentElicitation = {
      id: await this.#journal.id(), sessionId: this.#sessionId, runGeneration: generation,
      turnId, request: redactElicitationRequest(request), state: "pending", createdAt: timestamp(),
    }
    let resolve!: PendingElicitation["resolve"]
    const answer = new Promise<acp.CreateElicitationResponse>(done => { resolve = done })
    this.#pending.set(elicitation.id, { signal, resolve })
    try {
      const saved = await this.#journal.serial(this.#sessionId, async () => {
        const snapshot = await this.#journal.read(this.#sessionId)
        if (request.sessionId !== snapshot.session.providerSessionId || !this.#isLive(elicitation, snapshot)) return false
        await this.#journal.commit(snapshot, { elicitations: [elicitation], events: [this.#journal.event(this.#sessionId, "elicitation", elicitation)] })
        return true
      })
      if (!saved) return { action: "cancel" }
      const abort = () => { void this.cancel(elicitation.id).catch(error => console.error("Question cancellation failed", error)) }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted || !this.#state().running || this.#state().generation !== generation) abort()
      try { return await answer } finally { signal.removeEventListener("abort", abort) }
    } finally { this.#pending.delete(elicitation.id) }
  }

  #isLive(elicitation: AgentElicitation, snapshot: AgentSnapshot): boolean {
    const state = this.#state()
    const pending = this.#pending.get(elicitation.id)
    return !!pending && !pending.signal.aborted && state.running && state.generation === elicitation.runGeneration
      && snapshot.session.lifecycle === "ready"
      && (!elicitation.turnId || snapshot.turns.some(turn => turn.id === elicitation.turnId && ["starting", "running"].includes(turn.state)))
  }

  async respond(command: AgentCommand, value: unknown): Promise<AgentElicitation> {
    return this.#journal.serial(this.#sessionId, async () => {
      const snapshot = await this.#journal.read(this.#sessionId)
      const previous = snapshot.elicitations.find(row => row.id === command.params.elicitationId)
      if (!previous) throw new Error("Question was not found")
      const response = validateElicitationResponse(previous.request, value)
      let result = previous
      if (previous.state === "pending") {
        result = this.#isLive(previous, snapshot)
          ? { ...previous, state: "resolved", response: redactElicitationResponse(previous.request, response),
              decisionCommandId: command.id, actor: command.actor, resolvedAt: timestamp() }
          : { ...previous, state: "cancelled", response: { action: "cancel" }, resolvedAt: timestamp() }
      }
      const changed = result !== previous
      await this.#journal.commit(snapshot, {
        elicitations: changed ? [result] : [],
        command: { ...command, status: "completed", result, completedAt: timestamp() },
        events: changed ? [this.#journal.event(this.#sessionId, "elicitation", result)] : [],
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
        .map(row => ({ ...row, state: "cancelled" as const, response: { action: "cancel" as const }, resolvedAt: timestamp() }))
      if (elicitations.length) await this.#journal.commit(snapshot, { elicitations,
        events: elicitations.map(row => this.#journal.event(this.#sessionId, "elicitation", row)),
      })
      for (const row of elicitations) {
        this.#pending.get(row.id)?.resolve({ action: "cancel" })
        this.#pending.delete(row.id)
      }
    })
  }
}
