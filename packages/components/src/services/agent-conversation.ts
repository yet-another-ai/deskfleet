import type { AgentElicitation, AgentEvent, AgentInput, AgentPermission, AgentSnapshot, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"

type Content = AgentInput["content"]
export type ConversationTool = AgentPermission["request"]["toolCall"]
type MessageEntry = { id: string; kind: "message"; role: "assistant" | "thought"; content: Content; turnId?: string }
type ToolEntry = { id: string; kind: "tool"; tool: ConversationTool; permission?: AgentPermission; turnId?: string }
type PlanEntry = { id: string; kind: "plan"; entries: { content: string; status: string }[]; turnId?: string }
type ElicitationEntry = { id: string; kind: "elicitation"; elicitation: AgentElicitation; turnId?: string }
export type ConversationStep = MessageEntry | ToolEntry | PlanEntry | ElicitationEntry
export type ConversationEntry =
  | { id: string; kind: "input"; input: AgentInput }
  | ConversationStep
  | { id: string; kind: "turn"; turn: AgentTurn }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
export function readableValue(value: unknown): string {
  if (typeof value === "string") return value
  return value === undefined ? "" : JSON.stringify(value, null, 2)
}

/** Rebuild from committed event order; live ACP mirrors are deliberately excluded. */
export function projectConversation(events: AgentEvent[], snapshot: AgentSnapshot): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  const inputs = new Map(snapshot.inputs.map(input => [input.id, input]))
  const seenInputs = new Set<string>()
  const permissions = new Map(snapshot.permissions.map(permission => [permission.id, permission]))
  const elicitations = new Map(snapshot.elicitations.map(elicitation => [elicitation.id, elicitation]))
  const seenElicitations = new Set<string>()
  const messages = new Map<string, MessageEntry>()
  const tools = new Map<string, ToolEntry>()
  const plans = new Map<string, PlanEntry>()
  for (const event of events) {
    if (event.kind === "elicitation") {
      const elicitation = elicitations.get((event.payload as AgentElicitation).id) ?? event.payload as AgentElicitation
      if (!seenElicitations.has(elicitation.id)) {
        entries.push({ id: `elicitation-${elicitation.id}`, kind: "elicitation", elicitation, turnId: elicitation.turnId ?? event.turnId })
        seenElicitations.add(elicitation.id)
      }
      continue
    }
    if (event.kind === "input") {
      const input = event.payload as AgentInput
      const current = inputs.get(input.id) ?? input
      if (!["delivered", "dispatching", "uncertain"].includes(current.state) || !["delivered", "dispatching"].includes(input.state) || seenInputs.has(input.id)) continue
      entries.push({ id: `input-${input.id}`, kind: "input", input: current })
      seenInputs.add(input.id)
      continue
    }
    if (event.kind === "turn") {
      const turn = event.payload as AgentTurn
      if (["completed", "cancelled", "interrupted", "failed"].includes(turn.state)) entries.push({ id: `turn-${turn.id}`, kind: "turn", turn })
      continue
    }
    if (event.kind === "permission") {
      const permission = permissions.get((event.payload as AgentPermission).id) ?? event.payload as AgentPermission
      const key = `${permission.runGeneration}:${permission.request.toolCall.toolCallId}`
      let entry = tools.get(key)
      if (!entry) {
        entry = { id: `tool-${key}`, kind: "tool", tool: { ...permission.request.toolCall }, turnId: permission.turnId ?? event.turnId }
        entries.push(entry)
        tools.set(key, entry)
      }
      entry.permission = permission
      continue
    }
    if (event.kind !== "acp" || !record(event.payload) || !record(event.payload.update)) continue
    const update = event.payload.update
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (!record(update.content) || typeof update.content.type !== "string") continue
      const role = update.sessionUpdate === "agent_thought_chunk" ? "thought" : "assistant"
      const meta = record(update._meta) && record(update._meta.deskfleet) ? update._meta.deskfleet : undefined
      const messageId = typeof update.messageId === "string" ? update.messageId : typeof meta?.messageId === "string" ? meta.messageId : undefined
      const key = messageId ? `${event.runGeneration ?? 0}:${role}:${messageId}` : undefined
      const previous = entries.at(-1)
      let entry = key ? messages.get(key) : previous?.kind === "message" && previous.role === role && previous.turnId === event.turnId ? previous : undefined
      if (!entry) {
        entry = { id: `message-${event.seq}`, kind: "message", role, content: [], turnId: event.turnId }
        entries.push(entry)
        if (key) messages.set(key, entry)
      }
      const content = update.content as Content[number]
      const last = entry.content.at(-1)
      if (last?.type === "text" && content.type === "text") last.text += content.text
      else entry.content.push({ ...content })
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (typeof update.toolCallId !== "string") continue
      const key = `${event.runGeneration ?? 0}:${update.toolCallId}`
      let entry = tools.get(key)
      if (!entry) {
        entry = { id: `tool-${key}`, kind: "tool", tool: { toolCallId: update.toolCallId }, turnId: event.turnId }
        entries.push(entry)
        tools.set(key, entry)
      }
      for (const field of ["title", "kind", "status", "content", "rawInput", "rawOutput", "locations"] as const) {
        if (field in update) Object.assign(entry.tool, { [field]: update[field] ?? undefined })
      }
    } else if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      const key = event.turnId ?? `run-${event.runGeneration ?? 0}`
      let entry = plans.get(key)
      if (!entry) { entry = { id: `plan-${event.seq}`, kind: "plan", entries: [], turnId: event.turnId }; entries.push(entry); plans.set(key, entry) }
      entry.entries = update.entries.filter(record).map(value => ({ content: String(value.content ?? ""), status: String(value.status ?? "pending") }))
    }
  }
  // A reconnect can restore a pending question before its journal page arrives.
  for (const elicitation of snapshot.elicitations) {
    if (!seenElicitations.has(elicitation.id)) entries.push({ id: `elicitation-${elicitation.id}`, kind: "elicitation", elicitation, turnId: elicitation.turnId })
  }
  return entries
}

