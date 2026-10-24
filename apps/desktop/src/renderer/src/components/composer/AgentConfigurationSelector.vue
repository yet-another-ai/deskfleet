<script setup lang="ts">
import { Bot, Check, ChevronDown, ChevronRight, LoaderCircle } from "@lucide/vue"
import { onClickOutside, useEventListener } from "@vueuse/core"
import { computed, nextTick, ref, useId, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useAgentConfiguration } from "./useAgentConfiguration.ts"

const props = defineProps<{ workspaceId?: string; sessionId?: string; disabled?: boolean }>()
const emit = defineEmits<{ loading: [value: boolean] }>()
const { t, te } = useI18n()
const { configuration, expanded, loading, error, modelName, reasoningEffort, toggle, changeModel, changeReasoningEffort, reload } = useAgentConfiguration(() => ({ workspaceId: props.workspaceId, sessionId: props.sessionId }))
watch(loading, value => emit("loading", value), { immediate: true })
const controlsId = useId()
const root = useTemplateRef<HTMLElement>("root")
const trigger = useTemplateRef<HTMLButtonElement>("trigger")
type Control = "agent" | "model" | "reasoning"
const active = ref<Control | null>(null)
const submenuPosition = ref({ left: "0px", top: "0px" })

function effortName(value: string, fallback?: string): string {
  return te(`composer.efforts.${value}`) ? t(`composer.efforts.${value}`) : fallback ?? value
}
const effortLabel = computed(() => reasoningEffort.value && effortName(reasoningEffort.value, configuration.value?.reasoningEfforts?.options.find(option => option.id === reasoningEffort.value)?.name))
const summary = computed(() => [configuration.value?.provider.name ?? "Codex", modelName.value, effortLabel.value].filter(Boolean).join(" · "))
const controls = computed(() => [
  { id: "agent" as const, label: t("composer.provider"), value: "codex", name: configuration.value?.provider.name ?? "Codex", options: [{ id: "codex", name: "Codex" }], disabled: false },
  { id: "model" as const, label: t("composer.model"), value: configuration.value?.models?.currentValue, name: modelName.value, options: configuration.value?.models?.options ?? [], disabled: props.disabled || loading.value || !configuration.value?.models?.options.length },
  { id: "reasoning" as const, label: t("composer.reasoningEffort"), value: configuration.value?.reasoningEfforts?.currentValue, name: effortLabel.value, options: configuration.value?.reasoningEfforts?.options.map(option => ({ ...option, name: effortName(option.id, option.name) })) ?? [], disabled: props.disabled || loading.value || !configuration.value?.reasoningEfforts?.options.length },
])

async function expand(): Promise<void> {
  if (expanded.value) { await collapse(); return }
  toggle()
  await nextTick()
  root.value?.querySelector<HTMLButtonElement>("[data-agent-control]")?.focus()
}
async function collapse(restoreFocus = true): Promise<void> {
  if (expanded.value) toggle()
  active.value = null
  if (restoreFocus) { await nextTick(); trigger.value?.focus() }
}
onClickOutside(root, () => { void collapse(false) })
async function openOptions(control: Control, focus = false): Promise<void> {
  if (controls.value.find(option => option.id === control)?.disabled) return
  active.value = control
  await nextTick()
  const row = root.value?.querySelector<HTMLElement>(`[data-agent-control="${control}"]`)
  const submenu = root.value?.querySelector<HTMLElement>("[data-agent-configuration-options]")
  if (!row || !submenu) return
  const bounds = row.getBoundingClientRect()
  const width = submenu.offsetWidth
  const right = bounds.right + 4
  const left = right + width <= window.innerWidth - 8 ? right : bounds.left - width - 4
  submenuPosition.value = {
    left: `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`,
    top: `${Math.max(8, Math.min(bounds.top, window.innerHeight - submenu.offsetHeight - 8))}px`,
  }
  if (focus) (submenu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? submenu.querySelector<HTMLButtonElement>("button"))?.focus()
}
useEventListener(window, "resize", () => { if (active.value) void openOptions(active.value) })
async function closeOptions(control: Control): Promise<void> {
  active.value = null
  await nextTick()
  root.value?.querySelector<HTMLButtonElement>(`[data-agent-control="${control}"]`)?.focus()
}
function move(event: KeyboardEvent, selector: string, direction: number): void {
  const buttons = [...root.value!.querySelectorAll<HTMLButtonElement>(selector)].filter(button => !button.disabled)
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  buttons[(index + direction + buttons.length) % buttons.length]?.focus()
}
function choose(control: Control, value: string): void {
  void closeOptions(control)
  if (control === "model") void changeModel(value)
  if (control === "reasoning") void changeReasoningEffort(value)
}
</script>

