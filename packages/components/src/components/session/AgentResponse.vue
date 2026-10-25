<script setup lang="ts">
import { ChevronRight, CircleAlert, CircleX, LoaderCircle } from "@lucide/vue"
import { useIntervalFn, useNow, watchImmediate } from "@vueuse/core"
import { computed, reactive, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { ConversationResponse } from "../../services/agent-conversation.ts"
import { summarizeTools } from "../../services/agent-conversation.ts"
import { elapsed, formatDuration } from "../../services/agent-format.ts"
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
</script>

<template>
  <div class="flex flex-col gap-3">
    <template v-if="response.turn">
      <div v-if="response.live" class="flex items-center gap-2 text-ui-text-muted" role="status">
        <LoaderCircle :size="15" :stroke-width="2" class="animate-spin" aria-hidden="true" />
        <span>{{ duration ? t('agent.workingFor', { duration }) : t('agent.working') }}</span>
      </div>
      <button v-else-if="steps.length" type="button" data-turn-work class="group/worked inline-flex cursor-pointer items-center gap-1 self-start text-ui-text-muted hover:text-ui-text" :aria-expanded="open" @click="toggled = !open">
        <span>{{ duration ? t('agent.workedFor', { duration }) : t('agent.worked') }}</span>
        <ChevronRight :size="15" :stroke-width="2" class="opacity-0 transition-transform group-hover/worked:opacity-100" :class="open && 'rotate-90 opacity-100'" aria-hidden="true" />
      </button>
      <p v-else-if="duration" class="m-0 text-ui-text-muted">{{ t('agent.workedFor', { duration }) }}</p>
    </template>
    <div v-if="open && steps.length" class="flex flex-col gap-2" :class="response.turn && !response.live && 'border-l border-ui-border pl-4'">
      <div v-for="step in steps" :key="step.id" :data-conversation-entry="step.id">
        <AgentToolCall v-if="step.kind === 'tool'" :tool="step.tool" :permission="step.permission" :live="response.live" />
        <AgentPlan v-else-if="step.kind === 'plan'" :entries="step.entries" />
        <AgentElicitation v-else-if="step.kind === 'elicitation'" :elicitation="step.elicitation" :disabled="disabled" />
        <div v-else-if="step.role === 'thought'" class="text-sm text-ui-text-muted">
          <button type="button" class="group/thought inline-flex cursor-pointer items-center gap-1 hover:text-ui-text" :aria-expanded="thoughts.has(step.id)" @click="toggleThought(step.id)">
            {{ t('agent.thinking') }}<ChevronRight :size="14" :stroke-width="2" class="opacity-0 transition-transform group-hover/thought:opacity-100" :class="thoughts.has(step.id) && 'rotate-90 opacity-100'" aria-hidden="true" />
          </button>
          <AgentContent v-if="thoughts.has(step.id)" :content="step.content" markdown class="mt-1" />
        </div>
        <AgentContent v-else :content="step.content" markdown class="py-1" />
      </div>
    </div>
    <AgentContent v-if="answer" :content="answer.content" markdown :data-conversation-entry="answer.id" />
    <p v-if="summary.length" class="m-0 text-ui-text-muted">{{ summary.join(' · ') }}</p>
    <div v-if="outcome" class="flex items-start gap-1.5 text-sm" :class="outcome.state === 'failed' ? 'text-ui-danger' : 'text-ui-text-muted'">
      <CircleX v-if="outcome.state === 'failed'" :size="15" :stroke-width="2" class="mt-0.5 shrink-0" aria-hidden="true" />
      <CircleAlert v-else :size="15" :stroke-width="2" class="mt-0.5 shrink-0" aria-hidden="true" />
      <span class="min-w-0 break-words">{{ t(`agent.turnState.${outcome.state}`) }}<template v-if="outcome.error">: {{ outcome.error }}</template></span>
    </div>
  </div>
</template>
