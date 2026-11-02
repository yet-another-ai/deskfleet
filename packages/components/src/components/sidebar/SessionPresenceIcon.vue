<script setup lang="ts">
import { computed } from "vue"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { sessionFaces } from "../../services/session-faces.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import UserAvatarStack from "../common/UserAvatarStack.vue"

const props = defineProps<{ sessionId: string; machineId?: string }>()
const runtimes = useMachineRuntimes()
const account = useAccountSession()
const host = useAgentSessionsStore()
const agents = computed(() => {
  const state = props.machineId ? runtimes?.opened.get(props.machineId)?.state : undefined
  if (state) return useAgentSessionsStore(state)
  // Another machine's catalog can reuse Session IDs. Only the open connection knows who is there.
  if (props.machineId && account && account.machineId.value !== props.machineId) return undefined
  return host
})
const active = computed(() => !agents.value ? [] : sessionFaces(
  agents.value.views[props.sessionId]?.snapshot?.session.viewers ?? agents.value.sessions[props.sessionId]?.viewers,
  agents.value.sessionPresence[props.sessionId] ?? [],
  userId => {
    const user = account?.account.value.user
    const member = user?.id === userId ? user : account?.members.value.find(person => person.userId === userId)
    return { name: member?.name.trim() || member?.email || userId, email: member?.email }
  },
).filter(person => person.active))
</script>

<template>
  <UserAvatarStack v-if="active.length" :people="active" :size="16" :limit="3" surface="sidebar" />
  <slot v-else />
</template>
