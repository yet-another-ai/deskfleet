<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentEvent, AgentSnapshot } from "../../../../../../daemon/src/agent-protocol.ts"
import { groupTranscript, projectConversation } from "../../services/agent-conversation.ts"
import AgentResponse from "./AgentResponse.vue"
import AgentUserMessage from "./AgentUserMessage.vue"
const props = defineProps<{ events: AgentEvent[]; snapshot: AgentSnapshot }>()
const { t } = useI18n()
const transcript = computed(() => groupTranscript(projectConversation(props.events, props.snapshot), props.snapshot))
</script>

<template>
  <ol class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')">
    <li v-for="entry in transcript" :key="entry.id" :data-conversation-entry="entry.kind === 'input' ? entry.id : undefined">
      <AgentUserMessage v-if="entry.kind === 'input'" :input="entry.input" />
      <AgentResponse v-else :response="entry" />
    </li>
  </ol>
</template>
