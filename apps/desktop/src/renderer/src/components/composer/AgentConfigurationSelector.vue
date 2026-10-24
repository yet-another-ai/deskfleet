<script setup lang="ts">
import { Bot, ChevronDown, ChevronUp, LoaderCircle } from "@lucide/vue"
import { computed, nextTick, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAgentConfiguration } from "./useAgentConfiguration.ts"

const props = defineProps<{ worktreeId?: string }>()
const { t, te } = useI18n()
const { configuration, expanded, loading, error, modelName, reasoningEffort, toggle, changeModel: configureModel, changeReasoningEffort: configureReasoningEffort, reload } = useAgentConfiguration(() => props.worktreeId)
const controlsId = useId()
const trigger = useTemplateRef<HTMLButtonElement>("trigger")
const providerSelect = useTemplateRef<HTMLSelectElement>("providerSelect")

function effortName(value: string, fallback?: string): string {
  return te(`composer.efforts.${value}`) ? t(`composer.efforts.${value}`) : fallback ?? value
}
const summary = computed(() => [
  configuration.value?.provider.name ?? "Codex",
  modelName.value,
  reasoningEffort.value && effortName(reasoningEffort.value, configuration.value?.reasoningEfforts?.options.find(option => option.id === reasoningEffort.value)?.name),
].filter(Boolean).join(" · "))

async function expand(): Promise<void> {
  toggle()
  await nextTick()
  providerSelect.value?.focus()
}
async function collapse(): Promise<void> {
  if (expanded.value) toggle()
  await nextTick()
  trigger.value?.focus()
}
function changeModel(event: Event): void {
  const select = event.target as HTMLSelectElement
  const value = select.value
  // Keep the confirmed value visible until the agent accepts the change.
  select.value = configuration.value?.models?.currentValue ?? ""
  void configureModel(value)
}
function changeReasoningEffort(event: Event): void {
  const select = event.target as HTMLSelectElement
  const value = select.value
  select.value = configuration.value?.reasoningEfforts?.currentValue ?? ""
  void configureReasoningEffort(value)
}
</script>

<template>
  <div class="min-w-0" :class="expanded && 'w-full'" @keydown.esc.stop.prevent="collapse">
    <button
      v-show="!expanded"
      ref="trigger"
      type="button"
      class="ui-chip max-w-full cursor-pointer hover:bg-ui-hover"
      :aria-label="t('composer.configureAgent', { selection: summary })"
      :aria-expanded="expanded"
      :aria-controls="controlsId"
      @click="expand"
    >
      <Bot :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
      <span class="truncate">{{ summary }}</span>
      <ChevronDown :size="13" class="shrink-0" aria-hidden="true" />
    </button>

    <div v-show="expanded" :id="controlsId" class="rounded-xl border border-ui-border bg-ui-surface p-3" role="group" :aria-label="t('composer.configuration')" :aria-busy="loading">
      <div class="flex items-start gap-2">
        <div class="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
          <label class="flex min-w-0 flex-col gap-1 text-xs text-ui-text-muted">
            {{ t('composer.provider') }}
            <select ref="providerSelect" class="agent-select" :value="configuration?.provider.id ?? 'codex'" @change="reload">
              <option value="codex">Codex</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-xs text-ui-text-muted">
            {{ t('composer.model') }}
            <select class="agent-select" :value="configuration?.models?.currentValue ?? ''" :disabled="loading || !configuration?.models?.options.length" @change="changeModel">
              <option v-if="!configuration?.models?.options.length" value="">{{ loading ? t('composer.loading') : t('composer.unavailable') }}</option>
              <option v-for="option in configuration?.models?.options" :key="option.id" :value="option.id">{{ option.name }}</option>
            </select>
          </label>
          <label class="flex min-w-0 flex-col gap-1 text-xs text-ui-text-muted">
            {{ t('composer.reasoningEffort') }}
            <select class="agent-select" :value="configuration?.reasoningEfforts?.currentValue ?? ''" :disabled="loading || !configuration?.reasoningEfforts?.options.length" @change="changeReasoningEffort">
              <option v-if="!configuration?.reasoningEfforts?.options.length" value="">{{ loading ? t('composer.loading') : t('composer.unavailable') }}</option>
              <option v-for="option in configuration?.reasoningEfforts?.options" :key="option.id" :value="option.id">{{ effortName(option.id, option.name) }}</option>
            </select>
          </label>
        </div>
        <button type="button" class="mt-5 inline-flex h-8 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-muted hover:bg-ui-hover" :aria-label="t('composer.collapseConfiguration')" :aria-controls="controlsId" aria-expanded="true" @click="collapse">
          <ChevronUp :size="15" aria-hidden="true" />
        </button>
      </div>
      <p v-if="loading" class="m-0 mt-2 flex items-center gap-1.5 text-xs text-ui-text-muted" role="status">
        <LoaderCircle :size="13" class="animate-spin" aria-hidden="true" />
        {{ t('composer.loadingConfiguration') }}
      </p>
      <div v-if="error" class="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span role="alert" class="break-words text-ui-danger">{{ error }}</span>
        <button type="button" class="catalog-button" @click="reload">{{ t('composer.reloadConfiguration') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-select {
  width: 100%;
  min-width: 0;
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid var(--ui-color-border);
  border-radius: 0.375rem;
  background: var(--ui-color-canvas);
  color: var(--ui-color-text);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.agent-select:disabled { cursor: default; opacity: 0.6; }
</style>
