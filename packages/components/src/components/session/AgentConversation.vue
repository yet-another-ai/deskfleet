<script setup lang="ts">
import { LoaderCircle } from "@lucide/vue"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { computed, inject, onBeforeUnmount, provide, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentEvent, AgentInput, AgentSnapshot } from "@deskfleet/protocol/agent"
import type { AgentLiveNotice } from "@deskfleet/protocol/agent-live"
import { groupTranscript, liveTurnStates, type ConversationEntry, type ConversationTurn, type TranscriptEntry } from "../../services/agent-conversation.ts"
import { useConversationProjection } from "../../composables/useConversationProjection.ts"
import { useConversationViewport } from "../../composables/useConversationViewport.ts"
import { useTranscriptLocate } from "../../composables/useTranscriptLocate.ts"
import { conversationReadingKey, createConversationReading } from "../../stores/conversation-reading.ts"
import ConversationRowContent from "./ConversationRowContent.vue"
import AgentResponse from "./AgentResponse.vue"
import AgentUserMessage from "./AgentUserMessage.vue"
import AgentLiveNotices from "./AgentLiveNotices.vue"
import type { FileTarget } from "@deskfleet/client/files"
import { agentResourceContextKey } from "../../services/agent-resources.ts"

const client = usePlatformClient()
const props = defineProps<{
  events?: AgentEvent[]
  snapshot?: AgentSnapshot
  sessionId?: string
  projection?: ConversationEntry[]
  turns?: readonly ConversationTurn[]
  startupStatus?: string
  unattributedUserLabel?: string
  optimisticInput?: AgentInput
  notices?: AgentLiveNotice[]
  disabled?: boolean
  resourceTarget?: FileTarget
  canFork?: boolean
  forkDisabled?: boolean
  locateEntry?: string
}>()
const emit = defineEmits<{ fork: []; dismissNotice: [id: string] }>()
const sessionId = computed(() => props.sessionId ?? props.snapshot?.session.id)
const resourceActive = ref(true)
watch([sessionId, () => JSON.stringify(props.resourceTarget)], () => { resourceActive.value = true })
const unsubscribe = client.central?.onEvent(event => { if (event.type === "accountChanged") resourceActive.value = false })
onBeforeUnmount(() => unsubscribe?.())
provide(agentResourceContextKey, computed(() => {
  const target = resourceActive.value ? props.resourceTarget : undefined
  return target && sessionId.value ? { target, sessionId: sessionId.value } : undefined
}))
const { t } = useI18n()
const projection = useConversationProjection(() => props.events ?? [], () => props.snapshot)
const previewing = computed(() => {
  const lastSeq = props.events?.at(-1)?.seq
  return !!lastSeq && BigInt(lastSeq) > BigInt(props.snapshot?.session.lastEventSeq || "0")
})
const transcript = computed<TranscriptEntry[]>(previous =>
  groupTranscript(props.projection ?? projection.value, props.snapshot, previous, { previewing: previewing.value, turns: props.turns }),
)
const optimisticKey = "initial-session-input"
const optimisticSessions = new Set<string>()
const displayedTranscript = computed<TranscriptEntry[]>(() => {
  const base = transcript.value
  if (props.snapshot && !props.snapshot.inputs.length && props.optimisticInput && !base.some(entry => entry.kind === "input")) {
    optimisticSessions.add(props.snapshot.session.id)
    return [...base, { id: "input-optimistic", kind: "input", input: props.optimisticInput }]
  }
  return base
})
function entryKey(entry: TranscriptEntry): string {
  if (entry.kind === "input" && props.snapshot && optimisticSessions.has(props.snapshot.session.id)) {
    if (entry.id === "input-optimistic" || entry.input.id === props.snapshot.inputs[0]?.id) return optimisticKey
  }
  return entry.id
}
const lastInputId = computed(() => displayedTranscript.value.findLast(entry => entry.kind === "input")?.id)
const liveResponseExists = computed(() => displayedTranscript.value.some(entry => entry.kind === "response" && entry.live))
const startupStatus = computed(() => {
  if (liveResponseExists.value) return undefined
  const snapshot = props.snapshot
  if (!snapshot) return props.startupStatus
  if (snapshot.session.archiveState !== "active") return undefined
  if (snapshot.turns.some(turn => liveTurnStates.includes(turn.state))) return t("agent.working")
  if (snapshot.session.lifecycle === "provisioning") return t("agent.lifecycle.provisioning")
  if (snapshot.runs.at(-1)?.state === "starting") return t("agent.runState.starting")
  return undefined
})
const located = useTranscriptLocate(displayedTranscript, sessionId, () => props.locateEntry)
const { observe, printing } = useConversationViewport(() => props.locateEntry)
const reading = inject(conversationReadingKey, undefined)
const fallbackReading = ref(createConversationReading())
watch(sessionId, () => { fallbackReading.value = createConversationReading() })
const readingState = computed(() => reading?.() ?? fallbackReading.value)
provide(conversationReadingKey, () => readingState.value)
// Short histories paint on the first frame. A long history opens without parsing distant rows.
const eager = computed(() => displayedTranscript.value.length < 20)
const canObserve = typeof IntersectionObserver !== "undefined"
const items = useTemplateRef<HTMLLIElement[]>("items")
defineExpose({ items })
</script>

<template>
  <div class="flex flex-col gap-4">
  <slot name="live" />
  <AgentLiveNotices :notices="notices ?? []" @dismiss="emit('dismissNotice', $event)" />
  <ol :key="sessionId" class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')">
    <li v-for="entry in displayedTranscript" :key="entryKey(entry)" ref="items" class="scroll-mt-6"
      :class="{ 'ui-conversation-input': entry.kind === 'input' }"
      :data-conversation-entry="entry.kind === 'input' ? entry.id : undefined">
      <ConversationRowContent :observe="canObserve ? observe : undefined" :eager="eager" :heights="readingState.rowHeights" :row-id="entryKey(entry)" :estimate="entry.kind === 'input' ? 80 : 384"
        :pinned="printing || entry === displayedTranscript.at(-1) || (entry.kind === 'response' && entry.live) || located?.rowId === entry.id">
        <AgentUserMessage v-if="entry.kind === 'input'" :input="entry.input" :disclosure-id="entryKey(entry)" :animate-send="entry.id === lastInputId" :unattributed-label="unattributedUserLabel" />
        <AgentResponse v-else :response="entry" :disabled="disabled" :can-fork="canFork && entry === displayedTranscript.at(-1)" :fork-disabled="forkDisabled" :locate-entry="located?.rowId === entry.id ? located.entryId : undefined" @fork="emit('fork')" />
      </ConversationRowContent>
    </li>
    <li v-if="startupStatus" key="agent-startup-status" data-agent-startup-status class="scroll-mt-6">
      <div class="flex items-center gap-2 text-ui-text-muted" role="status">
        <LoaderCircle :size="16" :stroke-width="2" class="shrink-0 animate-spin" aria-hidden="true" />
        <span class="ui-shimmer-text">{{ startupStatus }}</span>
      </div>
    </li>
  </ol>
  </div>
</template>
