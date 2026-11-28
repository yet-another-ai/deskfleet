<script setup lang="ts">
import { computed, provide, reactive, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { FileTarget } from "@deskfleet/client/files"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import type { AgentInput } from "@deskfleet/protocol/agent"
import { isValidAccentSlot, type SuperAttachmentPreview, type SuperMessage, type SuperTicket } from "@deskfleet/protocol/super-agent"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { resolveWorkspaceAgentDisplayName, useWorkspaceAgentDisplayName } from "../../composables/useWorkspaceAgentDisplayName.ts"
import "../../styles/sa-ticket-accents.css"
import AgentContent from "./AgentContent.vue"
import WorkspaceMessageAttachment from "./WorkspaceMessageAttachment.vue"
import AgentMessageActions from "./AgentMessageActions.vue"
import AgentUserMessage from "./AgentUserMessage.vue"

const props = defineProps<{ message: SuperMessage; assistantName?: string; accentTickets?: readonly SuperTicket[]; resourceTarget?: FileTarget; readAttachment?: (id: string, index: number) => Promise<SuperAttachmentPreview>; animateSend: boolean; touch: boolean; canFork: boolean; forkDisabled: boolean; canLocatePrevious?: boolean }>()
const emit = defineEmits<{ quote: []; fork: []; avatarDblclick: []; locatePrevious: [] }>()
const { t } = useI18n()
const fallbackAssistantName = props.assistantName === undefined
  ? useWorkspaceAgentDisplayName(() => t("superAgent.role.assistant")).displayName
  : undefined
const roleName = computed(() => {
  if (props.message.role !== "assistant") return t(`superAgent.role.${props.message.role}`)
  return props.assistantName !== undefined
    ? resolveWorkspaceAgentDisplayName(props.assistantName, t("superAgent.role.assistant"))
    : fallbackAssistantName!.value
})
provide(agentResourceContextKey, computed(() => props.resourceTarget && props.message.sessionId
  ? { target: props.resourceTarget, sessionId: props.message.sessionId } : undefined))
const account = useAccountSession()
const messageText = computed(() => props.message.adhdModeNotice ? t(`composer.completions.adhdMode.${props.message.adhdModeNotice}`) : props.message.text)
const content = computed<AgentInput["content"]>(() => messageText.value ? [{ type: "text", text: messageText.value }] : [])
const pastes = reactive(new Map<number, string>())
watch([() => props.readAttachment, () => props.message.id], () => pastes.clear(), { flush: "sync" })
const copyContent = computed<AgentInput["content"] | undefined>(() => {
  if (!props.readAttachment || !props.message.attachments?.some(item => item.type === "resource")) return
  const blocks = [...content.value]
  for (const [index, item] of props.message.attachments.entries()) {
    if (item.type !== "resource") continue
    const text = pastes.get(index)
    if (text === undefined) return []
    blocks.push({ type: "text", text })
  }
  return blocks
})
// The daemon returns only acknowledged messages from the signed-in user's personal room.
// Some older hosts omit the author. Dispatch progress belongs to the reply.
const input = computed(() => ({
  author: props.message.author ?? { kind: "user" as const, userId: account?.account.value.user?.id },
  state: "delivered" as const, createdAt: props.message.createdAt, content: content.value,
}))
const attributedTickets = computed(() => {
  const seen = new Set<string>()
  const list: SuperTicket[] = []
  for (const ticket of props.accentTickets ?? []) {
    if (seen.has(ticket.id)) continue
    seen.add(ticket.id)
    list.push(ticket)
  }
  return list
})
const singleAccentSlot = computed(() => {
  if (attributedTickets.value.length !== 1) return undefined
  const slot = attributedTickets.value[0]!.accentSlot
  return isValidAccentSlot(slot) ? slot : undefined
})
</script>

<template>
  <AgentUserMessage v-if="message.role === 'user'" :input="input" :copy-content="copyContent" :animate-send="animateSend" can-quote :can-locate-previous="canLocatePrevious" :always-show-actions="touch" @quote="emit('quote')" @avatar-dblclick="emit('avatarDblclick')" @locate-previous="emit('locatePrevious')">
    <template #heading><slot name="heading" /></template>
    <template #before><slot name="before" /></template>
    <template #attachments>
      <ul v-if="message.attachments?.length" :aria-label="t('composer.attachments')" class="m-0 flex list-none flex-col gap-2 p-0">
        <li v-for="(item, index) in message.attachments" :key="index" class="min-w-0">
          <WorkspaceMessageAttachment :item="item" :read="readAttachment" :message-id="message.id" :index="index" @paste="pastes.set(index, $event)" />
        </li>
      </ul>
    </template>
    <template #after><slot /></template>
  </AgentUserMessage>
  <div v-else class="group flex min-w-0 flex-col items-start gap-3">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ui-text-muted">
      <span class="inline-flex items-center gap-1">
        <span
          v-if="message.role === 'assistant' && singleAccentSlot !== undefined"
          data-sa-role-dot
          :data-sa-accent-slot="singleAccentSlot"
          aria-hidden="true"
          class="sa-ticket-accent sa-ticket-dot"
        >·</span>
        <span data-sa-role-name>{{ roleName }}</span>
      </span>
      <slot name="heading" />
    </div>
    <slot name="before" />
    <AgentContent class="max-w-full" :content="content" markdown final />
    <div v-if="message.workerEvent === 'result' && message.stopState === 'stopped'" class="my-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <p role="status" class="m-0 text-sm text-ui-text-muted">{{ t("superAgent.status.stopped") }}</p>
      <slot name="stopped-actions" />
    </div>
    <p v-if="message.workerEvent === 'result' && message.truncated" data-excerpt-notice class="my-1 text-xs text-ui-text-muted">{{ t("superAgent.feedback.excerptNotice") }}</p>
    <p v-if="message.workerEvent === 'result' && message.unboundedOutcome && message.stopState !== 'stopped'" data-unbounded-outcome class="my-1 text-xs text-ui-text-muted">{{ t("superAgent.feedback.unboundedOutcome") }}</p>
    <slot />
    <AgentMessageActions :text="messageText" :can-fork="canFork" :fork-disabled="forkDisabled" :always-visible="touch" can-quote @fork="emit('fork')" @quote="emit('quote')" />
  </div>
</template>
