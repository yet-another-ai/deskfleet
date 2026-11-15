import type { AgentEvent } from "../../../../apps/daemon/src/agent-protocol.ts"

// Committed journal events are immutable; a later snapshot never edits them.
let serializedEvents = new WeakMap<AgentEvent, string>()
let memoBytes = 0
export const maxConversationCacheBytes = 32 * 1024 * 1024
const budgetMs = 4

/** Snapshot JSON is captured by the caller before this work can yield. */
export async function serializeConversation(snapshot: string, events: readonly AgentEvent[]): Promise<string | undefined> {
  const parts = new Array<string>(events.length)
  const prefix = `{"snapshot":${snapshot},"events":[`
  let bytes = (prefix.length + 2 + Math.max(0, events.length - 1)) * 2
  function resetMemo(): void { serializedEvents = new WeakMap(); memoBytes = 0 }
  if (bytes > maxConversationCacheBytes) { resetMemo(); return undefined }
  let started = performance.now()
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    let json = serializedEvents.get(event)
    if (json === undefined) {
      json = JSON.stringify(event)
      if (memoBytes + json.length * 2 > maxConversationCacheBytes) resetMemo()
      // An oversized event is rejected below without retaining its encoding.
      if (json.length * 2 <= maxConversationCacheBytes) {
        serializedEvents.set(event, json)
        memoBytes += json.length * 2
      }
    }
    bytes += json.length * 2
    if (bytes > maxConversationCacheBytes) { resetMemo(); return undefined }
    parts[index] = json
    if (index + 1 < events.length && performance.now() - started >= budgetMs) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      started = performance.now()
    }
  }
  return `${prefix}${parts.join(",")}]}`
}
