<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import { ChevronDown, CircleAlert, CornerDownRight, ListEnd, RotateCw, X } from "@lucide/vue"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentInput } from "@deskfleet/protocol/agent"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { commandDraft } from "../../services/composer-mentions.ts"
import AgentActor from "./AgentActor.vue"
const props = defineProps<{ inputs: AgentInput[]; canSteer: boolean; disabled: boolean; excludeInputId?: string; excludeInputIds?: string[] }>()
const emit = defineEmits<{ steer: [id: string]; withdraw: [id: string]; retry: [id: string] }>()
const { t } = useI18n()
const session = useAccountSession()
const expanded = ref(false)
const candidates = computed(() => props.inputs.filter(input => ["pending", "failed"].includes(input.state) && input.id !== props.excludeInputId && !props.excludeInputIds?.includes(input.id)))
const pendingCount = computed(() => candidates.value.filter(input => input.state === "pending").length)
const failedCount = computed(() => candidates.value.filter(input => input.state === "failed").length)
const currentUserId = computed(() => session?.account.value.user?.id)
const showActor = (input: AgentInput) => Boolean(input.author.userId && input.author.userId !== currentUserId.value)
const preview = (input: AgentInput) => input.content.map(block => block.type === "text" ? block.text : t("agent.contentType", { type: block.type })).join(" ")
const command = (input: AgentInput) => commandDraft(input.content.find(block => block.type === "text")?.text ?? "")
watch(() => candidates.value.length, count => {
  if (count <= 1) expanded.value = false
})
</script>

<template>
  <section v-if="candidates.length" class="overflow-hidden rounded-xl border border-ui-border bg-ui-surface" :aria-label="t('agent.backlog')">
    <button
      v-if="candidates.length > 1"
      type="button"
      data-backlog-toggle
      :aria-expanded="expanded"
      :title="t(expanded ? 'agent.backlogCollapse' : 'agent.backlogExpand')"
      class="flex min-h-9 w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-[13px] transition-colors hover:bg-ui-hover/60"
      @click="expanded = !expanded"
    >
      <span v-if="pendingCount" class="flex min-w-0 items-center gap-1.5 font-medium text-ui-text">
        <ListEnd :size="14" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
        <span class="truncate">{{ t('agent.backlogQueued', pendingCount) }}</span>
      </span>
      <span v-if="pendingCount && failedCount" class="shrink-0 text-ui-text-muted" aria-hidden="true">·</span>
      <span v-if="failedCount" class="flex shrink-0 items-center gap-1 text-xs font-medium text-ui-danger">
        <CircleAlert :size="14" :stroke-width="2" class="shrink-0" aria-hidden="true" />
        <span>{{ t('agent.backlogFailed', failedCount) }}</span>
      </span>
      <ChevronDown :size="14" :stroke-width="1.75" class="ml-auto shrink-0 text-ui-text-muted transition-transform duration-150" :class="expanded && 'rotate-180'" aria-hidden="true" />
    </button>
    <UiScrollArea v-if="candidates.length === 1 || expanded" fade-size="sm" class="max-h-36" :class="candidates.length > 1 && 'border-t border-ui-border'">
      <ol :class="candidates.length > 1 ? 'py-1' : undefined">
        <li
          v-for="input in candidates"
          :key="input.id"
          :data-input-id="input.id"
          class="group flex items-center gap-1.5 px-3 text-[13px]"
          :class="candidates.length === 1 ? 'min-h-9 py-1' : 'py-0.5'"
        >
          <CircleAlert v-if="input.state === 'failed'" :size="14" :stroke-width="2" class="shrink-0 text-ui-danger" aria-hidden="true" />
          <ListEnd v-else-if="candidates.length === 1" :size="14" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" :title="t('agent.backlog')" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate select-text" :title="input.error ?? preview(input)">{{ preview(input) }}</span>
          <span v-if="input.state === 'failed'" class="shrink-0 text-xs text-ui-danger">{{ t('agent.inputState.failed') }}</span>
          <AgentActor v-if="showActor(input)" :actor="input.author" class="shrink-0 text-xs text-ui-text-muted" />
          <UiButton variant="ghost" size="sm" v-if="input.state === 'pending' && canSteer && !command(input)" type="button" class="shrink-0 cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:opacity-50" :disabled="disabled" @click="emit('steer', input.id)"><CornerDownRight :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.steer') }}</UiButton>
          <UiButton variant="ghost" size="sm" v-if="input.state === 'failed' || (input.state === 'pending' && input.error)" type="button" class="shrink-0 cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:opacity-50" :disabled="disabled" @click="emit('retry', input.id)"><RotateCw :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.retryInput') }}</UiButton>
          <UiButton variant="ghost" size="icon" v-if="input.state === 'pending'" type="button" class="shrink-0 cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:opacity-50" :disabled="disabled" :title="t('agent.withdraw')" :aria-label="t('agent.withdraw')" @click="emit('withdraw', input.id)"><X :size="14" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        </li>
      </ol>
    </UiScrollArea>
  </section>
</template>
