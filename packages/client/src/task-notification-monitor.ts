import type { AgentSessionSummary, CentralApi, CentralEvent } from "./central.ts"

export interface TaskNotification {
  kind: "taskCompleted" | "taskNeedsInput"
  machineId: string
  sessionId: string
  title: string
}

type NotificationSource = Pick<CentralApi, "status" | "teams" | "machines" | "sessions" | "onEvent">
interface SeenSession {
  sequence: bigint
  completedTurns: Set<string>
  requests: Set<string>
}
interface SeenMachine {
  watchStartedAt: number
  initialized: boolean
  /** The first read failed or was discarded, so the next snapshot is not a silent baseline. */
  missedBaseline: boolean
  /** Recover missed targeted updates with a full read on the next event. */
  refreshAll: boolean
  sessions: Map<string, SeenSession>
}

/** Observes synchronized tasks independently of the host's visible machine or route. */
export class TaskNotificationMonitor {
  readonly #source: NotificationSource
  readonly #notify: (notification: TaskNotification) => void
  readonly #onError: (error: unknown) => void
  readonly #machines = new Map<string, SeenMachine>()
  readonly #pendingMachines = new Map<string, Set<string> | null>()
  #identity: string | undefined
  #epoch = 0
  #rosterPending = false
  #running: Promise<void> | undefined
  #unsubscribe: (() => void) | undefined
  #closed = false

  constructor(source: NotificationSource, notify: (notification: TaskNotification) => void, onError: (error: unknown) => void) {
    this.#source = source
    this.#notify = notify
    this.#onError = onError
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    this.#unsubscribe ??= this.#source.onEvent(event => this.#event(event))
    this.#rosterPending = true
    return this.#schedule()
  }

  close(): void {
    this.#closed = true
    this.#epoch++
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#machines.clear()
    this.#pendingMachines.clear()
    this.#rosterPending = false
  }

  #event(event: CentralEvent): void {
    if (this.#closed) return
    if (event.type === "accountChanged") {
      // Logout/server changes invalidate reads immediately, before their next response arrives.
      this.#epoch++
      this.#identity = undefined
      this.#machines.clear()
      this.#pendingMachines.clear()
      this.#rosterPending = true
    } else if (event.type === "connection" && event.connected) {
      this.#rosterPending = true
    } else if (event.type === "machinesChanged") {
      this.#epoch++
      this.#rosterPending = true
    } else if (event.type === "catalogChanged") {
      if (this.#machines.has(event.machineId)) this.#queueMachine(event.machineId, event.sessionId)
      else this.#rosterPending = true
    } else return
    void this.#schedule()
  }

  #current(epoch: number): boolean { return !this.#closed && epoch === this.#epoch }

  #queueMachine(machineId: string, sessionId?: string): void {
    const machine = this.#machines.get(machineId)
    if (!sessionId || !machine?.initialized || machine.refreshAll) {
      this.#pendingMachines.set(machineId, null)
      return
    }
    const pending = this.#pendingMachines.get(machineId)
    if (pending === null) return
    const sessions = pending ?? new Set<string>()
    sessions.add(sessionId)
    this.#pendingMachines.set(machineId, sessions)
  }

