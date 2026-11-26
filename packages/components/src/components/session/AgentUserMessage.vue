<script setup lang="ts">
import { CircleAlert, CircleCheck, LoaderCircle, User } from "@lucide/vue"
import { usePreferredReducedMotion } from "@vueuse/core"
import { computed, onMounted, onScopeDispose, provide, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { ConversationInput } from "../../services/agent-conversation.ts"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { useAgentActor } from "../../composables/useAgentActor.ts"
import { formatMessageTime } from "../../services/agent-format.ts"
import { consumeSentMessageTransition, type SentMessageTransition } from "../../services/message-sent-transition.ts"
import { conversationEntryIdKey } from "../../services/preview.ts"
import UserAvatar from "../common/UserAvatar.vue"
import AgentActor from "./AgentActor.vue"
import McpActorBadge from "./McpActorBadge.vue"
import AgentContent from "./AgentContent.vue"
import AgentMessageActions from "./AgentMessageActions.vue"
const props = defineProps<{ input: ConversationInput; entryId?: string; disclosureId?: string; animateSend?: boolean; unattributedLabel?: string }>()
provide(conversationEntryIdKey, computed(() => props.entryId))
const { t, locale } = useI18n()
const { name, email, mcpSender } = useAgentActor(() => props.input.author)
const time = computed(() => formatMessageTime(props.input.deliveredAt ?? props.input.createdAt, intlLocale(locale.value as AppLocale)))
// An initial prompt is already running once it is claimed; only steering waits for confirmation.
const state = computed(() => props.input.state === "delivered" || props.input.state === "pending" ? undefined : props.input.state === "dispatching" && props.input.actualDelivery === "turn_start" ? t("agent.inputInProgress") : t(`agent.inputState.${props.input.state}`))
const steered = computed(() => props.input.state === "delivered" && props.input.actualDelivery === "steer")
const text = computed(() => props.input.content.flatMap(block => block.type === "text" ? [block.text] : block.type === "resource" && "text" in block.resource ? [block.resource.text] : []).join("\n\n"))
const root = useTemplateRef<HTMLElement>("root")
const reducedMotion = usePreferredReducedMotion()
let animations: SentMessageTransition[] = []
onMounted(() => queueMicrotask(() => {
  if (props.animateSend ?? !root.value?.parentElement?.nextElementSibling) {
    animations = consumeSentMessageTransition(root.value, reducedMotion.value === "reduce")
  }
}))
onScopeDispose(() => { for (const anim of animations) anim.cancel() })
</script>

<template>
  <div ref="root" class="group flex justify-end gap-3 pl-12">
    <div class="flex min-w-0 flex-col items-end gap-1.5">
      <div data-user-message-meta class="flex items-center gap-1.5 text-xs text-ui-text-muted">
        <template v-if="mcpSender"><span class="font-medium text-ui-text">{{ mcpSender }}</span><span aria-hidden="true">·</span></template>
        <template v-else-if="input.author.userId"><AgentActor :actor="input.author" class="font-medium text-ui-text" /><span aria-hidden="true">·</span></template>
        <template v-else-if="unattributedLabel"><span class="font-medium text-ui-text">{{ unattributedLabel }}</span><span aria-hidden="true">·</span></template>
        <span v-if="steered">{{ t('agent.steered') }}<template v-if="input.dispatcher && (input.dispatcher.userId !== input.author.userId || input.dispatcher.via !== input.author.via)"> · <AgentActor :actor="input.dispatcher" /></template></span>
        <LoaderCircle v-if="input.state === 'dispatching'" :size="14" :stroke-width="2" class="animate-spin" aria-hidden="true" />
        <CircleAlert v-else-if="input.state === 'uncertain'" :size="14" :stroke-width="2" class="text-ui-warning" aria-hidden="true" />
        <CircleCheck v-else :size="14" :stroke-width="2" class="text-ui-focus" aria-hidden="true" />
        <span v-if="state">{{ state }}</span>
        <time v-if="time" :datetime="input.deliveredAt ?? input.createdAt">{{ time }}</time>
      </div>
      <div data-user-message-bubble class="max-w-full rounded-2xl bg-ui-accent/8 px-4 py-2.5">
        <AgentContent :content="input.content" :disclosure-id="disclosureId ?? `input-${input.id}`" />
      </div>
      <p v-if="input.state === 'uncertain'" class="m-0 max-w-md text-right text-xs text-ui-warning">{{ t('agent.uncertainInput') }}</p>
      <AgentMessageActions :text="text" />
    </div>
    <McpActorBadge v-if="mcpSender" data-user-message-avatar :actor="input.author" large class="mt-6 self-start" />
    <UserAvatar v-else-if="input.author.userId" data-user-message-avatar :name="name" :email="email" :size="32" :title="name" class="mt-6 text-xs" />
    <span v-else data-user-message-avatar class="ui-avatar mt-6 h-8 w-8 rounded-full" :title="unattributedLabel || name" aria-hidden="true">
      <User :size="16" :stroke-width="2" />
    </span>
  </div>
</template>
