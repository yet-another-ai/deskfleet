<script setup lang="ts">
import { ChevronRight, CircleAlert, CircleX, LoaderCircle } from "@lucide/vue"
import { useIntervalFn, useNow, watchImmediate } from "@vueuse/core"
import { computed, reactive, ref, watch } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { ConversationResponse, ConversationStep } from "../../services/agent-conversation.ts"
import { groupResponseActivity, summarizeTools } from "../../services/agent-conversation.ts"
import { elapsed, formatDuration } from "../../services/agent-format.ts"
import { pendingMermaidLocate, type MermaidLocateRequest } from "../../stores/layout.ts"
import { pendingPreviewLocate, type PreviewLocateRequest } from "../../stores/previews.ts"
import AgentContent from "./AgentContent.vue"
import AgentPlan from "./AgentPlan.vue"
import AgentToolCall from "./AgentToolCall.vue"
import AgentElicitation from "./AgentElicitation.vue"
import AgentActivityGroup from "./AgentActivityGroup.vue"
import AgentMessageActions from "./AgentMessageActions.vue"
const props = defineProps<{ response: ConversationResponse; disabled?: boolean; canFork?: boolean; forkDisabled?: boolean; locateEntry?: string }>()
const emit = defineEmits<{ fork: [] }>()
const { t } = useI18n()
const { now, pause, resume } = useNow({ controls: true, scheduler: callback => useIntervalFn(callback, 1000) })
watchImmediate(() => props.response.live, live => live ? resume() : pause())
const duration = computed(() => {
  const value = elapsed(props.response.startedAt, props.response.live ? now.value.getTime() : props.response.endedAt)
  return value === undefined ? undefined : formatDuration(value)
})
// Fold completed work only when a final assistant message remains visible.
const answer = computed(() => {
  const last = props.response.steps.at(-1)
  return !props.response.live && props.response.turn && last?.kind === "message" && last.role === "assistant" ? last : undefined
})
const text = computed(() => {
  const content = answer.value?.content ?? props.response.steps.flatMap(step => step.kind === "message" && step.role === "assistant" ? step.content : [])
  return content.flatMap(block => block.type === "text" ? [block.text] : block.type === "resource" && "text" in block.resource ? [block.resource.text] : []).join("\n\n")
})
const steps = computed(() => answer.value ? props.response.steps.slice(0, -1) : props.response.steps)
const groupedSteps = computed(() => groupResponseActivity(steps.value))
const endingToolId = computed(() => {
  const last = props.response.steps.at(-1)
  return !props.response.live && props.response.turn && last?.kind === "tool" ? last.id : undefined
})
const activities = reactive(new Map<string, boolean>())
const toggled = ref<boolean | null>(null)
watch(() => props.response.live, () => { toggled.value = null })
const open = computed(() => props.response.steps.some(step => step.kind === "elicitation" && step.elicitation.state === "pending") || !props.response.turn || (toggled.value ?? !answer.value))
const summary = computed(() => props.response.live ? [] : summarizeTools(props.response.steps).map(({ kind, count }) => t(`agent.summary.${kind}`, { n: count }, count)))
const outcome = computed(() => props.response.last && props.response.turn && ["cancelled", "interrupted", "failed"].includes(props.response.turn.state) ? props.response.turn : undefined)
const thoughts = reactive(new Set<string>())
const toggleThought = (id: string) => thoughts.has(id) ? thoughts.delete(id) : thoughts.add(id)

type LocateRequest = PreviewLocateRequest | MermaidLocateRequest | { entryId: string }
const pendingLocate = computed(() => pendingPreviewLocate.value ?? pendingMermaidLocate.value ?? (props.locateEntry ? { entryId: props.locateEntry } : undefined))

function stepMatchesLocate(step: ConversationStep, target: LocateRequest): boolean {
  if (target.entryId) return step.id === target.entryId
  const content = "content" in target ? target.content : "code" in target ? target.code : undefined
  if (content === undefined) return false
  if (step.kind === "message") {
    return step.content.some(block =>
      (block.type === "text" && block.text.includes(content))
      || ((block.type === "image" || block.type === "audio") && `data:${block.mimeType};base64,${block.data}` === content)
      || (block.type === "resource_link" && block.uri === content),
    )
  }
  return false
}

