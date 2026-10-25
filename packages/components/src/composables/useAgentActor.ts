import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentActor } from "../../../../apps/daemon/src/agent-protocol.ts"
import { useAccountSession } from "./useAccountSession.ts"

/** Resolve journal actor IDs using the current account and selected Team's directory. */
export function useAgentActor(actor: () => AgentActor) {
  const session = useAccountSession()
  const { t } = useI18n()
  const profile = computed(() => {
    const userId = actor().userId
    if (!userId) return undefined
    const user = session?.account.value.user
    return user?.id === userId ? user : session?.members.value.find(member => member.userId === userId)
  })
  return {
    name: computed(() => profile.value?.name.trim() || profile.value?.email || actor().userId || t(actor().kind === "system" ? "agent.system" : "agent.localUser")),
    email: computed(() => profile.value?.email),
  }
}
