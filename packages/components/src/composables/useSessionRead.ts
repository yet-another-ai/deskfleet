import { useDocumentVisibility } from "@vueuse/core"
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue"
import { sessionIsUnread } from "../services/agent-conversation.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"

/** A mounted conversation acknowledges each displayed completion once, so an explicit unread mark stays until it is opened again. */
export function useSessionRead(sessionId: MaybeRefOrGetter<string>): void {
  const agents = useAgentSessionsStore()
  const visibility = useDocumentVisibility()
  const displayedCompletion = computed(() => {
    const id = toValue(sessionId)
    const view = agents.views[id]
    const seq = view?.snapshot?.session.lastCompletedSeq
    if (visibility.value === "hidden" || agents.state !== "connected" || !view || view.loading || view.error
      || !seq || BigInt(view.historySeq) < BigInt(seq)) return undefined
    return seq
  })
  let seen: { id: string; seq: string } | undefined
  watch([() => toValue(sessionId), displayedCompletion], ([id, seq]) => {
    if (!seq || (seen?.id === id && seen.seq === seq)) return
    seen = { id, seq }
    if (!sessionIsUnread(agents.views[id]?.snapshot?.session)) return
    // Failed acknowledgements remain in the Session's existing operation retry UI.
    void agents.markRead(id, seq).catch(() => {})
  }, { immediate: true, flush: "post" })
}
