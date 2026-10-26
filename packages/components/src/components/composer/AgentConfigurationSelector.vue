<script setup lang="ts">
import { Check, ChevronDown, ChevronRight, LoaderCircle } from "@lucide/vue"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "reka-ui"
import { computed, nextTick, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentChoice } from "../../../../client/src/agent-configuration.ts"
import { useAgentConfiguration } from "./useAgentConfiguration.ts"
import ProviderIcon from "../common/ProviderIcon.vue"
import { useProvidersStore } from "../../stores/providers.ts"
import { useAgentSessionsStore, type AgentSelection } from "../../stores/agent-sessions.ts"

const props = defineProps<{ workspaceId?: string; sessionId?: string; providerId?: string; selection?: AgentSelection; disabled?: boolean }>()
const emit = defineEmits<{ loading: [value: boolean]; "update:providerId": [value: string]; "update:selection": [value: AgentSelection] }>()
const { t, te } = useI18n()
const providers = useProvidersStore()
const agents = useAgentSessionsStore()
const draftSelection = computed({
  get: () => props.selection ?? agents.draftConfiguration,
  set: (value: AgentSelection) => {
    if (props.selection === undefined) agents.draftConfiguration = value
    else emit("update:selection", value)
  },
})
const providerId = computed(() => props.sessionId ? agents.sessions[props.sessionId]?.provider ?? agents.configurations[props.sessionId]?.provider.id : props.providerId ?? providers.selectedId)
const selectedProvider = computed(() => providers.providers.find(provider => provider.id === providerId.value))
const providerUnavailable = computed(() => !!(props.sessionId || props.providerId) && providers.loaded && !selectedProvider.value)
const { configuration, expanded, loading, error, modelName, modelValue, requestedModel, reasoningEffort, modeName, toggle, changeModel, changeReasoningEffort, changeMode, reload } = useAgentConfiguration(() => ({ workspaceId: props.workspaceId, sessionId: props.sessionId, providerId: providerId.value }), draftSelection)
const providerPending = computed(() => !selectedProvider.value && !configuration.value && !providerUnavailable.value)
watch(loading, value => emit("loading", value), { immediate: true })
const root = useTemplateRef<{ $el: HTMLElement }>("root")
type Control = "agent" | "model" | "reasoning" | "mode"
interface ConfigurationControl { id: Control; label: string; value?: string; name?: string; options: AgentChoice[]; disabled: boolean }
const active = ref<Control | null>(null)

function effortName(value: string, fallback?: string): string {
  return te(`composer.efforts.${value}`) ? t(`composer.efforts.${value}`) : fallback ?? value
}
const effortLabel = computed(() => reasoningEffort.value && effortName(reasoningEffort.value, configuration.value?.reasoningEfforts?.options.find(option => option.id === reasoningEffort.value)?.name))
const providerName = computed(() => selectedProvider.value?.name ?? configuration.value?.provider.name ?? t(providerUnavailable.value ? "providers.unavailable" : "composer.provider"))
const summary = computed(() => [providerName.value, modelName.value, effortLabel.value, modeName.value].filter(Boolean).join(" · "))
const controls = computed<ConfigurationControl[]>(() => [
  { id: "agent" as const, label: t("composer.provider"), value: providerId.value, name: providerName.value, options: providers.providers, disabled: props.disabled || !!props.sessionId || !providers.ready || !providers.providers.length },
  { id: "model" as const, label: t("composer.model"), value: modelValue.value, name: modelName.value, options: configuration.value?.models?.options ?? [], disabled: props.disabled || loading.value && !requestedModel.value || !configuration.value?.models?.options.length },
  { id: "reasoning" as const, label: t("composer.reasoningEffort"), value: configuration.value?.reasoningEfforts?.currentValue, name: effortLabel.value, options: configuration.value?.reasoningEfforts?.options.map(option => ({ ...option, name: effortName(option.id, option.name) })) ?? [], disabled: props.disabled || loading.value || !configuration.value?.reasoningEfforts?.options.length },
  { id: "mode" as const, label: t("composer.mode"), value: configuration.value?.modes?.currentValue, name: modeName.value, options: configuration.value?.modes?.options ?? [], disabled: props.disabled || loading.value || !configuration.value?.modes?.options.length },
])