<template>
  <div ref="root" data-agent-configuration class="relative min-w-0" @keydown.esc.stop.prevent="collapse()">
    <button ref="trigger" data-agent-configuration-trigger data-composer-context type="button" class="ui-chip max-w-full cursor-pointer hover:bg-ui-hover" :aria-label="t('composer.configureAgent', { selection: summary })" aria-haspopup="menu" :aria-expanded="expanded" :aria-controls="controlsId" @click="expand" @keydown.down.prevent="expand">
      <Bot :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
      <span class="truncate">{{ summary }}</span>
      <ChevronDown :size="13" class="shrink-0" aria-hidden="true" />
    </button>
    <div v-if="expanded" :id="controlsId" data-agent-configuration-menu role="menu" :aria-label="t('composer.configuration')" :aria-busy="loading" class="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl border border-ui-border bg-ui-surface p-1 shadow-ui-card">
      <div v-for="control in controls" :key="control.id" class="relative" @mouseenter="openOptions(control.id)">
        <button type="button" role="menuitem" :data-agent-control="control.id" :data-value="control.value" :disabled="control.disabled" aria-haspopup="menu" :aria-expanded="active === control.id" :aria-controls="`${controlsId}-${control.id}`" class="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] text-ui-text hover:bg-ui-hover focus:bg-ui-hover focus:outline-none disabled:cursor-default disabled:opacity-50" :class="active === control.id && 'bg-ui-hover'" @click="openOptions(control.id, true)" @focus="active = null" @keydown.right.stop.prevent="openOptions(control.id, true)" @keydown.down.stop.prevent="move($event, '[data-agent-control]', 1)" @keydown.up.stop.prevent="move($event, '[data-agent-control]', -1)">
          <span>{{ control.label }}</span>
          <span class="ml-auto truncate text-ui-text-muted">{{ control.name ?? (loading ? t('composer.loading') : t('composer.unavailable')) }}</span>
          <ChevronRight :size="14" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
        </button>
        <div v-if="active === control.id" :id="`${controlsId}-${control.id}`" data-agent-configuration-options role="menu" :aria-label="control.label" :style="submenuPosition" class="fixed z-40 max-h-[min(20rem,calc(100vh-16px))] min-w-48 max-w-[min(20rem,calc(100vw-16px))] overflow-y-auto rounded-xl border border-ui-border bg-ui-surface p-1 shadow-ui-card">
          <button v-for="option in control.options" :key="option.id" type="button" role="menuitemradio" :data-value="option.id" :aria-checked="control.value === option.id" :disabled="control.disabled" class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ui-text hover:bg-ui-hover focus:bg-ui-hover focus:outline-none disabled:cursor-default disabled:opacity-50" @click="choose(control.id, option.id)" @keydown.left.stop.prevent="closeOptions(control.id)" @keydown.down.stop.prevent="move($event, '[data-agent-configuration-options] button', 1)" @keydown.up.stop.prevent="move($event, '[data-agent-configuration-options] button', -1)">
            <Bot v-if="control.id === 'agent'" :size="15" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ option.name }}</span>
            <Check v-if="control.value === option.id" :size="15" class="shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p v-if="loading" class="m-0 flex items-center gap-1.5 border-t border-ui-border px-2.5 py-2 text-xs text-ui-text-muted" role="status"><LoaderCircle :size="13" class="shrink-0 animate-spin" aria-hidden="true" />{{ t('composer.loadingConfiguration') }}</p>
      <div v-if="error" class="border-t border-ui-border px-2.5 py-2 text-xs">
        <p role="alert" class="m-0 break-words text-ui-danger">{{ error }}</p>
        <button type="button" role="menuitem" class="mt-2 cursor-pointer text-ui-text hover:underline" @click="reload">{{ t('composer.reloadConfiguration') }}</button>
      </div>
    </div>
  </div>
</template>
