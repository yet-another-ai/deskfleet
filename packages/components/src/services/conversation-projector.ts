import type { AgentElicitation, AgentEvent, AgentInput, AgentPermission, AgentSnapshot, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"
import { isSubagentNotification } from "@deskfleet/client/agent-session-scope"
import type { AgentTerminalOutput, CompactionEntry, ConversationEntry, ConversationStep, ConversationTool, SessionMessageEntry, StructuredPlanEntry, SubagentEntry } from "./agent-conversation.ts"

type Content = AgentInput["content"]
type MessageEntry = Extract<ConversationEntry, { kind: "message" }>
type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>
type PlanEntry = Extract<ConversationEntry, { kind: "plan" }>
interface TerminalProjection {
  outputs: Map<string, AgentTerminalOutput>
  references: Set<string>
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const scopedId = (generation: number | undefined, sessionId: string, id = "") => JSON.stringify([generation ?? 0, sessionId, id])

/** Append streamed text without changing the persisted content blocks. */
function appendContent(content: Content, block: Content[number]): void {
  const last = content.at(-1)
  if (last?.type === "text" && block.type === "text") last.text += block.text
  else content.push({ ...block })
}

function patch<T extends object>(target: T, update: T, fields: readonly (keyof T)[]): void {
  for (const field of fields) if (field in update) target[field] = update[field]
}

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
  const messageScopes = new Map<MessageEntry, string>()
  const tools = new Map<string, ToolEntry>()
  const terminals = new Map<ToolEntry, TerminalProjection>()
  const plans = new Map<string, PlanEntry>()
  const structuredPlans = new Map<string, StructuredPlanEntry>()
  const compactions = new Map<string, CompactionEntry>()
  const sessionMessages = new Map<string, SessionMessageEntry>()
  const subagents = new Map<string, SubagentEntry>()
  const owners = new Map<ConversationEntry, SubagentEntry>()
  const removed = new Set<ConversationEntry>()
  // A reconnect can restore a pending question before its journal page arrives.
  const fallback: ConversationEntry[] = snapshot.elicitations.map(elicitation => ({
    id: `elicitation-${elicitation.id}`, kind: "elicitation", elicitation, turnId: elicitation.turnId,
    providerSessionId: "sessionId" in elicitation.request && typeof elicitation.request.sessionId === "string" ? elicitation.request.sessionId : undefined,
  }))
  let initial = true
  function changed(entry: ConversationEntry): void {
    dirty.add(entry)
    const owner = owners.get(entry)
    if (owner) changed(owner)
  }
  function add(entry: ConversationEntry, owner?: SubagentEntry): void {
    indices.set(entry, entries.length)
    entries.push(entry)
    if (owner && entry.kind !== "input" && entry.kind !== "turn") {
      owners.set(entry, owner)
      owner.steps.push(entry)
    }
    changed(entry)
  }
  function childOwner(generation: number | undefined, sessionId: string, turnId: string | undefined, marked: boolean): SubagentEntry | undefined {
    const key = scopedId(generation, sessionId)
    let child = subagents.get(key)
    if (!child && marked) {
      child = { id: `subagent-${key}`, kind: "subagent", session: { sessionId }, steps: [], turnId }
      subagents.set(key, child)
      add(child)
    }
    return child
  }
  function append(event: AgentEvent): void {
    if (event.kind === "elicitation") {
      const elicitation = elicitations.get((event.payload as AgentElicitation).id) ?? event.payload as AgentElicitation
      if (!seenElicitations.has(elicitation.id)) {
        const providerSessionId = "sessionId" in elicitation.request && typeof elicitation.request.sessionId === "string" ? elicitation.request.sessionId : undefined
        add({ id: `elicitation-${elicitation.id}`, kind: "elicitation", elicitation, turnId: elicitation.turnId ?? event.turnId, providerSessionId },
          providerSessionId ? childOwner(elicitation.runGeneration, providerSessionId, event.turnId, isSubagentNotification(elicitation.request)) : undefined)
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
      const providerSessionId = permission.request.sessionId
      const key = scopedId(permission.runGeneration, providerSessionId, permission.request.toolCall.toolCallId)
      let entry = tools.get(key)
      if (!entry) {
        entry = { id: `tool-${key}`, kind: "tool", tool: { ...permission.request.toolCall }, turnId: permission.turnId ?? event.turnId, providerSessionId }
        add(entry, childOwner(permission.runGeneration, providerSessionId, event.turnId, isSubagentNotification(permission.request)))
        tools.set(key, entry)
      }
      entry.permission = permission
      changed(entry)
      return
    }
    if (event.kind !== "acp" || !record(event.payload) || !record(event.payload.update) || typeof event.payload.sessionId !== "string") return
    const update = event.payload.update
    const providerSessionId = event.payload.sessionId
    const scope = scopedId(event.runGeneration, providerSessionId)
    const entityId = (id: string) => scopedId(event.runGeneration, providerSessionId, id)
    // A history page can start after the parent's association. Keep marked child
    // output out of the parent answer until older history supplies its metadata.
    const owner = childOwner(event.runGeneration, providerSessionId, event.turnId,
      isSubagentNotification(event.payload))
    if (update.sessionUpdate === "subagent_update" && typeof update.sessionId === "string") {
      const childKey = scopedId(event.runGeneration, update.sessionId)
      let entry = subagents.get(childKey)
      if (!entry) {
        entry = { id: `subagent-${childKey}`, kind: "subagent", session: { sessionId: update.sessionId }, steps: [], turnId: event.turnId, providerSessionId }
        subagents.set(childKey, entry)
        add(entry, owner)
      } else if (owner && !owners.has(entry)) {
        owners.set(entry, owner)
        owner.steps.push(entry)
        owner.steps.sort((left, right) => indices.get(left)! - indices.get(right)!)
      }
      entry.providerSessionId = providerSessionId
      patch(entry.session, update as SubagentEntry["session"], ["title", "description", "state", "capabilities", "cwd", "additionalDirectories", "_meta"])
      changed(entry)
      return
    }
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk" || owner && update.sessionUpdate === "user_message_chunk") {
      if (!record(update.content) || typeof update.content.type !== "string") return
      const role = update.sessionUpdate === "agent_thought_chunk" ? "thought" : update.sessionUpdate === "user_message_chunk" ? "user" : "assistant"
      const meta = record(update._meta) && record(update._meta.deskfleet) ? update._meta.deskfleet : undefined
      const messageId = typeof update.messageId === "string" ? update.messageId : typeof meta?.messageId === "string" ? meta.messageId : undefined
      const key = messageId ? entityId(`${role}:${messageId}`) : undefined
      const previous = owner ? owner.steps.at(-1) : entries.at(-1)
      let entry = key ? messages.get(key) : previous?.kind === "message" && previous.role === role && previous.turnId === event.turnId && messageScopes.get(previous) === scope ? previous : undefined
      if (!entry) {
        entry = { id: `message-${event.seq}`, kind: "message", role, content: [], turnId: event.turnId, providerSessionId, ...(messageId ? { messageId } : {}) }
        add(entry, owner)
        messageScopes.set(entry, scope)
        if (key) messages.set(key, entry)
      }
      const content = update.content as Content[number]
      appendContent(entry.content, content)
      changed(entry)
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      if (typeof update.toolCallId !== "string") return
      const key = entityId(update.toolCallId)
      let entry = tools.get(key)
      if (!entry) {
        entry = { id: `tool-${key}`, kind: "tool", tool: { toolCallId: update.toolCallId }, turnId: event.turnId, providerSessionId }
        add(entry, owner)
        tools.set(key, entry)
      }
      for (const field of ["title", "kind", "status", "content", "rawInput", "rawOutput", "locations"] as const) {
        if (field in update) Object.assign(entry.tool, { [field]: update[field] ?? undefined })
      }
      let terminalState = terminals.get(entry)
      if (!terminalState) { terminalState = { outputs: new Map(), references: new Set() }; terminals.set(entry, terminalState) }
      updateTerminalProjection(terminalState, entry.tool, update._meta)
      changed(entry)
    } else if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      const key = entityId(event.turnId ?? "")
      let entry = plans.get(key)
      if (!entry) { entry = { id: `plan-${event.seq}`, kind: "plan", entries: [], turnId: event.turnId, providerSessionId }; add(entry, owner); plans.set(key, entry) }
      entry.entries = update.entries.filter(record).map(value => ({ content: String(value.content ?? ""), status: String(value.status ?? "pending"), ...(record(value._meta) ? { _meta: value._meta } : {}) }))
      changed(entry)
    } else if (update.sessionUpdate === "plan_update" && record(update.plan) && typeof update.plan.planId === "string") {
      const key = entityId(update.plan.planId)
      let entry = structuredPlans.get(key)
      if (!entry) {
        entry = { id: `plan-${event.seq}`, kind: "structured_plan", plan: update.plan as StructuredPlanEntry["plan"], turnId: event.turnId, providerSessionId }
        add(entry, owner)
        structuredPlans.set(key, entry)
      }
      entry.plan = update.plan as StructuredPlanEntry["plan"]
      changed(entry)
    } else if (update.sessionUpdate === "plan_removed" && typeof update.planId === "string") {
      const key = entityId(update.planId)
      const entry = structuredPlans.get(key)
      if (entry) { removed.add(entry); structuredPlans.delete(key); changed(entry) }
    } else if ((update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") && typeof update.compactionId === "string") {
      const key = entityId(update.compactionId)
      let entry = compactions.get(key)
      if (!entry) {
        entry = { id: `compaction-${event.seq}`, kind: "compaction", compaction: { compactionId: update.compactionId, status: "in_progress" }, turnId: event.turnId, providerSessionId }
        add(entry, owner)
        compactions.set(key, entry)
      }
      if (update.sessionUpdate === "compaction_update") {
        patch(entry.compaction, update as CompactionEntry["compaction"], ["status", "error", "_meta"])
        if ("summary" in update) entry.compaction.summary = Array.isArray(update.summary) ? update.summary.map(block => ({ ...block })) as Content : null
      } else if (record(update.content)) {
        appendContent(entry.compaction.summary ??= [], update.content as Content[number])
      }
      changed(entry)
    } else if ((update.sessionUpdate === "session_message" || update.sessionUpdate === "session_message_chunk") && typeof update.messageId === "string") {
      const key = entityId(update.messageId)
      let entry = sessionMessages.get(key)
      if (!entry) {
        entry = { id: `session-message-${event.seq}`, kind: "session_message", message: { messageId: update.messageId }, turnId: event.turnId, providerSessionId }
        add(entry, owner)
        sessionMessages.set(key, entry)
      }
      if (update.sessionUpdate === "session_message") {
        patch(entry.message, update as SessionMessageEntry["message"], ["senderSessionId", "recipientSessionId", "senderMessageId", "recipientMessageId", "_meta"])
        if ("content" in update) entry.message.content = Array.isArray(update.content) ? update.content.map(block => ({ ...block })) as Content : null
      } else if (record(update.content)) {
        appendContent(entry.message.content ??= [], update.content as Content[number])
      }
      changed(entry)
    }
  }
  function publish(): ConversationEntry[] {
    if (!initial && !dirty.size) return result
    initial = false
    published = published.slice()
    const restored = fallback.filter((entry): entry is Extract<ConversationStep, { kind: "elicitation" }> => entry.kind === "elicitation" && !seenElicitations.has(entry.elicitation.id))
    for (const question of restored) if (question.providerSessionId) {
      childOwner(question.elicitation.runGeneration, question.providerSessionId, question.turnId, isSubagentNotification(question.elicitation.request))
    }
    const restoredOwner = (entry: typeof restored[number]) => entry.providerSessionId ? subagents.get(scopedId(entry.elicitation.runGeneration, entry.providerSessionId)) : undefined
    function publishEntry(entry: ConversationEntry): ConversationEntry {
      if (!dirty.has(entry)) return published[indices.get(entry)!]!
      let value: ConversationEntry
      if (entry.kind === "message") value = { ...entry, content: entry.content.map(block => ({ ...block })) }
      else if (entry.kind === "tool") {
        const tool = { ...entry.tool }
        const terminalState = terminals.get(entry)
        if (terminalState) applyTerminalProjection(tool, terminalState)
        value = { ...entry, tool }
      } else if (entry.kind === "subagent") {
        value = { ...entry, session: { ...entry.session }, steps: [
          ...entry.steps.filter(step => !removed.has(step)).map(step => publishEntry(step) as ConversationStep),
          ...restored.filter(question => restoredOwner(question) === entry),
        ] }
      } else if (entry.kind === "compaction") {
        value = { ...entry, compaction: { ...entry.compaction, summary: entry.compaction.summary?.map(block => ({ ...block })) ?? entry.compaction.summary } }
      } else if (entry.kind === "session_message") {
        value = { ...entry, message: { ...entry.message, content: entry.message.content?.map(block => ({ ...block })) ?? entry.message.content } }
      } else value = { ...entry }
      published[indices.get(entry)!] = value
      dirty.delete(entry)
      return value
    }
    for (const entry of dirty) publishEntry(entry)
    result = [...published.filter((_, index) => !owners.has(entries[index]!) && !removed.has(entries[index]!)), ...restored.filter(question => !restoredOwner(question))]
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
