import { computed, type ComputedRef } from "vue"
import { useAccountSession } from "./useAccountSession.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { sessionFaces, type SessionFace } from "../services/session-faces.ts"

/** Faces for the Session open in this app, using the Team directory for names. */
export function useSessionFaces(sessionId: () => string): ComputedRef<SessionFace[]> {
  const agents = useAgentSessionsStore()
  const account = useAccountSession()
  return computed(() => {
    const id = sessionId()
    const record = agents.views[id]?.snapshot?.session ?? agents.sessions[id]
    return sessionFaces(record?.viewers, agents.sessionPresence[id] ?? [], userId => {
      const user = account?.account.value.user
      const member = user?.id === userId ? user : account?.members.value.find(person => person.userId === userId)
      return { name: member?.name.trim() || member?.email || userId, email: member?.email }
    })
  })
}
