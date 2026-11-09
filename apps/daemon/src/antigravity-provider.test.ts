import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { AgentConnection } from "./agents/acp.ts"
import { createAntigravityClientWrapper, inspectAntigravityTranscript } from "./agents/antigravity.ts"

const toJsonl = (steps: Record<string, unknown>[]) => steps.map(s => JSON.stringify(s)).join("\n") + "\n"

async function writeTranscript(dataDir: string, sessionId: string, steps: Record<string, unknown>[]) {
  const dir = join(dataDir, "brain", sessionId, ".system_generated", "logs")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "transcript.jsonl"), toJsonl(steps), "utf8")
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

  const waiting = [
    ...base,
    { step_index: 248, type: "SYSTEM_MESSAGE", status: "DONE", content: "sender=s1/task-246 finished" },
    { step_index: 249, type: "GENERIC", status: "WAITING", content: "" },
  ]
  assert.deepEqual(inspectAntigravityTranscript(toJsonl(waiting), 200), { state: "waiting_interaction", lastStepIndex: 249 })
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
        return { stopReason: "end_turn" }
      }
      await wrappedClient.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" } })
      await wrappedClient.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final settled output." } } })
      await delay(50)
      await wrappedClient.onUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Redundant tail" } } })
      return { stopReason: "cancelled" }
    },
    async cancel() { cancels++ },
  }))

  const res = await conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] })
  assert.equal(res.stopReason, "end_turn")
  assert.equal(prompts, 2)
  assert.equal(cancels, 1)
  assert.deepEqual(messages, ["Running in background...", "Final settled output."])
})
