<script setup lang="ts">
import { CircleAlert, CornerDownRight, ListEnd, RotateCw, X } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentInput } from "../../../../../apps/daemon/src/agent-protocol.ts"
import AgentActor from "./AgentActor.vue"
const props = defineProps<{ inputs: AgentInput[]; canSteer: boolean; disabled: boolean }>()
const emit = defineEmits<{ steer: [id: string]; withdraw: [id: string]; retry: [id: string] }>()
const { t } = useI18n()
const candidates = computed(() => props.inputs.filter(input => ["pending", "failed", "uncertain"].includes(input.state)))
const preview = (input: AgentInput) => input.content.map(block => block.type === "text" ? block.text : t("agent.contentType", { type: block.type })).join(" ")
</script>

<template>
  <section v-if="candidates.length" class="overflow-hidden rounded-xl border border-ui-border bg-ui-surface" :aria-label="t('agent.backlog')">
    <h2 class="m-0 flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-medium text-ui-text-muted"><ListEnd :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.backlog') }} · {{ candidates.length }}</h2>
    <ol class="max-h-48 overflow-y-auto pb-1">
      <li v-for="input in candidates" :key="input.id" :data-input-id="input.id" class="group flex items-center gap-2 px-3 py-1 text-[13px]">
        <CircleAlert v-if="input.state !== 'pending'" :size="14" :stroke-width="2" class="shrink-0" :class="input.state === 'failed' ? 'text-ui-danger' : 'text-ui-warning'" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate select-text" :title="input.error ?? (input.state === 'uncertain' ? t('agent.uncertainInput') : preview(input))">{{ preview(input) }}</span>
        <span v-if="input.state !== 'pending'" class="shrink-0 text-xs" :class="input.state === 'failed' ? 'text-ui-danger' : 'text-ui-warning'">{{ t(`agent.inputState.${input.state}`) }}</span>
        <AgentActor v-if="input.author.userId" :actor="input.author" class="shrink-0 text-xs text-ui-text-muted" />
        <button v-if="input.state === 'pending' && canSteer" type="button" class="ui-text-button shrink-0 cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:opacity-50" :disabled="disabled" @click="emit('steer', input.id)"><CornerDownRight :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.steer') }}</button>
        <button v-if="input.state === 'failed'" type="button" class="ui-text-button shrink-0 cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:opacity-50" :disabled="disabled" @click="emit('retry', input.id)"><RotateCw :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.retryInput') }}</button>
        <button v-if="input.state === 'pending'" type="button" class="ui-text-button shrink-0 cursor-pointer px-1.5 hover:bg-ui-hover hover:text-ui-text disabled:opacity-50" :disabled="disabled" :title="t('agent.withdraw')" :aria-label="t('agent.withdraw')" @click="emit('withdraw', input.id)"><X :size="14" :stroke-width="1.75" aria-hidden="true" /></button>
      </li>
    </ol>
  </section>
</template>
