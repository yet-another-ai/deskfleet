<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AgentActor } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { useAgentActor } from "../../composables/useAgentActor.ts"
const props = defineProps<{ actor: AgentActor }>()
const { t } = useI18n()
const { name } = useAgentActor(() => props.actor)
</script>

<template>
  <span :title="actor.sourceMachine ? t('agent.sourceMachine', { id: actor.sourceMachine.id }) : undefined">{{ name }}</span>
</template>
