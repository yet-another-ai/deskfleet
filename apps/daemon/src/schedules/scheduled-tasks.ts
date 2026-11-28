import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentActor, AgentEvent, AgentReceipt, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { AgentSessions } from "../agent/sessions.ts"
import type { AgentProviders } from "../providers/providers.ts"
import type { DaemonCatalog } from "../machine/catalog.ts"
import {
  scheduleInput, scheduleObject, scheduleOperationId, schedulePlannedId,
  type ScheduleCommandReceipt, type ScheduleInput, type SchedulePrivateEvent, type ScheduleRun, type ScheduledTask,
} from "@deskfleet/protocol/schedule"
import { nextScheduleTime } from "./time.ts"

interface StoredRun extends ScheduleRun { createOperationId: string; inputOperationId: string; ownerUserId?: string; manualRunByUserId?: string; scheduleVersion?: number }
interface StoredTask extends Omit<ScheduledTask, "lastRun" | "runs"> {
  actor: AgentActor
  createdByActor?: AgentActor
  version?: number
  runs: StoredRun[]
}
interface Dependencies {
  agents: Pick<AgentSessions, "handle" | "onEvent" | "journal">
  catalog: Pick<DaemonCatalog, "native">
  providers: Pick<AgentProviders, "get">
  /** Revalidate durable user delegation against current Team membership. */
  authorize: (actor: AgentActor) => Promise<AgentActor>
  /** Optional predicate identifying schedules with private SA follow-up subscribers. */
  isSubscribed?: (scheduleId: string, ownerUserId?: string) => boolean
  /** Optional predicate identifying owners with global schedule takeover enabled so new creates emit a private event. */
  shouldEmitCreated?: (ownerUserId: string) => boolean
  now?: () => Date
}
const MAX_RECEIPTS = 500
const MAX_PENDING_EVENTS = 2000
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const activeTurn = (state: string) => ["starting", "running", "cancelling"].includes(state)
const pendingInput = (state: string) => ["pending", "dispatching", "uncertain"].includes(state)

function verified(actor: AgentActor): AgentActor {
  if (actor.kind !== "user" || !actor.userId || !actor.deviceId) throw new Error("A verified user and login session are required")
  return structuredClone(actor)
}

/** Explicit field allowlist guarantees private follow-up/ownership metadata never enters public snapshots or MCP. */
function publicRun(run: StoredRun): ScheduleRun {
  return structuredClone({
    id: run.id,
    state: run.state,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    ...(run.inputId !== undefined ? { inputId: run.inputId } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
  })
}

function publicTask(task: StoredTask): ScheduledTask {
  const runs = task.runs.map(publicRun)
  return structuredClone({
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    workspaceId: task.workspaceId,
    enabled: task.enabled,
    ...(task.yolo === true ? { yolo: true } : {}),
    target: task.target,
    trigger: task.trigger,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.nextRunAt !== undefined ? { nextRunAt: task.nextRunAt } : {}),
    runs,
    ...(runs[0] ? { lastRun: runs[0] } : {}),
  })
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
}

function hashParams(method: string, payload: unknown): string {
  return createHash("sha256").update(`${method}:${stableJson(payload)}`).digest("hex")
}

function targetKindOf(task: Pick<StoredTask, "target">): "worktree" | "directory" | "existing" {
  return task.target.kind === "existing" ? "existing" : task.target.context
}

/** Machine-owned scheduling survives viewer disconnects and never automatically replays uncertain dispatch. */
export class ScheduledTasks {
  readonly #directory: string
  readonly #path: string
  readonly #dependencies: Dependencies
  readonly #listeners = new Set<() => void>()
  readonly #privateListeners = new Set<() => void>()
  readonly #pending = new Set<Promise<unknown>>()
  #isSubscribed?: (scheduleId: string, ownerUserId?: string) => boolean
  #shouldEmitCreated?: (ownerUserId: string) => boolean
  #tasks: StoredTask[] = []
  #receipts: ScheduleCommandReceipt[] = []
  #pendingEvents: SchedulePrivateEvent[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #timer: ReturnType<typeof setTimeout> | undefined
  #unsubscribe: (() => void) | undefined
  #started = false
  #closed = false

  constructor(directory: string, dependencies: Dependencies) {
    this.#directory = directory; this.#path = join(directory, "scheduled-tasks.json"); this.#dependencies = dependencies
    this.#isSubscribed = dependencies.isSubscribed
    this.#shouldEmitCreated = dependencies.shouldEmitCreated
  }

