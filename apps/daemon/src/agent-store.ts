import type {
  AgentActor, AgentCommand, AgentCommit, AgentEvent, AgentEventDraft,
  AgentSessionContext, AgentSessionRecord, AgentSnapshot, AgentTurn,
} from "./agent-protocol.ts"

export interface AgentPersistence {
  agentIdentity(): Promise<string>
  agentAllocateId(): Promise<string>
  agentList(): Promise<string>
  agentSession(sessionId: string): Promise<string>
  agentSnapshot(sessionId: string): Promise<string>
  agentHistory(sessionId: string, afterSeq: string, limit: number): Promise<string>
  agentCommand(operationId: string): Promise<string>
  agentCommands(sessionId: string): Promise<string>
  agentCommandsSince(sessionId: string, afterRevision: string): Promise<string>
  agentAdmissionDeleted(operationId: string): Promise<boolean>
  agentCommit(transaction: string): Promise<string>
  agentCreateSession(request: string): Promise<string>
}

export const timestamp = () => new Date().toISOString()
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

export function requireActiveSession(session: AgentSessionRecord): void {
  if (session.archiveState !== "active") throw new Error("Restore this Session before starting or changing its execution")
}

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
  async session(id: string): Promise<AgentSessionRecord> {
    const session = JSON.parse(await this.native.agentSession(id)) as AgentSessionRecord | null
    if (!session) throw new Error("Agent Session was not found")
    return session
  }
  async read(id: string): Promise<AgentSnapshot> {
    const snapshot = JSON.parse(await this.native.agentSnapshot(id)) as AgentSnapshot | null
    if (!snapshot) throw new Error("Agent Session was not found")
    return snapshot
  }
  async command(operationId: string): Promise<AgentCommand | null> {
    return JSON.parse(await this.native.agentCommand(operationId))
  }
  async commands(sessionId: string): Promise<AgentCommand[]> {
    return JSON.parse(await this.native.agentCommands(sessionId))
  }
  async commandsSince(sessionId: string, afterRevision: string): Promise<{ commands: AgentCommand[]; revision: string }> {
    return JSON.parse(await this.native.agentCommandsSince(sessionId, afterRevision))
  }
  /** Publish receipt changes so synchronization observes outcomes after domain events. */
  async saveCommand(command: AgentCommand): Promise<void> {
    if (!command.sessionId) { await this.commit(undefined, { command }); return }
    const sessionId = command.sessionId
    await this.serial(sessionId, async () => {
      const session = JSON.parse(await this.native.agentSession(sessionId)) as AgentSessionRecord | null
      await this.commit(session ?? undefined, {
        command,
        ...(session ? { events: [this.event(sessionId, "command", command, { commandId: command.id })] } : {}),
      })
    })
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
  async commit(current: AgentSnapshot | AgentSessionRecord | undefined, changes: AgentCommit): Promise<AgentEvent[]> {
    const session = current && ("session" in current ? current.session : current)
    const terminal = (turn: AgentTurn) => ["completed", "cancelled", "interrupted", "failed"].includes(turn.state)
    if (session && changes.turns?.some(terminal)) {
      const snapshot = current && "session" in current ? current : await this.read(session.id)
      const finished = new Set(changes.turns.filter(turn => terminal(turn)
        && snapshot.turns.some(previous => previous.id === turn.id && !terminal(previous))).map(turn => turn.id))
      if (finished.size) {
        const events = [...changes.events ?? []]
        const index = events.findLastIndex(event => event.kind === "turn"
          && finished.has((event.payload as AgentTurn).id) && terminal(event.payload as AgentTurn))
        if (index < 0) throw new Error("Finishing a turn requires its journal event")
        const completed = { ...changes.session ?? session,
          lastCompletedSeq: String(BigInt(session.lastEventSeq) + BigInt(index) + 1n) }
        if (!events.some(event => event.kind === "session")) events.push(this.event(session.id, "session", completed))
        changes = { ...changes, session: completed, events }
      }
    }
    const transaction: AgentCommit = session ? {
      sessionId: session.id, expectedSeq: session.lastEventSeq,
      ...changes,
    } : changes
    const result = JSON.parse(await this.native.agentCommit(JSON.stringify(transaction))) as { events: AgentEvent[] }
    for (const event of result.events) {
      for (const listener of this.#listeners) listener(event)
    }
    return result.events
  }
  async create(command: AgentCommand, workspaceId: string | undefined, title: string, context: AgentSessionContext, provider: string, accounting: { admissionGeneration?: string; inheritedTurnCount?: number } = {}): Promise<AgentSessionRecord> {
    const result = JSON.parse(await this.native.agentCreateSession(JSON.stringify({
      command, provider, title, context, ...accounting, ...(workspaceId ? { workspaceId } : {}),
    }))) as { session: AgentSessionRecord }
    return result.session
  }
}
