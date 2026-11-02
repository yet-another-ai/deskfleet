<script setup lang="ts">
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { computed, onBeforeUnmount, provide, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentEvent, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { groupTranscript, type ConversationEntry, type TranscriptEntry } from "../../services/agent-conversation.ts"
import { useConversationProjection } from "../../composables/useConversationProjection.ts"
import AgentResponse from "./AgentResponse.vue"
import AgentUserMessage from "./AgentUserMessage.vue"
import type { FileTarget } from "../../../../client/src/files.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"

const client = usePlatformClient()
const props = defineProps<{ events: AgentEvent[]; snapshot: AgentSnapshot; projection?: ConversationEntry[]; disabled?: boolean; resourceTarget?: FileTarget; canFork?: boolean; forkDisabled?: boolean; locateEntry?: string }>()
const emit = defineEmits<{ fork: [] }>()
const resourceActive = ref(true)
watch([() => props.snapshot.session.id, () => JSON.stringify(props.resourceTarget)], () => { resourceActive.value = true })
const unsubscribe = client.central?.onEvent(event => { if (event.type === "accountChanged") resourceActive.value = false })
onBeforeUnmount(() => unsubscribe?.())
provide(agentResourceContextKey, computed(() => {
  const target = resourceActive.value ? props.resourceTarget : undefined
  return target ? { target, sessionId: props.snapshot.session.id } : undefined
}))
const { t } = useI18n()
const projection = useConversationProjection(() => props.events, () => props.snapshot)
const transcript = computed<TranscriptEntry[]>(previous => groupTranscript(props.projection ?? projection.value, props.snapshot, previous))
const items = useTemplateRef<HTMLLIElement[]>("items")
defineExpose({ items })
</script>

<template>
  <ol class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')">
    <li v-for="entry in transcript" :key="entry.id" ref="items" class="scroll-mt-6"
      :class="{
        'ui-conversation-history': entry !== transcript.at(-1) && (entry.kind === 'input' ? entry.id !== locateEntry : !entry.live && !entry.steps.some(step => step.id === locateEntry)),
        'ui-conversation-input': entry.kind === 'input',
      }"
      :data-conversation-entry="entry.kind === 'input' ? entry.id : undefined">
      <AgentUserMessage v-if="entry.kind === 'input'" :input="entry.input" />
      <AgentResponse v-else :response="entry" :disabled="disabled" :can-fork="canFork && entry === transcript.at(-1)" :fork-disabled="forkDisabled" :locate-entry="locateEntry" @fork="emit('fork')" />
    </li>
  </ol>
</template>

<style scoped>
/* Keep historical DOM and component state, but let the browser skip rendering
   distant rows. The remembered size preserves scrollback after a row is seen.
   Live/latest responses and explicitly located entries always render immediately. */
.ui-conversation-history {
  content-visibility: auto;
  contain-intrinsic-block-size: auto 24rem;
}
.ui-conversation-history.ui-conversation-input {
  contain-intrinsic-block-size: auto 5rem;
}
@media print {
  .ui-conversation-history { content-visibility: visible; }
}
</style>
