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

test("wrapAntigravityConnection bridges _meta.antigravity.systemPrompt.append for newSession, resume, and forkSession", async () => {
  const seen: { method: string; params: Record<string, unknown> }[] = []
  const conn = wrapAntigravityConnection(stubConnection({
    initialization: {
      protocolVersion: 1,
      agentCapabilities: {
        sessionCapabilities: { resume: {}, fork: {} },
        _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
      },
    },
    newSession: async params => { seen.push({ method: "new", params: params as unknown as Record<string, unknown> }); return { sessionId: "s1" } },
    resume: async params => { seen.push({ method: "resume", params: params as unknown as Record<string, unknown> }); return {} },
    forkSession: async params => { seen.push({ method: "fork", params: params as unknown as Record<string, unknown> }); return { sessionId: "s2" } },
    prompt: async () => ({ stopReason: "end_turn" }),
  }))

  assert.deepEqual(conn.initialization.agentCapabilities?.sessionCapabilities?.systemPrompt, {})
  const systemPrompt = { mode: "append" as const, content: [{ type: "text" as const, text: "Prefer DeskFleet MCP." }] }
  await conn.newSession({ cwd: "/work", mcpServers: [], systemPrompt, _meta: { custom: true, antigravity: { tier: "pro" } } })
  await conn.resume({ sessionId: "s1", cwd: "/work", mcpServers: [], systemPrompt })
  await conn.forkSession!({ sessionId: "s1", cwd: "/work", mcpServers: [], systemPrompt })

  assert.equal(seen[0]?.params.systemPrompt, undefined)
  assert.deepEqual(seen[0]?.params._meta, {
    custom: true,
    antigravity: { tier: "pro", systemPrompt: { append: "Prefer DeskFleet MCP." } },
  })
  assert.equal(seen[1]?.params.systemPrompt, undefined)
  assert.deepEqual(seen[1]?.params._meta, {
    antigravity: { systemPrompt: { append: "Prefer DeskFleet MCP." } },
  })
  assert.equal(seen[2]?.params.systemPrompt, undefined)
  assert.deepEqual(seen[2]?.params._meta, {
    antigravity: { systemPrompt: { append: "Prefer DeskFleet MCP." } },
  })
})