/** Agent output between two user messages; a steered turn spans several responses. */
export interface ConversationResponse {
  id: string
  kind: "response"
  turnId?: string
  turn?: AgentTurn
  steps: ConversationStep[]
  /** Bounds of this response within its turn; absent while unknown or still running. */
  startedAt?: string
  endedAt?: string
  /** Whether the turn is still producing this response. */
  live: boolean
  /** Whether this response ends its turn and therefore carries the turn outcome. */
  last: boolean
}
export type TranscriptEntry = Extract<ConversationEntry, { kind: "input" }> | ConversationResponse

/** Turn states that mean the agent is still producing work for a Session. */
export const liveTurnStates: AgentTurn["state"][] = ["starting", "running", "cancelling"]

/** Whether a snapshot currently has a live turn (starting, running, or cancelling). */
export function snapshotIsWorking(snapshot: Pick<AgentSnapshot, "turns"> | null | undefined): boolean {
  return !!snapshot?.turns.some(turn => liveTurnStates.includes(turn.state))
}

/** Groups projected entries into user messages and the agent responses that follow them. */
export function groupTranscript(entries: ConversationEntry[], snapshot: AgentSnapshot): TranscriptEntry[] {
  const turns = new Map(snapshot.turns.map(turn => [turn.id, turn]))
  const transcript: TranscriptEntry[] = []
  const turnOf = (id: string | undefined, fallback?: AgentTurn) => id ? turns.get(id) ?? fallback : fallback
  for (const entry of entries) {
    if (entry.kind === "input") { transcript.push(entry); continue }
    const turnId = entry.kind === "turn" ? entry.turn.id : entry.turnId
    const previous = transcript.at(-1)
    let response = previous?.kind === "response" && previous.turnId === turnId ? previous : undefined
    if (!response) {
      response = { id: `response-${entry.id}`, kind: "response", turnId, turn: turnOf(turnId, entry.kind === "turn" ? entry.turn : undefined), steps: [], live: false, last: false }
      transcript.push(response)
    }
    if (entry.kind !== "turn") response.steps.push(entry)
  }
  const lastResponse = new Map<string, ConversationResponse>()
  transcript.forEach((entry, index) => {
    if (entry.kind !== "response" || !entry.turn) return
    const before = transcript[index - 1]
    const after = transcript[index + 1]
    const sameTurn = (input: TranscriptEntry | undefined) => input?.kind === "input" && input.input.turnId === entry.turn!.id ? input.input : undefined
    entry.startedAt = sameTurn(before)?.actualDelivery === "steer" ? sameTurn(before)!.deliveredAt : entry.turn.startedAt
    entry.endedAt = sameTurn(after)?.deliveredAt ?? entry.turn.endedAt
    lastResponse.set(entry.turn.id, entry)
  })
  for (const entry of transcript) {
    if (entry.kind !== "response") continue
    entry.last = !entry.turn || lastResponse.get(entry.turn.id) === entry
    entry.live = entry.last && !!entry.turn && liveTurnStates.includes(entry.turn.state)
    if (entry.live) entry.endedAt = undefined
  }
  return transcript
}

export type ToolSummaryKind = "execute" | "edit" | "read" | "search" | "other"

/** Counts tool activity for a response summary; edits count distinct files when paths are known. */
export function summarizeTools(steps: ConversationStep[]): { kind: ToolSummaryKind; count: number }[] {
  const groups = new Map<ToolSummaryKind, Set<string>>()
  for (const step of steps) {
    if (step.kind !== "tool") continue
    const kind = step.tool.kind
    const group: ToolSummaryKind = kind === "execute" || kind === "read" || kind === "search" ? kind : kind === "edit" || kind === "delete" || kind === "move" ? "edit" : "other"
    const paths = group === "edit" ? [...step.tool.locations?.map(location => location.path) ?? [], ...step.tool.content?.flatMap(block => block.type === "diff" ? [block.path] : []) ?? []] : []
    const keys = groups.get(group) ?? new Set()
    for (const key of paths.length ? paths : [step.id]) keys.add(key)
    groups.set(group, keys)
  }
  return (["execute", "edit", "read", "search", "other"] as const).flatMap(kind => groups.has(kind) ? [{ kind, count: groups.get(kind)!.size }] : [])
}
