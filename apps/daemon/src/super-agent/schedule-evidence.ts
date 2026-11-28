import type { AgentSnapshot } from "@deskfleet/protocol/agent"
import type { ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"
import {
  classifyJournalReadError,
  inspectTurnOwnership,
  readTurnAssistantOutput,
  type TurnOutputReadResult,
  type TurnToolActivity,
} from "./follow-up-evidence.ts"
import type {
  FollowUpDeliveryPolicy,
  FollowUpEvidenceAvailability,
  FollowUpRunRecord,
} from "@deskfleet/protocol/super-agent-follow-up"
import { activeTurn, type SuperWorkers } from "./worker.ts"

export type ScheduleRunEvidenceStatus =
  | "concluded"
  | "in_progress"
  | "progress_only_no_conclusion"
  | "incomplete"
  | "no_output"
  | "failed"
  | "interrupted"
  | "skipped"
  | "restricted"
  | "deleted"

export interface ScheduleRunEvidence {
  runId: string
  scheduleId: string
  scheduleTitle: string
  status: FollowUpRunRecord["status"]
  startedAt: string
  finishedAt?: string
  scheduledFor?: string
  sessionId?: string
  inputId?: string
  turnId?: string
  deliveryPolicy?: FollowUpDeliveryPolicy
  deliveredToMainChat: boolean
  evidenceAvailability: FollowUpEvidenceAvailability
  evidenceStatus: ScheduleRunEvidenceStatus
  /** Substantive final conclusion text — populated ONLY when `evidenceStatus === "concluded"`. */
  conclusion?: string
  /** Concrete live or pre-conclusion progress (tools, commentary, milestone, pending approval). */
  progress?: string
  recentTools?: TurnToolActivity[]
  pendingAttention?: string
  summarySource: "follow_up_summary" | "run_turn_evidence" | "native_status"
  error?: string
}

const PLACEHOLDER_SUMMARY_RE = /^(?:Running scheduled task "|".*" finished \([^)]+\) while SA (?:follow-up|background follow-up) .*; not pushed to main chat\.|Run completed with no text output\.|「.*」已结束，但(?:未产出正文结论|仅包含非正文内容)|".*" finished, but (?:only (?:an opening acknowledgement|progress commentary) was recorded|no concise conclusion text was extracted)|".*" finished with only an intermediate milestone|This turn includes input from another member|".*" finished, but its execution session was deleted|Partial output captured for "|".*" finished, but its full turn transcript could not be read completely)/u

function isSubstantivePersistedSummary(run: FollowUpRunRecord): boolean {
  const summary = run.summary.trim()
  if (!summary) return false
  if (run.status === "claimed" || run.status === "running") return false
  if (run.evidenceAvailability === "restricted" || run.evidenceAvailability === "deleted" || run.evidenceAvailability === "partial") return false
  return !PLACEHOLDER_SUMMARY_RE.test(summary)
}

function pendingTurnAttention(snapshot: AgentSnapshot, turnId: string): string | undefined {
  const perm = snapshot.permissions.find(p => p.turnId === turnId && p.state === "pending")
  if (perm) return `Waiting for permission approval: ${perm.request.toolCall.title ?? perm.request.toolCall.toolCallId}`
  const q = snapshot.elicitations.find(e => e.turnId === turnId && e.state === "pending")
  if (q) return `Waiting for user answer: ${q.request.message}`
  return undefined
}

function describeTurnProgress(read: TurnOutputReadResult, pendingAttention?: string): string | undefined {
  const parts: string[] = []
  if (pendingAttention) parts.push(pendingAttention)
  if (read.recentTools?.length) {
    const tools = read.recentTools.map(t => `${t.title} (${t.status})`).join(", ")
    parts.push(`Tools: ${tools}`)
  }
  if (read.progressText?.trim()) {
    parts.push(read.progressText.trim().slice(0, 1200))
  }
  return parts.length ? parts.join(" · ") : undefined
}

function isFinalOutputSource(source: TurnOutputReadResult["outputSource"]): boolean {
  return source === "final_answer" || source === "untagged_tail" || source === "untagged"
}

/**
 * Inspect one schedule's runs by merging native runs and persisted SA follow-up records on exact `runId`.
 * - Uses persisted substantive summary directly when available (including quiet `exceptions_only` runs).
 * - Otherwise reads THAT SPECIFIC RUN's exact turn evidence within the user's verified turn ownership,
 *   never substituting another run's conclusion and never reducing the answer to a bare session link.
 * - Explicitly distinguishes in-progress / progress-only runs from completed final conclusions.
 */
export async function inspectScheduleRunsWithEvidence(params: {
  userId: string
  task: ScheduledTask
  persistedRuns: FollowUpRunRecord[]
  journal: SuperWorkers["journal"]
  runId?: string
  limit?: number
  historyPageSize?: number
  historyMaxPages?: number
}): Promise<ScheduleRunEvidence[]> {
  const { userId, task, persistedRuns, journal, runId: filterRunId, historyPageSize, historyMaxPages } = params
  const limit = Math.max(1, Math.min(20, params.limit ?? 5))

  interface Candidate {
    runId: string
    nativeRun?: ScheduleRun
    persisted?: FollowUpRunRecord
    startedAt: string
  }
  const byRunId = new Map<string, Candidate>()
  for (const nativeRun of task.runs) {
    byRunId.set(nativeRun.id, { runId: nativeRun.id, nativeRun, startedAt: nativeRun.startedAt })
  }
  for (const persisted of persistedRuns) {
    const id = persisted.runId ?? persisted.runKey.replace(/^run:/u, "")
    const existing = byRunId.get(id)
    if (existing) existing.persisted = persisted
    else byRunId.set(id, { runId: id, persisted, startedAt: persisted.startedAt })
  }

  let candidates = [...byRunId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId))
  if (filterRunId) {
    candidates = candidates.filter(c => c.runId === filterRunId)
  } else {
    candidates = candidates.slice(0, limit)
  }

  const results: ScheduleRunEvidence[] = []
  for (const candidate of candidates) {
    const { nativeRun, persisted } = candidate
    const sessionId = nativeRun?.sessionId ?? persisted?.sessionId ?? persisted?.evidenceRefs?.sessionId
    const inputId = nativeRun?.inputId ?? persisted?.inputId ?? persisted?.evidenceRefs?.inputId
    let turnId = persisted?.turnId ?? persisted?.evidenceRefs?.turnId
    const startedAt = nativeRun?.startedAt ?? persisted?.startedAt ?? task.updatedAt
    const finishedAt = nativeRun?.finishedAt ?? persisted?.finishedAt
    const scheduledFor = nativeRun?.scheduledFor ?? persisted?.scheduledFor
    const status: FollowUpRunRecord["status"] = nativeRun
      ? (nativeRun.state === "completed" && persisted?.status === "restricted" ? "restricted" : nativeRun.state)
      : (persisted?.status ?? "completed")
    const deliveryPolicy = persisted?.deliveryPolicy
    const deliveredToMainChat = persisted?.delivered === true
    const error = nativeRun?.error ?? persisted?.error

    // 1. Fast path: use substantive persisted summary directly when the run is terminal and already summarized.
    if (persisted && status === "completed" && isSubstantivePersistedSummary(persisted)) {
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status,
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(inputId ? { inputId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: persisted.evidenceAvailability,
        evidenceStatus: "concluded",
        conclusion: persisted.summary.trim(),
        summarySource: "follow_up_summary",
      })
      continue
    }

    if (status === "skipped") {
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status,
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(inputId ? { inputId } : {}),
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: sessionId ? "available" : "restricted",
        evidenceStatus: "skipped",
        summarySource: persisted ? "follow_up_summary" : "native_status",
        ...(error ? { error } : { error: "Skipped because the previous scheduled run was still active." }),
      })
      continue
    }

    // 2. No substantive summary (or currently running / progress-only / paused-window run):
    //    read THIS EXACT RUN's execution evidence within the user's verified permissions.
    if (!sessionId) {
      const inProgress = status === "claimed" || status === "running"
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status,
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: "restricted",
        evidenceStatus: inProgress ? "in_progress" : (status === "failed" || status === "interrupted" ? status : "no_output"),
        ...(inProgress ? { progress: "Scheduled run claimed; waiting for execution session to start (no conclusion yet)." } : {}),
        ...(error ? { error } : {}),
        summarySource: "native_status",
      })
      continue
    }

    let snapshot: AgentSnapshot
    try {
      snapshot = await journal.read(sessionId)
    } catch (readErr) {
      const kind = classifyJournalReadError(readErr)
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status,
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        sessionId,
        ...(inputId ? { inputId } : {}),
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: kind === "not_found" ? "deleted" : "partial",
        evidenceStatus: kind === "not_found" ? "deleted" : (status === "claimed" || status === "running" ? "in_progress" : "no_output"),
        summarySource: "native_status",
        error: kind === "not_found"
          ? "Execution session was deleted; original run evidence is unavailable."
          : "Execution session evidence is temporarily unavailable.",
      })
      continue
    }

    const baseAvailability: FollowUpEvidenceAvailability = snapshot.session.archiveState !== "active" ? "archived" : "available"
    // Strictly locate THIS run's turn by turnId or inputId — NEVER fall back to an unrelated turn on the same session!
    const input = inputId ? snapshot.inputs.find(item => item.id === inputId) : undefined
    const turn = turnId
      ? snapshot.turns.find(item => item.id === turnId)
      : inputId
        ? (input?.turnId
            ? snapshot.turns.find(item => item.id === input.turnId)
            : snapshot.turns.findLast(item => item.initialInputId === inputId))
        : (snapshot.turns.length === 1 ? snapshot.turns[0] : undefined)
    turnId = turn?.id

    if (!turn) {
      const waiting = status === "claimed" || status === "running" || (!!input && (input.state === "pending" || input.state === "dispatching"))
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status,
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        sessionId,
        ...(inputId ? { inputId } : {}),
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: baseAvailability,
        evidenceStatus: waiting ? "in_progress" : (status === "failed" || status === "interrupted" ? status : "no_output"),
        ...(waiting ? { progress: "Queued in execution session; waiting for the Agent turn to start (no conclusion yet)." } : {}),
        ...(error || input?.error ? { error: error ?? input?.error } : {}),
        summarySource: "run_turn_evidence",
      })
      continue
    }

    const ownership = inspectTurnOwnership(snapshot, turn.id, userId)
    if (!ownership.readable) {
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status: "restricted",
        startedAt,
        ...(finishedAt ? { finishedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        sessionId,
        ...(inputId ? { inputId } : {}),
        turnId: turn.id,
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: "restricted",
        evidenceStatus: "restricted",
        summarySource: "run_turn_evidence",
        error: "This run's turn includes input from another member or lacks verified author attribution; cannot read its content.",
      })
      continue
    }

    const read = await readTurnAssistantOutput(journal, snapshot, turn.id, {
      pageSize: historyPageSize,
      maxPages: historyMaxPages,
    })
    const pendingAttention = pendingTurnAttention(snapshot, turn.id)
    const progress = describeTurnProgress(read, pendingAttention)
    const availability: FollowUpEvidenceAvailability = !read.complete ? "partial" : baseAvailability

    if (activeTurn(turn) || status === "claimed" || status === "running") {
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status: pendingAttention ? "attention" : "running",
        startedAt,
        ...(scheduledFor ? { scheduledFor } : {}),
        sessionId,
        ...(inputId ? { inputId } : {}),
        turnId: turn.id,
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: availability,
        evidenceStatus: "in_progress",
        progress: progress ?? "Running in execution session; no final conclusion yet.",
        ...(read.recentTools?.length ? { recentTools: read.recentTools } : {}),
        ...(pendingAttention ? { pendingAttention } : {}),
        summarySource: "run_turn_evidence",
      })
      continue
    }

    if (turn.state === "failed" || turn.state === "cancelled" || turn.state === "interrupted" || status === "failed" || status === "interrupted") {
      const effectiveStatus = (turn.state === "interrupted" || status === "interrupted") ? "interrupted" : "failed"
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status: effectiveStatus,
        startedAt,
        ...(finishedAt || turn.endedAt ? { finishedAt: finishedAt ?? turn.endedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        sessionId,
        ...(inputId ? { inputId } : {}),
        turnId: turn.id,
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: availability,
        evidenceStatus: effectiveStatus,
        ...(progress ? { progress } : {}),
        ...(read.recentTools?.length ? { recentTools: read.recentTools } : {}),
        error: error ?? turn.error ?? (turn.state === "cancelled" ? "Scheduled turn was cancelled." : "Scheduled execution did not complete."),
        summarySource: "run_turn_evidence",
      })
      continue
    }

    // Completed turn with incomplete transcript: never fabricate a confirmed conclusion from partial evidence (D4b).
    if (!read.complete) {
      const partialSnippet = read.text.trim() ? read.text.trim().slice(0, 1200) : undefined
      const incompleteProgress = [progress, partialSnippet ? `Partial output excerpt: ${partialSnippet}` : undefined].filter(Boolean).join(" · ") || undefined
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status: "completed",
        startedAt,
        ...(finishedAt || turn.endedAt ? { finishedAt: finishedAt ?? turn.endedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        sessionId,
        ...(inputId ? { inputId } : {}),
        turnId: turn.id,
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: "partial",
        evidenceStatus: "incomplete",
        ...(incompleteProgress ? { progress: incompleteProgress } : {}),
        ...(read.recentTools?.length ? { recentTools: read.recentTools } : {}),
        error: "Full turn transcript could not be read completely; no confirmed final conclusion is available.",
        summarySource: "run_turn_evidence",
      })
      continue
    }

    // Completed turn: strictly distinguish real conclusion vs progress-only vs empty output.
    if (isFinalOutputSource(read.outputSource) && read.text.trim()) {
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status: "completed",
        startedAt,
        ...(finishedAt || turn.endedAt ? { finishedAt: finishedAt ?? turn.endedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        sessionId,
        ...(inputId ? { inputId } : {}),
        turnId: turn.id,
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: availability,
        evidenceStatus: "concluded",
        conclusion: read.text.trim().slice(0, 4000),
        ...(read.recentTools?.length ? { recentTools: read.recentTools } : {}),
        summarySource: "run_turn_evidence",
      })
      continue
    }

    if (read.outputSource === "milestone" || read.outputSource === "commentary" || read.outputSource === "ack" || (read.recentTools?.length ?? 0) > 0) {
      results.push({
        runId: candidate.runId,
        scheduleId: task.id,
        scheduleTitle: task.title,
        status: "completed",
        startedAt,
        ...(finishedAt || turn.endedAt ? { finishedAt: finishedAt ?? turn.endedAt } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
        sessionId,
        ...(inputId ? { inputId } : {}),
        turnId: turn.id,
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        deliveredToMainChat,
        evidenceAvailability: availability,
        evidenceStatus: "progress_only_no_conclusion",
        progress: progress ?? "Only intermediate progress was recorded; no formal final conclusion was produced.",
        ...(read.recentTools?.length ? { recentTools: read.recentTools } : {}),
        summarySource: "run_turn_evidence",
      })
      continue
    }

    results.push({
      runId: candidate.runId,
      scheduleId: task.id,
      scheduleTitle: task.title,
      status: "completed",
      startedAt,
      ...(finishedAt || turn.endedAt ? { finishedAt: finishedAt ?? turn.endedAt } : {}),
      ...(scheduledFor ? { scheduledFor } : {}),
      sessionId,
      ...(inputId ? { inputId } : {}),
      turnId: turn.id,
      ...(deliveryPolicy ? { deliveryPolicy } : {}),
      deliveredToMainChat,
      evidenceAvailability: availability,
      evidenceStatus: "no_output",
      summarySource: "run_turn_evidence",
    })
  }

  return results
}

