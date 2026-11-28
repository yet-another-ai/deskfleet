import { createHash } from "node:crypto"
import type { AgentEvent, AgentInput, AgentSnapshot, AgentTurn } from "@deskfleet/protocol/agent"
import { CentralRequestError, HttpError } from "@deskfleet/client/request-diagnostics"
import type { FollowUpPrRef, FollowUpSourceState } from "@deskfleet/protocol/super-agent-follow-up"
import { isSubagentNotification } from "@deskfleet/protocol/agent-session-scope"
import { activeTurn } from "./worker.ts"

const MAX_CAPTURED_CHARS = 16_000
const DEFAULT_HISTORY_PAGE_SIZE = 500
const DEFAULT_HISTORY_MAX_PAGES = 200

/**
 * Classify a delegation authorization failure into transient outage (keep pending events & retry)
 * vs explicit revocation/denial (stay silent and do not retry).
 */
export function classifyAuthorizeError(error: unknown): "transient" | "revoked" {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return "revoked"
    if (error.status >= 500 || error.status === 429 || error.status === 408) return "transient"
    if (error.code === "unauthorized" || error.code === "forbidden" || error.code === "invalid_credentials" || error.code === "machine_credential_rejected") return "revoked"
  }
  if (error instanceof CentralRequestError) {
    if (error.diagnostics.kind === "network" || error.diagnostics.kind === "timeout" || error.diagnostics.kind === "cancelled") return "transient"
    if (error.diagnostics.status === 401 || error.diagnostics.status === 403) return "revoked"
    if (error.diagnostics.status && (error.diagnostics.status >= 500 || error.diagnostics.status === 429 || error.diagnostics.status === 408)) return "transient"
    if (error.diagnostics.apiErrorCode === "unauthorized" || error.diagnostics.apiErrorCode === "forbidden" || error.diagnostics.apiErrorCode === "invalid_credentials") return "revoked"
  }
  const obj = error && typeof error === "object" ? error as { status?: unknown; code?: unknown } : undefined
  if (typeof obj?.status === "number") {
    if (obj.status === 401 || obj.status === 403) return "revoked"
    if (obj.status >= 500 || obj.status === 429 || obj.status === 408) return "transient"
  }
  const code = typeof obj?.code === "string" ? obj.code : ""
  if (/^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_)/u.test(code)) {
    return "transient"
  }
  const msg = error instanceof Error ? error.message : String(error ?? "")
  if (/\b(?:500|502|503|504|429|408)\b/u.test(msg)) return "transient"
  if (/(?:service unavailable|temporar|offline|timeout|timed out|network|socket|econn|enotfound|etimedout|connection refused|unavailable)/iu.test(msg)
    && !/(?:revoked|removed from team|not a member|forbidden|unauthorized|did not authorize)/iu.test(msg)) {
    return "transient"
  }
  if (/(?:revoked|removed from team|not a member|forbidden|unauthorized|did not authorize|no longer authorized|verified user delegation is required)/iu.test(msg)) {
    return "revoked"
  }
  return "transient"
}

/**
 * Distinguish a confirmed missing/deleted session (`not_found`) from a transient storage/database
 * error such as `SQLITE_BUSY` (`transient`) so temporary read failures defer & retry instead of
 * fabricating an empty or deleted report.
 */
export function classifyJournalReadError(error: unknown): "not_found" | "transient" {
  const obj = error && typeof error === "object" ? error as { code?: unknown } : undefined
  const code = typeof obj?.code === "string" ? obj.code : ""
  if (/^(?:SQLITE_BUSY|SQLITE_LOCKED|EBUSY|EAGAIN|EIO)$/u.test(code)) return "transient"
  const msg = error instanceof Error ? error.message : String(error ?? "")
  if (/(?:SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|temporar|timeout|timed out)/iu.test(msg)) {
    return "transient"
  }
  if (/(?:Agent Session was not found|Session was not found|Session does not exist|ENOENT)/iu.test(msg)) {
    return "not_found"
  }
  return "transient"
}

export type TurnOutputSource = "final_answer" | "untagged_tail" | "untagged" | "milestone" | "commentary" | "ack" | "none"

export interface TurnToolActivity {
  title: string
  status: string
}

