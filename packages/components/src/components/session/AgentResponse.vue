<script setup lang="ts">
import { ChevronRight, CircleAlert, CircleX, LoaderCircle } from "@lucide/vue"
import { useIntervalFn, useNow, watchImmediate } from "@vueuse/core"
import { computed, reactive, ref, watch } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { ConversationResponse, ConversationStep } from "../../services/agent-conversation.ts"
import { summarizeTools } from "../../services/agent-conversation.ts"
import { elapsed, formatDuration } from "../../services/agent-format.ts"
import { pendingMermaidLocate, type MermaidLocateRequest } from "../../stores/layout.ts"
import AgentContent from "./AgentContent.vue"
import AgentPlan from "./AgentPlan.vue"
import AgentToolCall from "./AgentToolCall.vue"
import AgentElicitation from "./AgentElicitation.vue"
const props = defineProps<{ response: ConversationResponse; disabled?: boolean }>()
const { t } = useI18n()
const { now, pause, resume } = useNow({ controls: true, scheduler: callback => useIntervalFn(callback, 1000) })
watchImmediate(() => props.response.live, live => live ? resume() : pause())
const duration = computed(() => {
  const value = elapsed(props.response.startedAt, props.response.live ? now.value.getTime() : props.response.endedAt)
  return value === undefined ? undefined : formatDuration(value)
})
// A finished response leads with its final message; the work behind it folds away.
const answer = computed(() => {
  const last = props.response.steps.at(-1)
  return !props.response.live && props.response.turn && last?.kind === "message" && last.role === "assistant" ? last : undefined
})
const steps = computed(() => answer.value ? props.response.steps.slice(0, -1) : props.response.steps)
const toggled = ref<boolean | null>(null)
watch(() => props.response.live, () => { toggled.value = null })
const open = computed(() => props.response.steps.some(step => step.kind === "elicitation" && step.elicitation.state === "pending") || !props.response.turn || (toggled.value ?? props.response.live))
const summary = computed(() => props.response.live ? [] : summarizeTools(props.response.steps).map(({ kind, count }) => t(`agent.summary.${kind}`, { n: count }, count)))
const outcome = computed(() => props.response.last && props.response.turn && ["cancelled", "interrupted", "failed"].includes(props.response.turn.state) ? props.response.turn : undefined)
const thoughts = reactive(new Set<string>())
const toggleThought = (id: string) => thoughts.has(id) ? thoughts.delete(id) : thoughts.add(id)

function stepMatchesLocate(step: ConversationStep, target: MermaidLocateRequest): boolean {
  if (target.entryId) return step.id === target.entryId
  if (step.kind === "message") {
    return step.content.some(block => block.type === "text" && block.text.includes(target.code))
  }
  return false
}

watchImmediate([pendingMermaidLocate, steps], ([target, currentSteps]) => {
  if (!target) return
  for (const step of currentSteps) {
    if (!stepMatchesLocate(step, target)) continue
    toggled.value = true
    if (step.kind === "message" && step.role === "thought") thoughts.add(step.id)
  }
})
</script>

<template>
  <CollapsibleRoot :open="open" class="flex flex-col gap-3" @update:open="toggled = $event">
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
      <div v-for="(step, idx) in steps" :key="step.id" :data-conversation-entry="step.id">
        <AgentToolCall v-if="step.kind === 'tool'" :tool="step.tool" :permission="step.permission" :live="response.live" />
        <AgentPlan v-else-if="step.kind === 'plan'" :entries="step.entries" />
        <AgentElicitation v-else-if="step.kind === 'elicitation'" :elicitation="step.elicitation" :disabled="disabled" />
        <CollapsibleRoot v-else-if="step.role === 'thought'" :open="thoughts.has(step.id)" class="text-sm text-ui-text-muted" @update:open="toggleThought(step.id)">
          <CollapsibleTrigger type="button" class="group/thought inline-flex cursor-pointer items-center gap-1 hover:text-ui-text">
            {{ t('agent.thinking') }}<ChevronRight :size="14" :stroke-width="2" class="opacity-0 transition-transform group-hover/thought:opacity-100" :class="thoughts.has(step.id) && 'rotate-90 opacity-100'" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent><AgentContent :content="step.content" markdown :final="!response.live || idx < steps.length - 1" class="mt-1" /></CollapsibleContent>
        </CollapsibleRoot>
        <AgentContent v-else :content="step.content" markdown :final="!response.live || idx < steps.length - 1" class="py-1" />
      </div>
    </CollapsibleContent>
    <AgentContent v-if="answer" :content="answer.content" markdown :final="true" :data-conversation-entry="answer.id" />
    <p v-if="summary.length" class="m-0 text-ui-text-muted">{{ summary.join(' \u00b7 ') }}</p>
    <div v-if="outcome" class="flex items-start gap-1.5 text-sm" :class="outcome.state === 'failed' ? 'text-ui-danger' : 'text-ui-text-muted'">
      <CircleX v-if="outcome.state === 'failed'" :size="15" :stroke-width="2" class="mt-0.5 shrink-0" aria-hidden="true" />
      <CircleAlert v-else :size="15" :stroke-width="2" class="mt-0.5 shrink-0" aria-hidden="true" />
      <span class="min-w-0 break-words">{{ t(`agent.turnState.${outcome.state}`) }}<template v-if="outcome.error">: {{ outcome.error }}</template></span>
    </div>
  </CollapsibleRoot>
</template>
