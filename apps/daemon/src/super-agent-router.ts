import type { AgentSessionRecord } from "./agent-protocol.ts"
import type { StoredSuperMessage, SuperRoom } from "./super-agent-state.ts"
import type { SuperWorkspace } from "./super-agent-protocol.ts"
import { basename, dirname } from "node:path"
import type { SuperCoordinatorUsage, SuperModelSelection, SuperTicketStatus } from "./super-agent-protocol.ts"
import type { SuperImage, SuperAttachmentContext } from "./super-agent-attachments.ts"
import { runSuperDecisionModel } from "./super-agent-model.ts"
import { runCodexSuperDecisionModel } from "./super-agent-codex.ts"
import type { SuperEvidenceRequest } from "./super-agent-evidence.ts"
export type { SuperEvidenceRequest } from "./super-agent-evidence.ts"

export interface SuperRouteTicket {
  id: string; title: string; scope: string; status?: SuperTicketStatus; latestAcceptance?: string; summary?: string; sessionId?: string; terms?: string[]
}
export interface SuperRouteContext {
  workspaceId: string | null
  coordinator?: string
  coordinatorSelection?: SuperModelSelection
  text: string
  attachments?: SuperAttachmentContext
  quote?: { text: string; ticketId?: string }
  focusTicketId?: string
  recentTicketIds?: string[]
  pendingQuestion?: { ticketId: string; options: string[]; optionDisposition?: "continue" }
  recent: { role: "user" | "assistant" | "worker"; text: string; ticketId?: string }[]
  tickets: SuperRouteTicket[]
  workspaces: { id: string; name: string; rootCount?: number; folderHint?: string }[]
  history?: { id: string; title: string; archiveState?: string }[]
  providers?: { id: string; name: string }[]
}
export type SuperRouteAction =
  | { kind: "answer" | "clarify"; text: string; ticketId?: string; options?: string[]; optionDisposition?: "continue" }
  | { kind: "create"; title: string; scope: string; prompt: string; ticketId?: string; sessionId?: string; provider?: string; context?: "directory" }
  | { kind: "continue"; ticketId: string; prompt: string; acceptanceUpdate?: string; delivery?: "backlog" | "steer" }
  | { kind: "stop"; ticketId: string; prompt: string }
  | { kind: "handoff"; workspaceId: string; prompt: string; context: string }
