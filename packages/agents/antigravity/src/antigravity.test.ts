import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { PromptRequest, PromptResponse } from "@agentclientprotocol/sdk/unstable"
import { supportsSteering, type AgentConnection } from "@deskfleet/agent-core"
import { AntigravityWork, wrapAntigravityConnection } from "./index.ts"

function stubConnection(
  overrides: Partial<AgentConnection> & Pick<AgentConnection, "prompt">,
): AgentConnection {
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

test("wrapAntigravityConnection bridges active-turn steering, merges usage, and reports inactive when idle", async () => {
  const sessionId = "session-steer"
  const msg = (text: string): PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] })
  const received: string[] = []
  const resolvers: ((value: PromptResponse) => void)[] = []

  const conn = wrapAntigravityConnection(stubConnection({
    prompt(params) {
      received.push(params.prompt[0]?.type === "text" ? params.prompt[0].text : "")
      return new Promise<PromptResponse>(resolve => {
        resolvers.push(resolve)
      })
    },
  }))

  assert.equal(supportsSteering(conn.initialization), true)
  assert.deepEqual(await conn.steer(msg("early"), "d0"), { outcome: "inactive" })
  assert.deepEqual(received, [])

  const turn = conn.prompt(msg("first"))
  while (received.length < 1) {
    await delay(5)
  }

  assert.deepEqual(await conn.steer(msg("second"), "d1"), { outcome: "injected" })
  resolvers.shift()!({
    stopReason: "cancelled",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedReadTokens: 4,
    },
  })
  await delay(5)

  assert.deepEqual(await conn.steer(msg("third"), "d2"), { outcome: "injected" })
  resolvers.shift()!({
    stopReason: "cancelled",
    usage: {
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      thoughtTokens: 3,
    },
  })
  resolvers.shift()!({
    stopReason: "end_turn",
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cachedReadTokens: 6,
      thoughtTokens: 7,
    },
  })

  const res = await turn
  assert.equal(res.stopReason, "end_turn")
  assert.deepEqual(res.usage, {
    inputTokens: 30,
    outputTokens: 10,
    totalTokens: 40,
    cachedReadTokens: 10,
    cachedWriteTokens: undefined,
    thoughtTokens: 10,
  })
  assert.deepEqual(await conn.steer(msg("late"), "d3"), { outcome: "inactive" })
  assert.deepEqual(received, ["first", "second", "third"])
})

test("wrapAntigravityConnection keeps end_turn open while background tools and subagents run", async () => {
  const sessionId = "session-background"
  const child = "session-background-child"
  const work = new AntigravityWork()
  let prompts = 0
  const conn = wrapAntigravityConnection(stubConnection({
    async prompt() {
      prompts++
      work.observe({ sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: "daemon", title: "Watch", status: "in_progress", rawInput: { IsDaemon: true },
      } })
      work.observe({ sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: "build", title: "Build", status: "in_progress", rawInput: { IsDaemon: false },
      } })
      work.observe({ sessionId, update: {
        sessionUpdate: "subagent_update", sessionId: child, title: "Explorer", state: { state: "running" },
      } })
      work.observe({ sessionId: child, update: {
        sessionUpdate: "tool_call", toolCallId: "search", title: "Search", status: "in_progress",
      } })
      return { stopReason: "end_turn" }
    },
  }), undefined, work)

  let resolved = false
  const turn = conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] }).finally(() => { resolved = true })
  await delay(20)
  assert.equal(resolved, false, "daemon tools alone must not hold the turn, but the non-daemon build must")

  work.observe({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "build", status: "completed" } })
  work.observe({ sessionId: child, update: { sessionUpdate: "tool_call_update", toolCallId: "search", status: "completed" } })
  await delay(20)
  assert.equal(resolved, false, "a running child still holds the turn")

  work.observe({ sessionId, update: {
    sessionUpdate: "subagent_update", sessionId: child, state: { state: "idle", stopReason: "end_turn" },
  } })
  assert.deepEqual(await turn, { stopReason: "end_turn" })
  assert.equal(resolved, true)
  assert.equal(prompts, 1)
})

test("wrapAntigravityConnection delivers steering while background work holds the turn", async () => {
  const sessionId = "session-background-steer"
  const work = new AntigravityWork()
  const received: string[] = []
  const resolvers: ((value: PromptResponse) => void)[] = []
  const conn = wrapAntigravityConnection(stubConnection({
    prompt(params) {
      received.push(params.prompt[0]?.type === "text" ? params.prompt[0].text : "")
      if (received.length === 1) {
        work.observe({ sessionId, update: {
          sessionUpdate: "tool_call", toolCallId: "build", title: "Build", status: "in_progress",
        } })
        return Promise.resolve({ stopReason: "end_turn" })
      }
      return new Promise<PromptResponse>(resolve => { resolvers.push(resolve) })
    },
  }), undefined, work)

  const turn = conn.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] })
  await delay(20)
  assert.deepEqual(await conn.steer({ sessionId, prompt: [{ type: "text", text: "second" }] }, "d1"), { outcome: "injected" })
  await delay(10)
  assert.deepEqual(received, ["first", "second"], "steering must be delivered while the tool still holds the turn")
  resolvers.shift()!({ stopReason: "end_turn" })
  await delay(10)
  work.observe({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "build", status: "completed" } })
  assert.deepEqual(await turn, { stopReason: "end_turn" })
})

test("wrapAntigravityConnection releases a silent background hold at its bound", async () => {
  const sessionId = "session-background-bound"
  const work = new AntigravityWork()
  const conn = wrapAntigravityConnection(stubConnection({
    async prompt() {
      work.observe({ sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: "silent", title: "Long build", status: "in_progress",
      } })
      return { stopReason: "end_turn" }
    },
  }), undefined, work, { workWaitMs: 40 })

  const started = Date.now()
  assert.deepEqual(await conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] }), { stopReason: "end_turn" })
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 30, "the hold must survive without further notifications")
  assert.ok(elapsed < 1_000, "the hold must end at its deadline")
})

test("wrapAntigravityConnection cancels a turn held for background work", async () => {
  const sessionId = "session-background-cancel"
  const work = new AntigravityWork()
  let cancelled = 0
  const conn = wrapAntigravityConnection(stubConnection({
    async prompt() {
      work.observe({ sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: "build", title: "Build", status: "in_progress",
      } })
      return { stopReason: "end_turn" }
    },
    async cancel() { cancelled++ },
  }), undefined, work)

  const turn = conn.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] })
  await delay(20)
  await conn.cancel(sessionId)
  assert.deepEqual(await turn, { stopReason: "cancelled" })
  assert.equal(cancelled, 1)
})

test("wrapAntigravityConnection stops steering and returns cancelled on cancel()", async () => {
  const sessionId = "session-cancel"
  const msg = (text: string): PromptRequest => ({ sessionId, prompt: [{ type: "text", text }] })
  const cancelledSessions: string[] = []
  let resolvePrompt!: (value: PromptResponse) => void

  const conn = wrapAntigravityConnection(stubConnection({
    prompt() {
      return new Promise<PromptResponse>(resolve => {
        resolvePrompt = resolve
      })
    },
    async cancel(id) {
      cancelledSessions.push(id)
      resolvePrompt({ stopReason: "end_turn" })
    },
  }))

  const turn = conn.prompt(msg("work"))
  await delay(5)
  await conn.cancel(sessionId)

  assert.deepEqual(cancelledSessions, [sessionId])
  assert.deepEqual(await conn.steer(msg("after-cancel"), "d1"), { outcome: "inactive" })
  assert.deepEqual(await turn, { stopReason: "cancelled" })
})
