<script setup lang="ts">
import { CircleAlert, CircleCheck, Copy, LoaderCircle, User } from "@lucide/vue"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentInput } from "../../../../../../daemon/src/agent-protocol.ts"
import { intlLocale, type AppLocale } from "../../../../shared/i18n.ts"
import { formatMessageTime, initials } from "../../services/agent-format.ts"
import IconButton from "../common/IconButton.vue"
import AgentActor from "./AgentActor.vue"
import AgentContent from "./AgentContent.vue"
const props = defineProps<{ input: AgentInput }>()
const { t, locale } = useI18n()
const time = computed(() => formatMessageTime(props.input.deliveredAt ?? props.input.createdAt, intlLocale(locale.value as AppLocale)))
// An initial prompt is already running once it is claimed; only steering waits for confirmation.
const state = computed(() => props.input.state === "delivered" ? undefined : props.input.state === "dispatching" && props.input.actualDelivery === "turn_start" ? t("agent.inputInProgress") : t(`agent.inputState.${props.input.state}`))
const steered = computed(() => props.input.state === "delivered" && props.input.actualDelivery === "steer")
const text = computed(() => props.input.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n\n"))
const copied = ref(false)
async function copy(): Promise<void> {
  try { await navigator.clipboard.writeText(text.value) } catch { return }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
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
      <div class="max-w-full rounded-2xl bg-ui-surface px-4 py-2.5">
        <AgentContent :content="input.content" />
      </div>
      <p v-if="input.state === 'uncertain'" class="m-0 max-w-md text-right text-xs text-ui-warning">{{ t('agent.uncertainInput') }}</p>
      <div v-if="text" class="-my-1 flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <IconButton :icon="copied ? CircleCheck : Copy" :label="t(copied ? 'agent.copied' : 'agent.copy')" @click="copy" />
      </div>
    </div>
    <span class="mt-6 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ui-avatar text-xs font-semibold text-white" :title="input.author.userId ?? t('agent.localUser')" aria-hidden="true">
      <template v-if="input.author.userId">{{ initials(input.author.userId) }}</template>
      <User v-else :size="16" :stroke-width="2" />
    </span>
  </div>
</template>
