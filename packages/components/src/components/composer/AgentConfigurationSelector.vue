<script setup lang="ts">
import { Check, ChevronDown, ChevronRight, LoaderCircle } from "@lucide/vue"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "reka-ui"
import { computed, nextTick, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentChoice, AgentConfiguration } from "../../../../client/src/agent-configuration.ts"
import { useAgentConfiguration } from "./useAgentConfiguration.ts"
import AgentConfigOptionMenu from "./AgentConfigOptionMenu.vue"
import ProviderIcon from "../common/ProviderIcon.vue"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import { useProvidersStore } from "../../stores/providers.ts"
import { useAgentSessionsStore, type AgentSelection } from "../../stores/agent-sessions.ts"

const props = defineProps<{ workspaceId?: string; sessionId?: string; providerId?: string; selection?: AgentSelection; disabled?: boolean }>()
const emit = defineEmits<{ loading: [value: boolean]; configuration: [value: AgentConfiguration | null]; "update:providerId": [value: string]; "update:selection": [value: AgentSelection] }>()
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
const session = computed(() => props.sessionId ? agents.sessions[props.sessionId] : undefined)
const sessionReady = computed(() => session.value?.lifecycle === undefined || session.value.lifecycle === "ready")
const pendingProvider = ref<string>()
const pendingProviderName = computed(() => providers.providers.find(provider => provider.id === pendingProvider.value)?.name ?? pendingProvider.value)
const currentProviderName = computed(() => selectedProvider.value?.name ?? providerId.value ?? "")
const providerUnavailable = computed(() => !!(props.sessionId || props.providerId) && providers.loaded && !selectedProvider.value)
const { configuration, expanded, loading, error, modelName, modelValue, requestedModel, reasoningEffort, modeName, toggle, changeModel, changeReasoningEffort, changeMode, changeConfigOption, reload, discover } = useAgentConfiguration(() => ({ workspaceId: props.workspaceId, sessionId: props.sessionId, providerId: providerId.value }), draftSelection)
const providerPending = computed(() => !selectedProvider.value && !configuration.value && !providerUnavailable.value)
watch(loading, value => emit("loading", value), { immediate: true })
watch(configuration, value => emit("configuration", value), { immediate: true })
defineExpose({ discover })
const root = useTemplateRef<{ $el: HTMLElement }>("root")
type Control = "agent" | "model" | "reasoning" | "mode"
interface ConfigurationControl { id: Control; label: string; value?: string; name?: string; options: AgentChoice[]; disabled: boolean }
const active = ref<string | null>(null)
const extraOptions = computed(() => {
  const current = configuration.value
  const primary = new Set([current?.models?.id, current?.reasoningEfforts?.id, current?.modes?.id])
  return current?.configOptions?.filter(option => !primary.has(option.id)) ?? []
})

function optionGroups(control: ConfigurationControl) {
  const id = control.id === "model" ? configuration.value?.models?.id
    : control.id === "reasoning" ? configuration.value?.reasoningEfforts?.id
      : control.id === "mode" ? configuration.value?.modes?.id : undefined
  const raw = configuration.value?.configOptions?.find(option => option.id === id)
  if (raw?.type === "select" && raw.options.some(row => "group" in row)) {
    return raw.options.map(row => "group" in row ? {
      id: row.group, name: row.name, options: row.options.flatMap(value => control.options.filter(option => option.id === value.value)),
    } : { id: row.value, name: undefined, options: control.options.filter(option => option.id === row.value) })
  }
  return [{ id: control.id, name: undefined, options: control.options }]
}