watchImmediate([pendingLocate, steps], ([target, currentSteps]) => {
  if (!target) return
  for (const step of currentSteps) {
    if (!stepMatchesLocate(step, target)) continue
    toggled.value = true
    if (step.kind === "message" && step.role === "thought") thoughts.add(step.id)
    const activity = groupedSteps.value.find(group => group.kind === "activity" && group.steps.some(item => item.id === step.id))
    if (activity) activities.set(activity.id, true)
  }
})
</script>

<template>
  <CollapsibleRoot :open="open" class="group flex flex-col gap-3" @update:open="toggled = $event">
    <template v-if="response.turn">
      <div v-if="response.live" class="flex items-center gap-2 text-ui-text-muted" role="status">
        <LoaderCircle :size="15" :stroke-width="2" class="animate-spin" aria-hidden="true" />
        <span>{{ duration ? t('agent.workingFor', { duration }) : t('agent.working') }}</span>
      </div>
      <CollapsibleTrigger v-else-if="steps.length" type="button" data-turn-work class="group/worked inline-flex cursor-pointer items-center gap-1 self-start text-ui-text-muted hover:text-ui-text">
        <span>{{ duration ? t('agent.workedFor', { duration }) : t('agent.worked') }}</span>
        <ChevronRight :size="15" :stroke-width="2" class="opacity-0 transition-transform group-hover/worked:opacity-100" :class="open && 'rotate-90 opacity-100'" aria-hidden="true" />
      </CollapsibleTrigger>
      <p v-else-if="duration" class="m-0 text-ui-text-muted">{{ t('agent.workedFor', { duration }) }}</p>
    </template>
    <CollapsibleContent v-if="steps.length" class="flex flex-col gap-2" :class="response.turn && !response.live && 'border-l border-ui-border pl-4'">
      <div v-for="step in groupedSteps" :key="step.id" :data-conversation-entry="step.kind === 'activity' ? undefined : step.id">
        <AgentActivityGroup v-if="step.kind === 'activity'" :steps="step.steps" :live="response.live" :last-step-id="steps.at(-1)?.id" :expanded-tool-id="endingToolId" :open="activities.get(step.id) ?? step.steps.some(item => item.id === endingToolId)" @update:open="activities.set(step.id, $event)" />
        <AgentToolCall v-else-if="step.kind === 'tool'" :tool="step.tool" :permission="step.permission" :live="response.live" :default-open="step.id === endingToolId" />
        <AgentPlan v-else-if="step.kind === 'plan'" :entries="step.entries" />
        <AgentElicitation v-else-if="step.kind === 'elicitation'" :elicitation="step.elicitation" :disabled="disabled" />
        <CollapsibleRoot v-else-if="step.role === 'thought'" :open="thoughts.has(step.id)" class="text-sm text-ui-text-muted" @update:open="toggleThought(step.id)">
          <CollapsibleTrigger type="button" class="group/thought inline-flex cursor-pointer items-center gap-1 hover:text-ui-text">
            {{ t('agent.thinking') }}<ChevronRight :size="14" :stroke-width="2" class="opacity-0 transition-transform group-hover/thought:opacity-100" :class="thoughts.has(step.id) && 'rotate-90 opacity-100'" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent><AgentContent :content="step.content" markdown :final="!response.live || step.id !== steps.at(-1)?.id" class="mt-1" /></CollapsibleContent>
        </CollapsibleRoot>
        <AgentContent v-else :content="step.content" markdown :final="!response.live || step.id !== steps.at(-1)?.id" class="py-1" />
      </div>
    </CollapsibleContent>
    <AgentContent v-if="answer" :content="answer.content" markdown :final="true" :data-conversation-entry="answer.id" />
    <p v-if="summary.length" class="m-0 text-ui-text-muted">{{ summary.join(' \u00b7 ') }}</p>
    <div v-if="outcome" class="flex items-start gap-1.5 text-sm" :class="outcome.state === 'failed' ? 'text-ui-danger' : 'text-ui-text-muted'">
      <CircleX v-if="outcome.state === 'failed'" :size="15" :stroke-width="2" class="mt-0.5 shrink-0" aria-hidden="true" />
      <CircleAlert v-else :size="15" :stroke-width="2" class="mt-0.5 shrink-0" aria-hidden="true" />
      <span class="min-w-0 break-words">{{ t(`agent.turnState.${outcome.state}`) }}<template v-if="outcome.error">: {{ outcome.error }}</template></span>
    </div>
    <AgentMessageActions v-if="!response.live" :text="text" :can-fork="canFork" :fork-disabled="forkDisabled || disabled" @fork="emit('fork')" />
  </CollapsibleRoot>
</template>
