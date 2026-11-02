import type { AgentElicitation, AgentEvent, AgentInput, AgentPermission, AgentSnapshot, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"
import type { AgentTerminalOutput, ConversationEntry, ConversationTool } from "./agent-conversation.ts"

type Content = AgentInput["content"]
type MessageEntry = Extract<ConversationEntry, { kind: "message" }>
type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>
type PlanEntry = Extract<ConversationEntry, { kind: "plan" }>
interface TerminalProjection {
  outputs: Map<string, AgentTerminalOutput>
  references: Set<string>
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/** Provider-owned terminals arrive as ACP v1 metadata, without terminal/create. */
function updateTerminalProjection(state: TerminalProjection, tool: ConversationTool, meta: unknown): void {
  for (const block of tool.content ?? []) if (block.type === "terminal") state.references.add(block.terminalId)
  if (!record(meta)) return
  const terminal = (value: unknown) => {
    if (!record(value) || typeof value.terminal_id !== "string") return undefined
    let output = state.outputs.get(value.terminal_id)
    if (!output) {
      output = { terminalId: value.terminal_id, output: "", status: "running" }
      state.outputs.set(value.terminal_id, output)
    }
    return output
  }
  const info = terminal(meta.terminal_info)
  if (info) {
    state.references.add(info.terminalId)
    if (record(meta.terminal_info) && typeof meta.terminal_info.cwd === "string") info.cwd = meta.terminal_info.cwd
  }
  // Both conventions carry plain text chunks. Prefer terminal_output if both occur.
  const chunk = meta.terminal_output ?? meta.terminal_output_delta
  if (record(chunk) && typeof chunk.data === "string") {
    const output = terminal(chunk)
    if (output) output.output += chunk.data
  }
  const exit = meta.terminal_exit
  const ended = terminal(exit)
  if (ended && record(exit)) {
    ended.status = "exited"
    if (exit.exit_code === null || typeof exit.exit_code === "number") ended.exitCode = exit.exit_code
    if (exit.signal === null || typeof exit.signal === "string") ended.signal = exit.signal
  }
}

function applyTerminalProjection(tool: ConversationTool, state: TerminalProjection): void {
  for (const output of state.outputs.values()) {
    if (state.references.has(output.terminalId)) {
      tool.terminals = { ...tool.terminals, [output.terminalId]: { ...output } }
      if (!tool.content?.some(block => block.type === "terminal" && block.terminalId === output.terminalId)) {
        tool.content = [...tool.content ?? [], { type: "terminal", terminalId: output.terminalId }]
      }
    } else if (output.output) {
      // Codex also streams read/search output through metadata without a terminal reference.
      tool.content = [...tool.content ?? [], { type: "content", content: { type: "text", text: output.output } }]
    }
  }
}

/** Mutable reduction state stays private; published entries are immutable snapshots. */
function createReduction(snapshot: AgentSnapshot) {
  const entries: ConversationEntry[] = []
  const indices = new Map<ConversationEntry, number>()
  const dirty = new Set<ConversationEntry>()
  let published: ConversationEntry[] = []
  let result: ConversationEntry[] = []
  const inputs = new Map(snapshot.inputs.map(input => [input.id, input]))
  const seenInputs = new Set<string>()
  const permissions = new Map(snapshot.permissions.map(permission => [permission.id, permission]))
  const elicitations = new Map(snapshot.elicitations.map(elicitation => [elicitation.id, elicitation]))
  const seenElicitations = new Set<string>()
  const messages = new Map<string, MessageEntry>()
  const tools = new Map<string, ToolEntry>()
  const terminals = new Map<ToolEntry, TerminalProjection>()
  const plans = new Map<string, PlanEntry>()
  // A reconnect can restore a pending question before its journal page arrives.
  const fallback: ConversationEntry[] = snapshot.elicitations.map(elicitation => ({
    id: `elicitation-${elicitation.id}`, kind: "elicitation", elicitation, turnId: elicitation.turnId,
  }))
  let initial = true
  function add(entry: ConversationEntry): void {
    indices.set(entry, entries.length)
    entries.push(entry)
    dirty.add(entry)
  }
  function append(event: AgentEvent): void {
    if (event.kind === "elicitation") {
      const elicitation = elicitations.get((event.payload as AgentElicitation).id) ?? event.payload as AgentElicitation
      if (!seenElicitations.has(elicitation.id)) {
        add({ id: `elicitation-${elicitation.id}`, kind: "elicitation", elicitation, turnId: elicitation.turnId ?? event.turnId })
        seenElicitations.add(elicitation.id)
      }
      return
    }
    if (event.kind === "input") {
      const input = event.payload as AgentInput
      const current = inputs.get(input.id) ?? input
      if (!["delivered", "dispatching", "uncertain"].includes(current.state) || !["delivered", "dispatching"].includes(input.state) || seenInputs.has(input.id)) return
      add({ id: `input-${input.id}`, kind: "input", input: current })
      seenInputs.add(input.id)
      return
    }
    if (event.kind === "turn") {
      const turn = event.payload as AgentTurn
      if (["completed", "cancelled", "interrupted", "failed"].includes(turn.state)) add({ id: `turn-${turn.id}`, kind: "turn", turn })
      return
    }
    if (event.kind === "permission") {
      const permission = permissions.get((event.payload as AgentPermission).id) ?? event.payload as AgentPermission
      const key = `${permission.runGeneration}:${permission.request.toolCall.toolCallId}`
      let entry = tools.get(key)
      if (!entry) {
        entry = { id: `tool-${key}`, kind: "tool", tool: { ...permission.request.toolCall }, turnId: permission.turnId ?? event.turnId }
        add(entry)
        tools.set(key, entry)
      }
      entry.permission = permission
      dirty.add(entry)
      return
    }
    if (event.kind !== "acp" || !record(event.payload) || !record(event.payload.update)) return
    const update = event.payload.update
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (!record(update.content) || typeof update.content.type !== "string") return
      const role = update.sessionUpdate === "agent_thought_chunk" ? "thought" : "assistant"
      const meta = record(update._meta) && record(update._meta.deskfleet) ? update._meta.deskfleet : undefined
      const messageId = typeof update.messageId === "string" ? update.messageId : typeof meta?.messageId === "string" ? meta.messageId : undefined
      const key = messageId ? `${event.runGeneration ?? 0}:${role}:${messageId}` : undefined
      const previous = entries.at(-1)
      let entry = key ? messages.get(key) : previous?.kind === "message" && previous.role === role && previous.turnId === event.turnId ? previous : undefined
      if (!entry) {
        entry = { id: `message-${event.seq}`, kind: "message", role, content: [], turnId: event.turnId }
        add(entry)
        if (key) messages.set(key, entry)
      }
      const content = update.content as Content[number]
      const last = entry.content.at(-1)
      if (last?.type === "text" && content.type === "text") last.text += content.text
      else entry.content.push({ ...content })
      dirty.add(entry)
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (typeof update.toolCallId !== "string") return
      const key = `${event.runGeneration ?? 0}:${update.toolCallId}`
      let entry = tools.get(key)
      if (!entry) {
        entry = { id: `tool-${key}`, kind: "tool", tool: { toolCallId: update.toolCallId }, turnId: event.turnId }
        add(entry)
        tools.set(key, entry)
      }
      for (const field of ["title", "kind", "status", "content", "rawInput", "rawOutput", "locations"] as const) {
        if (field in update) Object.assign(entry.tool, { [field]: update[field] ?? undefined })
      }
      let terminalState = terminals.get(entry)
      if (!terminalState) { terminalState = { outputs: new Map(), references: new Set() }; terminals.set(entry, terminalState) }
      updateTerminalProjection(terminalState, entry.tool, update._meta)
      dirty.add(entry)
    } else if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      const key = event.turnId ?? `run-${event.runGeneration ?? 0}`
      let entry = plans.get(key)
      if (!entry) { entry = { id: `plan-${event.seq}`, kind: "plan", entries: [], turnId: event.turnId }; add(entry); plans.set(key, entry) }
      entry.entries = update.entries.filter(record).map(value => ({ content: String(value.content ?? ""), status: String(value.status ?? "pending") }))
      dirty.add(entry)
    }
  }
  function publish(): ConversationEntry[] {
    if (!initial && !dirty.size) return result
    initial = false
    published = published.slice()
    for (const entry of dirty) {
      let value: ConversationEntry
      if (entry.kind === "message") value = { ...entry, content: entry.content.map(block => ({ ...block })) }
      else if (entry.kind === "tool") {
        const tool = { ...entry.tool }
        const terminalState = terminals.get(entry)
        if (terminalState) applyTerminalProjection(tool, terminalState)
        value = { ...entry, tool }
      } else value = { ...entry }
      published[indices.get(entry)!] = value
    }
    dirty.clear()
    result = [...published, ...fallback.filter(entry => entry.kind === "elicitation" && !seenElicitations.has(entry.elicitation.id))]
    return result
  }
  return { append, publish }
}

