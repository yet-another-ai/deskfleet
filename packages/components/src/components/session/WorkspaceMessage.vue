<script setup lang="ts">
import { computed, provide, reactive, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { FileTarget } from "../../../../client/src/files.ts"
import { agentResourceContextKey } from "../../services/agent-resources.ts"
import type { AgentInput } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { SuperAttachmentPreview, SuperMessage } from "../../../../../apps/daemon/src/super-agent-protocol.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import AgentContent from "./AgentContent.vue"
import WorkspaceMessageAttachment from "./WorkspaceMessageAttachment.vue"
import AgentMessageActions from "./AgentMessageActions.vue"
import AgentUserMessage from "./AgentUserMessage.vue"

const props = defineProps<{ message: SuperMessage; resourceTarget?: FileTarget; readAttachment?: (id: string, index: number) => Promise<SuperAttachmentPreview>; animateSend: boolean; touch: boolean; canFork: boolean; forkDisabled: boolean }>()
const emit = defineEmits<{ quote: []; fork: [] }>()
const { t } = useI18n()
provide(agentResourceContextKey, computed(() => props.resourceTarget && props.message.sessionId
  ? { target: props.resourceTarget, sessionId: props.message.sessionId } : undefined))
const account = useAccountSession()
const content = computed<AgentInput["content"]>(() => props.message.text ? [{ type: "text", text: props.message.text }] : [])
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
</script>

<template>
  <AgentUserMessage v-if="message.role === 'user'" :input="input" :copy-content="copyContent" :animate-send="animateSend" can-quote :always-show-actions="touch" @quote="emit('quote')">
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
      <span>{{ t(`superAgent.role.${message.role}`) }}</span>
      <slot name="heading" />
    </div>
    <slot name="before" />
    <AgentContent class="max-w-full" :content="content" markdown final />
    <slot />
    <AgentMessageActions :text="message.text" :can-fork="canFork" :fork-disabled="forkDisabled" :always-visible="touch" can-quote @fork="emit('fork')" @quote="emit('quote')" />
  </div>
</template>
