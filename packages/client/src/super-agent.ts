import type { BillingPlan } from "./billing.ts"

export interface SuperAgentSession {
  sessionId: string
  title: string | null
  /** UTC milliseconds. Older idle sessions predate activity tracking. */
  lastActiveAt: number
}

export interface SuperAgentUsage {
  start: string
  end: string
  plan: BillingPlan
  usedCredits?: string
  includedCredits?: number | null
  usedTokens: number
  includedTokens: number | null
  runtimeConfigured: boolean
  admitted: boolean
}

/** Ordered input parts for the Eve HTTP channel. A file's data is base64, a data URL, or a URL. */
export type SuperAgentMessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; data: string; filename?: string }

export type SuperAgentMessageContent = string | readonly SuperAgentMessagePart[]

/** A stored input file carries metadata and may also expose a URL. */
export type SuperAgentTranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "file"; mediaType: string; filename?: string; url?: string }

export interface SuperAgentMessage {
  id: string
  role: "user" | "assistant"
  text: string
  at: string
  senderId?: string
  turnId?: string
  parts?: SuperAgentTranscriptPart[]
}

/** A page may carry the start or settlement of a turn separately. */
export interface SuperAgentTurn {
  id: string
  state: "running" | "completed" | "cancelled" | "failed"
  startedAt?: string
  endedAt?: string
}

export interface SuperAgentTextPreview {
  id: string
  text: string
  turnId?: string
}

export interface SuperAgentHistory {
  nextIndex: number
  messages: SuperAgentMessage[]
  turns?: SuperAgentTurn[]
  /** Announced text parts that have not yet been committed. */
  previews?: SuperAgentTextPreview[]
  /** Authenticated senders whose deliveries have been admitted but not consumed or settled. */
  pendingSenders?: readonly (readonly [deliveryId: string, senderId: string])[]
  /** An accepted delivery can settle without ever producing a user message. */
  undeliveredIds?: string[]
  /** Omitted if this read contains no lifecycle transition. */
  status?: "working" | "idle" | "failed" | "ended"
}

export function superAgentPath(teamId: string) {
  return `/api/teams/${encodeURIComponent(teamId)}/super-agent`
}

interface EveFact {
  type: string
  scope?: { turnId?: string }
  data: {
    deliveryId?: string
    turnId?: string
    principal?: { id?: string; type?: string }
    source?: { control?: string }
    parts?: SuperAgentTranscriptPart[]
    partId?: string
    kind?: string
    value?: unknown
    interrupted?: boolean
    outcome?: string
    delta?: string
  }
}

/** Project consumed inputs and published text from Eve's committed stream. */
function applyFact(history: SuperAgentHistory, senders: Map<string, string>, previews: Map<string, SuperAgentTextPreview>, at: string, { type, scope, data }: EveFact) {
  const turnId = data.turnId ?? scope?.turnId
  switch (type) {
    case "delivery.admitted":
      if (data.deliveryId && data.principal?.type === "user" && typeof data.principal.id === "string" && data.principal.id) {
        senders.set(data.deliveryId, data.principal.id)
      }
      history.status = "working"
      break
    case "delivery.consumed": {
      const parts = data.parts?.flatMap((part): SuperAgentTranscriptPart[] => {
        if (part.kind === "text" && typeof part.text === "string") return [{ kind: "text", text: part.text }]
        if (part.kind === "file" && typeof part.mediaType === "string") return [{
          kind: "file", mediaType: part.mediaType,
          ...(typeof part.filename === "string" && { filename: part.filename }),
          ...(typeof part.url === "string" && { url: part.url }),
        }]
        return []
      })
      const text = parts?.flatMap(part => part.kind === "text" ? [part.text] : []).join("\n") ?? ""
      if (data.deliveryId) {
        const senderId = senders.get(data.deliveryId)
        const hasFiles = parts?.some(part => part.kind === "file")
        if (text || hasFiles) history.messages.push({
          id: data.deliveryId, at, role: "user", text, ...(senderId && { senderId }), ...(turnId && { turnId }), ...(hasFiles && { parts }),
        })
        senders.delete(data.deliveryId)
      }
      history.status = "working"
      break
    }
    case "content.completed":
      if (data.partId) {
        const owner = turnId ?? previews.get(data.partId)?.turnId
        previews.delete(data.partId)
        if (data.kind === "text" && !data.interrupted && typeof data.value === "string" && data.value) {
          history.messages.push({ id: data.partId, at, role: "assistant", text: data.value, ...(owner && { turnId: owner }) })
        }
      }
      break
    case "turn.started":
      if (turnId) (history.turns ??= []).push({ id: turnId, state: "running", startedAt: at })
      history.status = "working"
      break
    case "turn.settled": {
      const state = data.outcome === "failed" ? "failed" : data.outcome === "cancelled" ? "cancelled" : "completed"
      if (turnId) {
        (history.turns ??= []).push({ id: turnId, state, endedAt: at })
        for (const [id, preview] of previews) if (preview.turnId === turnId) previews.delete(id)
      }
      history.status = data.outcome === "failed" ? "failed" : "idle"
      break
    }
    case "delivery.settled":
      if (data.deliveryId) senders.delete(data.deliveryId)
      if (data.outcome === "refused" || data.outcome === "failed" || data.outcome === "ignored") {
        if (data.deliveryId) (history.undeliveredIds ??= []).push(data.deliveryId)
        history.status = "failed"
      }
      break
    case "session.ended":
      history.status = "ended"
      senders.clear()
      previews.clear()
      break
  }
}

