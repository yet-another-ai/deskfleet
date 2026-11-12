<script setup lang="ts">
import { LoaderCircle } from "@lucide/vue"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { computed, onBeforeUnmount, provide, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentEvent, AgentInput, AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { AgentLiveNotice } from "@deskfleet/client/agent-live"
import { containsConversationEntry, groupTranscript, liveTurnStates, type ConversationEntry, type TranscriptEntry } from "../../services/agent-conversation.ts"
import { useConversationProjection } from "../../composables/useConversationProjection.ts"
import AgentResponse from "./AgentResponse.vue"
import AgentUserMessage from "./AgentUserMessage.vue"
import AgentLiveNotices from "./AgentLiveNotices.vue"
import type { FileTarget } from "../../../../client/src/files.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"

const client = usePlatformClient()
const props = defineProps<{ events: AgentEvent[]; snapshot: AgentSnapshot; projection?: ConversationEntry[]; optimisticInput?: AgentInput; notices?: AgentLiveNotice[]; disabled?: boolean; resourceTarget?: FileTarget; canFork?: boolean; forkDisabled?: boolean; locateEntry?: string }>()
const emit = defineEmits<{ fork: []; dismissNotice: [id: string] }>()
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
const optimisticKey = "initial-session-input"
const optimisticSessions = new Set<string>()
const displayedTranscript = computed<TranscriptEntry[]>(() => {
  const base = transcript.value
  if (!props.snapshot.inputs.length && props.optimisticInput && !base.some(entry => entry.kind === "input")) {
    optimisticSessions.add(props.snapshot.session.id)
    return [...base, { id: "input-optimistic", kind: "input", input: props.optimisticInput }]
  }
  return base
})
function entryKey(entry: TranscriptEntry): string {
  if (entry.kind === "input" && optimisticSessions.has(props.snapshot.session.id)) {
    if (entry.id === "input-optimistic" || entry.input.id === props.snapshot.inputs[0]?.id) return optimisticKey
  }
  return entry.id
}
const lastInputId = computed(() => displayedTranscript.value.findLast(entry => entry.kind === "input")?.id)
const liveResponseExists = computed(() => displayedTranscript.value.some(entry => entry.kind === "response" && entry.live))
const activeTurn = computed(() => props.snapshot.turns.find(turn => liveTurnStates.includes(turn.state)))
const latestRun = computed(() => props.snapshot.runs.at(-1))
const startupStatus = computed(() => {
  if (props.snapshot.session.archiveState !== "active" || liveResponseExists.value) return undefined
  if (activeTurn.value) return t("agent.working")
  if (props.snapshot.session.lifecycle === "provisioning") return t("agent.lifecycle.provisioning")
  if (latestRun.value?.state === "starting") return t("agent.runState.starting")
  return undefined
})
const items = useTemplateRef<HTMLLIElement[]>("items")
defineExpose({ items })
</script>

<template>
  <div class="flex flex-col gap-4">
  <slot name="live" />
  <AgentLiveNotices :notices="notices ?? []" @dismiss="emit('dismissNotice', $event)" />
  <ol class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')">
    <li v-for="entry in displayedTranscript" :key="entryKey(entry)" ref="items" class="scroll-mt-6"
      :class="{
        'ui-conversation-history': entry !== displayedTranscript.at(-1) && (entry.kind === 'input' ? entry.id !== locateEntry : !entry.live && !entry.steps.some(step => locateEntry && containsConversationEntry(step, locateEntry))),
        'ui-conversation-input': entry.kind === 'input',
      }"
      :data-conversation-entry="entry.kind === 'input' ? entry.id : undefined">
      <AgentUserMessage v-if="entry.kind === 'input'" :input="entry.input" :animate-send="entry.id === lastInputId" />
      <AgentResponse v-else :response="entry" :disabled="disabled" :can-fork="canFork && entry === displayedTranscript.at(-1)" :fork-disabled="forkDisabled" :locate-entry="locateEntry" @fork="emit('fork')" />
    </li>
    <li v-if="startupStatus" key="agent-startup-status" data-agent-startup-status class="scroll-mt-6">
      <div class="flex items-center gap-2 text-ui-text-muted" role="status">
        <LoaderCircle :size="15" :stroke-width="2" class="animate-spin" aria-hidden="true" />
        <span class="ui-shimmer-text">{{ startupStatus }}</span>
      </div>
    </li>
  </ol>
  </div>
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
