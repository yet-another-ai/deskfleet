<script setup lang="ts">
import { ArrowRight, Bot, ChevronRight, CircleAlert, CircleCheck, Layers, LoaderCircle, MessageSquare } from "@lucide/vue"
import { computed } from "vue"
import { watchImmediate } from "@vueuse/core"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import { containsConversationEntry, type ConversationStep } from "../../services/agent-conversation.ts"
import { useConversationDisclosure } from "../../stores/conversation-reading.ts"
import AgentContent from "./AgentContent.vue"
import AgentPlan from "./AgentPlan.vue"
import AgentToolCall from "./AgentToolCall.vue"
import AgentElicitation from "./AgentElicitation.vue"
import AgentResourceLink from "./AgentResourceLink.vue"

const props = defineProps<{ step: ConversationStep; live?: boolean; disabled?: boolean; sessionLabels?: Record<string, string>; locateEntry?: string }>()
const { t } = useI18n()
const toggled = useConversationDisclosure(() => `protocol:${props.step.id}`)
const open = computed(() => toggled.value ?? (props.step.kind === "subagent"
  ? props.step.session.state?.state !== "idle" : props.step.kind === "compaction" && props.step.compaction.status === "failed"))
const childState = computed(() => props.step.kind === "subagent" && props.step.session.state?.state || "unknown")
const childStateKey = computed(() => ["running", "idle", "requires_action"].includes(childState.value) ? childState.value : "unknown")
const compactionStateKey = computed(() => props.step.kind === "compaction" && ["in_progress", "completed", "failed", "cancelled"].includes(props.step.compaction.status) ? props.step.compaction.status : "unknown")
const childLive = computed(() => props.step.kind === "subagent" && props.step.session.state?.state === "running")
const childError = computed(() => {
  if (props.step.kind !== "subagent") return undefined
  const state = props.step.session.state
  const error = state && "error" in state ? state.error : undefined
  return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : undefined
})
const label = (id: string | null | undefined) => id && props.sessionLabels?.[id] || t("agent.protocol.session")
watchImmediate([() => props.locateEntry, () => props.step], ([id, step]) => {
  if (id && containsConversationEntry(step, id)) toggled.value = true
})
</script>