function applyProgress(previews: Map<string, SuperAgentTextPreview>, { type, scope, data }: EveFact): void {
  if (type !== "content.delta" || !data.partId || typeof data.delta !== "string") return
  const previous = previews.get(data.partId)
  // Eve announces the kind on a part's first record only. Unknown deltas are
  // ignored if their announcement was omitted or carried a non-text kind.
  if (data.kind !== "text" && (data.kind !== undefined || !previous)) return
  const turnId = scope?.turnId ?? previous?.turnId
  previews.set(data.partId, { id: data.partId, text: (previous?.text ?? "") + data.delta, ...(turnId && { turnId }) })
}

/** A finite eve v27 read. Position markers may skip lines, heartbeats never consume an index. */
export function readSuperAgentHistory(
  text: string, response: Response, startIndex: number, pendingSenders?: SuperAgentHistory["pendingSenders"],
  previousPreviews?: SuperAgentHistory["previews"],
): SuperAgentHistory {
  const version = response.headers.get("x-eve-stream-version")
  const tail = response.headers.get("x-eve-stream-tail-index")
  if (version !== "27" || tail === null || !/^(?:-1|\d+)$/u.test(tail) || !Number.isSafeInteger(Number(tail))) {
    throw new SyntaxError("Invalid Super Agent history headers")
  }
  const history: SuperAgentHistory = { nextIndex: startIndex, messages: [] }
  const senders = new Map(pendingSenders)
  const previews = new Map(previousPreviews?.map(preview => [preview.id, preview]))
  let terminated = false
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const record = JSON.parse(line)
    if (record.$eve) {
      if (record.$eve === "position" && Number.isSafeInteger(record.next)) history.nextIndex = Math.max(history.nextIndex, record.next)
      if (record.$eve === "stream.ended" || record.$eve === "stream.lease-ended") terminated = true
      continue
    }
    if (Array.isArray(record.facts) && typeof record.at === "string") {
      const facts: EveFact[] = record.facts
      // Eve commits a cancel receipt and its delivery settlement together.
      // Only the turn facts in that commit change the conversation's status.
      const controlIds = new Set(facts.flatMap(({ type, data }) =>
        type === "delivery.admitted" && data.deliveryId && data.source?.control === "cancel" ? [data.deliveryId] : [],
      ))
      for (const fact of facts) {
        if (fact.data.deliveryId && controlIds.has(fact.data.deliveryId)) continue
        applyFact(history, senders, previews, record.at, fact)
      }
    } else if (record.progress) {
      applyProgress(previews, record.progress)
    } else {
      throw new SyntaxError("Invalid Super Agent history entry")
    }
    history.nextIndex++
  }
  // Eve snapshots the reader and the tail header separately. A lease or an
  // earlier bounded reader can end cleanly short of that header. Resume from
  // consumed records so messages appended between snapshots remain readable.
  const end = Math.max(startIndex, Number(tail) + 1)
  if (history.nextIndex > end || (history.nextIndex < end && !terminated)) throw new SyntaxError("Incomplete Super Agent history")
  if (senders.size) history.pendingSenders = [...senders]
  if (previews.size) history.previews = [...previews.values()]
  return history
}