/** Render a concise, substantive run line for main-chat inspect responses (never just a bare link). */
export function formatRunEvidenceLine(item: ScheduleRunEvidence): string {
  const header = `- Run \`${item.runId}\` (${item.startedAt}${item.finishedAt ? ` → ${item.finishedAt}` : ""}) · ${item.status}`
  const quietNote = item.deliveryPolicy === "exceptions_only" && !item.deliveredToMainChat && item.evidenceStatus === "concluded"
    ? " [exceptions_only · recorded quietly, not pushed]"
    : ""
  if (item.evidenceStatus === "concluded" && item.conclusion) {
    return `${header}${quietNote}: ${item.conclusion}`
  }
  if (item.evidenceStatus === "in_progress") {
    return `${header} [In progress — no final conclusion yet]: ${item.progress ?? "Running."}`
  }
  if (item.evidenceStatus === "progress_only_no_conclusion") {
    return `${header} [Finished — progress only, no final conclusion]: ${item.progress ?? "Only intermediate progress was recorded."}`
  }
  if (item.evidenceStatus === "incomplete") {
    return `${header} [Incomplete evidence — no confirmed conclusion]: ${item.error ?? "Full turn transcript could not be read completely."}${item.progress ? ` (${item.progress})` : ""}`
  }
  if (item.evidenceStatus === "failed" || item.evidenceStatus === "interrupted" || item.evidenceStatus === "skipped") {
    return `${header}: ${item.error ?? item.status}${item.progress ? ` (${item.progress})` : ""}`
  }
  if (item.evidenceStatus === "restricted" || item.evidenceStatus === "deleted") {
    return `${header}: ${item.error ?? item.evidenceStatus}`
  }
  return `${header}: Completed with no text output.`
}
