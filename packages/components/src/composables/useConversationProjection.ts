import { computed, toValue, type MaybeRefOrGetter } from "vue"
import type { AgentEvent, AgentSnapshot } from "../../../../apps/daemon/src/agent-protocol.ts"
import { createConversationProjector } from "../services/conversation-projector.ts"

/** One mounted conversation retains its reducer across display commits. */
export function useConversationProjection(
  events: MaybeRefOrGetter<readonly AgentEvent[]>,
  snapshot: MaybeRefOrGetter<AgentSnapshot | null | undefined>,
) {
  const project = createConversationProjector()
  return computed(() => {
    const current = toValue(snapshot)
    return current ? project(toValue(events), current) : []
  })
}