export interface TurnOutputReadResult {
  text: string
  complete: boolean
  startAfterSeq: string
  lastReadSeq: string
  pagesRead: number
  outputSource?: TurnOutputSource
  outputTruncated?: boolean
  /** Latest non-final progress text (milestone, commentary, ack, or pre-boundary text) for live/incomplete inspection. */
  progressText?: string
  /** Recent tool calls observed inside this exact turn (bounded, preserving latest status per tool call). */
  recentTools?: TurnToolActivity[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readChunkTag(update: unknown): { phase?: string; purpose?: string; messageId?: string } {
  if (!isRecord(update)) return {}
  const meta = isRecord(update._meta) ? update._meta : undefined
  const deskfleet = meta && isRecord(meta.deskfleet) ? meta.deskfleet : undefined
  const codex = meta && isRecord(meta.codex) ? meta.codex : undefined
  const rawPhase = update.phase ?? deskfleet?.phase ?? codex?.phase ?? meta?.phase
  const phase = typeof rawPhase === "string" ? rawPhase : undefined
  const rawPurpose = deskfleet?.purpose ?? deskfleet?.publicPurpose
  const purpose = typeof rawPurpose === "string" ? rawPurpose : undefined
  const rawMessageId = update.messageId ?? deskfleet?.messageId ?? meta?.messageId
  const messageId = typeof rawMessageId === "string" && rawMessageId.trim() ? rawMessageId : undefined
  return { phase, purpose, messageId }
}

function appendBoundedTail(current: string, chunk: string): { value: string; truncated: boolean } {
  const combined = current + chunk
  if (combined.length > MAX_CAPTURED_CHARS * 2) {
    return { value: combined.slice(-MAX_CAPTURED_CHARS), truncated: true }
  }
  return { value: combined, truncated: false }
}

/**
 * Page through the session journal starting from the turn's earliest known input sequence
 * until the turn's terminal event or the snapshot horizon is reached.
 * Extracts explicit `final_answer` segments separately from preceding `commentary`/`activity`
 * process logs so long commentary can never push out or pollute the official final conclusion.
 * Distinguishes an incomplete/truncated read (`complete: false`) from a turn that genuinely
 * produced empty assistant text (`complete: true, text: ""`).
 */
export async function readTurnAssistantOutput(
  journal: { history(sessionId: string, afterSeq: string, limit?: number): Promise<AgentEvent[]> },
  snapshot: AgentSnapshot,
  turnId: string,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<TurnOutputReadResult> {
  const turn = snapshot.turns.find(item => item.id === turnId)
  const relatedInputs = snapshot.inputs.filter(input => input.id === turn?.initialInputId || input.turnId === turnId)
  let minAccepted: bigint | undefined
  for (const input of relatedInputs) {
    if (!/^\d+$/u.test(input.acceptedSeq)) continue
    const seq = BigInt(input.acceptedSeq)
    if (minAccepted === undefined || seq < minAccepted) minAccepted = seq
  }
  const startAfterSeq = minAccepted !== undefined && minAccepted > 0n ? String(minAccepted - 1n) : "0"
  const throughSeq = /^\d+$/u.test(snapshot.session.lastEventSeq) ? BigInt(snapshot.session.lastEventSeq) : undefined
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE)
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_HISTORY_MAX_PAGES)
  const providerSessionId = snapshot.session.providerSessionId

  let cursor = startAfterSeq
  let pagesRead = 0
  let reachedTerminal = false
  let reachedEnd = false

  const finalSegments: Array<{ messageId?: string; text: string; truncated: boolean }> = []
  const milestoneSegments: Array<{ messageId?: string; text: string; truncated: boolean }> = []
  let commentaryOut = ""
  let commentaryTruncated = false
  let ackOut = ""
  let ackTruncated = false
  let untaggedAll = ""
  let untaggedAllTruncated = false
  let untaggedTail = ""
  let untaggedTailTruncated = false
  let hadProcessBoundary = false
  const toolOrder: string[] = []
  const toolsById = new Map<string, TurnToolActivity>()

  const recordTool = (toolCallId: string | undefined, title: string | undefined, status: string | undefined) => {
    const key = toolCallId && toolCallId.trim() ? toolCallId.trim() : `tool-${toolOrder.length + 1}`
    const existing = toolsById.get(key)
    const nextTitle = title && title.trim() ? title.trim().slice(0, 160) : (existing?.title ?? "Tool execution")
    const nextStatus = status && status.trim() ? status.trim() : (existing?.status ?? "in_progress")
    if (!existing) toolOrder.push(key)
    toolsById.set(key, { title: nextTitle, status: nextStatus })
  }

  const progressMeta = () => {
    const recentTools = toolOrder.slice(-8).map(id => toolsById.get(id)!).filter(Boolean)
    const milestoneLatest = milestoneSegments.map(s => s.text.trim()).filter(Boolean).join("\n\n").trim()
    const commentaryTrimmed = commentaryOut.trim()
    const ackTrimmed = ackOut.trim()
    const untaggedAllTrimmed = untaggedAll.trim()
    const progressText = (milestoneLatest || commentaryTrimmed || (hadProcessBoundary ? untaggedAllTrimmed : "") || ackTrimmed || untaggedAllTrimmed).slice(-2000)
    return {
      ...(progressText ? { progressText } : {}),
      ...(recentTools.length ? { recentTools } : {}),
    }
  }

  const appendSegment = (
    list: Array<{ messageId?: string; text: string; truncated: boolean }>,
    messageId: string | undefined,
    chunk: string,
  ) => {
    const last = list.at(-1)
    if (last && ((messageId && last.messageId === messageId) || (!messageId && !last.messageId))) {
      const next = appendBoundedTail(last.text, chunk)
      last.text = next.value
      last.truncated = last.truncated || next.truncated
    } else {
      const next = appendBoundedTail("", chunk)
      list.push({ messageId, text: next.value, truncated: next.truncated })
    }
  }

  const selectBest = (complete: boolean): TurnOutputReadResult => {
    const meta = progressMeta()
    const finalText = finalSegments.map(s => s.text.trim()).filter(Boolean).join("\n\n").trim()
    if (finalText) {
      const truncated = finalSegments.some(s => s.truncated) || finalText.length > MAX_CAPTURED_CHARS
      return {
        text: finalText.slice(-MAX_CAPTURED_CHARS),
        complete, startAfterSeq, lastReadSeq: cursor, pagesRead,
        outputSource: "final_answer",
        ...(truncated ? { outputTruncated: true } : {}),
        ...meta,
      }
    }
    const untaggedTailTrimmed = untaggedTail.trim()
    const untaggedAllTrimmed = untaggedAll.trim()
    if (hadProcessBoundary) {
      // After an explicit process boundary (tool call, plan, permission, commentary, ack, milestone),
      // ONLY untagged text produced AFTER the last boundary can serve as the concluding answer;
      // pre-boundary opening text MUST NEVER be concatenated onto it or promoted as a final report.
      if (untaggedTailTrimmed) {
        const truncated = untaggedTailTruncated || untaggedTailTrimmed.length > MAX_CAPTURED_CHARS
        return {
          text: untaggedTailTrimmed.slice(-MAX_CAPTURED_CHARS),
          complete, startAfterSeq, lastReadSeq: cursor, pagesRead,
          outputSource: "untagged_tail",
          ...(truncated ? { outputTruncated: true } : {}),
          ...meta,
        }
      }
    } else if (untaggedAllTrimmed) {
      // Pure-text direct answer compatibility path (no tool/process boundary occurred).
      const truncated = untaggedAllTruncated || untaggedAllTrimmed.length > MAX_CAPTURED_CHARS
      return {
        text: untaggedAllTrimmed.slice(-MAX_CAPTURED_CHARS),
        complete, startAfterSeq, lastReadSeq: cursor, pagesRead,
        outputSource: "untagged",
        ...(truncated ? { outputTruncated: true } : {}),
        ...meta,
      }
    }
    const milestoneText = milestoneSegments.map(s => s.text.trim()).filter(Boolean).join("\n\n").trim()
    if (milestoneText) {
      const truncated = milestoneSegments.some(s => s.truncated) || milestoneText.length > MAX_CAPTURED_CHARS
      return {
        text: milestoneText.slice(-MAX_CAPTURED_CHARS),
        complete, startAfterSeq, lastReadSeq: cursor, pagesRead,
        outputSource: "milestone",
        ...(truncated ? { outputTruncated: true } : {}),
        ...meta,
      }
    }
    const commentaryTrimmed = commentaryOut.trim()
    const preBoundaryProgress = commentaryTrimmed || (hadProcessBoundary ? untaggedAllTrimmed : "")
    if (preBoundaryProgress) {
      const truncated = (commentaryTrimmed ? commentaryTruncated : untaggedAllTruncated) || preBoundaryProgress.length > MAX_CAPTURED_CHARS
      return {
        text: preBoundaryProgress.slice(-MAX_CAPTURED_CHARS),
        complete, startAfterSeq, lastReadSeq: cursor, pagesRead,
        outputSource: "commentary",
        ...(truncated ? { outputTruncated: true } : {}),
        ...meta,
      }
    }
    const ackTrimmed = ackOut.trim()
    if (ackTrimmed) {
      const truncated = ackTruncated || ackTrimmed.length > MAX_CAPTURED_CHARS
      return {
        text: ackTrimmed.slice(-MAX_CAPTURED_CHARS),
        complete, startAfterSeq, lastReadSeq: cursor, pagesRead,
        outputSource: "ack",
        ...(truncated ? { outputTruncated: true } : {}),
        ...meta,
      }
    }
    return { text: "", complete, startAfterSeq, lastReadSeq: cursor, pagesRead, outputSource: "none", ...meta }
  }

  while (pagesRead < maxPages) {
    if (throughSeq !== undefined && BigInt(cursor) >= throughSeq) {
      reachedEnd = true
      break
    }
    const page = await journal.history(snapshot.session.id, cursor, pageSize)
    pagesRead += 1
    if (!page.length) {
      reachedEnd = true
      break
    }
    const lastPageSeq = BigInt(page.at(-1)!.seq)
    if (lastPageSeq <= BigInt(cursor)) {
      return selectBest(false)
    }
    for (const event of page) {
      const eventSeq = BigInt(event.seq)
      if (throughSeq !== undefined && eventSeq > throughSeq) {
        reachedEnd = true
        break
      }
      if (event.kind === "acp" && event.turnId === turnId && "update" in event.payload) {
        if ((!providerSessionId || event.payload.sessionId === providerSessionId) && !isSubagentNotification(event.payload)) {
          const update = event.payload.update
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            const chunk = update.content.text
            const tag = readChunkTag(update)
            if (tag.phase === "final_answer" || tag.purpose === "final_answer") {
              appendSegment(finalSegments, tag.messageId, chunk)
            } else if (tag.purpose === "ack") {
              const next = appendBoundedTail(ackOut, chunk)
              ackOut = next.value
              ackTruncated = ackTruncated || next.truncated
              hadProcessBoundary = true
              untaggedTail = ""
              untaggedTailTruncated = false
            } else if (tag.phase === "commentary" || tag.purpose === "activity") {
              const next = appendBoundedTail(commentaryOut, chunk)
              commentaryOut = next.value
              commentaryTruncated = commentaryTruncated || next.truncated
              hadProcessBoundary = true
              untaggedTail = ""
              untaggedTailTruncated = false
            } else if (tag.purpose === "milestone" || tag.phase === "partial_answer") {
              appendSegment(milestoneSegments, tag.messageId, chunk)
              hadProcessBoundary = true
              untaggedTail = ""
              untaggedTailTruncated = false
            } else {
              const nextAll = appendBoundedTail(untaggedAll, chunk)
              untaggedAll = nextAll.value
              untaggedAllTruncated = untaggedAllTruncated || nextAll.truncated
              const nextTail = appendBoundedTail(untaggedTail, chunk)
              untaggedTail = nextTail.value
              untaggedTailTruncated = untaggedTailTruncated || nextTail.truncated
            }
          } else if (
            update.sessionUpdate === "tool_call"
            || update.sessionUpdate === "tool_call_update"
            || update.sessionUpdate === "plan"
          ) {
            if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
              recordTool(
                typeof update.toolCallId === "string" ? update.toolCallId : undefined,
                typeof update.title === "string" ? update.title : undefined,
                typeof update.status === "string" ? update.status : undefined,
              )
            }
            hadProcessBoundary = true
            untaggedTail = ""
            untaggedTailTruncated = false
          }
        }
      } else if (event.kind === "permission" || event.kind === "elicitation") {
        if (event.turnId === turnId) {
          hadProcessBoundary = true
          untaggedTail = ""
          untaggedTailTruncated = false
        }
      } else if (event.kind === "turn") {
        const payload = event.payload as AgentTurn
        if (payload.id === turnId && !activeTurn(payload)) {
          reachedTerminal = true
        }
      }
    }
    cursor = page.at(-1)!.seq
    if (reachedTerminal || (throughSeq !== undefined && lastPageSeq >= throughSeq)) {
      reachedEnd = true
      break
    }
  }

  return selectBest(reachedTerminal || reachedEnd)
}

