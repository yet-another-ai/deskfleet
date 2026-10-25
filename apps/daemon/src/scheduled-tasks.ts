import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentActor, AgentEvent, AgentReceipt, AgentSnapshot } from "./agent-protocol.ts"
import type { AgentSessions } from "./agent-sessions.ts"
import type { AgentProviders } from "./agent-providers.ts"
import type { DaemonCatalog } from "./catalog.ts"
import { scheduleInput, scheduleObject, type ScheduleInput, type ScheduleRun, type ScheduledTask } from "./schedule-protocol.ts"
import { nextScheduleTime } from "./schedule-time.ts"

interface StoredRun extends ScheduleRun { createOperationId: string; inputOperationId: string }
interface StoredTask extends Omit<ScheduledTask, "lastRun" | "runs"> { actor: AgentActor; runs: StoredRun[] }
interface Dependencies {
  agents: Pick<AgentSessions, "handle" | "onEvent" | "journal">
  catalog: Pick<DaemonCatalog, "native">
  providers: Pick<AgentProviders, "get">
  /** Revalidate durable user delegation against current Team membership. */
  authorize: (actor: AgentActor) => Promise<AgentActor>
  now?: () => Date
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const activeTurn = (state: string) => ["starting", "running", "cancelling"].includes(state)
const pendingInput = (state: string) => ["pending", "dispatching", "uncertain"].includes(state)

function verified(actor: AgentActor): AgentActor {
  if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and login session are required")
  return structuredClone(actor)
}
function publicRun(run: StoredRun): ScheduleRun {
  const { createOperationId: _create, inputOperationId: _input, ...result } = run
  return structuredClone(result)
}
function publicTask(task: StoredTask): ScheduledTask {
  const { actor: _actor, runs, ...result } = task
  return structuredClone({ ...result, runs: runs.map(publicRun), ...(runs[0] ? { lastRun: publicRun(runs[0]) } : {}) })
}

/** Machine-owned scheduling survives viewer disconnects and never automatically replays uncertain dispatch. */
export class ScheduledTasks {
  readonly #directory: string
  readonly #path: string
  readonly #dependencies: Dependencies
  readonly #listeners = new Set<() => void>()
  readonly #pending = new Set<Promise<unknown>>()
  #tasks: StoredTask[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #timer: ReturnType<typeof setTimeout> | undefined
  #unsubscribe: (() => void) | undefined
  #started = false
  #closed = false

  constructor(directory: string, dependencies: Dependencies) {
    this.#directory = directory; this.#path = join(directory, "scheduled-tasks.json"); this.#dependencies = dependencies
  }

  #now(): Date { return this.#dependencies.now?.() ?? new Date() }

