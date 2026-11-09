import { ref } from "vue"
import type { AgentAuthStatus, AgentLiveNotice, AgentLiveUpdate } from "../../../client/src/agent-live.ts"

/** Viewer-local, dismissible notices and the connected provider's latest identity. */
export function useAgentLiveState() {
  const notices = ref<Record<string, AgentLiveNotice[]>>({})
  const authStatuses = ref<Record<string, AgentAuthStatus>>({})
  const generations = new Map<string, number>()

  function receive(update: AgentLiveUpdate): void {
    if (update.runGeneration < (generations.get(update.sessionId) ?? 0)) return
    if (update.runGeneration !== generations.get(update.sessionId)) {
      remove(update.sessionId)
      generations.set(update.sessionId, update.runGeneration)
    }
    if (update.kind === "notice") {
      // Notices are live hints. Bound a noisy provider without retaining a second history.
      notices.value[update.sessionId] = [...notices.value[update.sessionId] ?? [], update.notice].slice(-20)
    } else if (update.auth) authStatuses.value[update.sessionId] = update.auth
    else delete authStatuses.value[update.sessionId]
  }

  function dismiss(sessionId: string, id: string): void {
    notices.value[sessionId] = (notices.value[sessionId] ?? []).filter(notice => notice.id !== id)
  }

  function remove(sessionId: string): void {
    delete notices.value[sessionId]
    delete authStatuses.value[sessionId]
    generations.delete(sessionId)
  }

  function clear(): void { notices.value = {}; authStatuses.value = {}; generations.clear() }
  return { notices, authStatuses, receive, dismiss, remove, clear }
}
