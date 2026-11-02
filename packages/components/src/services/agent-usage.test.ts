import { expect, test } from "vitest"
import { agentEvent, agentInput } from "../test/agent.ts"
import { createAgentUsageSelector, latestAgentUsage, type AgentUsage } from "./agent-usage.ts"

const usageEvent = (seq: number, usage: Omit<AgentUsage, "sessionUpdate">) => agentEvent(seq, "acp", {
  sessionId: "provider-session", update: { sessionUpdate: "usage_update", ...usage },
})

test("usage stays unavailable until the provider reports it", () => {
  expect(latestAgentUsage([])).toBeUndefined()
  expect(latestAgentUsage([
    agentEvent(1, "input", agentInput()),
    agentEvent(2, "acp", { sessionId: "provider-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working" } } }),
  ])).toBeUndefined()
})

test("the latest journal snapshot replaces context and cumulative cost, including decreases after compaction", () => {
  const events = [
    usageEvent(1, { used: 180_000, size: 200_000, cost: { amount: 0.2, currency: "USD" } }),
    usageEvent(2, { used: 20_000, size: 128_000, cost: { amount: 0.25, currency: "USD" } }),
    agentEvent(3, "input", agentInput()),
  ]
  const before = structuredClone(events)
  expect(latestAgentUsage(events)).toEqual({ sessionUpdate: "usage_update", used: 20_000, size: 128_000, cost: { amount: 0.25, currency: "USD" } })
  expect(events).toEqual(before)
})

test("optional cost belongs to the latest snapshot and does not carry over when absent", () => {
  const initial = usageEvent(1, { used: 10_000, size: 200_000, cost: { amount: 0.1, currency: "USD" } })
  expect(latestAgentUsage([initial, usageEvent(2, { used: 11_000, size: 200_000 })])?.cost).toBeUndefined()
  expect(latestAgentUsage([initial, usageEvent(2, { used: 11_000, size: 200_000, cost: null })])?.cost).toBeNull()
  expect(latestAgentUsage([initial, usageEvent(2, { used: 0, size: 200_000, cost: { amount: 0, currency: "EUR" } })])?.cost).toEqual({ amount: 0, currency: "EUR" })
})

test("a long thought stream without usage does not reread historical payloads on append", () => {
  const events = Array.from({ length: 5000 }, (_, index) => agentEvent(index + 1, "acp", {
    sessionId: "provider-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } },
  }))
  const select = createAgentUsageSelector()
  expect(select(events)).toBeUndefined()
  Object.defineProperty(events[0]!, "payload", { get: () => { throw new Error("Historical payload was reread") } })
  events.push(agentEvent(5001, "acp", {
    sessionId: "provider-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " more" } },
  }))
  expect(select(events)).toBeUndefined()
  expect(select(events)).toBeUndefined()
})

test("incremental usage selects the newest appended snapshot including compaction and removed cost", () => {
  const select = createAgentUsageSelector()
  const events = [usageEvent(1, { used: 180_000, size: 200_000, cost: { amount: 0.2, currency: "USD" } })]
  const first = select(events)
  events.push(agentEvent(2, "input", agentInput()))
  expect(select(events)).toBe(first)
  events.push(
    usageEvent(3, { used: 190_000, size: 200_000, cost: { amount: 0.3, currency: "USD" } }),
    usageEvent(4, { used: 20_000, size: 128_000 }),
  )
  expect(select(events)).toEqual({ sessionUpdate: "usage_update", used: 20_000, size: 128_000 })
  expect(select(events)).toEqual(latestAgentUsage(events))
})

test("history replacement, truncation and reconnect can replace or remove cached usage", () => {
  const select = createAgentUsageSelector()
  const first = usageEvent(1, { used: 10_000, size: 200_000 })
  const events = [first, usageEvent(2, { used: 20_000, size: 200_000 })]
  expect(select(events)?.used).toBe(20_000)
  events.pop()
  expect(select(events)?.used).toBe(10_000)
  const replacement = [usageEvent(1, { used: 30_000, size: 200_000 })]
  expect(select(replacement)?.used).toBe(30_000)
  replacement[0] = agentEvent(1, "input", agentInput())
  expect(select(replacement)).toBeUndefined()
  expect(select([first])?.used).toBe(10_000)
  expect(select([])).toBeUndefined()
  expect(select([agentEvent(1, "input", agentInput())])).toBeUndefined()
})