  #now(): Date { return this.#dependencies.now?.() ?? new Date() }
  #subscribed(scheduleId: string, ownerUserId?: string): boolean { return this.#isSubscribed?.(scheduleId, ownerUserId) === true }
  #autoAdoptOwner(ownerUserId: string | undefined): boolean { return !!ownerUserId && this.#shouldEmitCreated?.(ownerUserId) === true }

  /** Attach or update the private SA subscriber check without mutating public schedule behavior. */
  setSubscriberCheck(check: ((scheduleId: string, ownerUserId?: string) => boolean) | undefined): void {
    this.#isSubscribed = check
  }

  /** Attach or update the private SA global schedule takeover check for newly created schedules. */
  setAutoAdoptCheck(check: ((ownerUserId: string) => boolean) | undefined): void {
    this.#shouldEmitCreated = check
  }

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
      if (Array.isArray(parsed.commandReceipts)) {
        this.#receipts = (parsed.commandReceipts as ScheduleCommandReceipt[])
          .filter(item => item && typeof item.operationId === "string" && typeof item.paramsHash === "string")
          .slice(-MAX_RECEIPTS)
      }
      if (Array.isArray(parsed.pendingEvents)) {
        this.#pendingEvents = (parsed.pendingEvents as SchedulePrivateEvent[])
          .filter(item => item && typeof item.id === "string" && typeof item.scheduleId === "string")
          .slice(-MAX_PENDING_EVENTS)
      }
      const recoveredEvents: SchedulePrivateEvent[] = []
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
          if (this.#subscribed(task.id, run.ownerUserId ?? task.actor.userId)) recoveredEvents.push(this.#runEvent("run_finished", task, run))
        }
      }
      await this.#save(this.#tasks, this.#receipts, [...this.#pendingEvents, ...recoveredEvents], { publicChanged: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    // Agent initialization recovers lost runs before scheduler initialization.
    for (const task of this.#tasks) for (const run of task.runs.filter(run => run.state === "running")) await this.#reconcile(task.id, run.id)
    this.#unsubscribe = this.#dependencies.agents.onEvent(event => this.#event(event))
  }

  onChanged(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  onPrivateEvent(listener: () => void): () => void { this.#privateListeners.add(listener); return () => this.#privateListeners.delete(listener) }
  /** Committed public state for central replication; delegation and operation IDs stay local. */
  snapshot(): ScheduledTask[] { return this.#tasks.map(publicTask) }
  /** Internal daemon-only metadata for ownership verification and follow-up reconciliation. */
  inspectTask(scheduleId: string): {
    task: ScheduledTask
    ownerUserId: string
    createdByUserId: string
    version: number
    runMeta: Record<string, { ownerUserId: string; manualRunByUserId?: string; scheduleVersion: number }>
  } | undefined {
    const task = this.#tasks.find(item => item.id === scheduleId)
    if (!task) return undefined
    const runMeta: Record<string, { ownerUserId: string; manualRunByUserId?: string; scheduleVersion: number }> = {}
    for (const run of task.runs) {
      runMeta[run.id] = {
        ownerUserId: run.ownerUserId ?? task.actor.userId!,
        ...(run.manualRunByUserId ? { manualRunByUserId: run.manualRunByUserId } : {}),
        scheduleVersion: run.scheduleVersion ?? task.version ?? 1,
      }
    }
    return {
      task: publicTask(task),
      ownerUserId: task.actor.userId!,
      createdByUserId: (task.createdByActor ?? task.actor).userId!,
      version: task.version ?? 1,
      runMeta,
    }
  }
  /** Internal daemon-only check identifying sessions provisioned by a new-session schedule run (including before run.sessionId is saved). */
  isScheduleSession(sessionId: string, createOperationId?: string): boolean {
    return this.#tasks.some(task =>
      task.target.kind === "new"
      && task.runs.some(run => run.sessionId === sessionId || (!!createOperationId && run.createOperationId === createOperationId)))
  }
  /** Internal daemon-only check identifying inputs submitted by a scheduled task run (including on existing sessions). */
  isScheduleRunInput(sessionId: string, inputId?: string, inputOperationId?: string): boolean {
    return this.#tasks.some(task =>
      task.runs.some(run =>
        (run.sessionId === sessionId || (task.target.kind === "existing" && task.target.sessionId === sessionId))
        && ((!!inputId && run.inputId === inputId) || (!!inputOperationId && run.inputOperationId === inputOperationId))))
  }
  /** Internal daemon-only inspection of an idempotent command receipt. */
  commandReceipt(operationId: string): ScheduleCommandReceipt | undefined {
    const found = this.#receipts.find(item => item.operationId === operationId)
    return found ? structuredClone(found) : undefined
  }
  /** Unacknowledged durable private schedule events awaiting consumer SQLite commit. */
  pendingPrivateEvents(): SchedulePrivateEvent[] { return structuredClone(this.#pendingEvents) }

  /** Acknowledge consumed private events atomically without triggering public central sync. */
  ackPrivateEvents(ids: string[]): Promise<void> {
    if (!ids.length) return Promise.resolve()
    const acked = new Set(ids)
    return this.#serial(async () => {
      const remaining = this.#pendingEvents.filter(event => !acked.has(event.id))
      if (remaining.length === this.#pendingEvents.length) return
      await this.#save(this.#tasks, this.#receipts, remaining, { publicChanged: false, notifyPrivate: false })
    })
  }

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

  async #save(
    tasks: StoredTask[],
    receipts: ScheduleCommandReceipt[] = this.#receipts,
    pendingEvents: SchedulePrivateEvent[] = this.#pendingEvents,
    options: { publicChanged?: boolean; notifyPrivate?: boolean } = {},
  ): Promise<void> {
    const boundedReceipts = receipts.slice(-MAX_RECEIPTS)
    const boundedEvents = pendingEvents.slice(-MAX_PENDING_EVENTS)
    const addedPrivate = boundedEvents.length > this.#pendingEvents.length
    const payload: Record<string, unknown> = { tasks }
    if (boundedReceipts.length) payload.commandReceipts = boundedReceipts
    if (boundedEvents.length) payload.pendingEvents = boundedEvents
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(payload), { mode: 0o600, flush: true })
      await rename(temporary, this.#path)
    } finally { await rm(temporary, { force: true }) }
    this.#tasks = tasks
    this.#receipts = boundedReceipts
    this.#pendingEvents = boundedEvents
    if (options.publicChanged !== false) {
      for (const listener of this.#listeners) listener()
      this.#arm()
    }
    if (options.notifyPrivate ?? addedPrivate) {
      for (const listener of this.#privateListeners) listener()
    }
  }

  #runEvent(kind: "run_started" | "run_finished" | "run_skipped", task: StoredTask, run: StoredRun): SchedulePrivateEvent {
    return {
      id: randomUUID(),
      kind,
      scheduleId: task.id,
      scheduleTitle: task.title,
      scheduleVersion: run.scheduleVersion ?? task.version ?? 1,
      workspaceId: task.workspaceId,
      targetKind: targetKindOf(task),
      ...(task.target.kind === "existing" ? { targetSessionId: task.target.sessionId } : {}),
      ownerUserId: run.ownerUserId ?? task.actor.userId!,
      ...(run.manualRunByUserId ? { manualRunByUserId: run.manualRunByUserId } : {}),
      runId: run.id,
      runState: run.state,
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.inputId ? { inputId: run.inputId } : {}),
      ...(run.error ? { error: run.error } : {}),
      createdAt: this.#now().toISOString(),
    }
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

  #checkReceipt(operationId: string | undefined, method: ScheduleCommandReceipt["method"], actor: AgentActor, paramsHash: string): ScheduleCommandReceipt | undefined {
    if (!operationId) return undefined
    const existing = this.#receipts.find(item => item.operationId === operationId)
    if (!existing) return undefined
    if (existing.method !== method || existing.actorUserId !== actor.userId || existing.paramsHash !== paramsHash) {
      throw new Error("Schedule operation ID was already used with different parameters")
    }
    return existing
  }

  async handle(method: string, value: unknown, actor: AgentActor): Promise<unknown> {
    if (this.#closed) throw new Error("Scheduler is stopping")
    const owner = verified(actor)
    const params = scheduleObject(value)
    const operationId = scheduleOperationId(params.operationId)
    if (method === "scheduleRun") {
      if (operationId) {
        const paramsHash = hashParams("scheduleRun", { scheduleId: params.scheduleId })
        const existing = this.#checkReceipt(operationId, "scheduleRun", owner, paramsHash)
        if (existing) return structuredClone(existing.result)
      }
      return this.#track(this.#run(params.scheduleId, owner, undefined, operationId))
    }
    return this.#serial(async () => {
      if (this.#closed) throw new Error("Scheduler is stopping")
      if (method === "scheduleList") return this.snapshot()
      const tasks = structuredClone(this.#tasks)
      const receipts = structuredClone(this.#receipts)
      const pendingEvents = structuredClone(this.#pendingEvents)
      const now = this.#now().toISOString()
      if (method === "scheduleCreate") {
        const input = scheduleInput(params.schedule)
        const plannedId = schedulePlannedId(params.scheduleId)
        if (plannedId && !operationId) throw new Error("A planned schedule ID requires an operation ID")
        const paramsHash = hashParams("scheduleCreate", { schedule: input, ...(plannedId ? { scheduleId: plannedId } : {}) })
        const existing = this.#checkReceipt(operationId, "scheduleCreate", owner, paramsHash)
        if (existing) {
          const live = tasks.find(item => item.id === existing.scheduleId)
          return live ? publicTask(live) : structuredClone(existing.result)
        }
        if (plannedId && (tasks.some(item => item.id === plannedId) || receipts.some(item => item.scheduleId === plannedId))) {
          throw new Error("Planned schedule ID is already in use")
        }
        await this.#validateTarget(input)
        const id = plannedId ?? randomUUID()
        const task: StoredTask = {
          ...input, id, actor: owner, createdByActor: owner, version: 1, createdAt: now, updatedAt: now, runs: [],
          nextRunAt: input.enabled ? nextScheduleTime(input.trigger, this.#now()) : undefined,
        }
        tasks.push(task)
        const result = publicTask(task)
        if (operationId) {
          receipts.push({ operationId, method: "scheduleCreate", actorUserId: owner.userId!, paramsHash, scheduleId: id, status: "completed", result, createdAt: now })
        }
        if (this.#autoAdoptOwner(owner.userId)) {
          pendingEvents.push({
            id: randomUUID(), kind: "schedule_created", scheduleId: task.id, scheduleTitle: task.title,
            scheduleVersion: task.version ?? 1, workspaceId: task.workspaceId, targetKind: targetKindOf(task),
            ...(task.target.kind === "existing" ? { targetSessionId: task.target.sessionId } : {}),
            ownerUserId: owner.userId!, editorUserId: owner.userId!, createdAt: now,
          })
        }
        await this.#save(tasks, receipts, pendingEvents)
        return result
      }
      if (method === "scheduleDelete") {
        const paramsHash = hashParams("scheduleDelete", { scheduleId: params.scheduleId })
        const existing = this.#checkReceipt(operationId, "scheduleDelete", owner, paramsHash)
        if (existing) return null
        const task = this.#find(tasks, params.scheduleId)
        const nextTasks = tasks.filter(value => value.id !== task.id)
        for (const receipt of receipts) {
          if (receipt.scheduleId === task.id && receipt.method === "scheduleCreate") receipt.status = "deleted"
        }
        if (operationId) {
          receipts.push({ operationId, method: "scheduleDelete", actorUserId: owner.userId!, paramsHash, scheduleId: task.id, status: "deleted", result: null, createdAt: now })
        }
        if (this.#subscribed(task.id, task.actor.userId)) {
          pendingEvents.push({
            id: randomUUID(), kind: "schedule_deleted", scheduleId: task.id, scheduleTitle: task.title,
            scheduleVersion: (task.version ?? 1) + 1, workspaceId: task.workspaceId, targetKind: targetKindOf(task),
            ...(task.target.kind === "existing" ? { targetSessionId: task.target.sessionId } : {}),
            ownerUserId: task.actor.userId!, editorUserId: owner.userId!, createdAt: now,
          })
        }
        await this.#save(nextTasks, receipts, pendingEvents)
        return null
      }
      if (method !== "scheduleUpdate") throw new Error("Unknown schedule operation")
      const changes = scheduleObject(params.changes)
      const paramsHash = hashParams("scheduleUpdate", { scheduleId: params.scheduleId, changes })
      const existing = this.#checkReceipt(operationId, "scheduleUpdate", owner, paramsHash)
      if (existing) {
        const live = tasks.find(item => item.id === existing.scheduleId)
        return live ? publicTask(live) : structuredClone(existing.result)
      }
      const task = this.#find(tasks, params.scheduleId)
      const input = scheduleInput({ ...task, ...changes })
      if (input.workspaceId !== task.workspaceId) throw new Error("A scheduled task's Workspace cannot be changed")
      // Pausing remains possible even if its provider or target has been removed.
      if (input.enabled || Object.keys(changes).some(key => key !== "enabled")) await this.#validateTarget(input)
      const previousOwnerUserId = task.actor.userId!
      const scopeChanged = input.prompt !== task.prompt
        || JSON.stringify(input.target) !== JSON.stringify(task.target)
        || Boolean(input.yolo) !== Boolean(task.yolo)
        || previousOwnerUserId !== owner.userId!
      const reschedule = JSON.stringify(input.trigger) !== JSON.stringify(task.trigger) || input.enabled !== task.enabled
      const nextVersion = (task.version ?? 1) + 1
      Object.assign(task, input, { actor: owner, version: nextVersion, updatedAt: now })
      // scheduleInput omits false YOLO; drop a previously saved flag when disabled.
      if (!input.yolo) delete task.yolo
      if (reschedule) task.nextRunAt = input.enabled ? nextScheduleTime(input.trigger, this.#now()) : undefined
      const result = publicTask(task)
      if (operationId) {
        receipts.push({ operationId, method: "scheduleUpdate", actorUserId: owner.userId!, paramsHash, scheduleId: task.id, status: "completed", result, createdAt: now })
      }
      if (this.#subscribed(task.id, owner.userId) || this.#subscribed(task.id, previousOwnerUserId)) {
        pendingEvents.push({
          id: randomUUID(), kind: "schedule_updated", scheduleId: task.id, scheduleTitle: task.title,
          scheduleVersion: nextVersion, workspaceId: task.workspaceId, targetKind: targetKindOf(task),
          ...(task.target.kind === "existing" ? { targetSessionId: task.target.sessionId } : {}),
          ownerUserId: owner.userId!, previousOwnerUserId, editorUserId: owner.userId!, scopeChanged, createdAt: now,
        })
      }
      await this.#save(tasks, receipts, pendingEvents)
      return result
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
      const presence = await this.#sessionPresence(sessionId)
      if (presence === "missing") return "missing"
      if (presence === "archived") return "anchor"
      return "blocking"
    }
    if (!this.#pendingWork(run, snapshot)) return "idle"
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

  async #run(id: unknown, manualActor?: AgentActor, scheduledFor?: string, operationId?: string): Promise<ScheduleRun | undefined> {
    const claimed = await this.#serial(async () => {
      if (this.#closed) throw new Error("Scheduler is stopping")
      if (operationId && manualActor) {
        const paramsHash = hashParams("scheduleRun", { scheduleId: id })
        const existing = this.#checkReceipt(operationId, "scheduleRun", manualActor, paramsHash)
        if (existing) return { existing: structuredClone(existing.result) as ScheduleRun }
      }
      const tasks = structuredClone(this.#tasks)
      const receipts = structuredClone(this.#receipts)
      const pendingEvents = structuredClone(this.#pendingEvents)
      const task = this.#find(tasks, id)
      // Competing ticks may observe the same deadline; only its first claim wins.
      if (scheduledFor && (!task.enabled || task.nextRunAt !== scheduledFor)) return undefined
      const now = this.#now().toISOString()
      const { blocking, retained } = await this.#overlap(task)
      const run: StoredRun = {
        id: randomUUID(), createOperationId: randomUUID(), inputOperationId: randomUUID(),
        ownerUserId: task.actor.userId!, ...(manualActor ? { manualRunByUserId: manualActor.userId! } : {}),
        scheduleVersion: task.version ?? 1,
        state: blocking ? "skipped" : "claimed",
        scheduledFor: scheduledFor ?? now, startedAt: now,
        ...(blocking ? { finishedAt: now, error: "The previous scheduled input is still active" } : {}),
      }
      task.runs = [run, ...task.runs].slice(0, 50)
      for (const anchor of retained) if (!task.runs.some(value => value.id === anchor.id)) task.runs.push(anchor)
      if (scheduledFor) task.nextRunAt = nextScheduleTime(task.trigger, this.#now())
      if (this.#subscribed(task.id, run.ownerUserId ?? task.actor.userId)) {
        pendingEvents.push(this.#runEvent(blocking ? "run_skipped" : "run_started", task, run))
      }
      if (operationId && manualActor) {
        receipts.push({
          operationId, method: "scheduleRun", actorUserId: manualActor.userId!,
          paramsHash: hashParams("scheduleRun", { scheduleId: id }), scheduleId: task.id,
          status: "completed", result: publicRun(run), createdAt: now,
        })
      }
      await this.#save(tasks, receipts, pendingEvents)
      return { task: structuredClone(task), run: structuredClone(run) }
    })
    if (!claimed) return undefined
    if ("existing" in claimed) return claimed.existing
    const { task, run } = claimed
    if (run.state === "skipped") return publicRun(run)
    try {
      const actor = await this.#dependencies.authorize(manualActor ?? task.actor)
      if (this.#closed) throw new Error("Scheduler stopped before dispatch")
      await this.#validateTarget(task)
      let sessionId: string
      if (task.target.kind === "existing") {
        sessionId = task.target.sessionId
        if (task.yolo) {
          await this.#dependencies.agents.handle("_deskfleet/session/yolo", { sessionId, operationId: randomUUID(), enabled: true }, actor)
        }
      } else {
        const snapshot = await this.#dependencies.agents.handle("_deskfleet/session/create", {
          workspaceId: task.workspaceId, operationId: run.createOperationId, title: task.title, provider: task.target.provider,
          context: task.target.context, ...task.target.configuration, ...(task.yolo ? { yolo: true } : {}),
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
      await this.#updateRun(task.id, run, "run_started")
      await this.#reconcile(task.id, run.id)
      const saved = this.#tasks.find(value => value.id === task.id)?.runs.find(value => value.id === run.id)
      return publicRun(saved ?? run)
    } catch (error) {
      let failure: "failed" | "interrupted" = "failed"
      if (run.sessionId && !run.inputId) {
        try {
          const command = await this.#dependencies.agents.journal.command(run.inputOperationId)
          const receipt = command?.result as AgentReceipt | undefined
          if (receipt?.inputId && receipt.sessionId === run.sessionId) {
            run.inputId = receipt.inputId; run.state = "running"
            await this.#updateRun(task.id, run, "run_started")
            await this.#reconcile(task.id, run.id)
            const saved = this.#tasks.find(value => value.id === task.id)?.runs.find(value => value.id === run.id)
            return publicRun(saved ?? run)
          }
          if (command?.status === "accepted" || command?.status === "uncertain") failure = "interrupted"
        } catch { failure = "interrupted" }
      }
      run.state = failure; run.finishedAt = this.#now().toISOString(); run.error = message(error)
      await this.#updateRun(task.id, run, "run_finished")
      return publicRun(run)
    }
  }

  #updateRun(taskId: string, run: StoredRun, emitKind?: "run_started" | "run_finished"): Promise<void> {
    return this.#serial(async () => {
      const tasks = structuredClone(this.#tasks)
      const pendingEvents = structuredClone(this.#pendingEvents)
      const task = tasks.find(task => task.id === taskId)
      const index = task?.runs.findIndex(value => value.id === run.id) ?? -1
      if (!task || index < 0) return
      task.runs[index] = structuredClone(run)
      if (emitKind && this.#subscribed(task.id, run.ownerUserId ?? task.actor.userId)) pendingEvents.push(this.#runEvent(emitKind, task, run))
      await this.#save(tasks, this.#receipts, pendingEvents)
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
      const pendingEvents = structuredClone(this.#pendingEvents)
      const task = tasks.find(item => item.id === taskId)
      const run = task?.runs.find(run => run.id === runId)
      if (!task || !run || !["running", "failed", "interrupted"].includes(run.state) || !run.sessionId || !run.inputId) return
      const previous = JSON.stringify(run)
      const previousState = run.state
      let snapshot: AgentSnapshot
      try { snapshot = await this.#dependencies.agents.journal.read(run.sessionId) }
      catch {
        const presence = await this.#sessionPresence(run.sessionId)
        if (presence !== "missing" && presence !== "archived") return
        this.#release(run, presence)
        if (JSON.stringify(run) === previous) return
        if (this.#subscribed(task.id, run.ownerUserId ?? task.actor.userId)) pendingEvents.push(this.#runEvent("run_finished", task, run))
        await this.#save(tasks, this.#receipts, pendingEvents)
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
      if (this.#subscribed(task.id, run.ownerUserId ?? task.actor.userId) && run.state !== "running" && previousState !== run.state) {
        pendingEvents.push(this.#runEvent("run_finished", task, run))
      }
      await this.#save(tasks, this.#receipts, pendingEvents)
    })
  }

  async close(): Promise<void> {
    this.#closed = true; this.#started = false; clearTimeout(this.#timer); this.#unsubscribe?.()
    await Promise.allSettled([...this.#pending])
    await this.#queue.catch(() => {})
  }
}