export interface ControlEventsReadResult {
  events: AgentEvent[]
  lastSeq: string
  complete: boolean
}

/**
 * Page through session journal events from `fromSeq` to `throughSeq`, retaining only
 * non-streaming control/lifecycle events so long turns with >200 text chunks never drop
 * terminal turn or permission/elicitation transitions.
 */
export async function readSessionControlEvents(
  journal: { history(sessionId: string, afterSeq: string, limit?: number): Promise<AgentEvent[]> },
  sessionId: string,
  fromSeq: string,
  throughSeq: string,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<ControlEventsReadResult> {
  const target = BigInt(throughSeq)
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE)
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_HISTORY_MAX_PAGES)
  const events: AgentEvent[] = []
  let cursor = fromSeq
  let pagesRead = 0

  while (BigInt(cursor) < target && pagesRead < maxPages) {
    const page = await journal.history(sessionId, cursor, pageSize)
    pagesRead += 1
    if (!page.length) break
    let advanced = cursor
    let hitTarget = false
    for (const event of page) {
      const seq = BigInt(event.seq)
      if (seq > target) { hitTarget = true; break }
      advanced = event.seq
      if (event.kind !== "acp" && event.kind !== "command") events.push(event)
    }
    if (BigInt(advanced) <= BigInt(cursor)) break
    cursor = advanced
    if (hitTarget) break
  }

  return {
    events,
    lastSeq: cursor,
    complete: BigInt(cursor) >= target,
  }
}

