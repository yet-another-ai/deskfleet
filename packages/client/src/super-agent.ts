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

export interface SuperAgentMessage {
  id: string
  role: "user" | "assistant"
  text: string
  at: string
}

export interface SuperAgentHistory {
  nextIndex: number
  messages: SuperAgentMessage[]
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
  data: {
    deliveryId?: string
    parts?: { kind: string; text?: string }[]
    partId?: string
    kind?: string
    phase?: string
    value?: unknown
    interrupted?: boolean
    outcome?: string
  }
}

/** The text transcript projects consumed user text and committed replies from Eve's stream. */
function applyFact(history: SuperAgentHistory, at: string, { type, data }: EveFact) {
  switch (type) {
    case "delivery.consumed": {
      const text = data.parts?.filter(part => part.kind === "text").map(part => part.text).join("\n")
      if (data.deliveryId && text) history.messages.push({ id: data.deliveryId, at, role: "user", text })
      history.status = "working"
      break
    }
    case "content.completed":
      if (data.partId && data.kind === "text" && data.phase === "reply" && !data.interrupted && typeof data.value === "string" && data.value) {
        history.messages.push({ id: data.partId, at, role: "assistant", text: data.value })
      }
      break
    case "turn.started":
    case "delivery.admitted":
      history.status = "working"
      break
    case "turn.settled":
      history.status = data.outcome === "failed" ? "failed" : "idle"
      break
    case "delivery.settled":
      if (data.outcome === "refused" || data.outcome === "failed" || data.outcome === "ignored") {
        if (data.deliveryId) (history.undeliveredIds ??= []).push(data.deliveryId)
        history.status = "failed"
      }
      break
    case "session.ended":
      history.status = "ended"
      break
  }
}

/** A finite eve v27 read. Position markers may skip lines, heartbeats never consume an index. */
export function readSuperAgentHistory(text: string, response: Response, startIndex: number): SuperAgentHistory {
  const version = response.headers.get("x-eve-stream-version")
  const tail = response.headers.get("x-eve-stream-tail-index")
  if (version !== "27" || tail === null || !/^(?:-1|\d+)$/u.test(tail) || !Number.isSafeInteger(Number(tail))) {
    throw new SyntaxError("Invalid Super Agent history headers")
  }
  const history: SuperAgentHistory = { nextIndex: startIndex, messages: [] }
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
      for (const fact of record.facts) applyFact(history, record.at, fact)
    } else if (!record.progress) {
      throw new SyntaxError("Invalid Super Agent history entry")
    }
    history.nextIndex++
  }
  // Eve snapshots the reader and the tail header separately. A lease or an
  // earlier bounded reader can end cleanly short of that header. Resume from
  // consumed records so messages appended between snapshots remain readable.
  const end = Math.max(startIndex, Number(tail) + 1)
  if (history.nextIndex > end || (history.nextIndex < end && !terminated)) throw new SyntaxError("Incomplete Super Agent history")
  return history
}
