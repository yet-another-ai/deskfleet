<script setup lang="ts">
import { Check, ChevronDown, Search } from "@lucide/vue"
import { computed, nextTick, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { iconForProvider, providerIcons } from "../../services/provider-icons.ts"
import ProviderIcon from "../common/ProviderIcon.vue"

const props = defineProps<{ template: string; disabled?: boolean }>()
const icon = defineModel<string | undefined>()
const { t } = useI18n()
const id = useId()
const open = ref(false)
const query = ref("")
const search = useTemplateRef<HTMLInputElement>("search")
const trigger = useTemplateRef<HTMLButtonElement>("trigger")
const selected = computed(() => iconForProvider(icon.value, props.template))
const label = computed(() => icon.value ? selected.value?.name ?? icon.value : t("providers.iconDefault"))
const icons = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return providerIcons.filter(item => `${item.name} ${item.id}`.toLocaleLowerCase().includes(term))
})
async function toggle(): Promise<void> {
  if (props.disabled) return
  open.value = !open.value
  if (open.value) {
    query.value = ""
    await nextTick()
    search.value?.focus()
  }
}
async function close(): Promise<void> {
  open.value = false
  await nextTick()
  trigger.value?.focus()
}
function escape(event: KeyboardEvent): void {
  if (!open.value) return
  event.preventDefault()
  event.stopPropagation()
  void close()
}
function select(value?: string): void {
  if (props.disabled) return
  icon.value = value
  void close()
}
</script>

<template>
  <div class="flex flex-col gap-1.5" @keydown.esc="escape">
    <label :for="`${id}-trigger`" class="text-sm">{{ t("providers.icon") }}</label>
    <button :id="`${id}-trigger`" ref="trigger" type="button" class="catalog-input flex cursor-pointer items-center gap-3 text-left hover:border-ui-text-muted" :disabled="disabled" :aria-expanded="open" :aria-controls="`${id}-choices`" @click="toggle">
      <ProviderIcon :icon="icon" :template="template" :size="22" />
      <span class="min-w-0 flex-1 truncate text-sm">{{ label }}</span>
      <ChevronDown :size="15" :stroke-width="1.75" class="text-ui-text-muted" :class="open && 'rotate-180'" aria-hidden="true" />
    </button>
    <div v-if="open" :id="`${id}-choices`" class="rounded-lg border border-ui-border bg-ui-surface p-2">
      <div class="relative mb-2">
        <Search :size="15" :stroke-width="1.75" class="pointer-events-none absolute left-2.5 top-2.5 text-ui-text-muted" aria-hidden="true" />
        <input ref="search" v-model="query" type="search" name="provider-icon-search" class="catalog-input !pl-8 text-[13px]" :aria-label="t('providers.iconSearch')" :placeholder="t('providers.iconSearch')" :disabled="disabled" autocomplete="off" :spellcheck="false" @keydown.enter.prevent />
      </div>
      <button type="button" class="mb-2 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-ui-hover disabled:cursor-default" :aria-pressed="!icon" :disabled="disabled" data-default-icon @click="select()">
        <ProviderIcon :template="template" :size="18" />
        <span class="flex-1">{{ t("providers.iconReset") }}</span>
        <Check v-if="!icon" :size="14" :stroke-width="1.75" aria-hidden="true" />
      </button>
      <div class="grid max-h-52 grid-cols-5 gap-1 overflow-y-auto" role="group" :aria-label="t('providers.iconChoices')">
        <button v-for="item in icons" :key="item.id" type="button" class="flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-md border px-1 py-2.5 hover:bg-ui-hover disabled:cursor-default" :class="icon === item.id ? 'border-ui-text-muted bg-ui-hover' : 'border-transparent'" :disabled="disabled" :aria-label="item.name" :aria-pressed="icon === item.id" :title="item.name" :data-provider-icon-choice="item.id" @click="select(item.id)">
          <ProviderIcon :icon="item.id" :size="24" />
          <span class="w-full truncate text-center text-[10px] text-ui-text-muted">{{ item.name }}</span>
        </button>
      </div>
      <p v-if="!icons.length" role="status" class="m-0 px-2 py-4 text-center text-[13px] text-ui-text-muted">{{ t("providers.iconNoResults") }}</p>
    </div>
  </div>
</template>