export type TurnOwnershipKind = "owned_by_user" | "other_user" | "mixed_shared" | "missing_author"

export interface TurnOwnership {
  kind: TurnOwnershipKind
  readable: boolean
  inputIds: string[]
  isSaOrigin: boolean
  parentActionId?: string
}

function inputFollowUpMeta(input: AgentInput): { origin?: string; parentActionId?: string } {
  for (const block of input.content) {
    const meta = (block as { _meta?: Record<string, unknown> })._meta
    if (!meta || typeof meta !== "object") continue
    const origin = typeof meta["deskfleet/followUpOrigin"] === "string" ? meta["deskfleet/followUpOrigin"] : undefined
    const parentActionId = typeof meta["deskfleet/followUpActionId"] === "string" ? meta["deskfleet/followUpActionId"] : undefined
    if (origin || parentActionId) return { origin, parentActionId }
  }
  return {}
}

/**
 * Determine whether a turn's output boundary is provably owned by one verified user.
 * Shared turns with multiple authors or legacy turns without verified authors stay restricted.
 */
export function inspectTurnOwnership(snapshot: AgentSnapshot, turnId: string | undefined, userId: string): TurnOwnership {
  if (!turnId) return { kind: "missing_author", readable: false, inputIds: [], isSaOrigin: false }
  const turn = snapshot.turns.find(item => item.id === turnId)
  const related = snapshot.inputs.filter(input =>
    input.id === turn?.initialInputId
    || input.turnId === turnId
    || (input.state === "dispatching" && input.requestedDelivery === "steer" && input.requestedTurnId === turnId))
  if (!related.length) return { kind: "missing_author", readable: false, inputIds: [], isSaOrigin: false }
  const inputIds = related.map(input => input.id)
  const authors = new Set<string>()
  let missingAuthor = false
  let isSaOrigin = false
  let parentActionId: string | undefined
  for (const input of related) {
    if (input.author.kind !== "user" || !input.author.userId) {
      missingAuthor = true
      continue
    }
    authors.add(input.author.userId)
    const meta = inputFollowUpMeta(input)
    if (meta.origin === "sa_follow_up") {
      isSaOrigin = true
      parentActionId ??= meta.parentActionId
    }
  }
  if (missingAuthor) return { kind: "missing_author", readable: false, inputIds, isSaOrigin, parentActionId }
  if (authors.size === 1 && authors.has(userId)) {
    return { kind: "owned_by_user", readable: true, inputIds, isSaOrigin, parentActionId }
  }
  if (authors.has(userId)) return { kind: "mixed_shared", readable: false, inputIds, isSaOrigin, parentActionId }
  return { kind: "other_user", readable: false, inputIds, isSaOrigin, parentActionId }
}

