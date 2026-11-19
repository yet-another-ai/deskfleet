import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import type { PromptRequest, PromptResponse } from "@agentclientprotocol/sdk/unstable"
import { supportsSteering, type AgentConnection } from "@deskfleet/agent-core"
import { wrapAntigravityConnection } from "./index.ts"

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
