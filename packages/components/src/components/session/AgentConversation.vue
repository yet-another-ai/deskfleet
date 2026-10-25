<script setup lang="ts">
import { computed, provide } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentEvent, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { groupTranscript, projectConversation } from "../../services/agent-conversation.ts"
import AgentResponse from "./AgentResponse.vue"
import AgentUserMessage from "./AgentUserMessage.vue"
import type { FileTarget } from "../../../../client/src/files.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
const props = defineProps<{ events: AgentEvent[]; snapshot: AgentSnapshot; disabled?: boolean; resourceTarget?: FileTarget }>()
provide(agentResourceContextKey, computed(() => props.resourceTarget ? { target: props.resourceTarget, sessionId: props.snapshot.session.id } : undefined))
const { t } = useI18n()
const transcript = computed(() => groupTranscript(projectConversation(props.events, props.snapshot), props.snapshot))
</script>

<template>
  <ol class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')">
    <li v-for="entry in transcript" :key="entry.id" :data-conversation-entry="entry.kind === 'input' ? entry.id : undefined">
      <AgentUserMessage v-if="entry.kind === 'input'" :input="entry.input" />
      <AgentResponse v-else :response="entry" :disabled="disabled" />
    </li>
  </ol>
</template>