/** Extract user-visible assistant text for a specific turn, ignoring subagent streams and private reasoning. */
export function extractTurnAssistantText(events: readonly AgentEvent[], turnId: string, providerSessionId?: string): string {
  let out = ""
  for (const event of events) {
    if (event.kind !== "acp" || event.turnId !== turnId || !("update" in event.payload)) continue
    if (providerSessionId && event.payload.sessionId !== providerSessionId) continue
    if (isSubagentNotification(event.payload)) continue
    const update = event.payload.update
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      out += update.content.text
    }
  }
  return out.trim().slice(-16_000)
}

const PR_URL_RE = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/giu
const PR_QUALIFIED_RE = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/gu
const COMMIT_SHA_RE = /\b[0-9a-f]{7,40}\b/gu

/**
 * Extract only verifiable repo-qualified PR references (`owner/repo#N` or full GitHub PR URL).
 * Bare `#123` or PR titles are never treated as cross-Worker proof.
 */
export function extractVerifiedPrRefs(text: string, objective?: string): FollowUpPrRef[] {
  const seen = new Map<string, FollowUpPrRef>()
  for (const match of text.matchAll(PR_URL_RE)) {
    const owner = match[1]!.toLowerCase()
    const repo = match[2]!.toLowerCase()
    const number = Number(match[3])
    if (!Number.isSafeInteger(number) || number <= 0) continue
    const key = `${owner}/${repo}#${number}`
    seen.set(key, { owner, repo, number, url: match[0], ...(objective ? { objective } : {}) })
  }
  for (const match of text.matchAll(PR_QUALIFIED_RE)) {
    const owner = match[1]!.toLowerCase()
    const repo = match[2]!.toLowerCase()
    const number = Number(match[3])
    if (!Number.isSafeInteger(number) || number <= 0) continue
    const key = `${owner}/${repo}#${number}`
    if (!seen.has(key)) seen.set(key, { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}`, ...(objective ? { objective } : {}) })
  }
  return [...seen.values()]
}

export function extractCommitShas(text: string): string[] {
  const shas = new Set<string>()
  for (const match of text.matchAll(COMMIT_SHA_RE)) {
    const value = match[0]
    if (/[a-f]/u.test(value) && /\d/u.test(value)) shas.add(value)
  }
  return [...shas].slice(0, 12)
}

export interface CrossWorkerCandidate {
  sessionId: string
  workspaceId: string
  ownerUserId: string
  title: string
  objective: string
  prRefs: FollowUpPrRef[]
  summary: string
  updatedAt: string
}

export interface CrossWorkerMatch {
  sessionId: string
  title: string
  prRef: FollowUpPrRef
  summary: string
  compatibleObjective: boolean
}

const objectiveTokens = (text: string) =>
  new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter(word => !["pr", "pull", "request", "the", "and", "for", "with", "this", "that", "fix", "check", "update", "worker"].includes(word)))

/**
 * Determine whether two Workers touching the same verified PR share the same deliverable/objective.
 * Distinct tasks on the same PR (e.g. docs vs flaky test) keep separate references and are not merged.
 */
export function objectivesCompatible(a: string, b: string): boolean {
  const left = a.trim().toLocaleLowerCase()
  const right = b.trim().toLocaleLowerCase()
  if (!left || !right) return true
  if (left === right || left.includes(right) || right.includes(left)) return true
  const tokensA = objectiveTokens(left)
  const tokensB = objectiveTokens(right)
  if (!tokensA.size || !tokensB.size) return false
  let overlap = 0
  for (const token of tokensA) if (tokensB.has(token)) overlap++
  const denom = Math.min(tokensA.size, tokensB.size)
  return overlap / denom >= 0.4
}

/**
 * Match verifiable cross-Worker evidence strictly inside the same workspace & verified owner.
 * Never merges across different repositories, different workspaces sharing a folder, or conflicting objectives.
 */
export function matchCrossWorkerEvidence(params: {
  candidates: readonly CrossWorkerCandidate[]
  targetSessionId: string
  targetWorkspaceId: string
  ownerUserId: string
  targetPrRefs: readonly FollowUpPrRef[]
  targetObjective: string
}): { compatible: CrossWorkerMatch[]; relatedSeparate: CrossWorkerMatch[] } {
  const targetKeys = new Map(params.targetPrRefs.map(ref => [`${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`, ref]))
  const compatible: CrossWorkerMatch[] = []
  const relatedSeparate: CrossWorkerMatch[] = []
  if (!targetKeys.size) return { compatible, relatedSeparate }
  for (const candidate of params.candidates) {
    if (candidate.sessionId === params.targetSessionId) continue
    if (candidate.workspaceId !== params.targetWorkspaceId) continue
    if (candidate.ownerUserId !== params.ownerUserId) continue
    if (!candidate.summary.trim()) continue
    for (const ref of candidate.prRefs) {
      const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`
      if (!targetKeys.has(key)) continue
      const match: CrossWorkerMatch = {
        sessionId: candidate.sessionId,
        title: candidate.title,
        prRef: ref,
        summary: candidate.summary,
        compatibleObjective: objectivesCompatible(params.targetObjective, candidate.objective || ref.objective || ""),
      }
      if (match.compatibleObjective) compatible.push(match)
      else relatedSeparate.push(match)
      break
    }
  }
  return { compatible, relatedSeparate }
}

/** Normalize transient IDs/timestamps/line numbers so repeated identical errors map to one issue key. */
export function normalizeErrorFingerprint(error: string): string {
  const normalized = error
    .toLocaleLowerCase()
    .replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gu, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/giu, "<ts>")
    .replace(/\b\d+\b/gu, "<n>")
    .replace(/\s+/gu, " ")
    .trim()
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}

