import type { AgentEvent } from "../../../../apps/daemon/src/agent-protocol.ts"
import { isSubagentNotification } from "../../../client/src/agent-session-scope.ts"

type SessionNotification = Extract<AgentEvent["payload"], { update: unknown }>
export type AgentUsage = Extract<SessionNotification["update"], { sessionUpdate: "usage_update" }>

function usageAfter(events: readonly AgentEvent[], after: number): AgentUsage | undefined {
  for (let index = events.length - 1; index >= after; index--) {
    const event = events[index]!
    if (event.kind === "acp" && "update" in event.payload && !isSubagentNotification(event.payload) && event.payload.update.sessionUpdate === "usage_update") return event.payload.update
  }
  return undefined
}

/** Session usage is a snapshot, projected from the store's committed sequence order. */
export function latestAgentUsage(events: readonly AgentEvent[]): AgentUsage | undefined {
  return usageAfter(events, 0)
}

/** Cache both a reported usage snapshot and its absence across token appends. */
export function createAgentUsageSelector() {
  let source: readonly AgentEvent[] | undefined
  let count = 0
  let last: AgentEvent | undefined
  let usage: AgentUsage | undefined
  return (events: readonly AgentEvent[]): AgentUsage | undefined => {
    // Reconnect/history replacement and truncation can remove the latest usage.
    if (source !== events || events.length < count || events[count - 1] !== last) usage = latestAgentUsage(events)
    else usage = usageAfter(events, count) ?? usage
    source = events
    count = events.length
    last = events[count - 1]
    return usage
  }
}
