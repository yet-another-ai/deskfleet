import type { AgentEvent, AgentInput, AgentSnapshot, AgentTurn } from "../../../../apps/daemon/src/agent-protocol.ts"

export interface BenchmarkOptions {
  turns: number
  chunks: number
  intervalMs: number
  expanded: boolean
  scroll: "bottom" | "history"
}

export const FINAL_MARKER = "BENCHMARK ANSWER COMPLETE"
export const CODE_MARKER = "const benchmarkComplete = true;"
const sessionId = "benchmark-session"
const createdAt = "2026-11-01T00:00:00.000Z"

export function mixedMarkdown(index: number): string {
  return `### Investigation ${index}

The renderer should preserve **completed text**, *emphasis*, and \`inline code\` while the next response arrives. 中文段落用于覆盖混合语言文本。

1. Inspect the existing implementation.
2. Measure the update cost.
   - Keep completed work stable.
   - Validate **nested formatting**.

> A result should be reproducible with the same fixture and viewport.

| Stage | Count | State |
| --- | ---: | --- |
| Read | ${index + 1} | complete |
| Render | ${index + 2} | measured |

\`\`\`typescript
export function summarize${index}(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
const rows${index} = Array.from({ length: 12 }, (_, i) => ({ id: i, label: "row" }));
\`\`\`

Inline math $a^2 + b^2 = c^2$ and a block:

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

[Documentation](https://example.com/benchmark) and [source](src/example.ts:12).

---

The measured result for iteration ${index} includes completed history and hidden work.
${index % 4 === 0 ? `
\`\`\`json
${JSON.stringify({ rows: Array.from({ length: 96 }, (_, row) => ({ id: row, label: `item-${index}-${row}`, enabled: true })) })}
\`\`\`

\`\`\`mermaid
flowchart LR
  Read${index}[Read] --> Parse${index}[Parse] --> Render${index}[Render]
\`\`\`
` : ""}
`
}

export function createFixture(options: BenchmarkOptions) {
  let sequence = 0
  const events: AgentEvent[] = []
  const inputs: AgentInput[] = []
  const turns: AgentTurn[] = []
  function event(kind: AgentEvent["kind"], payload: AgentEvent["payload"], turnId: string): AgentEvent {
    return { sessionId, seq: String(++sequence), kind, payload, turnId, createdAt, runGeneration: 1 }
  }
  function text(text: string, turnId: string, thought = false): AgentEvent {
    return event("acp", { sessionId, update: {
      sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
      content: { type: "text", text },
    } }, turnId)
  }
  function tool(turnId: string): AgentEvent {
    return event("acp", { sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: `${turnId}-tool`, title: "Read benchmark source", kind: "read", status: "completed",
      rawInput: { path: "src/example.ts" },
      content: [{ type: "content", content: { type: "text", text: "export const sample = 42;\n".repeat(30) } }],
    } }, turnId)
  }
  function start(index: number, live: boolean): AgentTurn {
    const turnId = `turn-${index}`
    const input: AgentInput = {
      id: `input-${index}`, sessionId, submissionCommandId: `command-${index}`, author: { kind: "local_token" },
      content: [{ type: "text", text: `Investigate renderer performance, round ${index}. Include implementation and verification.` }],
      acceptedSeq: String(sequence + 1), state: "delivered", requestedDelivery: "backlog", actualDelivery: "turn_start",
      turnId, createdAt, deliveredAt: createdAt,
    }
    const turn: AgentTurn = {
      id: turnId, sessionId, initialInputId: input.id, dispatchCommandId: `dispatch-${index}`, runGeneration: 1,
      state: live ? "running" : "completed", startedAt: createdAt,
      ...(!live ? { endedAt: "2026-11-01T00:00:01.000Z" } : {}),
    }
    inputs.push(input)
    turns.push(turn)
    events.push(event("input", input, turnId))
    return turn
  }
  for (let index = 0; index < options.turns; index++) {
    const turn = start(index, false)
    const thought = mixedMarkdown(index + 1000)
    for (let offset = 0; offset < thought.length; offset += 96) events.push(text(thought.slice(offset, offset + 96), turn.id, true))
    events.push(tool(turn.id))
    const answer = mixedMarkdown(index)
    for (let offset = 0; offset < answer.length; offset += 96) events.push(text(answer.slice(offset, offset + 96), turn.id))
    events.push(event("turn", turn, turn.id))
  }
  const active = start(options.turns, true)
  // Seed a thought so the active turn is present while history mounts.
  events.push(text("Inspecting the live response.\n\n", active.id, true))
  const pending: AgentEvent[] = []
  const thoughtChunks = Math.max(1, Math.floor(options.chunks / 4))
  const answerChunks = options.chunks - thoughtChunks
  const thought = mixedMarkdown(2000).repeat(2)
  const answer = `${mixedMarkdown(3000)}\n${mixedMarkdown(3001)}\n\`\`\`typescript\n${CODE_MARKER}\n\`\`\`\n\n${FINAL_MARKER}`
  function split(content: string, count: number, isThought: boolean) {
    for (let index = 0; index < count; index++) {
      pending.push(text(content.slice(Math.floor(index * content.length / count), Math.floor((index + 1) * content.length / count)), active.id, isThought))
    }
  }
  split(thought, thoughtChunks, true)
  pending.push(tool(active.id))
  split(answer, answerChunks, false)
  const snapshot: AgentSnapshot = {
    session: { id: sessionId, provider: "benchmark", title: "Rendering benchmark", context: "directory", lifecycle: "ready", archiveState: "active", lastEventSeq: events.at(-1)!.seq, createdAt, updatedAt: createdAt },
    runs: [], inputs, turns, permissions: [], elicitations: [],
  }
  const completed: AgentTurn = { ...active, state: "completed", endedAt: "2026-11-01T00:00:02.000Z" }
  const completion = event("turn", completed, active.id)
  return { events, snapshot, pending, completion, completed, sourceCharacters: thought.length + answer.length }
}