/**
 * Journal records are immutable and normally append to the same array. Replacing
 * history, switching Sessions, or changing snapshot overrides rebuilds the view.
 * Token appends only reduce new events and replace their affected entries.
 */
export function createConversationProjector() {
  let source: readonly AgentEvent[] | undefined
  let count = 0
  let last: AgentEvent | undefined
  let dependencies: unknown[] = []
  let reduction: ReturnType<typeof createReduction> | undefined
  return (events: readonly AgentEvent[], snapshot: AgentSnapshot): ConversationEntry[] => {
    // Snapshot records are replaced by the store. Tracking state also handles a
    // caller changing a decision in place, without traversing streamed payloads.
    const nextDependencies: unknown[] = [snapshot.session.id,
      ...snapshot.inputs.flatMap(input => [input, input.state]),
      ...snapshot.permissions.flatMap(permission => [permission, permission.state]),
      ...snapshot.elicitations.flatMap(elicitation => [elicitation, elicitation.state]),
    ]
    if (!reduction || source !== events || events.length < count || events[count - 1] !== last
      || nextDependencies.length !== dependencies.length || nextDependencies.some((value, index) => value !== dependencies[index])) {
      reduction = createReduction(snapshot)
      count = 0
    }
    dependencies = nextDependencies
    source = events
    for (; count < events.length; count++) reduction.append(events[count]!)
    last = events[count - 1]
    return reduction.publish()
  }
}
