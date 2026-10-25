<script setup lang="ts">
import { CircleAlert, CircleCheck, Copy, LoaderCircle, User } from "@lucide/vue"
import { computed, onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentInput } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import { useAgentActor } from "../../composables/useAgentActor.ts"
import { formatMessageTime } from "../../services/agent-format.ts"
import IconButton from "../common/IconButton.vue"
import UserAvatar from "../common/UserAvatar.vue"
import AgentActor from "./AgentActor.vue"
import AgentContent from "./AgentContent.vue"
const props = defineProps<{ input: AgentInput }>()
const { t, locale } = useI18n()
const { name, email } = useAgentActor(() => props.input.author)
const time = computed(() => formatMessageTime(props.input.deliveredAt ?? props.input.createdAt, intlLocale(locale.value as AppLocale)))
// An initial prompt is already running once it is claimed; only steering waits for confirmation.
const state = computed(() => props.input.state === "delivered" ? undefined : props.input.state === "dispatching" && props.input.actualDelivery === "turn_start" ? t("agent.inputInProgress") : t(`agent.inputState.${props.input.state}`))
const steered = computed(() => props.input.state === "delivered" && props.input.actualDelivery === "steer")
const text = computed(() => props.input.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n\n"))
const copied = ref(false)
const copyFailed = ref(false)
let resetCopied: ReturnType<typeof setTimeout> | undefined
async function copy(): Promise<void> {
  clearTimeout(resetCopied)
  copied.value = false
  copyFailed.value = false
  try { await navigator.clipboard.writeText(text.value) }
  catch { copyFailed.value = true; return }
  copied.value = true
  resetCopied = setTimeout(() => { copied.value = false }, 1500)
}
onBeforeUnmount(() => clearTimeout(resetCopied))
</script>

<template>
  <div class="group flex justify-end gap-3 pl-12">
    <div class="flex min-w-0 flex-col items-end gap-1.5">
      <div class="flex items-center gap-1.5 text-xs text-ui-text-muted">
        <template v-if="input.author.userId"><AgentActor :actor="input.author" class="font-medium text-ui-text" /><span aria-hidden="true">·</span></template>
        <span v-if="steered">{{ t('agent.steered') }}<template v-if="input.dispatcher && input.dispatcher.userId !== input.author.userId"> · <AgentActor :actor="input.dispatcher" /></template></span>
        <LoaderCircle v-if="input.state === 'dispatching'" :size="14" :stroke-width="2" class="animate-spin" aria-hidden="true" />
        <CircleAlert v-else-if="input.state === 'uncertain'" :size="14" :stroke-width="2" class="text-ui-warning" aria-hidden="true" />
        <CircleCheck v-else :size="14" :stroke-width="2" class="text-ui-focus" aria-hidden="true" />
        <span v-if="state">{{ state }}</span>
        <time v-if="time" :datetime="input.deliveredAt ?? input.createdAt">{{ time }}</time>
      </div>
      <div class="max-w-full rounded-2xl bg-ui-accent/8 px-4 py-2.5">
        <AgentContent :content="input.content" />
      </div>
      <p v-if="input.state === 'uncertain'" class="m-0 max-w-md text-right text-xs text-ui-warning">{{ t('agent.uncertainInput') }}</p>
      <div v-if="text" class="-my-1 flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <IconButton :icon="copied ? CircleCheck : Copy" :label="t(copied ? 'agent.copied' : 'agent.copy')" @click="copy" />
      </div>
      <p v-if="copyFailed" role="alert" class="m-0 text-xs text-ui-danger">{{ t('agent.copyFailed') }}</p>
    </div>
    <UserAvatar v-if="input.author.userId" :name="name" :email="email" :size="32" :title="name" class="mt-6 text-xs" />
    <span v-else class="ui-avatar mt-6 h-8 w-8 rounded-full" :title="name" aria-hidden="true">
      <User :size="16" :stroke-width="2" />
    </span>
  </div>
</template>