  #schedule(): Promise<void> {
    if (this.#running) return this.#running
    this.#running = this.#drain().finally(() => {
      this.#running = undefined
      if (!this.#closed && (this.#rosterPending || this.#pendingMachines.size)) void this.#schedule()
    })
    return this.#running
  }

  async #drain(): Promise<void> {
    while (!this.#closed && (this.#rosterPending || this.#pendingMachines.size)) {
      const epoch = this.#epoch
      if (this.#rosterPending) {
        this.#rosterPending = false
        try { await this.#refreshRoster(epoch) }
        catch (error) { if (this.#current(epoch)) this.#onError(error) }
        if (!this.#current(epoch)) continue
      }
      const machines = [...this.#pendingMachines]
      this.#pendingMachines.clear()
      await Promise.all(machines.map(async ([id, sessions]) => {
        try { await this.#refreshMachine(id, epoch, sessions) }
        catch (error) { if (this.#current(epoch)) this.#onError(error) }
      }))
    }
  }

  async #refreshRoster(epoch: number): Promise<void> {
    const account = await this.#source.status()
    if (!this.#current(epoch)) return
    const identity = account.user ? JSON.stringify([account.serverUrl, account.user.id]) : undefined
    if (identity !== this.#identity) {
      this.#identity = identity
      this.#machines.clear()
      this.#pendingMachines.clear()
    }
    if (!identity) return
    const teams = await this.#source.teams()
    if (!this.#current(epoch)) return
    const machines = (await Promise.all(teams.map(team => this.#source.machines(team.id)))).flat()
    if (!this.#current(epoch)) return
    const authorized = new Set(machines.map(machine => machine.id))
    for (const id of this.#machines.keys()) if (!authorized.has(id)) this.#machines.delete(id)
    for (const id of authorized) {
      if (!this.#machines.has(id)) this.#machines.set(id, { watchStartedAt: Date.now(), initialized: false, missedBaseline: false, refreshAll: false, sessions: new Map() })
      this.#queueMachine(id)
    }
  }

  async #refreshMachine(machineId: string, epoch: number, sessions: Set<string> | null): Promise<void> {
    const seen = this.#machines.get(machineId)
    if (!seen) return
    const full = sessions === null || !seen.initialized || seen.refreshAll
    let snapshots: AgentSessionSummary[]
    try {
      snapshots = full ? await this.#source.sessions(machineId)
        : (await Promise.all([...sessions!].map(id => this.#source.sessions(machineId, id)))).flat()
    } catch (error) {
      const current = this.#machines.get(machineId)
      if (this.#current(epoch) && current) {
        current.refreshAll = true
        if (!current.initialized) current.missedBaseline = true
      }
      throw error
    }
    const machine = this.#machines.get(machineId)
    if (!this.#current(epoch) || !machine) {
      if (machine && !machine.initialized) machine.missedBaseline = true
      return
    }
    // An immediate first read is the baseline, including events timestamped slightly
    // after the watch. A failed, discarded, or slow read must still surface work
    // that happened after observation began.
    const silentBaseline = !machine.initialized && !machine.missedBaseline && Date.now() <= machine.watchStartedAt
    for (const snapshot of snapshots) this.#observe(machineId, machine, snapshot, silentBaseline)
    machine.initialized = true
    if (full) machine.refreshAll = false
  }

  #observe(machineId: string, machine: SeenMachine, snapshot: AgentSessionSummary, silentBaseline: boolean): void {
    const { session } = snapshot
    const previous = machine.sessions.get(session.id)
    const sequence = BigInt(session.lastEventSeq)
    if (previous && sequence <= previous.sequence) return
    const seen = previous ?? { sequence, completedTurns: new Set<string>(), requests: new Set<string>() }
    // A daemon can upload existing history after the first (possibly empty) read.
    // Only new sessions need a time boundary; observed sessions use durable IDs.
    const eligible = (timestamp: string | undefined) => previous !== undefined
      || (timestamp !== undefined && Date.parse(timestamp) >= machine.watchStartedAt)
    const notices: TaskNotification["kind"][] = []
    for (const turn of snapshot.turns) {
      if (turn.state !== "completed") continue
      if (!seen.completedTurns.has(turn.id) && eligible(turn.endedAt)) notices.push("taskCompleted")
      seen.completedTurns.add(turn.id)
    }
    for (const [kind, requests] of [["permission", snapshot.permissions], ["elicitation", snapshot.elicitations]] as const) {
      for (const request of requests) {
        const id = `${kind}:${request.id}`
        if (request.state === "pending" && !seen.requests.has(id) && eligible(request.createdAt)) notices.push("taskNeedsInput")
        // Remember resolved requests too: replay must never make an old question new.
        seen.requests.add(id)
      }
    }
    seen.sequence = sequence
    machine.sessions.set(session.id, seen)
    if (silentBaseline || session.archiveState !== "active" || session.lifecycle !== "ready") return
    for (const kind of notices) {
      this.#notify({ kind, machineId, sessionId: session.id, title: session.title })
    }
  }
}
