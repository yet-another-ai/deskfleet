<script setup lang="ts">
import { ChevronRight, CircleX, Layers, LoaderCircle } from "@lucide/vue"
import { computed } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { ConversationActivityStep } from "../../services/agent-conversation.ts"
import AgentContent from "./AgentContent.vue"
import AgentToolCall from "./AgentToolCall.vue"

const props = defineProps<{ steps: ConversationActivityStep[]; live: boolean; lastStepId?: string; expandedToolId?: string }>()
const open = defineModel<boolean>("open", { default: false })
const { t } = useI18n()
const tools = computed(() => props.steps.filter(step => step.kind === "tool"))
const summary = computed(() => {
  const toolCount = tools.value.length
  const thoughtCount = props.steps.length - toolCount
  return [
    toolCount ? t("agent.activity.tools", { n: toolCount }, toolCount) : undefined,
    thoughtCount ? t("agent.activity.thoughts", { n: thoughtCount }, thoughtCount) : undefined,
  ].filter(Boolean).join(" · ")
})
const running = computed(() => props.live && tools.value.some(step => step.tool.status === "pending" || step.tool.status === "in_progress"))
const awaitingApproval = computed(() => tools.value.some(step => step.permission?.state === "pending"))
const failed = computed(() => tools.value.some(step => step.tool.status === "failed"))
</script>

<template>
  <CollapsibleRoot v-model:open="open" :data-activity-group="steps[0]?.id" class="text-sm text-ui-text-muted">
    <CollapsibleTrigger type="button" data-activity-trigger class="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1 text-left hover:bg-ui-hover hover:text-ui-text">
      <Layers :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
      <span>{{ summary }}</span>
      <LoaderCircle v-if="running" :size="14" :stroke-width="2" class="shrink-0 animate-spin" :aria-label="t('agent.toolStatus.in_progress')" />
      <span v-if="awaitingApproval" class="ui-badge text-ui-warning">{{ t('agent.awaitingApproval') }}</span>
      <span v-if="failed" class="inline-flex items-center gap-1 text-xs text-ui-danger"><CircleX :size="14" :stroke-width="2" aria-hidden="true" />{{ t('agent.toolStatus.failed') }}</span>
      <ChevronRight :size="14" :stroke-width="2" class="shrink-0 transition-transform" :class="open && 'rotate-90'" aria-hidden="true" />
    </CollapsibleTrigger>
    <CollapsibleContent class="mt-2 ml-1.5 flex flex-col gap-2 border-l border-ui-border pl-4">
      <div v-for="step in steps" :key="step.id" :data-conversation-entry="step.id">
        <AgentToolCall v-if="step.kind === 'tool'" :tool="step.tool" :permission="step.permission" :live="live" :default-open="step.id === expandedToolId" />
        <template v-else>
          <div class="text-xs">{{ t('agent.thinking') }}</div>
          <AgentContent :content="step.content" markdown :final="!live || step.id !== lastStepId" class="mt-1" />
        </template>
      </div>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
