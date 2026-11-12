import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { PromptRequest, PromptResponse } from "@agentclientprotocol/sdk/unstable"
import { supportsSteering, type AgentConnection } from "./agents/acp.ts"
import { createAntigravityClientWrapper, inspectAntigravityTranscript } from "./agents/antigravity.ts"

const toJsonl = (steps: Record<string, unknown>[]) => steps.map(s => JSON.stringify(s)).join("\n") + "\n"

async function writeTranscript(dataDir: string, sessionId: string, steps: Record<string, unknown>[]) {
  const dir = join(dataDir, "brain", sessionId, ".system_generated", "logs")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "transcript.jsonl"), toJsonl(steps), "utf8")
}

async function writeStepStatus(dataDir: string, sessionId: string, idx: number, status: number) {
  const dir = join(dataDir, "conversations")
  await mkdir(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, `${sessionId}.db`))
  try {
    db.exec("CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, status integer NOT NULL DEFAULT 0)")
    db.prepare("INSERT OR REPLACE INTO steps (idx, status) VALUES (?, ?)").run(idx, status)
  } finally {
    db.close()
  }
}

function stubConnection(overrides: Partial<AgentConnection> & Pick<AgentConnection, "prompt">): AgentConnection {
  return {
    initialization: { protocolVersion: 1 },
    newSession: async () => ({ sessionId: "s1" }),
    setConfigOption: async () => ({ configOptions: [] }),
    resume: async () => ({}),
    steer: async () => ({ outcome: "inactive" }),
    cancel: async () => {},
    close: async () => {},
    ...overrides,
  }
}

test("inspectAntigravityTranscript ignores IsDaemon commands and tracks chained background wakeups", () => {
  const base = [
    { step_index: 210, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ args: { IsDaemon: "true" } }] },
    { step_index: 211, type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: s1/task-211." },
    { step_index: 245, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ args: { IsDaemon: "false" } }] },
    { step_index: 246, type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: s1/task-246." },
    { step_index: 247, type: "PLANNER_RESPONSE", status: "DONE", content: "Recording video..." },
  ]
  assert.deepEqual(inspectAntigravityTranscript(toJsonl(base), 200), { state: "running", lastStepIndex: 247 })

  const chained = [
    ...base,
    { step_index: 248, type: "SYSTEM_MESSAGE", status: "DONE", content: "sender=s1/task-246 finished" },
    { step_index: 253, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ args: { IsDaemon: false } }] },
    { step_index: 254, type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task with task id: s1/task-254." },
  ]
  assert.deepEqual(inspectAntigravityTranscript(toJsonl(chained), 200), { state: "running", lastStepIndex: 254 })

  const settled = [
    ...chained,
    { step_index: 256, type: "SYSTEM_MESSAGE", status: "DONE", content: "sender=s1/task-254 finished" },
    { step_index: 320, type: "PLANNER_RESPONSE", status: "DONE", content: "All checks completed." },
  ]
  assert.deepEqual(inspectAntigravityTranscript(toJsonl(settled), 200), { state: "settled_response", lastStepIndex: 320 })
})

test("createAntigravityClientWrapper waits for background settlement, flushes updates, and suppresses sync tail", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "df-agy-test-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const sessionId = "session-73"
  const messages: string[] = []
  let prompts = 0
  let cancels = 0

  const { wrappedClient, wrapConnection } = createAntigravityClientWrapper(
    {
      onUpdate(n) {
        if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text") {
          messages.push(n.update.content.text)
        }
      },
    },
    { dataDir, pollIntervalMs: 15 },
  )

  const conn = wrapConnection(stubConnection({
    async prompt(params) {
      prompts++
      if (prompts === 1) {
        await wrappedClient.onUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Run", status: "in_progress", rawInput: { IsDaemon: false } },
        })
        await wrappedClient.onUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Running in background..." } },
        })
        const initial = [
          { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ args: { IsDaemon: false } }] },
          { step_index: 2, type: "GENERIC", status: "RUNNING", content: `Tool is running as a background task with task id: ${sessionId}/task-2.` },
        ]
        await writeTranscript(dataDir, sessionId, initial)
        setTimeout(() => void writeTranscript(dataDir, sessionId, [
          ...initial,
          { step_index: 3, type: "SYSTEM_MESSAGE", status: "DONE", content: `sender=${sessionId}/task-2 finished` },
          { step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "Final settled output." },
        ]), 25)
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      }
      await wrappedClient.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" } })
      await wrappedClient.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final settled output." } } })
      await delay(50)
      await wrappedClient.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Redundant tail" } } })
      return { stopReason: "cancelled", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }
    },
    async cancel() { cancels++ },
  }))

  const res = await conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] })
  assert.equal(res.stopReason, "end_turn")
  assert.equal(res.usage?.totalTokens, 45)
  assert.equal(prompts, 2)
  assert.equal(cancels, 1)
  assert.deepEqual(messages, ["Running in background...", "Final settled output."])
})

