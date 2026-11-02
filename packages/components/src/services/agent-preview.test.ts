import { expect, test } from "vitest"
import type { AgentEventDraft, AgentPreview } from "../../../../apps/daemon/src/agent-protocol.ts"
import { AgentPreviews } from "./agent-preview.ts"

function draft(text: string, sessionId = "session"): AgentEventDraft {
  return { sessionId, kind: "acp", createdAt: "now", runGeneration: 1, turnId: "turn", payload: {
    sessionId: "provider", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
  } }
}
function preview(events: AgentEventDraft[], values: Partial<AgentPreview> = {}): AgentPreview {
  return { sessionId: "session", streamId: "stream", baseSeq: "10", offset: 0, events, ...values }
}

test("contiguous and overlapping preview fragments append once without changing the source drafts", () => {
  const tails = new AgentPreviews()
  const a = draft("a"), b = draft("b"), c = draft("c")
  expect(tails.receive(preview([a, b]))).toBe(true)
  const first = tails.after("session", "10")
  expect(first.map(event => event.seq)).toEqual(["11", "12"])
  expect(tails.receive(preview([a, b]))).toBe(false)
  expect(tails.receive(preview([b, c], { offset: 1 }))).toBe(true)
  expect(tails.after("session", "0").map(event => event.seq)).toEqual(["11", "12", "13"])
  expect(tails.after("session", "12")).toEqual([{ ...c, seq: "13" }])
  expect(tails.after("session", "99")).toEqual([])
  expect(first).toHaveLength(2)
  expect(a).not.toHaveProperty("seq")
})

test("partial durable coverage keeps only the uncovered tail visible until the complete stream is committed", () => {
  const tails = new AgentPreviews()
  tails.receive(preview([draft("a"), draft("b"), draft("c")]))
  tails.committed("session", "11")
  expect(tails.has("session")).toBe(true)
  expect(tails.after("session", "11").map(event => event.seq)).toEqual(["12", "13"])
  // Offset continuity is measured from the original stream, including its durable prefix.
  expect(tails.receive(preview([draft("d")], { offset: 3 }))).toBe(true)
  tails.committed("session", "13")
  expect(tails.after("session", "13").map(event => event.seq)).toEqual(["14"])
  tails.committed("session", "14")
  expect(tails.has("session")).toBe(false)
  expect(tails.after("session", "0")).toEqual([])
})

test("display sequence arithmetic preserves durable bases beyond the safe integer limit", () => {
  const tails = new AgentPreviews()
  tails.receive(preview([draft("a"), draft("b")], { baseSeq: "9007199254740992" }))
  expect(tails.after("session", "9007199254740992").map(event => event.seq)).toEqual(["9007199254740993", "9007199254740994"])
  tails.committed("session", "9007199254740993")
  expect(tails.has("session")).toBe(true)
  expect(tails.after("session", "9007199254740993").map(event => event.seq)).toEqual(["9007199254740994"])
  tails.committed("session", "9007199254740994")
  expect(tails.has("session")).toBe(false)
})

test("stream rollover and per-session cleanup do not mix text from independent preview tails", () => {
  const tails = new AgentPreviews()
  tails.receive(preview([draft("old")]))
  tails.receive(preview([draft("other", "other")], { sessionId: "other", streamId: "other-stream" }))
  tails.receive(preview([draft("new")], { streamId: "next-window", baseSeq: "11" }))
  expect(tails.after("session", "0")).toEqual([{ ...draft("new"), seq: "12" }])
  tails.delete("session")
  expect(tails.ids()).toEqual(["other"])
  expect(tails.after("session", "0")).toEqual([])
  expect(tails.after("other", "0")).toEqual([{ ...draft("other", "other"), seq: "11" }])
})

test("missing beginning or a missing fragment fails without accepting an incomplete tail", () => {
  const tails = new AgentPreviews()
  expect(() => tails.receive(preview([draft("late")], { offset: 1 }))).toThrow("missing its beginning")
  expect(tails.ids()).toEqual([])
  tails.receive(preview([draft("first")]))
  expect(() => tails.receive(preview([draft("gap")], { offset: 2 }))).toThrow("missing fragment")
  expect(() => tails.receive(preview([draft("new gap")], { streamId: "next", offset: 1 }))).toThrow("missing its beginning")
  expect(tails.after("session", "0")).toEqual([{ ...draft("first"), seq: "11" }])
})
