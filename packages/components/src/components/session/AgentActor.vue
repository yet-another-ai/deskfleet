<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { AgentActor } from "../../../../../apps/daemon/src/agent-protocol.ts"
defineProps<{ actor: AgentActor }>()
const { t } = useI18n()
</script>

<template>
  <span :title="actor.sourceMachine ? t('agent.sourceMachine', { id: actor.sourceMachine.id }) : undefined">{{ actor.userId ?? t(actor.kind === 'system' ? 'agent.system' : 'agent.localUser') }}</span>
</template>
