import type { AgentSessionRecord } from "@deskfleet/protocol/agent"
import { superTaskText, type StoredSuperMessage, type SuperRoom } from "./state.ts"
import { resolveRoomMessageLinks } from "./message-links.ts"
import { adhdReplyInstructions } from "../agent/adhd-skill.ts"
import type { SuperWorkspace } from "@deskfleet/protocol/super-agent"
import { basename, dirname } from "node:path"
import type { SuperCoordinatorPhase, SuperCoordinatorUsage, SuperModelSelection, SuperTicketStatus } from "@deskfleet/protocol/super-agent"
import type { SuperImage, SuperAttachmentContext } from "./attachments.ts"
import type { SuperEvidenceRequest } from "./evidence.ts"
import { scheduleTrigger, type ScheduleTrigger } from "@deskfleet/protocol/schedule"
import type { FollowUpDeliveryPolicy } from "@deskfleet/protocol/super-agent-follow-up"
import { hostTimeZone, validTimeZone, type SuperScheduleAction } from "./schedule.ts"
import {
  buildEvidenceFallbackAck,
  describeEvidenceActivity,
  parseCoordinatorPublicFeedback,
  type SuperCoordinatorPublicFeedback,
  type SuperCoordinatorPublicMessage,
} from "./feedback-helpers.ts"
export type { SuperEvidenceRequest } from "./evidence.ts"
export type { SuperScheduleAction } from "./schedule.ts"

export interface SuperRouteTicket {
  id: string; title: string; scope: string; status?: SuperTicketStatus; latestAcceptance?: string; summary?: string; sessionId?: string; terms?: string[]
}
export interface SuperRouteSchedule {
  id: string
  title: string
  workspaceId: string
  enabled: boolean
  trigger: ScheduleTrigger
  targetKind: "worktree" | "directory" | "existing"
  sessionId?: string
  nextRunAt?: string
  followUpEnabled?: boolean
  followUpStatus?: "active" | "awaiting_authorization" | "paused" | "not_subscribed"
  deliveryPolicy?: FollowUpDeliveryPolicy
  lastRunState?: string
  activeRun?: { runId: string; state: "claimed" | "running"; startedAt: string; sessionId?: string }
  lastRun?: { runId: string; state: string; startedAt: string; finishedAt?: string; sessionId?: string; error?: string }
}
export interface SuperRouteContext {
  workspaceId: string | null
  adhdEnabled?: boolean
  coordinator?: string
  coordinatorSelection?: SuperModelSelection
  clientTimeZone?: string
  text: string
  attachments?: SuperAttachmentContext
  quote?: { messageId?: string; sourceMessageId?: string; text: string; ticketId?: string; ticketIds?: string[] }
  focusTicketId?: string
  recentTicketIds?: string[]
  pendingQuestion?: { ticketId: string; options: string[]; optionDisposition?: "continue" }
  recent: { id?: string; role: "user" | "assistant" | "worker"; text: string; ticketId?: string; ticketIds?: string[]; sourceMessageId?: string; replyTo?: string }[]
  tickets: SuperRouteTicket[]
  workspaces: { id: string; name: string; rootCount?: number; folderHint?: string }[]
  history?: { id: string; title: string; archiveState?: string }[]
  providers?: { id: string; name: string }[]
  schedules?: SuperRouteSchedule[]
  followUp?: { authorized: boolean; adoptAllSchedules: boolean; pendingAuthScheduleCount: number }
}
export type SuperRouteAction =
  | { kind: "answer" | "clarify"; text: string; ticketId?: string; options?: string[]; optionDisposition?: "continue" }
  | { kind: "create"; title: string; scope: string; prompt: string; ticketId?: string; sessionId?: string; provider?: string; context?: "directory"; quoteRole?: "source" | "background"; sourceDiscussionMessageIds?: string[] }
  | { kind: "continue"; ticketId: string; prompt: string; acceptanceUpdate?: string; delivery?: "backlog" | "steer"; resumeStopped?: boolean }
  | { kind: "stop"; ticketId: string; prompt: string }
  | { kind: "handoff"; workspaceId: string; prompt: string; context: string }
  | SuperScheduleAction
