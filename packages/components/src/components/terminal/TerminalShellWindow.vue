<script setup lang="ts">
import { computed } from "vue"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import LiveTerminal from "./LiveTerminal.vue"

const props = defineProps<{ terminalId: string }>()
const emit = defineEmits<{ title: [title: string] }>()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const readOnly = computed(() => {
  const location = fleet.findTerminal(props.terminalId)
  if (!location?.session) return false
  const session = agents.sessions[location.session.id]
  return (session?.archiveState ?? location.session.archiveState) !== "active"
})
</script>

<template>
  <LiveTerminal class="h-full" :terminal-id="terminalId" :read-only="readOnly" @title="emit('title', $event)" />
</template>
