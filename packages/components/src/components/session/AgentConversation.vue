<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { computed, onBeforeUnmount, provide, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentEvent, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { groupTranscript, projectConversation } from "../../services/agent-conversation.ts"
import AgentResponse from "./AgentResponse.vue"
import AgentUserMessage from "./AgentUserMessage.vue"
import type { FileTarget } from "../../../../client/src/files.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"

const client = usePlatformClient()
const props = defineProps<{ events: AgentEvent[]; snapshot: AgentSnapshot; disabled?: boolean; resourceTarget?: FileTarget }>()
const resourceActive = ref(true)
watch([() => props.snapshot.session.id, () => JSON.stringify(props.resourceTarget)], () => { resourceActive.value = true })
const unsubscribe = client.central?.onEvent(event => { if (event.type === "accountChanged") resourceActive.value = false })
onBeforeUnmount(() => unsubscribe?.())
provide(agentResourceContextKey, computed(() => {
  const target = resourceActive.value ? props.resourceTarget : undefined
  return target ? { target, sessionId: props.snapshot.session.id } : undefined
}))
const { t } = useI18n()
const transcript = computed(() => groupTranscript(projectConversation(props.events, props.snapshot), props.snapshot))
const items = useTemplateRef<HTMLLIElement[]>("items")
defineExpose({ items })
</script>

<template>
  <ol class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')">
    <li v-for="entry in transcript" :key="entry.id" ref="items" class="scroll-mt-6" :data-conversation-entry="entry.kind === 'input' ? entry.id : undefined">
      <AgentUserMessage v-if="entry.kind === 'input'" :input="entry.input" />
      <AgentResponse v-else :response="entry" :disabled="disabled" />
    </li>
  </ol>
</template>
