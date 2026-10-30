import { useDocumentVisibility } from "@vueuse/core"
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue"
import { sessionIsUnread } from "../services/agent-conversation.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"

/** A mounted conversation acknowledges only completed results it has displayed. */
export function useSessionRead(sessionId: MaybeRefOrGetter<string>): void {
  const agents = useAgentSessionsStore()
  const visibility = useDocumentVisibility()
  const completion = computed(() => {
    const id = toValue(sessionId)
    const view = agents.views[id]
    const session = view?.snapshot?.session
    const seq = session?.lastCompletedSeq
    if (visibility.value === "hidden" || agents.state !== "connected" || !view || view.loading || view.error
      || !seq || !sessionIsUnread(session) || BigInt(view.historySeq) < BigInt(seq)) return undefined
    return seq
  })
  watch([() => toValue(sessionId), completion], ([id, throughSeq]) => {
    if (!throughSeq) return
    // Failed acknowledgements remain in the Session's existing operation retry UI.
    void agents.markRead(id, throughSeq).catch(() => {})
  }, { immediate: true, flush: "post" })
}
