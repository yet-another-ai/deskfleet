import { expect, test } from "vitest"
import { agentEvent, agentInput } from "../test/agent.ts"
import { latestAgentUsage, type AgentUsage } from "./agent-usage.ts"

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
