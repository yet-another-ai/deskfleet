import type {
  AgentActor, AgentCommand, AgentCommit, AgentEvent, AgentEventDraft,
  AgentSessionContext, AgentSessionRecord, AgentSnapshot,
} from "./agent-protocol.ts"

export interface AgentPersistence {
  agentIdentity(): Promise<string>
  agentAllocateId(): Promise<string>
  agentList(): Promise<string>
  agentSnapshot(sessionId: string): Promise<string>
  agentHistory(sessionId: string, afterSeq: string, limit: number): Promise<string>
  agentCommand(operationId: string): Promise<string>
  agentCommit(transaction: string): Promise<string>
  agentCreateSession(request: string): Promise<string>
}

export const timestamp = () => new Date().toISOString()
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/** The journal's queue orders commits, never the lifetime of an ACP request. */
export class AgentJournal {
  readonly native: AgentPersistence
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #listeners = new Set<(event: AgentEvent) => void>()
  identity!: { originId: string; machineId: string }

  constructor(native: AgentPersistence) { this.native = native }
  async init(): Promise<void> { this.identity = JSON.parse(await this.native.agentIdentity()) }
  actor(): AgentActor {
    return { kind: "local_token", sourceMachine: { originId: this.identity.originId, id: this.identity.machineId } }
  }
  id(): Promise<string> { return this.native.agentAllocateId() }
  async list(): Promise<AgentSessionRecord[]> { return JSON.parse(await this.native.agentList()) }
  async read(id: string): Promise<AgentSnapshot> {
    const snapshot = JSON.parse(await this.native.agentSnapshot(id)) as AgentSnapshot | null
    if (!snapshot) throw new Error("Agent Session was not found")
    return snapshot
  }
  async command(operationId: string): Promise<AgentCommand | null> {
    return JSON.parse(await this.native.agentCommand(operationId))
  }
  async history(id: string, afterSeq: string, limit = 100): Promise<AgentEvent[]> {
    return JSON.parse(await this.native.agentHistory(id, afterSeq, Math.max(1, Math.min(limit, 200))))
  }
  serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const running = (this.#queues.get(id) ?? Promise.resolve()).then(action)
    const settled = running.catch(() => {})
    this.#queues.set(id, settled)
    void settled.then(() => {
      if (this.#queues.get(id) === settled) this.#queues.delete(id)
    })
    return running
  }
  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  event(sessionId: string, kind: AgentEvent["kind"], payload: AgentEvent["payload"], context: Partial<AgentEventDraft> = {}): AgentEventDraft {
    return { sessionId, kind, payload, createdAt: timestamp(), ...context }
  }
  async commit(snapshot: AgentSnapshot | undefined, changes: AgentCommit): Promise<AgentEvent[]> {
    const transaction: AgentCommit = snapshot ? {
      sessionId: snapshot.session.id, expectedSeq: snapshot.session.lastEventSeq,
      ...changes,
    } : changes
    const result = JSON.parse(await this.native.agentCommit(JSON.stringify(transaction))) as { events: AgentEvent[] }
    for (const event of result.events) {
      for (const listener of this.#listeners) listener(event)
    }
    return result.events
  }
  async create(command: AgentCommand, workspaceId: string, title: string, context: AgentSessionContext): Promise<AgentSessionRecord> {
    const result = JSON.parse(await this.native.agentCreateSession(JSON.stringify({ command, workspaceId, provider: "codex", title, context }))) as { session: AgentSessionRecord }
    return result.session
  }
}
