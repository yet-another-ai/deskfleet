import { expect, test, vi } from "vitest"
import { agentEvent, agentInput, agentSnapshot } from "../test/agent.ts"
import { maxConversationCacheBytes, serializeConversation } from "./conversation-cache-serializer.ts"

test("serializes complete conversation JSON and reuses only immutable event encodings", async () => {
  const snapshot = agentSnapshot()
  const first = agentEvent(1, "input", agentInput({ content: [{ type: "text", text: 'Unicode 你好, quotes " and a newline\n' }] }))
  const second = agentEvent(2, "input", agentInput({ id: "41" }))
  const stringify = vi.spyOn(JSON, "stringify")
  const initial = await serializeConversation(JSON.stringify(snapshot), [first])
  snapshot.session.lastEventSeq = "2"
  const appended = await serializeConversation(JSON.stringify(snapshot), [first, second])

  expect(JSON.parse(initial!)).toEqual({ snapshot: { ...snapshot, session: { ...snapshot.session, lastEventSeq: "0" } }, events: [first] })
  expect(JSON.parse(appended!)).toEqual({ snapshot, events: [first, second] })
  expect(stringify.mock.calls.filter(([value]) => value === first)).toHaveLength(1)
  expect(stringify.mock.calls.filter(([value]) => value === second)).toHaveLength(1)

  // A corrected event with the same sequence is a new journal object.
  const corrected = { ...first, payload: agentInput({ content: [{ type: "text", text: "authoritative" }] }) }
  expect(JSON.parse((await serializeConversation(JSON.stringify(snapshot), [corrected]))!).events).toEqual([corrected])
})

test("cold serialization yields between event batches without changing order or contents", async () => {
  vi.useFakeTimers()
  let now = 0
  vi.spyOn(performance, "now").mockImplementation(() => { now += 3; return now })
  try {
    const snapshot = agentSnapshot()
    const events = Array.from({ length: 8 }, (_, index) => agentEvent(index + 1, "input", agentInput({ id: String(index) })))
    let finished = false
    const pending = serializeConversation(JSON.stringify(snapshot), events).then(json => { finished = true; return json })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await vi.runAllTimersAsync()
    expect(JSON.parse((await pending)!)).toEqual({ snapshot, events })
  } finally { vi.useRealTimers() }
})

test("oversized histories stop encoding early and release the event memo", async () => {
  const snapshot = JSON.stringify(agentSnapshot())
  const first = agentEvent(1, "input", agentInput())
  const oversized = agentEvent(2, "input", agentInput({ content: [{ type: "text", text: "x".repeat(maxConversationCacheBytes / 2) }] }))
  const unvisited = agentEvent(3, "input", agentInput())
  const stringify = vi.spyOn(JSON, "stringify")
  await serializeConversation(snapshot, [first])
  expect(await serializeConversation(snapshot, [first, oversized, unvisited])).toBeUndefined()
  expect(stringify.mock.calls.filter(([value]) => value === unvisited)).toHaveLength(0)
  await serializeConversation(snapshot, [first])
  expect(stringify.mock.calls.filter(([value]) => value === first)).toHaveLength(2)
})

test("an empty journal preserves the existing cache JSON shape", async () => {
  const snapshot = agentSnapshot()
  expect(await serializeConversation(JSON.stringify(snapshot), [])).toBe(JSON.stringify({ snapshot, events: [] }))
})