function setOpen(open: boolean): void {
  if (open !== expanded.value) toggle()
  if (!open) active.value = null
}
async function closeOptions(control: Control): Promise<void> {
  active.value = null
  await nextTick()
  root.value?.$el.querySelector<HTMLButtonElement>(`[data-agent-control="${control}"]`)?.focus()
}
function choose(control: Control, value: string): void {
  void closeOptions(control)
  if (control === "agent" && !props.sessionId) {
    if (props.providerId === undefined) providers.selectedId = value
    else emit("update:providerId", value)
  }
  if (control === "model") void changeModel(value)
  if (control === "reasoning") void changeReasoningEffort(value)
  if (control === "mode") void changeMode(value)
}
</script>

<template>
  <div data-agent-configuration class="flex min-w-0">
    <DropdownMenuRoot :open="expanded" :modal="false" @update:open="setOpen">
      <DropdownMenuTrigger data-agent-configuration-trigger data-composer-context class="ui-text-button min-w-0 max-w-full cursor-pointer leading-5 hover:bg-ui-hover hover:text-ui-text" :title="t('composer.provider')" :aria-label="t('composer.configureAgent', { selection: summary })">
        <span v-if="providerPending" class="h-3.5 w-3.5 shrink-0 rounded bg-ui-border" data-provider-pending aria-hidden="true" />
        <ProviderIcon v-else :icon="selectedProvider?.icon" :template="selectedProvider?.template" :size="15" />
        <span class="truncate">{{ summary }}</span>
        <LoaderCircle v-if="requestedModel" :size="13" class="shrink-0 animate-spin" aria-hidden="true" />
        <ChevronDown :size="13" class="shrink-0" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent ref="root" data-agent-configuration-menu :aria-label="t('composer.configuration')" :aria-busy="loading" class="ui-menu z-50 w-64" side="top" align="start" :side-offset="8" :collision-padding="8" loop>
          <DropdownMenuSub v-for="control in controls" :key="control.id" :open="active === control.id" @update:open="active = $event ? control.id : active === control.id ? null : active">
            <DropdownMenuSubTrigger as="button" type="button" :data-agent-control="control.id" :data-value="control.value" :disabled="control.disabled" class="ui-menu-item gap-3 focus:outline-none" :class="active === control.id && 'bg-ui-hover'">
              <span>{{ control.label }}</span>
              <span class="ml-auto truncate text-ui-text-muted">{{ control.name ?? (loading ? t('composer.loading') : t('composer.unavailable')) }}</span>
              <LoaderCircle v-if="control.id === 'model' && requestedModel" :size="13" class="shrink-0 animate-spin text-ui-text-muted" data-model-pending aria-hidden="true" />
              <ChevronRight :size="14" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent data-agent-configuration-options :aria-label="control.label" :side-offset="4" :collision-padding="8" class="ui-menu z-50 max-h-[min(20rem,var(--reka-popper-available-height))] min-w-48 max-w-[min(20rem,calc(100vw-16px))] overflow-y-auto" loop>
                <DropdownMenuRadioGroup :model-value="control.value">
                  <DropdownMenuRadioItem v-for="option in control.options" :key="option.id" as="button" type="button" :value="option.id" :data-value="option.id" :disabled="control.disabled" class="ui-menu-item focus:outline-none" @select.prevent="choose(control.id, option.id)">
                    <ProviderIcon v-if="control.id === 'agent'" :icon="providers.providers.find(provider => provider.id === option.id)?.icon" :template="providers.providers.find(provider => provider.id === option.id)?.template" :size="15" class="text-ui-text-muted" />
                    <span class="min-w-0 flex-1 text-left">
                      <span class="block" :class="option.description ? 'whitespace-normal' : 'truncate'">{{ option.name }}</span>
                      <span v-if="option.description" class="mt-0.5 block whitespace-normal text-xs text-ui-text-muted">{{ option.description }}</span>
                    </span>
                    <Check v-if="control.value === option.id" :size="15" class="shrink-0" aria-hidden="true" />
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <p v-if="loading" class="m-0 flex items-center gap-1.5 border-t border-ui-border px-2.5 py-2 text-xs text-ui-text-muted" role="status"><LoaderCircle :size="13" class="shrink-0 animate-spin" aria-hidden="true" />{{ t('composer.loadingConfiguration') }}</p>
          <div v-if="error" class="border-t border-ui-border px-2.5 py-2 text-xs">
            <p role="alert" class="m-0 break-words text-ui-danger">{{ error }}</p>
            <DropdownMenuItem as="button" type="button" class="ui-menu-item mt-2" @select.prevent="reload">{{ t('composer.reloadConfiguration') }}</DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