export interface SuperRouteResult { actions: SuperRouteAction[]; reason: string; publicFeedback?: SuperCoordinatorPublicFeedback }
export interface SuperModelLaunch { binaryPath?: string; env?: NodeJS.ProcessEnv; authEnv?: NodeJS.ProcessEnv }
interface SuperModelOptions {
  launch?: SuperModelLaunch
  selection?: SuperModelSelection
  onUsage?: (usage: SuperCoordinatorUsage | undefined) => void
  onPublicMessage?: (message: SuperCoordinatorPublicMessage) => void
}
export type SuperDecisionModel = (packet: Record<string, unknown>, signal?: AbortSignal, images?: SuperImage[], options?: SuperModelOptions) => Promise<unknown>
export interface SuperRouterOptions {
  onUsage?: SuperModelOptions["onUsage"]
  onPhase?: (phase: SuperCoordinatorPhase) => void
  onPublicMessage?: (message: SuperCoordinatorPublicMessage) => void
  model: SuperDecisionModel
  evidence?: (request: SuperEvidenceRequest) => Promise<string>
  signal?: AbortSignal
}
type ModelAction = SuperRouteAction | { kind: "evidence"; request: SuperEvidenceRequest }
type JsonObject = Record<string, unknown>

function record(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as JsonObject
}
function string(value: unknown, field: string, max = 32_768): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${field}`)
  return value
}
function known(value: unknown, choices: readonly { id: string }[], field: string): string {
  const id = string(value, field, 512)
  if (!choices.some(choice => choice.id === id)) throw new Error(`Unknown ${field}`)
  return id
}

function requestFor(value: unknown, ctx: SuperRouteContext): SuperEvidenceRequest {
  const obj = record(value)
  if (obj.kind === "ticket") return { kind: "ticket", ticketId: known(obj.ticketId, ctx.tickets, "ticket") }
  if (obj.kind === "schedule") return { kind: "schedule", scheduleId: known(obj.scheduleId, ctx.schedules ?? [], "schedule") }
  if (obj.kind === "scheduleRuns") {
    const scheduleId = known(obj.scheduleId, ctx.schedules ?? [], "schedule")
    const runId = obj.runId === undefined ? undefined : string(obj.runId, "runId", 512)
    const limit = obj.limit === undefined ? undefined : Number(obj.limit)
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) throw new Error("Invalid schedule run limit")
    return { kind: "scheduleRuns", scheduleId, ...(runId ? { runId } : {}), ...(limit !== undefined ? { limit } : {}) }
  }
  if (obj.kind === "history") {
    const scheduleSessions = (ctx.schedules ?? []).flatMap(s => [
      ...(s.sessionId ? [{ id: s.sessionId }] : []),
      ...(s.activeRun?.sessionId ? [{ id: s.activeRun.sessionId }] : []),
      ...(s.lastRun?.sessionId ? [{ id: s.lastRun.sessionId }] : []),
    ])
    const ids = [...ctx.history ?? [], ...ctx.tickets.flatMap(ticket => ticket.sessionId ? [{ id: ticket.sessionId }] : []), ...scheduleSessions]
    const sessionId = known(obj.sessionId, ids, "history session")
    if (obj.afterSeq !== undefined && (typeof obj.afterSeq !== "string" || !/^\d{1,22}$/u.test(obj.afterSeq))) throw new Error("Invalid journal cursor")
    return { kind: "history", sessionId, afterSeq: obj.afterSeq as string | undefined }
  }
  const { kind, rootIndex } = obj
  if (kind !== "search" && kind !== "list" && kind !== "read") throw new Error("Unknown evidence kind")
  const workspaceId = known(obj.workspaceId, ctx.workspaces, "workspace")
  if (typeof rootIndex !== "number" || !Number.isSafeInteger(rootIndex) || rootIndex < 0) throw new Error("Invalid root index")
  const path = obj.path === undefined ? undefined : string(obj.path, "path", 4096)
  if (kind === "read" && !path) throw new Error("Path required for reading")
  const query = kind === "search" ? string(obj.query, "search", 256) : undefined
  const line = obj.line
  if (line !== undefined && (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1)) throw new Error("Invalid line")
  return { kind, workspaceId, rootIndex, path, query, line: line as number | undefined }
}

export const stoppedTicketContinuationError = "This ticket was stopped. Explicitly ask to resume or rerun it before continuing."

const resumeClauses = /[\r\n。！？!?;；，,]+/u
const zhNegatedResume = /(?:不要|不用|不必|不再|不需要|不想|不打算|不准备|不准|不许|不得|(?<![能可])不(?:能|可以)?|别|勿|无需|无须|没必要|暂不|先不|还未|还没|没有|尚未|未|并非|不是|已经|已)\s*(?:去|再|继续|接着|帮我|给我|自动|直接|顺便|偷偷|擅自|隐式|把[^，,。！？!?]{1,16})?\s*$/u
const enNegatedResume = /\b(?:don['’]?t|do\s+not|doesn['’]?t|does\s+not|didn['’]?t|did\s+not|never|not|no\s+need\s+to|without|avoid|stop|cancel|haven['’]?t|hasn['’]?t|won['’]?t|cannot|can['’]?t)\s+(?:[\w'-]+\s+){0,2}$/iu
const nonCommandResumeClause = /(?:为什么|为何|为啥|怎么(?:没|还没|不)|要不要|是否(?:要|需要)|需不需要|该不该|应该.{0,12}吗|要(?:恢复|重跑|重启|重开|重新).{0,12}吗)|\b(?:why\b|should\s+(?:i|we)\b|do\s+(?:i|we)\s+need\s+to\b|has\s+it\s+(?:resumed|restarted|reopened)\b|is\s+it\s+(?:resumed|restarted|reopened)\b)/iu
const resumeSignal = /恢复(?!正常|了(?:吗|没|没有)?(?:\s|$))|重跑|重新(?:跑|运行|执行|开始|启动|做|排查|检查|测试|验证|处理|试|打开|开启)|重启|重开|再(?:跑|运行|执行)(?:一[遍次下])?|再试一[次遍下]|(?:停掉|已停止|停止|暂停)(?:的|了)?.{0,8}(?:继续|接着)(?:跑|执行|运行|做|查|处理|完成)?|(?:继续|接着)(?:跑|执行|运行).{0,8}(?:停掉|已停止|停止|暂停)|\b(?:resume|re-?run|re-?start|re-?open|re-?execute|unpause)\b|\b(?:run|execute|start|try)\b(?:\s+[\w-]+){0,4}\s+\bagain\b|\bcontinue\s+(?:the\s+|this\s+)?stopped\b|\bpick\s+(?:this|it|that)\s+back\s+up\b/giu

/** Require an explicit, non-negated user request to resume or rerun a stopped ticket. */
export function hasExplicitResumeIntent(text: string): boolean {
  for (const raw of text.split(resumeClauses)) {
    const clause = raw.trim()
    if (!clause || nonCommandResumeClause.test(clause)) continue
    for (const match of clause.matchAll(resumeSignal)) {
      const before = clause.slice(0, match.index)
      if (!zhNegatedResume.test(before) && !enNegatedResume.test(before)) return true
    }
  }
  return false
}

function matchPendingOption(question: SuperRouteContext["pendingQuestion"], text: string): string | undefined {
  if (!question?.options.length) return
  const trimmed = text.trim()
  const index = /^[1-9]\d?$/u.test(trimmed) ? Number(trimmed) - 1 : question.options.findIndex(option => option.trim() === trimmed)
  return question.options[index]
}

export function allowsStoppedResume(
  text: string,
  pendingQuestion: SuperRouteContext["pendingQuestion"] | undefined,
  focusTicketId: string | undefined,
  quote: { ticketId?: string } | undefined,
  ticketId: string,
): boolean {
  if (hasExplicitResumeIntent(text)) return true
  if (pendingQuestion?.ticketId === ticketId && (quote?.ticketId === ticketId || (!quote && focusTicketId === ticketId))) {
    const selected = matchPendingOption(pendingQuestion, text)
    if (selected && hasExplicitResumeIntent(selected)) return true
  }
  return false
}

function parseAction(value: unknown, ctx: SuperRouteContext, readSessions: Set<string>): ModelAction {
  const obj = record(value)
  const ticketId = obj.ticketId === undefined ? undefined : known(obj.ticketId, ctx.tickets, "ticket")
  switch (obj.kind) {
    case "evidence": return { kind: "evidence", request: requestFor(obj.request, ctx) }
    case "answer": case "clarify": {
      if (obj.options !== undefined && (!Array.isArray(obj.options) || !obj.options.length || obj.options.length > 12)) throw new Error("Invalid options")
      const options = (obj.options as unknown[] | undefined)?.map(item => string(item, "option", 1000))
      if (obj.optionDisposition !== undefined && (obj.optionDisposition !== "continue" || !ticketId || !options?.length)) throw new Error("Option continuation requires a ticket and in-scope choices")
      if (obj.optionDisposition === "continue" && ctx.tickets.find(item => item.id === ticketId)?.status === "stopped") {
        throw new Error("Stopped tickets cannot pre-authorize option continuation")
      }
      return { kind: obj.kind, text: string(obj.text, "reply"), ticketId, options, optionDisposition: obj.optionDisposition }
    }
    case "create": {
      const sessionId = obj.sessionId === undefined ? undefined : known(obj.sessionId, ctx.history ?? [], "history session")
      if (sessionId && !readSessions.has(sessionId)) throw new Error("Read the history evidence before attaching this session")
      const provider = obj.provider === undefined ? undefined : known(obj.provider, ctx.providers ?? [], "provider")
      if (obj.context !== undefined && obj.context !== "directory") throw new Error("Unknown execution context")
      if (obj.quoteRole !== undefined && obj.quoteRole !== "source" && obj.quoteRole !== "background") throw new Error("Unknown quote role")
      let sourceDiscussionMessageIds: string[] | undefined
      if (obj.sourceDiscussionMessageIds !== undefined) {
        if (!Array.isArray(obj.sourceDiscussionMessageIds) || obj.sourceDiscussionMessageIds.length > 12) throw new Error("Invalid sourceDiscussionMessageIds")
        const knownDiscussionIds = new Set<string>([
          ...ctx.recent.flatMap(item => item.id ? [item.id] : []),
          ...(ctx.quote?.messageId ? [ctx.quote.messageId] : []),
          ...(ctx.quote?.sourceMessageId ? [ctx.quote.sourceMessageId] : []),
        ])
        sourceDiscussionMessageIds = []
        for (const rawId of obj.sourceDiscussionMessageIds) {
          const messageId = string(rawId, "source discussion message", 512)
          if (!knownDiscussionIds.has(messageId)) throw new Error("Unknown source discussion message")
          if (!sourceDiscussionMessageIds.includes(messageId)) sourceDiscussionMessageIds.push(messageId)
        }
      }
      return {
        kind: "create", context: obj.context, title: string(obj.title, "title", 200), scope: string(obj.scope, "scope", 6000), prompt: string(obj.prompt, "worker prompt"), ticketId, sessionId, provider,
        ...(obj.quoteRole !== undefined ? { quoteRole: obj.quoteRole } : {}),
        ...(sourceDiscussionMessageIds !== undefined ? { sourceDiscussionMessageIds } : {}),
      }
    }
    case "continue": {
      if (!ticketId) throw new Error("Continuation requires a ticket")
      if (obj.delivery !== undefined && obj.delivery !== "backlog" && obj.delivery !== "steer") throw new Error("Unknown delivery")
      if (obj.resumeStopped !== undefined && typeof obj.resumeStopped !== "boolean") throw new Error("Invalid resumeStopped")
      const ticket = ctx.tickets.find(item => item.id === ticketId)!
      if (ticket.status === "stopped") {
        if (!allowsStoppedResume(ctx.text, ctx.pendingQuestion, ctx.focusTicketId, ctx.quote, ticketId)) {
          throw new Error("Cannot reopen a stopped ticket unless the user explicitly asks to resume or rerun it. Answer, clarify, or create a new ticket instead.")
        }
        if (obj.resumeStopped !== true) {
          throw new Error("Resuming a stopped ticket requires resumeStopped: true when the user explicitly asked to resume or rerun it.")
        }
      }
      const acceptanceUpdate = obj.acceptanceUpdate === undefined ? undefined : string(obj.acceptanceUpdate, "updated acceptance", 6000)
      return { kind: "continue", ticketId, prompt: string(obj.prompt, "worker prompt"), acceptanceUpdate, delivery: obj.delivery, ...(obj.resumeStopped ? { resumeStopped: true } : {}) }
    }
    case "stop":
      if (!ticketId) throw new Error("Stopping requires a ticket")
      return { kind: "stop", ticketId, prompt: string(obj.prompt, "instruction") }
    case "handoff": {
      const workspaceId = known(obj.workspaceId, ctx.workspaces, "target workspace")
      if (workspaceId === ctx.workspaceId) throw new Error("Handoff must change workspaces")
      return { kind: "handoff", workspaceId, prompt: ctx.text, context: string(obj.context, "handoff background", 6000) }
    }
    case "schedule": {
      const op = obj.operation
      if (typeof op !== "string" || !["create", "list", "inspect", "update", "pause", "resume", "run", "delete", "stop_follow_up", "adopt", "adopt_all", "stop_all_follow_up"].includes(op)) {
        throw new Error("Unknown schedule operation")
      }
      const operation = op as SuperScheduleAction["operation"]
      const scheduleId = obj.scheduleId === undefined ? undefined : known(obj.scheduleId, ctx.schedules ?? [], "schedule")
      if (!["create", "list", "adopt_all", "stop_all_follow_up"].includes(operation) && !scheduleId) throw new Error("Schedule operation requires a known scheduleId")
      const runId = obj.runId === undefined ? undefined : string(obj.runId, "runId", 512)
      const workspaceId = obj.workspaceId === undefined ? undefined : known(obj.workspaceId, ctx.workspaces, "target workspace")
      const title = obj.title === undefined ? undefined : string(obj.title, "schedule title", 200)
      const prompt = obj.prompt === undefined ? undefined : string(obj.prompt, "schedule prompt", 100_000)
      const targetKind = obj.targetKind === undefined ? undefined : obj.targetKind
      if (targetKind !== undefined && targetKind !== "worktree" && targetKind !== "directory" && targetKind !== "existing") {
        throw new Error("Unknown schedule target kind")
      }
      const sessionIds = [...(ctx.history ?? []), ...ctx.tickets.flatMap(t => t.sessionId ? [{ id: t.sessionId }] : [])]
      const sessionId = obj.sessionId === undefined ? undefined : known(obj.sessionId, sessionIds, "session")
      const provider = obj.provider === undefined ? undefined : known(obj.provider, ctx.providers ?? [], "provider")
      let trigger: ScheduleTrigger | undefined
      if (obj.trigger !== undefined) {
        const raw = record(obj.trigger)
        const existingSchedule = scheduleId ? ctx.schedules?.find(s => s.id === scheduleId) : undefined
        const existingZone = existingSchedule && "timeZone" in existingSchedule.trigger ? validTimeZone(existingSchedule.trigger.timeZone) : undefined
        const withFallbackZone = (raw.kind === "daily" || raw.kind === "weekly") && !validTimeZone(raw.timeZone)
          ? { ...raw, timeZone: validTimeZone(ctx.clientTimeZone) ?? (operation === "update" ? existingZone : undefined) ?? hostTimeZone() }
          : raw
        trigger = scheduleTrigger(withFallbackZone)
      }
      if (obj.yolo !== undefined && typeof obj.yolo !== "boolean") throw new Error("Invalid schedule yolo flag")
      const deliveryPolicy = obj.deliveryPolicy === undefined ? undefined : obj.deliveryPolicy
      if (deliveryPolicy !== undefined && deliveryPolicy !== "every_run" && deliveryPolicy !== "exceptions_only") {
        throw new Error("Invalid schedule delivery policy")
      }
      if (obj.followUpEnabled !== undefined && typeof obj.followUpEnabled !== "boolean") throw new Error("Invalid followUpEnabled flag")
      const unsupportedRule = obj.unsupportedRule === undefined ? undefined : string(obj.unsupportedRule, "unsupported rule", 500)
      if (obj.confirmationRequired !== undefined && typeof obj.confirmationRequired !== "boolean") throw new Error("Invalid confirmationRequired flag")
      return {
        kind: "schedule",
        operation,
        ...(scheduleId ? { scheduleId } : {}),
        ...(runId ? { runId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(title ? { title } : {}),
        ...(prompt ? { prompt } : {}),
        ...(targetKind ? { targetKind } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(provider ? { provider } : {}),
        ...(trigger ? { trigger } : {}),
        ...(obj.yolo !== undefined ? { yolo: obj.yolo } : {}),
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        ...(obj.followUpEnabled !== undefined ? { followUpEnabled: obj.followUpEnabled } : {}),
        ...(unsupportedRule ? { unsupportedRule } : {}),
        ...(obj.confirmationRequired !== undefined ? { confirmationRequired: obj.confirmationRequired } : {}),
      }
    }
    default: throw new Error("Unknown routing action")
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" })

/** Complete directory of compact titles; more expensive evidence is attached to a few likely tickets. */
export function superCandidateCards(ctx: SuperRouteContext): SuperRouteTicket[] {
  const query = ctx.text.toLocaleLowerCase()
  const words = new Set(query.match(/[\p{L}\p{N}_./#-]+/gu) ?? [])
  // Keep literal filenames and error IDs alongside words from unspaced Chinese/Japanese text.
  for (const part of segmenter.segment(query)) if (part.isWordLike) words.add(part.segment)
  const terms = [...words].filter(word => word.length >= 2)
  const pinned = [ctx.quote?.ticketId, ctx.pendingQuestion?.ticketId, ctx.focusTicketId, ...(ctx.recentTicketIds ?? []).slice(0, 3)]
  const selected = new Set(pinned.filter((id): id is string => !!id))
  const documents = ctx.tickets.map(ticket => {
    const searchable = [ticket.id, ticket.title, ticket.scope, ticket.latestAcceptance ?? "", ticket.summary ?? "", ...ticket.terms ?? []].join("\n").toLocaleLowerCase()
    const entities = [ticket.id, ticket.title, ...ticket.terms ?? []].filter(term => term.length >= 2)
    return { id: ticket.id, matched: terms.filter(term => searchable.includes(term)), exact: entities.some(term => query.includes(term.toLocaleLowerCase())) }
  })
  const frequencies = new Map<string, number>()
  for (const doc of documents) for (const term of doc.matched) frequencies.set(term, 1 + (frequencies.get(term) ?? 0))
  const matches = documents.map(doc => ({
    id: doc.id, score: Number(doc.exact) * 4 + doc.matched.reduce((score, term) => score + Math.log1p(documents.length / frequencies.get(term)!), 0),
  })).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
  for (const item of matches.slice(0, 4)) selected.add(item.id)
  return ctx.tickets.filter(ticket => selected.has(ticket.id)).map(ticket => ({ ...ticket, scope: ticket.scope.slice(0, 1600), latestAcceptance: ticket.latestAcceptance?.slice(0, 1600), summary: ticket.summary?.slice(0, 2000) }))
}

function exactOption(ctx: SuperRouteContext): SuperRouteResult | undefined {
  const question = ctx.pendingQuestion
  const ticket = question ? ctx.tickets.find(item => item.id === question.ticketId) : undefined
  if (!question || question.optionDisposition !== "continue" || !question.options.length || question.ticketId !== ctx.focusTicketId
    || ctx.quote && ctx.quote.ticketId !== question.ticketId || !ticket || ticket.status === "stopped") return
  const selected = matchPendingOption(question, ctx.text)
  if (selected === undefined) return
  return { reason: "The user selected an option from the foreground question.", actions: [{
    kind: "continue", ticketId: question.ticketId, prompt: `${ctx.text}\n\nSelected option: ${selected}`, delivery: "backlog",
  }] }
}

export async function routeSuperMessage(ctx: SuperRouteContext, options: SuperRouterOptions): Promise<SuperRouteResult> {
  options.signal?.throwIfAborted()
  if (!ctx.text.trim() && !ctx.attachments?.previews.length) throw new Error("Message must contain text")
  options.onPhase?.("matchingTicket")
  const exact = !ctx.attachments?.previews.length && exactOption(ctx)
  if (exact) return exact
  const resolvedClientTimeZone = validTimeZone(ctx.clientTimeZone) ?? hostTimeZone()
  const packet = {
    ...(ctx.adhdEnabled && { replyStyle: adhdReplyInstructions() }),
    workspaceId: ctx.workspaceId, clientTimeZone: resolvedClientTimeZone, message: ctx.text, attachments: ctx.attachments?.previews, quote: ctx.quote, workspaces: ctx.workspaces, providers: ctx.providers,
    focusTicketId: ctx.focusTicketId, pendingQuestion: ctx.pendingQuestion, recent: ctx.recent.filter(message => message.role !== "worker").slice(-12)
      .map(message => ({ ...message, text: message.text.slice(0, 2400) })),
    directory: ctx.tickets.map(ticket => ({ id: ticket.id, title: ticket.title, status: ticket.status, scope: ticket.scope.slice(0, 190), latestAcceptance: ticket.latestAcceptance?.slice(0, 190), terms: ticket.terms?.slice(0, 8) })),
    cards: superCandidateCards(ctx), historyDirectory: ctx.history ?? [], schedules: ctx.schedules ?? [],
    ...(ctx.followUp ? { followUp: ctx.followUp } : {}),
  }
  const evidence: { request: SuperEvidenceRequest; result: string }[] = []
  const readSessions = new Set<string>()
  let validationError: string | undefined
  let invalidCount = 0
  let ackEmitted = false
  const emitPublic = (message: SuperCoordinatorPublicMessage) => {
    if (options.signal?.aborted) return
    if (message.purpose === "ack") {
      if (ackEmitted && !message.delta) return
      if (message.done !== false) ackEmitted = true
    }
    options.onPublicMessage?.(message)
  }
  for (let pass = 0; pass < 7; pass++) {
    options.signal?.throwIfAborted()
    // One model call can decide ownership and produce the entire reply.
    options.onPhase?.("processing")
    const raw = await options.model({ ...packet, evidence, validationError, remainingReads: Math.max(0, 5 - pass) }, options.signal, ctx.attachments?.images,
      { selection: ctx.coordinatorSelection, onUsage: options.onUsage, onPublicMessage: emitPublic })
    options.signal?.throwIfAborted()
    try {
      const data = record(raw)
      const reason = string(data.reason, "routing reason", 3000)
      const publicFeedback = parseCoordinatorPublicFeedback(data.publicFeedback)
      if (!Array.isArray(data.actions) || !data.actions.length || data.actions.length > 6) throw new Error("Expected 1–6 routing actions")
      const actions = data.actions.map(item => parseAction(item, ctx, readSessions))
      const reads = actions.filter(action => action.kind === "evidence")
      if (!reads.length) {
        if (actions.length > 1 && actions.some(a => ["handoff", "clarify"].includes(a.kind))) throw new Error("Clarifications and handoffs must be decided before any dispatch")
        const ownedTargets = actions.flatMap(a => a.kind === "continue" || a.kind === "stop" ? [a.ticketId] : [])
        if (new Set(ownedTargets).size !== ownedTargets.length) throw new Error("Combine instructions to the same ticket")
        return { actions: actions as SuperRouteAction[], reason, ...(publicFeedback ? { publicFeedback } : {}) }
      }
      if (reads.length !== actions.length) throw new Error("Read evidence separately from final actions")
      if (pass >= 5 || evidence.length + reads.length > 12) throw new Error("Evidence budget exhausted; give a grounded answer or ask for clarification")
      // Publish validated foreground feedback before executing slow evidence reads.
      const evidenceAck = publicFeedback?.ack
        ?? (!ackEmitted ? buildEvidenceFallbackAck(ctx.text, reads.map(item => item.request), { tickets: ctx.tickets, workspaces: ctx.workspaces, pass }) : undefined)
      if (evidenceAck && !ackEmitted) {
        emitPublic({ purpose: "ack", text: evidenceAck, done: true })
      }
      if (publicFeedback?.milestone) {
        emitPublic({ purpose: "milestone", dedupeKey: `route-pass:${pass}:milestone`, text: publicFeedback.milestone, done: true })
      }
      if (publicFeedback?.activity) {
        emitPublic({ purpose: "activity", itemId: `route-pass:${pass}:activity`, text: publicFeedback.activity, done: true })
      }
      options.onPhase?.("readingContext")
      for (const [readIndex, { request }] of reads.entries()) {
        options.signal?.throwIfAborted()
        if (evidence.some(item => JSON.stringify(item.request) === JSON.stringify(request))) throw new Error("Evidence already returned; use its result or request a different range")
        const activityId = `route-evidence:${pass}:${readIndex}`
        const activityText = describeEvidenceActivity(request, ctx.text)
        emitPublic({ purpose: "activity", itemId: activityId, text: activityText, done: false })
        let result: string
        try {
          if (request.kind === "ticket" && !options.evidence) result = JSON.stringify(ctx.tickets.find(t => t.id === request.ticketId))
          else if (options.evidence) result = await options.evidence(request)
          else throw new Error("Evidence source unavailable")
          if (request.kind === "history") {
            const history = JSON.parse(result) as { messages?: { text?: unknown }[] }
            if (history.messages?.some(row => typeof row.text === "string" && row.text.trim())) readSessions.add(request.sessionId)
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          result = `Evidence unavailable (${code && /^[A-Z_]+$/u.test(code) ? code : "unavailable"}). Check the requested path, range or access.`
        }
        emitPublic({ purpose: "activity", itemId: activityId, text: activityText, done: true })
        evidence.push({ request, result: result.slice(0, 12_000) })
      }
      validationError = undefined
    } catch (error) {
      if (++invalidCount > 1) throw new Error(`Invalid Super Agent decision: ${(error as Error).message}`)
      validationError = (error as Error).message
    }
  }
  throw new Error("Super Agent could not resolve this message within the evidence budget")
}

export function quotedFeedbackItem(room: SuperRoom, replyTo: string | undefined) {
  return replyTo ? room.feedbackItems?.find(item => item.itemId === replyTo && (item.kind === "milestone" || item.kind === "ack")) : undefined
}
export function quotedAttachmentSource(room: SuperRoom, source: StoredSuperMessage) {
  const quoted = room.messages.find(item => item.id === source.replyTo)
  if (quoted) return quoted.role === "user" ? quoted : quoted.sourceMessageId ? room.messages.find(m => m.id === quoted.sourceMessageId) : undefined
  const feedback = quotedFeedbackItem(room, source.replyTo)
  return feedback ? room.messages.find(m => m.id === feedback.sourceMessageId) : undefined
}
export function attachedKeys(room: SuperRoom, source: StoredSuperMessage, includeQuote = true): string[] {
  return [...new Set([...(source.attachmentKeys ?? []), ...(includeQuote ? quotedAttachmentSource(room, source)?.attachmentKeys ?? [] : [])])]
}
export function ticketOfQuote(room: SuperRoom, quoted: StoredSuperMessage | undefined, replyTo?: string) {
  if (quoted) return quoted.ticketId || (quoted.role === "assistant" && quoted.sourceMessageId ? room.messages.find(item => item.role === "user" && item.id === quoted.sourceMessageId)?.ticketId : undefined)
  const feedback = quotedFeedbackItem(room, replyTo)
  if (!feedback) return undefined
  return feedback.ticketId || room.messages.find(item => item.role === "user" && item.id === feedback.sourceMessageId)?.ticketId
}
export function frontendContext(
  room: SuperRoom,
  message: StoredSuperMessage,
  catalog: SuperWorkspace[],
  providers: SuperRouteContext["providers"],
  history: AgentSessionRecord[],
  schedules?: SuperRouteSchedule[],
  followUp?: SuperRouteContext["followUp"],
): SuperRouteContext {
  const quoted = room.messages.find(item => item.id === message.replyTo)
  const quotedFeedback = !quoted ? quotedFeedbackItem(room, message.replyTo) : undefined
  const quotedTicket = ticketOfQuote(room, quoted, message.replyTo)
  const archived = new Set(room.tickets.filter(ticket => ticket.archiveState).map(ticket => ticket.id))
  const archivedWorkers = new Set(room.tickets.filter(ticket => ticket.archiveState).map(ticket => ticket.sessionId))
  const limit = room.messages.findIndex(item => item.id === message.id)
  const superseded = new Set(
    room.messages
      .slice(0, limit + 1)
      .flatMap(item => item.role === "user" && item.reEditOf && item.reEditOf !== item.id ? [item.reEditOf] : []),
  )
  // A second window can append its user message while the previous route is still pending.
  // Include replies to preceding user messages even if their rows were appended after this one.
  // Superseded stopped turns stay in history for inspection, never as pending foreground context.
  const preceding = room.messages.slice(0, limit).filter(item => item.role === "user" && !superseded.has(item.id)).slice(-12)
  const replies = new Map<string, StoredSuperMessage[]>(preceding.map(item => [item.id, []]))
  for (const item of room.messages) {
    if (item.role === "assistant" && item.sourceMessageId) replies.get(item.sourceMessageId)?.push(item)
  }
  const recent = preceding.flatMap(user => [user, ...replies.get(user.id)!]).filter(item => !item.ticketId || !archived.has(item.ticketId)).slice(-12)
  // Only duplicate project names need a folder hint. The workspace ID still owns the conversation
  // when even the folder is shared; never coalesce projects by name or directory.
  const names = new Set<string>()
  const duplicates = new Set<string>()
  for (const { name } of catalog) {
    if (names.has(name)) duplicates.add(name)
    names.add(name)
  }
  const workspaces = catalog.map(({ id, name, roots }) => {
    const root = roots[0]
    const folderHint = duplicates.has(name) && root ? [basename(dirname(root)), basename(root)].filter(Boolean).join("/") : undefined
    return { id, name, rootCount: roots.length, folderHint }
  })
  const links = resolveRoomMessageLinks(room)
  return {
    workspaceId: room.workspaceId, clientTimeZone: message.clientTimeZone, text: superTaskText(message), adhdEnabled: message.adhdEnabled,
    quote: message.correctedTicketId ? { ticketId: message.correctedTicketId, text: "The user explicitly corrected the ownership of this message." }
      : quoted ? { messageId: quoted.id, ...(quoted.sourceMessageId ? { sourceMessageId: quoted.sourceMessageId } : {}), ticketId: quotedTicket, ...(links[quoted.id]?.length ? { ticketIds: links[quoted.id] } : {}), text: quoted.text }
        : quotedFeedback ? { ticketId: quotedTicket, text: quotedFeedback.text } : undefined,
    focusTicketId: room.focusTicketId, recentTicketIds: room.recentTicketIds, pendingQuestion: room.pendingQuestion,
    recent: [...recent.map(({ id, role, text, ticketId, sourceMessageId, replyTo }) => ({
      id, role, text, ticketId,
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(links[id]?.length ? { ticketIds: links[id] } : {}),
    })), ...(message.context ? [{ role: "assistant" as const, text: message.context }] : [])],
    tickets: room.tickets.filter(ticket => !ticket.archiveState).map(({ id, title, scope, latestAcceptance, status, summary, sessionId }) => ({ id, title, scope, latestAcceptance, status, summary, sessionId })),
    workspaces, providers,
    history: history.filter(session => !archivedWorkers.has(session.id)).map(({ id, title, archiveState }) => ({ id, title, archiveState })),
    ...(schedules?.length ? { schedules } : {}),
    ...(followUp ? { followUp } : {}),
  }
}
