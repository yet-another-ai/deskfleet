import type { AgentEvent } from "../../../../apps/daemon/src/agent-protocol.ts"

type SessionNotification = Extract<AgentEvent["payload"], { update: unknown }>
export type AgentUsage = Extract<SessionNotification["update"], { sessionUpdate: "usage_update" }>

/** Session usage is a snapshot, projected from the store's committed sequence order. */
export function latestAgentUsage(events: readonly AgentEvent[]): AgentUsage | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.kind === "acp" && "update" in event.payload && event.payload.update.sessionUpdate === "usage_update") return event.payload.update
  }
  return undefined
}