function effortName(value: string, fallback?: string): string {
  return te(`composer.efforts.${value}`) ? t(`composer.efforts.${value}`) : fallback ?? value
}
const effortLabel = computed(() => reasoningEffort.value && effortName(reasoningEffort.value, configuration.value?.reasoningEfforts?.options.find(option => option.id === reasoningEffort.value)?.name))
const providerName = computed(() => selectedProvider.value?.name ?? configuration.value?.provider.name ?? t(providerUnavailable.value ? "providers.unavailable" : "composer.provider"))
const summary = computed(() => [providerName.value, modelName.value, effortLabel.value, modeName.value].filter(Boolean).join(" · "))
const controls = computed<ConfigurationControl[]>(() => [
  { id: "agent" as const, label: t("composer.provider"), value: providerId.value, name: providerName.value, options: providers.providers, disabled: props.disabled || !sessionReady.value || !providers.ready || !providers.providers.length },
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
  if (control === "agent" && props.sessionId) {
    if (value !== providerId.value) pendingProvider.value = value
    return
  }
  if (control === "agent") {
    if (props.providerId === undefined) providers.selectedId = value
    else emit("update:providerId", value)
  }
  if (control === "model") void changeModel(value)
  if (control === "reasoning") void changeReasoningEffort(value)
  if (control === "mode") void changeMode(value)
}
async function confirmSwitch(): Promise<void> {
  const provider = pendingProvider.value
  if (!provider || !props.sessionId) return
  await agents.switchAgent(props.sessionId, provider)
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
        <DropdownMenuContent ref="root" data-agent-configuration-menu :aria-label="t('composer.configuration')" :aria-busy="loading" class="ui-menu z-50 max-h-[var(--reka-popper-available-height)] w-72 overflow-y-auto" side="top" align="start" :side-offset="8" :collision-padding="8" loop>
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
                  <template v-for="group in optionGroups(control)" :key="group.id">
                    <DropdownMenuLabel v-if="group.name" class="px-2.5 py-1.5 text-xs font-medium text-ui-text-muted">{{ group.name }}</DropdownMenuLabel>
                  <DropdownMenuRadioItem v-for="option in group.options" :key="option.id" as="button" type="button" :value="option.id" :data-value="option.id" :disabled="control.disabled" class="ui-menu-item focus:outline-none" @select.prevent="choose(control.id, option.id)">
                    <ProviderIcon v-if="control.id === 'agent'" :icon="providers.providers.find(provider => provider.id === option.id)?.icon" :template="providers.providers.find(provider => provider.id === option.id)?.template" :size="15" class="text-ui-text-muted" />
                    <span class="min-w-0 flex-1 text-left">
                      <span class="block" :class="option.description ? 'whitespace-normal' : 'truncate'">{{ option.name }}</span>
                      <span v-if="option.description" class="mt-0.5 block whitespace-normal text-xs text-ui-text-muted">{{ option.description }}</span>
                    </span>
                    <Check v-if="control.value === option.id" :size="15" class="shrink-0" aria-hidden="true" />
                  </DropdownMenuRadioItem>
                  </template>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuSeparator v-if="extraOptions.length" class="-mx-1 my-1 h-px bg-ui-border" />
          <AgentConfigOptionMenu v-for="option in extraOptions" :key="option.id" :option="option" :open="active === `config:${option.id}`" :disabled="disabled || loading || !sessionReady" @update:open="active = $event ? `config:${option.id}` : active === `config:${option.id}` ? null : active" @change="changeConfigOption(option.id, $event)" />
          <p v-if="loading" class="-mx-1 m-0 mt-1 flex items-center gap-1.5 border-t border-ui-border px-3.5 py-2 text-xs text-ui-text-muted" role="status"><LoaderCircle :size="13" class="shrink-0 animate-spin" aria-hidden="true" />{{ t('composer.loadingConfiguration') }}</p>
          <div v-if="error" class="-mx-1 mt-1 border-t border-ui-border px-1 pt-2 text-xs">
            <p role="alert" class="m-0 break-words px-2.5 text-ui-danger">{{ error }}</p>
            <DropdownMenuItem as="button" type="button" class="ui-menu-item mt-2" @select.prevent="reload">{{ t('composer.reloadConfiguration') }}</DropdownMenuItem>
          </div>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
    <ConfirmDialog
      v-if="pendingProvider"
      :title="t('composer.switchAgent.title')"
      :description="t('composer.switchAgent.description', { from: currentProviderName, to: pendingProviderName })"
      :confirm-label="t('composer.switchAgent.confirm')"
      tone="primary"
      :confirm="confirmSwitch"
      @close="pendingProvider = undefined"
    />
  </div>
</template>
