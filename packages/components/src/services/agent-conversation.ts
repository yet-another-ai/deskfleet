import { createConversationProjector } from "./conversation-projector.ts"
import { isRemoteMcpTool } from "./remote-mcp-tool.ts"
import type { AgentElicitation, AgentEvent, AgentInput, AgentPermission, AgentSessionRecord, AgentSnapshot, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"

/** A completion remains unread until any viewer acknowledges it on the owning daemon. */
export function sessionIsUnread(session: Pick<AgentSessionRecord, "lastCompletedSeq" | "lastReadSeq"> | undefined): boolean {
  return BigInt(session?.lastCompletedSeq ?? "0") > BigInt(session?.lastReadSeq ?? "0")
}

/** A read completion can be marked unread when its sequence is positive. */
export function sessionCanMarkUnread(session: Pick<AgentSessionRecord, "lastCompletedSeq" | "lastReadSeq"> | undefined): boolean {
  try {
    const completed = session?.lastCompletedSeq
    return !!completed && BigInt(completed) > 0n && !sessionIsUnread(session)
  } catch { return false }
}

type Content = AgentInput["content"]
export interface AgentTerminalOutput {
  terminalId: string
  output: string
  cwd?: string
  status: "running" | "exited"
  exitCode?: number | null
  signal?: string | null
}
export type ConversationTool = AgentPermission["request"]["toolCall"] & { terminals?: Record<string, AgentTerminalOutput> }

type MessageEntry = { id: string; kind: "message"; role: "assistant" | "thought"; content: Content; turnId?: string }
type ToolEntry = { id: string; kind: "tool"; tool: ConversationTool; permission?: AgentPermission; turnId?: string }
type PlanEntry = { id: string; kind: "plan"; entries: { content: string; status: string }[]; turnId?: string }
type ElicitationEntry = { id: string; kind: "elicitation"; elicitation: AgentElicitation; turnId?: string }
export type ConversationStep = MessageEntry | ToolEntry | PlanEntry | ElicitationEntry
export type ConversationActivityStep = ToolEntry | (MessageEntry & { role: "thought" })
export interface ConversationActivity {
  id: string
  kind: "activity"
  steps: ConversationActivityStep[]
}

/** Fold adjacent tools and thoughts, keeping remote operation cards directly visible. */
export function groupResponseActivity(steps: ConversationStep[]): (ConversationStep | ConversationActivity)[] {
  const groups: (ConversationStep | ConversationActivity)[] = []
  let activity: ConversationActivity | undefined
  for (const step of steps) {
    if ((step.kind === "tool" && !isRemoteMcpTool(step.tool)) || (step.kind === "message" && step.role === "thought")) {
      if (!activity) {
        activity = { id: step.id, kind: "activity", steps: [] }
        groups.push(activity)
      }
      activity.steps.push(step as ConversationActivityStep)
    } else {
      activity = undefined
      groups.push(step)
    }
  }
  // A single tool or thought already has its own disclosure.
  return groups.map(group => group.kind === "activity" && group.steps.length === 1 ? group.steps[0]! : group)
}

export type ConversationEntry =
  | { id: string; kind: "input"; input: AgentInput }
  | ConversationStep
  | { id: string; kind: "turn"; turn: AgentTurn }

export function readableValue(value: unknown): string {
  if (typeof value === "string") return value
  return value === undefined ? "" : JSON.stringify(value, null, 2)
}

/** Rebuild from committed event order; live ACP mirrors are deliberately excluded. */
export function projectConversation(events: AgentEvent[], snapshot: AgentSnapshot): ConversationEntry[] {
  return createConversationProjector()(events, snapshot)
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

export type SessionActivity = "working" | "permission" | "question"

/** Projects the highest-priority live activity for a Session snapshot. */
export function snapshotIsWorking(snapshot: Partial<Pick<AgentSnapshot, "turns" | "permissions" | "elicitations">> | null | undefined): SessionActivity | false {
  if (snapshot?.permissions?.some(permission => permission.state === "pending")) return "permission"
  if (snapshot?.elicitations?.some(elicitation => elicitation.state === "pending")) return "question"
  if (snapshot?.turns?.some(turn => liveTurnStates.includes(turn.state))) return "working"
  return false
}

/** Groups projected entries into user messages and the agent responses that follow them. */
export function groupTranscript(entries: ConversationEntry[], snapshot: AgentSnapshot, previous: readonly TranscriptEntry[] = []): TranscriptEntry[] {
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
  const retained = new Map(previous.map(entry => [entry.id, entry]))
  return transcript.map(entry => {
    if (entry.kind === "input") return entry
    const before = retained.get(entry.id)
    return before?.kind === "response" && before.turnId === entry.turnId && before.turn === entry.turn
      && before.startedAt === entry.startedAt && before.endedAt === entry.endedAt
      && before.live === entry.live && before.last === entry.last
      && before.steps.length === entry.steps.length && before.steps.every((step, index) => step === entry.steps[index])
      ? before : entry
  })
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