test("createAntigravityClientWrapper reconnects when background wakeup pauses on SQLite WAITING step", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "df-agy-wait-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const sessionId = "session-18"
  const messages: string[] = []
  let prompts = 0
  let cancels = 0

  const { wrappedClient, wrapConnection } = createAntigravityClientWrapper(
    {
      onUpdate(n) {
        if (n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text") {
          messages.push(n.update.content.text)
        }
      },
    },
    { dataDir, pollIntervalMs: 15 },
  )

  const initial = [
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ args: { IsDaemon: false } }] },
    { step_index: 2, type: "GENERIC", status: "RUNNING", content: `Tool is running as a background task with task id: ${sessionId}/task-2.` },
  ]

  const conn = wrapConnection(stubConnection({
    async prompt(params) {
      prompts++
      if (prompts === 1) {
        await wrappedClient.onUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Run", status: "in_progress", rawInput: { IsDaemon: false } },
        })
        await writeTranscript(dataDir, sessionId, initial)
        setTimeout(() => {
          void writeTranscript(dataDir, sessionId, [
            ...initial,
            { step_index: 3, type: "SYSTEM_MESSAGE", status: "DONE", content: `sender=${sessionId}/task-2 finished` },
            { step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ args: { IsDaemon: false } }] },
          ]).then(() => writeStepStatus(dataDir, sessionId, 5, 9))
        }, 25)
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      }
      await wrappedClient.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" } })
      await wrappedClient.onUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "c2", title: "Count lines", status: "completed", rawInput: { IsDaemon: false } },
      })
      await writeStepStatus(dataDir, sessionId, 5, 3)
      await wrappedClient.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "42 lines." } } })
      return { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }
    },
    async cancel() { cancels++ },
  }))

  const res = await conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] })
  assert.equal(res.stopReason, "end_turn")
  assert.equal(res.usage?.totalTokens, 45)
  assert.equal(prompts, 2)
  assert.equal(cancels, 0)
  assert.deepEqual(messages, ["42 lines."])
})

test("createAntigravityClientWrapper bridges active-turn and poll-wait steering and reports inactive when idle", async () => {
  const sessionId = "session-steer"
  const msg = (text: string): PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] })
  const received: string[] = []
  const resolvers: ((value: PromptResponse) => void)[] = []

  const { wrappedClient, wrapConnection } = createAntigravityClientWrapper(
    { onUpdate() {} },
    { dataDir: join(tmpdir(), "df-agy-nonexistent"), pollIntervalMs: 500 },
  )
  const conn = wrapConnection(stubConnection({
    prompt(params) {
      received.push(params.prompt[0]?.type === "text" ? params.prompt[0].text : "")
      resolvers.shift()?.({ stopReason: "cancelled", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
      return new Promise<PromptResponse>(resolve => { resolvers.push(resolve) })
    },
  }))

  assert.equal(supportsSteering(conn.initialization), true)
  assert.deepEqual(await conn.steer(msg("early"), "d0"), { outcome: "inactive" })

  const turn = conn.prompt(msg("first"))
  while (received.length < 1) await delay(5)
  assert.deepEqual(await conn.steer(msg("second"), "d1"), { outcome: "injected" })
  await wrappedClient.onUpdate({ sessionId, update: { sessionUpdate: "tool_call", toolCallId: "bg-1", title: "Build", status: "in_progress" } })
  resolvers.shift()!({ stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } })
  await delay(15)
  assert.deepEqual(await conn.steer(msg("third"), "d2"), { outcome: "injected" })
  await wrappedClient.onUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" } })
  resolvers.shift()!({ stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } })

  const res = await turn
  assert.equal(res.stopReason, "end_turn")
  assert.equal(res.usage?.totalTokens, 40)
  assert.deepEqual(await conn.steer(msg("late"), "d3"), { outcome: "inactive" })
  assert.deepEqual(received, ["first", "second", "third"])
})
