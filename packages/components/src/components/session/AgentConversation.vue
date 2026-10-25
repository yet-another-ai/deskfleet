<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import { computed, onBeforeUnmount, provide, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentEvent, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { groupTranscript, projectConversation } from "../../services/agent-conversation.ts"
import AgentResponse from "./AgentResponse.vue"
import AgentUserMessage from "./AgentUserMessage.vue"
import type { FileTarget } from "../../../../client/src/files.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
const props = defineProps<{ events: AgentEvent[]; snapshot: AgentSnapshot; disabled?: boolean; resourceTarget?: FileTarget }>()
const authorizedTarget = ref<FileTarget>()
const authorizing = ref(false)
const authorizationError = ref<string>()
const needsAuthorization = computed(() => props.resourceTarget?.kind === "local" && !!client.files?.authorizeLocalSession)
let generation = 0
function resetAuthorization(): void {
  ++generation; authorizedTarget.value = undefined; authorizationError.value = undefined; authorizing.value = false
}
watch([() => props.snapshot.session.id, () => JSON.stringify(props.resourceTarget)], resetAuthorization)
const unsubscribe = client.central?.onEvent(event => { if (event.type === "accountChanged") resetAuthorization() })
onBeforeUnmount(() => { ++generation; unsubscribe?.() })
provide(agentResourceContextKey, computed(() => {
  const target = needsAuthorization.value ? authorizedTarget.value : props.resourceTarget
  return target ? { target, sessionId: props.snapshot.session.id } : undefined
}))
async function authorize(): Promise<void> {
  const request = client.files?.authorizeLocalSession
  if (!request || authorizing.value) return
  const current = ++generation
  authorizing.value = true; authorizationError.value = undefined
  try {
    const target = await request(props.snapshot.session.id)
    if (current === generation && target?.kind === "local") authorizedTarget.value = target
  } catch (error) {
    if (current === generation) authorizationError.value = error instanceof Error ? error.message : String(error)
  } finally { if (current === generation) authorizing.value = false }
}
const { t } = useI18n()
const transcript = computed(() => groupTranscript(projectConversation(props.events, props.snapshot), props.snapshot))
</script>

<template>
  <div v-if="needsAuthorization && !authorizedTarget" class="mb-3 flex flex-col items-start gap-2">
    <button type="button" class="ui-button" :disabled="authorizing" @click="authorize">{{ t('files.allowLocalPreviews') }}</button>
    <p v-if="authorizationError" class="m-0 text-sm text-ui-danger" role="alert">{{ authorizationError }}</p>
  </div>
  <ol class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')">
    <li v-for="entry in transcript" :key="entry.id" :data-conversation-entry="entry.kind === 'input' ? entry.id : undefined">
      <AgentUserMessage v-if="entry.kind === 'input'" :input="entry.input" />
      <AgentResponse v-else :response="entry" :disabled="disabled" />
    </li>
  </ol>
</template>
