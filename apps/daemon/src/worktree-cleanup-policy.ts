import type { AgentSnapshot } from "./agent-protocol.ts"
import type { WorktreePreferences } from "./worktree-preferences.ts"

const DAY = 86_400_000
const GIT_CLEANUP_IDLE_MS = DAY

function lastSessionActivity(snapshot: AgentSnapshot): number {
  const activity = [snapshot.session.updatedAt, snapshot.session.createdAt,
    ...snapshot.inputs.map(input => input.createdAt),
    ...snapshot.turns.flatMap(turn => [turn.startedAt, ...(turn.endedAt ? [turn.endedAt] : [])]),
    ...(snapshot.session.viewers ?? []).map(viewer => viewer.seenAt),
  ].map(value => Date.parse(value))
  return Math.max(...activity)
}

export function cleanupSessionIdle(snapshot: AgentSnapshot): boolean {
  if (snapshot.session.context !== "worktree") return false
  if (snapshot.session.archiveState === "archived" && snapshot.session.lifecycle === "provision_failed") return true
  if (snapshot.session.lifecycle !== "ready") return false
  // Explicit archive already stopped all execution; its retained backlog is history.
  if (snapshot.session.archiveState === "archived") return true
  return !snapshot.turns.some(turn => ["starting", "running", "cancelling"].includes(turn.state))
    && !snapshot.runs.some(run => run.state === "starting" || run.state === "stopping")
    && !snapshot.inputs.some(input => ["pending", "dispatching", "uncertain"].includes(input.state))
    && !snapshot.permissions.some(permission => permission.state === "pending")
    && !snapshot.elicitations.some(elicitation => elicitation.state === "pending")
}

/** Completion and activity come from durable records, including after daemon restart. */
export function cleanupTimeReason(snapshot: AgentSnapshot, settings: WorktreePreferences["cleanup"], now: number): "archived" | "inactive" | "settled" | undefined {
  if (!cleanupSessionIdle(snapshot)) return
  if (snapshot.session.archiveState === "archived") return settings.archived ? "archived" : undefined
  if (snapshot.session.archiveState !== "active") return
  const lastActivity = lastSessionActivity(snapshot)
  if (settings.inactive && Number.isFinite(lastActivity) && now - lastActivity >= settings.inactiveDays * DAY) return "inactive"
  const turn = snapshot.turns.at(-1)
  if (settings.settled && turn?.state === "completed" && turn.endedAt
    && now - Date.parse(turn.endedAt) >= settings.settledDays * DAY) return "settled"
}

/** Do not remove a newly allocated checkout before its first task has finished and it has stayed idle. */
export function cleanupGitEligible(snapshot: AgentSnapshot, now = Date.now()): boolean {
  if (!cleanupSessionIdle(snapshot) || snapshot.session.archiveState !== "active"
    || snapshot.turns.at(-1)?.state !== "completed") return false
  const lastActivity = lastSessionActivity(snapshot)
  return Number.isFinite(lastActivity) && now - lastActivity >= GIT_CLEANUP_IDLE_MS
}