<template>
  <div v-if="step.kind === 'structured_plan'" data-structured-plan :data-plan-id="step.plan.planId" class="text-sm">
    <AgentPlan v-if="step.plan.type === 'items'" :entries="step.plan.entries" />
    <template v-else>
      <p class="m-0 mb-1.5 text-ui-text-muted">{{ t('agent.plan') }}</p>
      <AgentContent v-if="step.plan.type === 'markdown'" :content="[{ type: 'text', text: step.plan.content }]" markdown :final="!live" />
      <AgentResourceLink v-else :uri="step.plan.uri" :name="t('agent.plan')" />
    </template>
  </div>
  <CollapsibleRoot v-else-if="step.kind === 'compaction'" :open="open" data-compaction :data-compaction-id="step.compaction.compactionId" class="rounded-lg border border-ui-border bg-ui-surface/50 text-sm" @update:open="toggled = $event">
    <CollapsibleTrigger type="button" class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-text-muted hover:bg-ui-hover">
      <LoaderCircle v-if="step.compaction.status === 'in_progress' && live" :size="15" class="shrink-0 animate-spin" aria-hidden="true" />
      <CircleAlert v-else-if="step.compaction.status === 'failed'" :size="15" class="shrink-0 text-ui-danger" aria-hidden="true" />
      <Layers v-else :size="15" class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ t('agent.protocol.compaction') }}</span>
      <span class="text-xs">{{ t(`agent.protocol.compactionStates.${compactionStateKey}`) }}</span>
      <ChevronRight :size="14" class="shrink-0 ui-motion" :class="open && 'rotate-90'" aria-hidden="true" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="flex flex-col gap-2 border-t border-ui-border px-3 py-2">
        <AgentContent v-if="step.compaction.summary?.length" :content="step.compaction.summary" markdown :final="step.compaction.status !== 'in_progress' || !live" />
        <p v-if="step.compaction.error" class="m-0 whitespace-pre-wrap text-ui-danger">{{ step.compaction.error }}</p>
      </div>
    </CollapsibleContent>
  </CollapsibleRoot>
  <CollapsibleRoot v-else-if="step.kind === 'subagent'" :open="open" data-subagent :data-provider-session="step.session.sessionId" class="rounded-lg border border-ui-border text-sm" @update:open="toggled = $event">
    <CollapsibleTrigger type="button" class="flex w-full cursor-pointer items-start gap-2 rounded-lg bg-ui-surface/50 px-3 py-2.5 text-left hover:bg-ui-hover">
      <Bot :size="17" class="mt-0.5 shrink-0 text-ui-accent" aria-hidden="true" />
      <span class="min-w-0 flex-1">
        <span class="block font-medium text-ui-text">{{ step.session.title || t('agent.protocol.subagent') }}</span>
        <span v-if="step.session.description" class="mt-0.5 block text-xs text-ui-text-muted">{{ step.session.description }}</span>
      </span>
      <span class="inline-flex shrink-0 items-center gap-1 text-xs text-ui-text-muted" :class="childState === 'requires_action' && 'text-ui-warning'">
        <LoaderCircle v-if="childLive && live" :size="13" class="animate-spin" aria-hidden="true" />
        <CircleCheck v-else-if="childState === 'idle'" :size="13" aria-hidden="true" />
        <CircleAlert v-else-if="childState === 'requires_action'" :size="13" aria-hidden="true" />
        {{ t(`agent.protocol.subagentStates.${childStateKey}`) }}
      </span>
      <ChevronRight :size="14" class="mt-0.5 shrink-0 text-ui-text-muted ui-motion" :class="open && 'rotate-90'" aria-hidden="true" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="flex flex-col gap-3 border-t border-ui-border p-3">
        <p v-if="childError" class="m-0 whitespace-pre-wrap text-ui-danger">{{ childError }}</p>
        <AgentProtocolActivity v-for="child in step.steps" :key="child.id" :step="child" :live="live && childLive" :disabled="disabled" :session-labels="sessionLabels" :locate-entry="locateEntry" :data-conversation-entry="child.id" />
      </div>
    </CollapsibleContent>
  </CollapsibleRoot>
  <div v-else-if="step.kind === 'session_message'" data-session-message :data-message-id="step.message.messageId" class="rounded-lg border-l-2 border-ui-accent/40 bg-ui-surface/50 px-3 py-2 text-sm">
    <div class="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ui-text-muted">
      <MessageSquare :size="14" aria-hidden="true" />
      <span>{{ t('agent.protocol.sessionMessage') }}</span>
      <template v-if="step.message.senderSessionId || step.message.recipientSessionId">
        <span class="sr-only">{{ t('agent.protocol.messageRoute', { sender: label(step.message.senderSessionId), recipient: label(step.message.recipientSessionId) }) }}</span>
        <span aria-hidden="true">{{ label(step.message.senderSessionId) }}</span><ArrowRight :size="12" aria-hidden="true" /><span aria-hidden="true">{{ label(step.message.recipientSessionId) }}</span>
      </template>
    </div>
    <AgentContent v-if="step.message.content?.length" :content="step.message.content" markdown :final="!live" />
  </div>
  <AgentToolCall v-else-if="step.kind === 'tool'" :tool="step.tool" :disclosure-id="step.id" :permission="step.permission" :live="live" />
  <AgentPlan v-else-if="step.kind === 'plan'" :entries="step.entries" />
  <AgentElicitation v-else-if="step.kind === 'elicitation'" :elicitation="step.elicitation" :disabled="disabled" />
  <div v-else-if="step.kind === 'message'" :class="step.role !== 'assistant' && 'text-ui-text-muted'">
    <p v-if="step.role !== 'assistant'" class="m-0 mb-1 text-xs">{{ t(step.role === 'thought' ? 'agent.thinking' : 'agent.protocol.userMessage') }}</p>
    <AgentContent :content="step.content" :markdown="step.role !== 'user'" :final="!live" />
  </div>
</template>