export interface SuperRouteResult { actions: SuperRouteAction[]; reason: string }
export interface SuperModelLaunch { binaryPath?: string; env?: NodeJS.ProcessEnv; authEnv?: NodeJS.ProcessEnv }
interface SuperModelOptions {
  launch?: SuperModelLaunch
  selection?: SuperModelSelection
  onUsage?: (usage: SuperCoordinatorUsage | undefined) => void
}
export type SuperDecisionModel = (packet: Record<string, unknown>, signal?: AbortSignal, images?: SuperImage[], options?: SuperModelOptions) => Promise<unknown>
export interface SuperRouterOptions {
  onUsage?: SuperModelOptions["onUsage"]
  model?: SuperDecisionModel
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
  if (obj.kind === "history") {
    const ids = [...ctx.history ?? [], ...ctx.tickets.flatMap(ticket => ticket.sessionId ? [{ id: ticket.sessionId }] : [])]
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

function parseAction(value: unknown, ctx: SuperRouteContext, readSessions: Set<string>): ModelAction {
  const obj = record(value)
  const ticketId = obj.ticketId === undefined ? undefined : known(obj.ticketId, ctx.tickets, "ticket")
  switch (obj.kind) {
    case "evidence": return { kind: "evidence", request: requestFor(obj.request, ctx) }
    case "answer": case "clarify": {
      if (obj.options !== undefined && (!Array.isArray(obj.options) || !obj.options.length || obj.options.length > 12)) throw new Error("Invalid options")
      const options = (obj.options as unknown[] | undefined)?.map(item => string(item, "option", 1000))
      if (obj.optionDisposition !== undefined && (obj.optionDisposition !== "continue" || !ticketId || !options?.length)) throw new Error("Option continuation requires a ticket and in-scope choices")
      return { kind: obj.kind, text: string(obj.text, "reply"), ticketId, options, optionDisposition: obj.optionDisposition }
    }
    case "create": {
      const sessionId = obj.sessionId === undefined ? undefined : known(obj.sessionId, ctx.history ?? [], "history session")
      if (sessionId && !readSessions.has(sessionId)) throw new Error("Read the history evidence before attaching this session")
      const provider = obj.provider === undefined ? undefined : known(obj.provider, ctx.providers ?? [], "provider")
      if (obj.context !== undefined && obj.context !== "directory") throw new Error("Unknown execution context")
      return { kind: "create", context: obj.context, title: string(obj.title, "title", 200), scope: string(obj.scope, "scope", 6000), prompt: string(obj.prompt, "worker prompt"), ticketId, sessionId, provider }
    }
    case "continue": {
      if (!ticketId) throw new Error("Continuation requires a ticket")
      if (obj.delivery !== undefined && obj.delivery !== "backlog" && obj.delivery !== "steer") throw new Error("Unknown delivery")
      const acceptanceUpdate = obj.acceptanceUpdate === undefined ? undefined : string(obj.acceptanceUpdate, "updated acceptance", 6000)
      return { kind: "continue", ticketId, prompt: string(obj.prompt, "worker prompt"), acceptanceUpdate, delivery: obj.delivery }
    }
    case "stop":
      if (!ticketId) throw new Error("Stopping requires a ticket")
      return { kind: "stop", ticketId, prompt: string(obj.prompt, "instruction") }
    case "handoff": {
      const workspaceId = known(obj.workspaceId, ctx.workspaces, "target workspace")
      if (workspaceId === ctx.workspaceId) throw new Error("Handoff must change workspaces")
      return { kind: "handoff", workspaceId, prompt: ctx.text, context: string(obj.context, "handoff background", 6000) }
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
  if (!question || question.optionDisposition !== "continue" || !question.options.length || question.ticketId !== ctx.focusTicketId
    || ctx.quote && ctx.quote.ticketId !== question.ticketId || !ctx.tickets.some(ticket => ticket.id === question.ticketId)) return
  const text = ctx.text.trim()
  const index = /^[1-9]\d?$/u.test(text) ? Number(text) - 1 : question.options.findIndex(option => option.trim() === text)
  const selected = question.options[index]
  if (selected === undefined) return
  return { reason: "The user selected an option from the foreground question.", actions: [{
    kind: "continue", ticketId: question.ticketId, prompt: `${ctx.text}\n\nSelected option: ${selected}`, delivery: "backlog",
  }] }
}

export async function routeSuperMessage(ctx: SuperRouteContext, options: SuperRouterOptions = {}): Promise<SuperRouteResult> {
  options.signal?.throwIfAborted()
  if (!ctx.text.trim() && !ctx.attachments?.previews.length) throw new Error("Message must contain text")
  const exact = !ctx.attachments?.previews.length && exactOption(ctx)
  if (exact) return exact
  const packet = {
    workspaceId: ctx.workspaceId, message: ctx.text, attachments: ctx.attachments?.previews, quote: ctx.quote, workspaces: ctx.workspaces, providers: ctx.providers,
    focusTicketId: ctx.focusTicketId, pendingQuestion: ctx.pendingQuestion, recent: ctx.recent.filter(message => message.role !== "worker").slice(-12)
      .map(message => ({ ...message, text: message.text.slice(0, 2400) })),
    directory: ctx.tickets.map(ticket => ({ id: ticket.id, title: ticket.title, status: ticket.status, scope: ticket.scope.slice(0, 190), latestAcceptance: ticket.latestAcceptance?.slice(0, 190), terms: ticket.terms?.slice(0, 8) })),
    cards: superCandidateCards(ctx), historyDirectory: ctx.history ?? [],
  }
  const evidence: { request: SuperEvidenceRequest; result: string }[] = []
  const readSessions = new Set<string>()
  let validationError: string | undefined
  let invalidCount = 0
  const model = options.model ?? (ctx.coordinator === "codex" ? runCodexSuperDecisionModel
    : !ctx.coordinator || ctx.coordinator === "claude-code" ? runSuperDecisionModel : undefined)
  if (!model) throw new Error("The selected provider has no coordinator adapter")
  for (let pass = 0; pass < 7; pass++) {
    options.signal?.throwIfAborted()
    const raw = await model({ ...packet, evidence, validationError, remainingReads: Math.max(0, 5 - pass) }, options.signal, ctx.attachments?.images,
      { selection: ctx.coordinatorSelection, onUsage: options.onUsage })
    options.signal?.throwIfAborted()
    try {
      const data = record(raw)
      const reason = string(data.reason, "routing reason", 3000)
      if (!Array.isArray(data.actions) || !data.actions.length || data.actions.length > 6) throw new Error("Expected 1–6 routing actions")
      const actions = data.actions.map(item => parseAction(item, ctx, readSessions))
      const reads = actions.filter(action => action.kind === "evidence")
      if (!reads.length) {
        if (actions.length > 1 && actions.some(a => ["handoff", "clarify"].includes(a.kind))) throw new Error("Clarifications and handoffs must be decided before any dispatch")
        const ownedTargets = actions.flatMap(a => a.kind === "continue" || a.kind === "stop" ? [a.ticketId] : [])
        if (new Set(ownedTargets).size !== ownedTargets.length) throw new Error("Combine instructions to the same ticket")
        return { actions: actions as SuperRouteAction[], reason }
      }
      if (reads.length !== actions.length) throw new Error("Read evidence separately from final actions")
      if (pass >= 5 || evidence.length + reads.length > 12) throw new Error("Evidence budget exhausted; give a grounded answer or ask for clarification")
      for (const { request } of reads) {
        if (evidence.some(item => JSON.stringify(item.request) === JSON.stringify(request))) throw new Error("Evidence already returned; use its result or request a different range")
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

export function quotedAttachmentSource(room: SuperRoom, source: StoredSuperMessage) {
  const quoted = room.messages.find(item => item.id === source.replyTo)
  return quoted?.role === "user" ? quoted : quoted?.sourceMessageId ? room.messages.find(m => m.id === quoted.sourceMessageId) : undefined
}
export function attachedKeys(room: SuperRoom, source: StoredSuperMessage, includeQuote = true): string[] {
  return [...new Set([...(source.attachmentKeys ?? []), ...(includeQuote ? quotedAttachmentSource(room, source)?.attachmentKeys ?? [] : [])])]
}
export function ticketOfQuote(room: SuperRoom, quoted: StoredSuperMessage | undefined) {
  return quoted?.ticketId || (quoted?.role === "assistant" && quoted.sourceMessageId ? room.messages.find(item => item.role === "user" && item.id === quoted.sourceMessageId)?.ticketId : undefined)
}
export function frontendContext(room: SuperRoom, message: StoredSuperMessage, catalog: SuperWorkspace[], providers: SuperRouteContext["providers"], history: AgentSessionRecord[]): SuperRouteContext {
  const quoted = room.messages.find(item => item.id === message.replyTo)
  const quotedTicket = ticketOfQuote(room, quoted)
  const limit = room.messages.findIndex(item => item.id === message.id)
  // A second window can append its user message while the previous route is still pending.
  // Include replies to preceding user messages even if their rows were appended after this one.
  const preceding = room.messages.slice(0, limit).filter(item => item.role === "user").slice(-12)
  const replies = new Map<string, StoredSuperMessage[]>(preceding.map(item => [item.id, []]))
  for (const item of room.messages) {
    if (item.role === "assistant" && item.sourceMessageId) replies.get(item.sourceMessageId)?.push(item)
  }
  const recent = preceding.flatMap(user => [user, ...replies.get(user.id)!]).slice(-12)
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
  return {
    workspaceId: room.workspaceId, text: message.text,
    quote: message.correctedTicketId ? { ticketId: message.correctedTicketId, text: "The user explicitly corrected the ownership of this message." }
      : quoted ? { ticketId: quotedTicket, text: quoted.text } : undefined,
    focusTicketId: room.focusTicketId, recentTicketIds: room.recentTicketIds, pendingQuestion: room.pendingQuestion,
    recent: [...recent.map(({ role, text, ticketId }) => ({ role, text, ticketId })), ...(message.context ? [{ role: "assistant" as const, text: message.context }] : [])],
    tickets: room.tickets.map(({ id, title, scope, latestAcceptance, status, summary, sessionId }) => ({ id, title, scope, latestAcceptance, status, summary, sessionId })),
    workspaces, providers,
    history: history.map(({ id, title, archiveState }) => ({ id, title, archiveState })),
  }
}