export interface ProgressEvaluation {
  state: "attention" | "progressing" | "idle" | "repeated_failure" | "stalled"
  issueKey?: string
  repeatCount?: number
  error?: string
  shouldRecheckOnly?: boolean
}

/**
 * Evaluate Worker health from journal evidence rather than elapsed time alone:
 * - Active pending permissions/elicitations surface immediately.
 * - Any new journal event means real progress (long builds never false-alarm).
 * - Repeated identical failures collapse onto one stable issueKey.
 * - Pure elapsed time without progress triggers at most one quiet recheck before alerting.
 */
export function evaluateWorkerProgress(
  snapshot: AgentSnapshot,
  sourceState: FollowUpSourceState,
  workspaceId: string,
  sourceId: string,
  nowMs = Date.now(),
  stallThresholdMs = 10 * 60_000,
): ProgressEvaluation {
  const pendingReq = snapshot.permissions.some(p => p.state === "pending") || snapshot.elicitations.some(e => e.state === "pending")
  if (pendingReq) return { state: "attention" }

  const lastTurn = snapshot.turns.at(-1)
  const isRunning = snapshot.turns.some(activeTurn)
  const hasPendingInput = snapshot.inputs.some(input => input.state === "pending" || input.state === "dispatching")

  if (isRunning || hasPendingInput) {
    if (snapshot.session.lastEventSeq !== sourceState.lastProgressSeq) {
      return { state: "progressing" }
    }
    const lastAt = sourceState.lastProgressAt ? Date.parse(sourceState.lastProgressAt) : nowMs
    if (Number.isFinite(lastAt) && nowMs - lastAt >= stallThresholdMs) {
      return {
        state: "stalled",
        issueKey: `stall:${workspaceId}:${sourceId}`,
        shouldRecheckOnly: !sourceState.lastErrorKey || sourceState.lastErrorKey !== `stall:${workspaceId}:${sourceId}`,
      }
    }
    return { state: "progressing" }
  }

  const failedTurn = lastTurn && (lastTurn.state === "failed" || lastTurn.state === "interrupted") ? lastTurn : undefined
  const failedRun = snapshot.runs.at(-1)
  const error = failedTurn?.error ?? (failedRun && (failedRun.state === "failed" || failedRun.state === "interrupted") ? failedRun.error : undefined)
  if (failedTurn || (failedRun && (failedRun.state === "failed" || failedRun.state === "interrupted"))) {
    const fingerprint = normalizeErrorFingerprint(error || failedTurn?.state || failedRun?.state || "failed")
    const issueKey = `err:${workspaceId}:${sourceId}:${fingerprint}`
    const repeatCount = sourceState.lastErrorKey === issueKey ? (sourceState.lastErrorCount ?? 1) + 1 : 1
    return { state: "repeated_failure", issueKey, repeatCount, error: error || "Worker execution failed" }
  }
  return { state: "idle" }
}
