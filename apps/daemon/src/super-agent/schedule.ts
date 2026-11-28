import { createHash } from "node:crypto"
import { executeGit, GitPolicyError } from "../git/execution.ts"
import type { AgentActor } from "@deskfleet/protocol/agent"
import { scheduleInput, scheduleTrigger, type ScheduleInput, type ScheduleRun, type ScheduleTrigger, type ScheduledTask } from "@deskfleet/protocol/schedule"
import { nextScheduleTime } from "../schedules/time.ts"
import {
  inferDefaultDeliveryPolicy,
  type AdoptAllSchedulesResult,
  type FollowUpDeliveryPolicy,
  type FollowUpProvenance,
  type FollowUpRunRecord,
  type FollowUpSourceState,
} from "@deskfleet/protocol/super-agent-follow-up"
import { formatRunEvidenceLine, inspectScheduleRunsWithEvidence } from "./schedule-evidence.ts"
import type { SuperWorkspace, SuperWorkspaceId } from "@deskfleet/protocol/super-agent"
import type { SuperRoom } from "./state.ts"
import { ownedByActor } from "./target.ts"
import type { SuperWorkers } from "./worker.ts"

export interface SuperScheduleAction {
  kind: "schedule"
  operation: "create" | "list" | "inspect" | "update" | "pause" | "resume" | "run" | "delete" | "stop_follow_up" | "adopt" | "adopt_all" | "stop_all_follow_up"
  scheduleId?: string
  runId?: string
  workspaceId?: string
  title?: string
  prompt?: string
  targetKind?: "worktree" | "directory" | "existing"
  sessionId?: string
  provider?: string
  trigger?: ScheduleTrigger
  yolo?: boolean
  deliveryPolicy?: FollowUpDeliveryPolicy
  followUpEnabled?: boolean
  unsupportedRule?: string
  confirmationRequired?: boolean
}

export interface ScheduleCommandHost {
  handleSchedule(method: string, params: Record<string, unknown>, actor: AgentActor): Promise<unknown>
  listSchedules(): ScheduledTask[]
  subscribeSchedule?(params: {
    userId: string
    workspaceId: string
    scheduleId: string
    scheduleTitle: string
    targetKind: "worktree" | "directory" | "existing"
    deliveryPolicy: FollowUpDeliveryPolicy
    enabled: boolean
    awaitingAuthorization?: boolean
    optOutOnCreate?: boolean
  }): Promise<void>
  setAdoptAllSchedules?(enabled: boolean, actor: AgentActor, options?: { deliveryPolicy?: FollowUpDeliveryPolicy }): Promise<AdoptAllSchedulesResult>
  isFollowUpAuthorized?(userId: string): boolean
  getScheduleSubscription?(userId: string, workspaceId: string, scheduleId: string): {
    enabled: boolean
    awaitingAuthorization?: boolean
    pausedReason?: FollowUpSourceState["pausedReason"]
    deliveryPolicy: FollowUpDeliveryPolicy
  } | undefined
  listScheduleRuns?(userId: string, workspaceId: string, scheduleId: string, limit?: number): Promise<FollowUpRunRecord[]>
  getScheduleRun?(userId: string, workspaceId: string, scheduleId: string, runId: string): Promise<FollowUpRunRecord | undefined>
}

export interface ScheduleExecutionResult {
  text: string
  provenance?: FollowUpProvenance
  handoffWorkspaceId?: string
  clarifyOptions?: string[]
}

/** Deterministic UUIDv4-formatted identifier for idempotent schedule mutations from chat. */
export function deterministicScheduleUuid(namespace: string, ...parts: (string | number | null | undefined)[]): string {
  const hash = createHash("sha256").update([namespace, ...parts.map(part => String(part ?? ""))].join("\0")).digest("hex")
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function validTimeZone(zone: unknown): string | undefined {
  if (typeof zone !== "string" || !zone.trim() || zone.length > 100) return undefined
  const trimmed = zone.trim()
  try { new Intl.DateTimeFormat("en", { timeZone: trimmed }).format(); return trimmed }
  catch { return undefined }
}

export function hostTimeZone(): string {
  return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC"
}

export function requestsPrivateVisibility(text: string): boolean {
  return /(?:仅本人可见|只有我能看|不要让团队看到|私密计划|private\s+only|only\s+visible\s+to\s+me|hide\s+from\s+(?:the\s+)?team)/iu.test(text)
}

function describeTarget(target: ScheduleInput["target"]): string {
  if (target.kind === "existing") return `existing session (${target.sessionId})`
  return target.context === "worktree" ? `new worktree (${target.provider})` : `working directory (${target.provider})`
}

function describePolicy(policy: FollowUpDeliveryPolicy): string {
  return policy === "every_run" ? "Report every run (including no changes)" : "Report only anomalies, failures, or decisions"
}

function formatTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === "manual") return "manual"
  if (trigger.kind === "interval") return `every ${trigger.minutes} minute(s)`
  if (trigger.kind === "daily") return `daily at ${trigger.time} (${trigger.timeZone})`
  const days = trigger.weekdays.join(",") === "1,2,3,4,5" ? "Mon–Fri" : `weekdays [${trigger.weekdays.join(", ")}]`
  return `${days} at ${trigger.time} (${trigger.timeZone})`
}