  async init(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    try {
      const parsed = scheduleObject(JSON.parse(await readFile(this.#path, "utf8")))
      if (!Array.isArray(parsed.tasks)) throw new Error("Invalid scheduled tasks file")
      const ids = new Set<string>()
      this.#tasks = parsed.tasks.map(value => {
        const saved = scheduleObject(value)
        if (typeof saved.id !== "string" || !/^[\da-f-]{36}$/u.test(saved.id) || ids.has(saved.id) || !Array.isArray(saved.runs)) throw new Error("Invalid saved scheduled task")
        ids.add(saved.id)
        const task = { ...saved, ...scheduleInput(saved), actor: verified(saved.actor as AgentActor) } as unknown as StoredTask
        if (!Number.isFinite(Date.parse(task.createdAt)) || !Number.isFinite(Date.parse(task.updatedAt))) throw new Error("Invalid saved schedule timestamp")
        if (!task.enabled || task.trigger.kind === "manual") task.nextRunAt = undefined
        else if (!task.nextRunAt || Date.parse(task.nextRunAt) <= this.#now().getTime()) task.nextRunAt = nextScheduleTime(task.trigger, this.#now())
        return task
      })
      for (const task of this.#tasks) for (const run of task.runs) {
        if (run.state !== "claimed") continue
        const creation = await this.#dependencies.agents.journal.command(run.createOperationId)
        const submission = await this.#dependencies.agents.journal.command(run.inputOperationId)
        const receipt = submission?.result as AgentReceipt | undefined
        run.sessionId ??= receipt?.sessionId ?? creation?.sessionId
        run.inputId ??= receipt?.inputId
        run.state = receipt?.inputId ? "running" : "interrupted"
        if (run.state === "interrupted") {
          run.finishedAt = this.#now().toISOString(); run.error = "Daemon stopped during dispatch; delivery was not repeated"
        }
      }
      await this.#save(this.#tasks)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    // Agent initialization recovers lost runs before scheduler initialization.
    for (const task of this.#tasks) for (const run of task.runs.filter(run => run.state === "running")) await this.#reconcile(task.id, run.id)
    this.#unsubscribe = this.#dependencies.agents.onEvent(event => this.#event(event))
  }

  onChanged(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  start(): void { if (!this.#closed) { this.#started = true; this.#arm() } }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.#queue.catch(() => {}).then(action)
    this.#queue = pending
    return pending
  }

  #track<T>(pending: Promise<T>): Promise<T> {
    this.#pending.add(pending)
    void pending.finally(() => this.#pending.delete(pending)).catch(() => {})
    return pending
  }

  async #save(tasks: StoredTask[]): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ tasks }), { mode: 0o600, flush: true })
      await rename(temporary, this.#path)
    } finally { await rm(temporary, { force: true }) }
    this.#tasks = tasks
    for (const listener of this.#listeners) listener()
    this.#arm()
  }

  #find(tasks: StoredTask[], id: unknown): StoredTask {
    const task = tasks.find(task => task.id === id)
    if (!task) throw new Error("Scheduled task was not found")
    return task
  }

  async #validateTarget(input: ScheduleInput): Promise<void> {
    const workspace = (await this.#dependencies.catalog.native.snapshot()).workspaces.find(workspace => workspace.id === input.workspaceId)
    if (!workspace) throw new Error("Scheduled task Workspace was not found")
    if (input.target.kind === "new") this.#dependencies.providers.get(input.target.provider)
    else {
      const { session } = await this.#dependencies.agents.journal.read(input.target.sessionId)
      if (session.workspaceId !== input.workspaceId) throw new Error("Scheduled Session must belong to the selected Workspace")
      if (session.archiveState !== "active" || session.lifecycle !== "ready") throw new Error("Scheduled Session must be active and ready")
    }
  }

  async handle(method: string, value: unknown, actor: AgentActor): Promise<unknown> {
    if (this.#closed) throw new Error("Scheduler is stopping")
    const owner = verified(actor)
    const params = scheduleObject(value)
    if (method === "scheduleRun") return this.#track(this.#run(params.scheduleId, owner))
    return this.#serial(async () => {
      if (this.#closed) throw new Error("Scheduler is stopping")
      if (method === "scheduleList") return this.#tasks.map(publicTask)
      const tasks = structuredClone(this.#tasks)
      const now = this.#now().toISOString()
      if (method === "scheduleCreate") {
        const input = scheduleInput(params.schedule)
        await this.#validateTarget(input)
        const task: StoredTask = { ...input, id: randomUUID(), actor: owner, createdAt: now, updatedAt: now, runs: [],
          nextRunAt: input.enabled ? nextScheduleTime(input.trigger, this.#now()) : undefined }
        tasks.push(task)
        await this.#save(tasks)
        return publicTask(task)
      }
      const task = this.#find(tasks, params.scheduleId)
      if (method === "scheduleDelete") {
        await this.#save(tasks.filter(value => value.id !== task.id))
        return null
      }
      if (method !== "scheduleUpdate") throw new Error("Unknown schedule operation")
      const changes = scheduleObject(params.changes)
      const input = scheduleInput({ ...task, ...changes })
      if (input.workspaceId !== task.workspaceId) throw new Error("A scheduled task's Workspace cannot be changed")
      // Pausing remains possible even if its provider or target has been removed.
      if (input.enabled || Object.keys(changes).some(key => key !== "enabled")) await this.#validateTarget(input)
      const reschedule = JSON.stringify(input.trigger) !== JSON.stringify(task.trigger) || input.enabled !== task.enabled
      Object.assign(task, input, { actor: owner, updatedAt: now })
      if (reschedule) task.nextRunAt = input.enabled ? nextScheduleTime(input.trigger, this.#now()) : undefined
      await this.#save(tasks)
      return publicTask(task)
    })
  }

  #arm(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (!this.#started || this.#closed) return
    const next = this.#tasks.filter(task => task.enabled && task.nextRunAt).map(task => Date.parse(task.nextRunAt!))
    if (!next.length) return
    const delay = Math.max(10, Math.min(60_000, Math.min(...next) - this.#now().getTime()))
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.tick().catch(error => console.error("Schedule tick failed", message(error))).finally(() => this.#arm()) }, delay)
    this.#timer.unref()
  }

  /** Public for deterministic clock tests; the daemon normally drives this with its own timer. */
  async tick(): Promise<void> {
    if (this.#closed) return
    const due = this.#tasks.filter(task => task.enabled && task.nextRunAt && Date.parse(task.nextRunAt) <= this.#now().getTime())
    await Promise.all(due.map(task => this.#track(this.#run(task.id, undefined, task.nextRunAt)).catch(error => console.error("Scheduled task dispatch failed", message(error)))))
  }

  async #sessionPresence(sessionId: string): Promise<"missing" | "archived" | "present" | "unknown"> {
    try {
      const session = (await this.#dependencies.agents.journal.list()).find(session => session.id === sessionId)
      if (!session) return "missing"
      return session.archiveState === "archived" ? "archived" : "present"
    } catch { return "unknown" }
  }

  #release(run: StoredRun, reason: "missing" | "archived"): void {
    if (run.state !== "running") return
    run.state = "interrupted"
    run.finishedAt = run.finishedAt ?? this.#now().toISOString()
    run.error = reason === "archived" ? "Scheduled Session was archived" : "Scheduled Session is no longer available"
  }

  /** True when this run's input or turn should still count as scheduled overlap. */
  #pendingWork(run: StoredRun, snapshot: AgentSnapshot): boolean {
    if (!run.inputId) return run.state === "interrupted" && (snapshot.inputs.some(input => pendingInput(input.state)) || snapshot.turns.some(turn => activeTurn(turn.state)))
    const input = snapshot.inputs.find(input => input.id === run.inputId)
    if (input && pendingInput(input.state)) return true
    return snapshot.turns.some(turn => (turn.initialInputId === run.inputId || turn.id === input?.turnId) && activeTurn(turn.state))
  }

  async #activity(run: StoredRun): Promise<"blocking" | "anchor" | "idle" | "missing"> {
    const sessionId = run.sessionId
    if (!sessionId) return "idle"
    let snapshot: AgentSnapshot
    try { snapshot = await this.#dependencies.agents.journal.read(sessionId) }
    catch {
      // A missing Session cannot execute its input. A fully archived one cannot
      // either, but restoring it can make that input overlap again. A failed
      // read of a Session that may still be active does not prove the work stopped.
      const presence = await this.#sessionPresence(sessionId)
      if (presence === "missing") return "missing"
      if (presence === "archived") return "anchor"
      return "blocking"
    }
    if (!this.#pendingWork(run, snapshot)) return "idle"
    // Archive still closing keeps its input blocking. A finished archive does not,
    // but the run stays retained so restore can apply overlap again.
    return snapshot.session.archiveState === "archived" ? "anchor" : "blocking"
  }

  async #overlap(task: StoredTask): Promise<{ blocking?: StoredRun; retained: StoredRun[] }> {
    let blocking: StoredRun | undefined
    const retained: StoredRun[] = []
    for (const run of task.runs) {
      if (run.state === "claimed") { blocking ??= run; retained.push(run); continue }
      if (!run.sessionId || run.state === "completed" || run.state === "skipped") continue
      const activity = await this.#activity(run)
      if (activity === "blocking") { blocking ??= run; retained.push(run) }
      else if (activity === "anchor") retained.push(run)
      else if (activity === "missing") this.#release(run, "missing")
    }
    return { blocking, retained }
  }

  async #run(id: unknown, manualActor?: AgentActor, scheduledFor?: string): Promise<ScheduleRun | undefined> {
    const claimed = await this.#serial(async () => {
      if (this.#closed) throw new Error("Scheduler is stopping")
      const tasks = structuredClone(this.#tasks)
      const task = this.#find(tasks, id)
      // Competing ticks may observe the same deadline; only its first claim wins.
      if (scheduledFor && (!task.enabled || task.nextRunAt !== scheduledFor)) return undefined
      const now = this.#now().toISOString()
      const { blocking, retained } = await this.#overlap(task)
      const run: StoredRun = { id: randomUUID(), createOperationId: randomUUID(), inputOperationId: randomUUID(), state: blocking ? "skipped" : "claimed",
        scheduledFor: scheduledFor ?? now, startedAt: now, ...(blocking ? { finishedAt: now, error: "The previous scheduled input is still active" } : {}) }
      task.runs = [run, ...task.runs].slice(0, 50)
      // The newest 50 runs stay visible. Also keep live overlap and archived
      // inputs that would overlap again if their Session is restored.
      for (const anchor of retained) if (!task.runs.some(value => value.id === anchor.id)) task.runs.push(anchor)
      if (scheduledFor) task.nextRunAt = nextScheduleTime(task.trigger, this.#now())
      await this.#save(tasks)
      return { task: structuredClone(task), run: structuredClone(run) }
    })
    if (!claimed) return undefined
    const { task, run } = claimed
    if (run.state === "skipped") return publicRun(run)
    try {
      const actor = await this.#dependencies.authorize(manualActor ?? task.actor)
      if (this.#closed) throw new Error("Scheduler stopped before dispatch")
      await this.#validateTarget(task)
      let sessionId: string
      if (task.target.kind === "existing") sessionId = task.target.sessionId
      else {
        const snapshot = await this.#dependencies.agents.handle("_deskfleet/session/create", {
          workspaceId: task.workspaceId, operationId: run.createOperationId, title: task.title, provider: task.target.provider,
          context: task.target.context, ...task.target.configuration,
        }, actor) as AgentSnapshot
        sessionId = snapshot.session.id
        run.sessionId = sessionId
        await this.#updateRun(task.id, run)
        if (snapshot.session.lifecycle !== "ready") throw new Error(snapshot.session.error ?? "Scheduled Session provisioning failed")
      }
      run.sessionId = sessionId
      if (this.#closed) throw new Error("Scheduler stopped before input submission")
      const receipt = await this.#dependencies.agents.handle("_deskfleet/input/submit", {
        sessionId, operationId: run.inputOperationId, content: [{ type: "text", text: task.prompt }], delivery: "backlog",
      }, actor) as AgentReceipt
      run.inputId = receipt.inputId
      run.state = "running"
      await this.#updateRun(task.id, run)
      await this.#reconcile(task.id, run.id)
      const saved = this.#tasks.find(value => value.id === task.id)?.runs.find(value => value.id === run.id)
      return publicRun(saved ?? run)
    } catch (error) {
      let failure: "failed" | "interrupted" = "failed"
      if (run.sessionId && !run.inputId) {
        try {
          // Input acceptance and its receipt share a journal transaction. A lost
          // caller response must not make the next occurrence submit it again.
          const command = await this.#dependencies.agents.journal.command(run.inputOperationId)
          const receipt = command?.result as AgentReceipt | undefined
          if (receipt?.inputId && receipt.sessionId === run.sessionId) {
            run.inputId = receipt.inputId; run.state = "running"
            await this.#updateRun(task.id, run)
            await this.#reconcile(task.id, run.id)
            const saved = this.#tasks.find(value => value.id === task.id)?.runs.find(value => value.id === run.id)
            return publicRun(saved ?? run)
          }
          if (command?.status === "accepted" || command?.status === "uncertain") failure = "interrupted"
        } catch { failure = "interrupted" }
      }
      run.state = failure; run.finishedAt = this.#now().toISOString(); run.error = message(error)
      await this.#updateRun(task.id, run)
      return publicRun(run)
    }
  }

  #updateRun(taskId: string, run: StoredRun): Promise<void> {
    return this.#serial(async () => {
      const tasks = structuredClone(this.#tasks)
      const task = tasks.find(task => task.id === taskId)
      const index = task?.runs.findIndex(value => value.id === run.id) ?? -1
      if (!task || index < 0) return
      task.runs[index] = structuredClone(run)
      await this.#save(tasks)
    })
  }

  #event(event: AgentEvent): void {
    if (this.#closed || !["input", "turn", "run", "session"].includes(event.kind)) return
    for (const task of this.#tasks) for (const run of task.runs) {
      if (run.sessionId === event.sessionId && run.inputId && ["running", "failed", "interrupted"].includes(run.state)) {
        void this.#track(this.#reconcile(task.id, run.id)).catch(error => console.error("Schedule result update failed", message(error)))
      }
    }
  }

  #reconcile(taskId: string, runId: string): Promise<void> {
    return this.#serial(async () => {
      const tasks = structuredClone(this.#tasks)
      const run = tasks.find(task => task.id === taskId)?.runs.find(run => run.id === runId)
      if (!run || !["running", "failed", "interrupted"].includes(run.state) || !run.sessionId || !run.inputId) return
      const previous = JSON.stringify(run)
      let snapshot: AgentSnapshot
      try { snapshot = await this.#dependencies.agents.journal.read(run.sessionId) }
      catch {
        // Startup must survive a stale run whose Session journal is gone or unreadable.
        const presence = await this.#sessionPresence(run.sessionId)
        if (presence !== "missing" && presence !== "archived") return
        this.#release(run, presence)
        if (JSON.stringify(run) === previous) return
        await this.#save(tasks)
        return
      }
      const input = snapshot.inputs.find(input => input.id === run.inputId)
      const turn = snapshot.turns.find(turn => turn.id === input?.turnId)
        ?? snapshot.turns.findLast(turn => turn.initialInputId === run.inputId)
      if (turn && activeTurn(turn.state)) {
        run.state = "running"; run.error = undefined; run.finishedAt = undefined
      } else if (turn) {
        run.state = turn.state === "completed" ? "completed" : turn.state === "interrupted" ? "interrupted" : "failed"
        run.error = turn.error ?? (turn.state === "cancelled" ? "Scheduled turn was cancelled" : undefined)
      } else if (input && ["failed", "withdrawn", "uncertain"].includes(input.state)) {
        run.state = input.state === "uncertain" ? "interrupted" : "failed"
        run.error = input.error ?? `Scheduled input is ${input.state}`
      } else if (snapshot.session.archiveState !== "active") {
        run.state = "interrupted"; run.error = "Scheduled Session was archived"
      } else if (input?.state === "pending") {
        const providerRun = snapshot.runs.at(-1)
        if (providerRun && (providerRun.state === "failed" || providerRun.state === "interrupted")) {
          run.state = providerRun.state; run.error = providerRun.error ?? "The Agent could not run the scheduled input"
        } else { run.state = "running"; run.error = undefined; run.finishedAt = undefined }
      } else return
      if (run.state !== "running") run.finishedAt = turn?.endedAt ?? run.finishedAt ?? this.#now().toISOString()
      if (JSON.stringify(run) === previous) return
      await this.#save(tasks)
    })
  }

  async close(): Promise<void> {
    this.#closed = true; this.#started = false; clearTimeout(this.#timer); this.#unsubscribe?.()
    await Promise.allSettled([...this.#pending])
    await this.#queue.catch(() => {})
  }
}