async function workspaceSupportsWorktree(roots: string[]): Promise<boolean> {
  if (!roots.length) return false
  const results = await Promise.all(roots.map(async root => {
    try { await executeGit(["-C", root, "rev-parse", "--verify", "HEAD^{commit}"]); return true }
    catch (error) { if (error instanceof GitPolicyError) throw error; return false }
  }))
  return results.every(Boolean)
}

/**
 * Execute a validated main-chat schedule action through the exact same ScheduledTasks scheduler
 * used by the Schedules page and Worker MCP tools.
 */
export async function executeSuperScheduleAction(params: {
  action: SuperScheduleAction
  actionIndex: number
  sourceMessageId: string
  sourceRevision: number
  sourceText: string
  clientTimeZone?: string
  workspaceId: SuperWorkspaceId
  room: SuperRoom
  actor: AgentActor
  workspaces: SuperWorkspace[]
  providers: { id: string; name: string }[]
  workers: SuperWorkers
  host: ScheduleCommandHost
}): Promise<ScheduleExecutionResult> {
  const { action, actionIndex, sourceMessageId, sourceRevision, sourceText, clientTimeZone, workspaceId, room, actor, workspaces, providers, workers, host } = params
  const uid = actor.userId!

  if (action.unsupportedRule) {
    return {
      text: `The scheduler cannot accurately represent "${action.unsupportedRule}". Supported triggers are: manual, fixed interval (minutes), daily (HH:mm + IANA time zone), or weekly on chosen weekdays (such as Mon–Fri). Which supported schedule would you like to use?`,
      clarifyOptions: ["Weekdays (Mon–Fri) at the same time", "Daily at the same time", "Manual (Run now only)"],
    }
  }

  // Resolve project when called from the default conversation.
  let resolvedWorkspaceId = workspaceId ?? action.workspaceId ?? null
  if (workspaceId === null && !resolvedWorkspaceId && action.operation === "create") {
    const lowerText = sourceText.toLocaleLowerCase()
    const matched = workspaces.filter(item => item.name.trim().length > 0 && lowerText.includes(item.name.trim().toLocaleLowerCase()))
    if (matched.length === 1) {
      resolvedWorkspaceId = matched[0]!.id
    } else if (matched.length > 1) {
      const sameName = matched.every(item => item.name.toLocaleLowerCase() === matched[0]!.name.toLocaleLowerCase())
      const heading = sameName
        ? `Multiple projects match "${matched[0]!.name}". Which one should this scheduled task belong to?`
        : "Multiple projects match your request. Which one should this scheduled task belong to?"
      return {
        text: `${heading}\n${matched.map(item => `- ${item.name} (${item.roots[0] ?? item.id}) [${item.id}]`).join("\n")}`,
        clarifyOptions: matched.slice(0, 6).map(item => `${item.name} (${item.roots[0] ?? item.id})`),
      }
    }
  }
  if (workspaceId === null && resolvedWorkspaceId) {
    const targetProject = workspaces.find(item => item.id === resolvedWorkspaceId)
    if (!targetProject) throw new Error("Selected project was not found on this machine")
    if (action.operation === "create") {
      return {
        text: `Handing off this schedule request to project "${targetProject.name}".`,
        handoffWorkspaceId: targetProject.id,
      }
    }
  }

  if (action.operation === "adopt_all") {
    if (!host.setAdoptAllSchedules) throw new Error("Proactive follow-up is unavailable on this machine")
    const result = await host.setAdoptAllSchedules(true, actor, { deliveryPolicy: action.deliveryPolicy })
    if (result.authorized) {
      const details = [
        `Enabled **自动跟进会话与定时任务** on this machine (covers **all your scheduled tasks** and ordinary project sessions, both existing and future, without selecting them one by one).`,
        `- Active now: ${result.adoptedCount} owned schedule(s)${result.adoptedSessionCount ? ` and ${result.adoptedSessionCount} ordinary session(s)` : ""}${result.preservedPreferenceCount ? ` (${result.preservedPreferenceCount} preserved existing reporting preferences)` : ""}.`,
        `- Future ordinary sessions (matched by project directory) and schedules created from either the Schedules form or SA will attach automatically without subscribing one by one.`,
      ]
      if (result.skippedOtherOwnerCount) {
        details.push(`- Ownership preserved: ${result.skippedOtherOwnerCount} schedule(s) owned by other team members were left untouched.`)
      }
      return { text: details.join("\n") }
    }
    const pendingLines = [
      `Saved your choice for **自动跟进会话与定时任务** (covers all your scheduled tasks and ordinary project sessions without selecting them one by one).`,
      `- SA follow-up status: **Waiting for background authorization** (${result.awaitingAuthorizationCount} owned schedule(s) staged; existing preferences preserved).`,
      `- Required permission: Turn on Settings → Super Agent → **自动跟进会话与定时任务** (or click the main-chat authorization banner) to complete **background follow-up authorization on this execution machine**.`,
      `- Once authorized, SA will automatically attach to all staged and future schedules and ordinary project sessions without recreating them or selecting one by one. Native schedules continue running on time in the meantime.`,
    ]
    if (result.skippedOtherOwnerCount) {
      pendingLines.push(`- Ownership preserved: ${result.skippedOtherOwnerCount} schedule(s) owned by other team members were left untouched.`)
    }
    return { text: pendingLines.join("\n") }
  }

  if (action.operation === "stop_all_follow_up") {
    if (!host.setAdoptAllSchedules) throw new Error("Proactive follow-up is unavailable on this machine")
    const result = await host.setAdoptAllSchedules(false, actor)
    return {
      text: [
        `Turned off **自动跟进会话与定时任务** (${result.stoppedCount} schedule(s) paused from SA follow-up, and automatic takeover for ordinary sessions and future schedules is off).`,
        `Your existing sessions stay open and native scheduled tasks keep their enabled state, trigger time, and execution target unchanged and will continue running on time.`,
      ].join("\n"),
    }
  }

  if (action.operation === "list") {
    const tasks = host.listSchedules().filter(task => resolvedWorkspaceId === null || task.workspaceId === resolvedWorkspaceId)
    if (!tasks.length) return { text: "There are no scheduled tasks in this project yet." }
    const runningLines: string[] = []
    const lines: string[] = []
    for (const task of tasks) {
      const sub = host.getScheduleSubscription?.(uid, task.workspaceId, task.id)
      const follow = sub?.awaitingAuthorization
        ? " · SA follow-up: waiting for background authorization"
        : sub?.enabled
          ? ` · SA follow-up: ${sub.deliveryPolicy === "every_run" ? "every run" : "exceptions only"}`
          : sub
            ? " · SA follow-up: stopped"
            : ""
      const next = task.enabled && task.nextRunAt ? ` · Next: ${task.nextRunAt}` : task.enabled ? "" : " · Paused"
      const activeRun = task.runs.find(r => r.state === "running" || r.state === "claimed")
      let runNote = ""
      if (activeRun) {
        const persisted = await host.listScheduleRuns?.(uid, task.workspaceId, task.id, 10) ?? []
        const [ev] = await inspectScheduleRunsWithEvidence({
          userId: uid, task, persistedRuns: persisted, journal: workers.journal, runId: activeRun.id, limit: 1,
        })
        const progress = ev?.progress ?? "Running (no final conclusion yet)."
        runningLines.push(`- **${task.title}** (\`${task.id}\`, run \`${activeRun.id}\`): ${progress}`)
        runNote = ` · **Running now** (run \`${activeRun.id}\`: ${progress})`
      } else if (task.lastRun) {
        runNote = ` · Last run: ${task.lastRun.state} (\`${task.lastRun.id}\`)`
      }
      lines.push(`- **${task.title}** (\`${task.id}\`): ${formatTrigger(task.trigger)} · ${describeTarget(task.target)}${next}${follow}${runNote}`)
    }
    const header = runningLines.length
      ? `Currently running (${runningLines.length}):\n${runningLines.join("\n")}\n\nAll scheduled tasks:\n${lines.join("\n")}`
      : `No scheduled tasks are currently running.\n\nScheduled tasks:\n${lines.join("\n")}`
    return { text: header }
  }

  if (action.operation === "inspect") {
    if (!action.scheduleId) throw new Error("Choose which scheduled task to inspect")
    const task = host.listSchedules().find(item => item.id === action.scheduleId && (resolvedWorkspaceId === null || item.workspaceId === resolvedWorkspaceId))
    if (!task) throw new Error("Scheduled task was not found in this project")
    const sub = host.getScheduleSubscription?.(uid, task.workspaceId, task.id)
    let persisted: FollowUpRunRecord[]
    if (action.runId && host.getScheduleRun) {
      const exact = await host.getScheduleRun(uid, task.workspaceId, task.id, action.runId)
      persisted = exact ? [exact] : []
    } else {
      persisted = await host.listScheduleRuns?.(uid, task.workspaceId, task.id, action.runId ? 200 : 10) ?? []
    }
    const evidenced = await inspectScheduleRunsWithEvidence({
      userId: uid,
      task,
      persistedRuns: persisted,
      journal: workers.journal,
      runId: action.runId,
      limit: action.runId ? 1 : 5,
    })
    const runLines = evidenced.map(formatRunEvidenceLine)
    const zone = "timeZone" in task.trigger ? task.trigger.timeZone : undefined
    const followUpLine = sub?.awaitingAuthorization
      ? `SA follow-up: Waiting for background authorization (${describePolicy(sub.deliveryPolicy)}; will attach automatically once authorized)`
      : sub
        ? `SA follow-up: ${sub.enabled ? describePolicy(sub.deliveryPolicy) : "Stopped (view in execution session only)"}`
        : "SA follow-up: Not subscribed"
    const latestSessionId = evidenced[0]?.sessionId
    const latestRunId = evidenced[0]?.runId
    const runsSection = action.runId && !runLines.length
      ? `Requested run \`${action.runId}\` was not found for this scheduled task.`
      : runLines.length
        ? `${action.runId ? "Requested run" : "Recent runs"}:\n${runLines.join("\n")}`
        : "No runs recorded yet."
    return {
      text: [
        `**${task.title}** (\`${task.id}\`)`,
        `Trigger: ${formatTrigger(task.trigger)} · Status: ${task.enabled ? "Active" : "Paused"}`,
        `Target: ${describeTarget(task.target)}${task.nextRunAt ? ` · Next run: ${task.nextRunAt}` : ""}`,
        followUpLine,
        runsSection,
      ].join("\n"),
      provenance: {
        origin: "schedule_receipt", sourceKind: "schedule", sourceId: task.id,
        scheduleId: task.id, scheduleTitle: task.title, targetKind: task.target.kind === "existing" ? "existing" : task.target.context,
        ...(latestRunId ? { runId: latestRunId } : {}),
        ...(latestSessionId ? { sessionId: latestSessionId } : {}),
        deliveryPolicy: sub?.deliveryPolicy, nextRunAt: task.nextRunAt, timeZone: zone,
      },
    }
  }

  if (action.operation === "create") {
    if (!resolvedWorkspaceId) {
      return {
        text: "Which project should this scheduled task belong to?",
        clarifyOptions: workspaces.slice(0, 8).map(item => item.name),
      }
    }
    const project = workspaces.find(item => item.id === resolvedWorkspaceId)
    if (!project) throw new Error("Project was not found on this machine")

    // Visibility guard: native schedules replicate title/prompt to the team schedule snapshot.
    if (requestsPrivateVisibility(sourceText) && action.confirmationRequired !== false) {
      return {
        text: "Native scheduled tasks store their name and execution instructions in the team's schedule visibility scope (private chat and evidence are never copied into the task). Confirm if you still want to create this team-visible schedule, or let me know if you prefer running it manually inside your private conversation.",
        clarifyOptions: ["Create schedule with minimal team-visible title and instructions", "Cancel — do not create a team-visible schedule"],
      }
    }

    const title = action.title?.trim()
    const prompt = action.prompt?.trim()
    if (!title || !prompt) throw new Error("Schedule creation requires a title and standalone task instructions")
    if (!action.trigger) throw new Error("Schedule creation requires a valid trigger")

    // Resolve timezone: explicit trigger timeZone > sending client's IANA timeZone > host fallback.
    const rawTrigger = structuredClone(action.trigger)
    if (rawTrigger.kind === "daily" || rawTrigger.kind === "weekly") {
      rawTrigger.timeZone = validTimeZone(rawTrigger.timeZone) ?? validTimeZone(clientTimeZone) ?? hostTimeZone()
    }
    const trigger = scheduleTrigger(rawTrigger)

    let target: ScheduleInput["target"]
    if (action.targetKind === "existing" || action.sessionId) {
      if (!action.sessionId) throw new Error("Specify which existing session this schedule should target")
      const snapshot = await workers.journal.read(action.sessionId)
      if (snapshot.session.workspaceId !== project.id) throw new Error("The selected session does not belong to this project")
      if (snapshot.session.archiveState !== "active" || snapshot.session.lifecycle !== "ready") {
        throw new Error("The selected session is archived or unavailable. Choose an active session or create a new-session schedule.")
      }
      if (!await ownedByActor(workers, snapshot.session.id, actor)) {
        throw new Error("The selected session belongs to a different or unknown owner and cannot be targeted automatically.")
      }
      target = { kind: "existing", sessionId: snapshot.session.id }
    } else {
      const providerId = action.provider && providers.some(p => p.id === action.provider)
        ? action.provider
        : (providers.some(p => p.id === room.provider) ? room.provider : providers[0]?.id)
      if (!providerId) throw new Error("Configure an execution Agent provider on this machine before creating a scheduled task.")
      const canWorktree = await workspaceSupportsWorktree(project.roots)
      if (action.targetKind === "worktree" && !canWorktree) {
        throw new Error("This project directory is not a Git repository with a committed HEAD, so a new worktree cannot be created. Choose working directory explicitly if you want the task to run in place.")
      }
      const context: "worktree" | "directory" = action.targetKind === "directory" ? "directory" : canWorktree ? "worktree" : "directory"
      const configuration = room.provider === providerId && room.workerSelection
        ? Object.fromEntries(Object.entries(room.workerSelection).filter(([, value]) => value !== undefined))
        : undefined
      target = { kind: "new", provider: providerId, context, ...(configuration && Object.keys(configuration).length ? { configuration } : {}) }
    }

    const input = scheduleInput({
      title, prompt, workspaceId: project.id, enabled: true,
      ...(action.yolo === true ? { yolo: true } : {}),
      target, trigger,
    })
    const operationId = deterministicScheduleUuid("sa-schedule-create", uid, project.id, sourceMessageId, sourceRevision, actionIndex)
    const scheduleId = deterministicScheduleUuid("sa-schedule-id", uid, project.id, sourceMessageId, sourceRevision, actionIndex)
    const created = await host.handleSchedule("scheduleCreate", { schedule: input, operationId, scheduleId }, actor) as ScheduledTask

    const deliveryPolicy = inferDefaultDeliveryPolicy(created.title, created.prompt, action.deliveryPolicy)
    const wantsFollowUp = action.followUpEnabled !== false
    const authorized = host.isFollowUpAuthorized?.(uid) ?? false
    const shouldFollow = wantsFollowUp && authorized
    const awaitingAuthorization = wantsFollowUp && !authorized && !!host.subscribeSchedule
    if (host.subscribeSchedule) {
      if (wantsFollowUp) {
        await host.subscribeSchedule({
          userId: uid, workspaceId: project.id, scheduleId: created.id,
          scheduleTitle: created.title, targetKind: created.target.kind === "existing" ? "existing" : created.target.context,
          deliveryPolicy, enabled: authorized, ...(authorized ? {} : { awaitingAuthorization: true }),
        })
      } else {
        // Persist explicit per-schedule opt-out ("do not follow up with SA") so master takeover
        // auto-enrollment (`processSchedulePrivateEvent` / `#reconcileTakeoverForUser`) respects it.
        await host.subscribeSchedule({
          userId: uid, workspaceId: project.id, scheduleId: created.id,
          scheduleTitle: created.title, targetKind: created.target.kind === "existing" ? "existing" : created.target.context,
          deliveryPolicy, enabled: false, optOutOnCreate: true,
        })
      }
    }

    const zone = "timeZone" in created.trigger ? created.trigger.timeZone : undefined
    const nextRun = created.nextRunAt ?? nextScheduleTime(created.trigger, new Date())
    const followUpLines = shouldFollow
      ? [`- SA follow-up: Active — ${describePolicy(deliveryPolicy)}`]
      : awaitingAuthorization
        ? [
            `- Schedule status: **Created** (已创建) — native schedule is active and will run on time.`,
            `- SA follow-up status: **Waiting for background authorization** (等待授权跟进) — requires **background follow-up authorization on this execution machine** (turn on Settings → Super Agent → **自动跟进会话与定时任务**, or click the main-chat authorization banner).`,
            `- Auto-attach: Once authorized, SA will automatically follow this schedule (\`${created.id}\`) with reporting preference "${describePolicy(deliveryPolicy)}" without recreating it or selecting schedules one by one.`,
          ]
        : [`- SA follow-up: Not enabled (native schedule runs on time; view runs in the execution session or Schedules page).`]
    return {
      text: [
        `Created scheduled task **${created.title}** (\`${created.id}\`).`,
        `- Project: ${project.name}`,
        `- Schedule: ${formatTrigger(created.trigger)}${nextRun ? ` · Next run: ${nextRun}` : ""}`,
        `- Run in: ${describeTarget(created.target)} · Approvals: ${created.yolo ? "YOLO (auto-approve)" : "Manual approval"}`,
        ...followUpLines,
        `- Visibility: Schedule name and execution instructions follow the team schedule visibility scope.`,
      ].join("\n"),
      provenance: {
        origin: "schedule_receipt",
        sourceKind: "schedule",
        sourceId: created.id,
        scheduleId: created.id,
        scheduleTitle: created.title,
        targetKind: created.target.kind === "existing" ? "existing" : created.target.context,
        deliveryPolicy,
        nextRunAt: nextRun,
        timeZone: zone,
      },
    }
  }

  // Remaining operations target an existing schedule by real scheduleId.
  if (!action.scheduleId) throw new Error("Specify which scheduled task to modify")
  const targetTask = host.listSchedules().find(item => item.id === action.scheduleId && (resolvedWorkspaceId === null || item.workspaceId === resolvedWorkspaceId))
  if (!targetTask) throw new Error("Scheduled task was not found in this project")
  const opId = deterministicScheduleUuid(`sa-schedule-${action.operation}`, uid, targetTask.workspaceId, sourceMessageId, sourceRevision, actionIndex)
  const zone = "timeZone" in targetTask.trigger ? targetTask.trigger.timeZone : undefined

  if (action.operation === "stop_follow_up") {
    if (host.subscribeSchedule) {
      const current = host.getScheduleSubscription?.(uid, targetTask.workspaceId, targetTask.id)
      await host.subscribeSchedule({
        userId: uid, workspaceId: targetTask.workspaceId, scheduleId: targetTask.id,
        scheduleTitle: targetTask.title, targetKind: targetTask.target.kind === "existing" ? "existing" : targetTask.target.context,
        deliveryPolicy: current?.deliveryPolicy ?? "every_run", enabled: false,
      })
    }
    return {
      text: `Stopped SA follow-up for **${targetTask.title}** (\`${targetTask.id}\`). The schedule itself remains ${targetTask.enabled ? "active and will keep running on time" : "paused"}; view future runs in the execution session or Schedules page.`,
      provenance: {
        origin: "schedule_receipt", sourceKind: "schedule", sourceId: targetTask.id,
        scheduleId: targetTask.id, scheduleTitle: targetTask.title,
        targetKind: targetTask.target.kind === "existing" ? "existing" : targetTask.target.context,
        nextRunAt: targetTask.nextRunAt, timeZone: zone,
      },
    }
  }

  if (action.operation === "adopt") {
    const policy = inferDefaultDeliveryPolicy(targetTask.title, targetTask.prompt, action.deliveryPolicy)
    const authorized = host.isFollowUpAuthorized?.(uid) ?? false
    if (host.subscribeSchedule) {
      await host.subscribeSchedule({
        userId: uid, workspaceId: targetTask.workspaceId, scheduleId: targetTask.id,
        scheduleTitle: targetTask.title, targetKind: targetTask.target.kind === "existing" ? "existing" : targetTask.target.context,
        deliveryPolicy: policy, enabled: authorized, ...(authorized ? {} : { awaitingAuthorization: true }),
      })
    }
    return {
      text: authorized
        ? `Subscribed SA follow-up for existing schedule **${targetTask.title}** (\`${targetTask.id}\`), starting from the next run. Reporting: ${describePolicy(policy)}.`
        : `Staged SA follow-up for **${targetTask.title}** (\`${targetTask.id}\`) as **Waiting for background authorization** (${describePolicy(policy)}). Turn on Settings → Super Agent → **自动跟进会话与定时任务** (or click the main-chat authorization banner) to complete background follow-up authorization on this execution machine, and SA will attach automatically without selecting one by one.`,
      provenance: {
        origin: "schedule_receipt", sourceKind: "schedule", sourceId: targetTask.id,
        scheduleId: targetTask.id, scheduleTitle: targetTask.title, deliveryPolicy: policy,
        targetKind: targetTask.target.kind === "existing" ? "existing" : targetTask.target.context,
        nextRunAt: targetTask.nextRunAt, timeZone: zone,
      },
    }
  }

  if (action.operation === "pause" || action.operation === "resume") {
    const enabled = action.operation === "resume"
    const updated = await host.handleSchedule("scheduleUpdate", { scheduleId: targetTask.id, changes: { enabled }, operationId: opId }, actor) as ScheduledTask
    return {
      text: `${enabled ? "Resumed" : "Paused"} scheduled task **${updated.title}** (\`${updated.id}\`).${updated.nextRunAt ? ` Next run: ${updated.nextRunAt}.` : ""}`,
      provenance: {
        origin: "schedule_receipt", sourceKind: "schedule", sourceId: updated.id,
        scheduleId: updated.id, scheduleTitle: updated.title,
        targetKind: updated.target.kind === "existing" ? "existing" : updated.target.context,
        nextRunAt: updated.nextRunAt, timeZone: "timeZone" in updated.trigger ? updated.trigger.timeZone : undefined,
      },
    }
  }

  if (action.operation === "run") {
    const run = await host.handleSchedule("scheduleRun", { scheduleId: targetTask.id, operationId: opId }, actor) as ScheduleRun
    return {
      text: `Triggered **${targetTask.title}** (\`${targetTask.id}\`). Run \`${run.id}\` status: ${run.state}${run.sessionId ? ` (session \`${run.sessionId}\`)` : ""}${run.error ? ` — ${run.error}` : ""}.`,
      provenance: {
        origin: "schedule_receipt", sourceKind: "schedule", sourceId: targetTask.id,
        scheduleId: targetTask.id, scheduleTitle: targetTask.title, runId: run.id, sessionId: run.sessionId, inputId: run.inputId,
        targetKind: targetTask.target.kind === "existing" ? "existing" : targetTask.target.context,
        nextRunAt: targetTask.nextRunAt, timeZone: zone,
      },
    }
  }

  if (action.operation === "delete") {
    await host.handleSchedule("scheduleDelete", { scheduleId: targetTask.id, operationId: opId }, actor)
    return {
      text: `Deleted scheduled task **${targetTask.title}** (\`${targetTask.id}\`). Existing execution sessions and their history are preserved.`,
      provenance: {
        origin: "schedule_receipt", sourceKind: "schedule", sourceId: targetTask.id,
        scheduleId: targetTask.id, scheduleTitle: targetTask.title,
        targetKind: targetTask.target.kind === "existing" ? "existing" : targetTask.target.context,
      },
    }
  }

  // update
  const changes: Partial<ScheduleInput> = {}
  if (action.title?.trim()) changes.title = action.title.trim()
  if (action.prompt?.trim()) changes.prompt = action.prompt.trim()
  if (action.yolo !== undefined) changes.yolo = action.yolo
  if (action.trigger) {
    const nextTrigger = structuredClone(action.trigger)
    if (nextTrigger.kind === "daily" || nextTrigger.kind === "weekly") {
      nextTrigger.timeZone = validTimeZone(nextTrigger.timeZone) ?? validTimeZone(clientTimeZone) ?? zone ?? hostTimeZone()
    }
    changes.trigger = scheduleTrigger(nextTrigger)
  }
  if (action.targetKind !== undefined || action.sessionId !== undefined || action.provider !== undefined) {
    const project = workspaces.find(item => item.id === targetTask.workspaceId)
    if (!project) throw new Error("Project was not found on this machine")
    const wantsExisting = action.targetKind === "existing" || (action.targetKind === undefined && action.sessionId !== undefined)
    if (wantsExisting) {
      const targetSessionId = action.sessionId ?? (targetTask.target.kind === "existing" ? targetTask.target.sessionId : undefined)
      if (!targetSessionId) throw new Error("Specify which existing session this schedule should target")
      const snapshot = await workers.journal.read(targetSessionId)
      if (snapshot.session.workspaceId !== project.id) throw new Error("The selected session does not belong to this project")
      if (snapshot.session.archiveState !== "active" || snapshot.session.lifecycle !== "ready") {
        throw new Error("The selected session is archived or unavailable. Choose an active session or switch to a working directory / new worktree target.")
      }
      if (!await ownedByActor(workers, snapshot.session.id, actor)) {
        throw new Error("The selected session belongs to a different or unknown owner and cannot be targeted automatically.")
      }
      changes.target = { kind: "existing", sessionId: snapshot.session.id }
    } else if (action.targetKind === "directory" || action.targetKind === "worktree" || targetTask.target.kind === "new") {
      const currentNew = targetTask.target.kind === "new" ? targetTask.target : undefined
      const providerId = action.provider && providers.some(p => p.id === action.provider)
        ? action.provider
        : (currentNew && providers.some(p => p.id === currentNew.provider)
          ? currentNew.provider
          : (providers.some(p => p.id === room.provider) ? room.provider : providers[0]?.id))
      if (!providerId) throw new Error("Configure an execution Agent provider on this machine before updating this scheduled task.")
      const nextContext: "worktree" | "directory" = action.targetKind === "directory" || action.targetKind === "worktree"
        ? action.targetKind
        : currentNew!.context
      if (nextContext === "worktree") {
        const canWorktree = await workspaceSupportsWorktree(project.roots)
        if (!canWorktree) {
          throw new Error("This project directory is not a Git repository with a committed HEAD, so a new worktree cannot be created. Choose working directory explicitly if you want the task to run in place.")
        }
      }
      const configuration = currentNew && currentNew.provider === providerId && currentNew.configuration
        ? structuredClone(currentNew.configuration)
        : (room.provider === providerId && room.workerSelection
          ? Object.fromEntries(Object.entries(room.workerSelection).filter(([, value]) => value !== undefined))
          : undefined)
      changes.target = {
        kind: "new",
        provider: providerId,
        context: nextContext,
        ...(configuration && Object.keys(configuration).length ? { configuration } : {}),
      }
    } else {
      throw new Error("Specify whether to run in the working directory or a new worktree when changing the provider of an existing-session schedule.")
    }
  }
  const updated = Object.keys(changes).length
    ? await host.handleSchedule("scheduleUpdate", { scheduleId: targetTask.id, changes, operationId: opId }, actor) as ScheduledTask
    : targetTask
  if ((action.deliveryPolicy !== undefined || action.followUpEnabled !== undefined) && host.subscribeSchedule) {
    const current = host.getScheduleSubscription?.(uid, updated.workspaceId, updated.id)
    const policy = action.deliveryPolicy ?? current?.deliveryPolicy ?? inferDefaultDeliveryPolicy(updated.title, updated.prompt)
    const enabled = action.followUpEnabled ?? current?.enabled ?? true
    await host.subscribeSchedule({
      userId: uid, workspaceId: updated.workspaceId, scheduleId: updated.id,
      scheduleTitle: updated.title, targetKind: updated.target.kind === "existing" ? "existing" : updated.target.context,
      deliveryPolicy: policy, enabled,
    })
  }
  const nextZone = "timeZone" in updated.trigger ? updated.trigger.timeZone : undefined
  const currentSub = host.getScheduleSubscription?.(uid, updated.workspaceId, updated.id)
  return {
    text: `Updated scheduled task **${updated.title}** (\`${updated.id}\`). Target: ${describeTarget(updated.target)} · Schedule: ${formatTrigger(updated.trigger)}${updated.nextRunAt ? ` · Next run: ${updated.nextRunAt}` : ""}${currentSub ? ` · Reporting: ${currentSub.enabled ? describePolicy(currentSub.deliveryPolicy) : "Stopped"}` : ""}.`,
    provenance: {
      origin: "schedule_receipt", sourceKind: "schedule", sourceId: updated.id,
      scheduleId: updated.id, scheduleTitle: updated.title,
      targetKind: updated.target.kind === "existing" ? "existing" : updated.target.context,
      deliveryPolicy: currentSub?.deliveryPolicy, nextRunAt: updated.nextRunAt, timeZone: nextZone,
    },
  }
}
