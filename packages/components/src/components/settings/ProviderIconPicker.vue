<script setup lang="ts">
import { Check, ChevronDown, Search } from "@lucide/vue"
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui"
import { computed, ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import { loadProviderIcons, matchProviderIcon, type ProviderIcon as ProviderIconMark } from "../../services/provider-icons.ts"
import ProviderIcon from "../common/ProviderIcon.vue"

const props = defineProps<{ template: string; disabled?: boolean }>()
const icon = defineModel<string | undefined>()
const { t } = useI18n()
const open = ref(false)
const ready = ref(false)
const query = ref("")
const catalog = shallowRef<readonly ProviderIconMark[]>([])
const iconsById = shallowRef<ReadonlyMap<string, ProviderIconMark>>(new Map())
let loading: Promise<void> | undefined
function ensureIcons(): Promise<void> {
  loading ??= loadProviderIcons().then(loaded => {
    catalog.value = loaded.providerIcons
    iconsById.value = loaded.iconsById
    ready.value = true
  })
  return loading
}
void ensureIcons()
const selected = computed(() => matchProviderIcon(iconsById.value, icon.value, props.template))
const label = computed(() => icon.value ? selected.value?.name ?? icon.value : t("providers.iconDefault"))
const icons = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return catalog.value.filter(item => `${item.name} ${item.id}`.toLocaleLowerCase().includes(term))
})
let toggling = false
async function setOpen(next: boolean): Promise<void> {
  if (props.disabled || toggling) return
  toggling = true
  try {
    if (next) await ensureIcons()
    open.value = next
    if (next) query.value = ""
  } finally {
    toggling = false
  }
}
function select(value?: string): void {
  if (props.disabled) return
  icon.value = value
  open.value = false
}
</script>

<template>
  <!-- A compact trigger that sits beside the name; the chooser opens as a popover. -->
  <PopoverRoot :open="open" @update:open="setOpen">
    <PopoverTrigger type="button" class="ui-input flex h-full w-auto shrink-0 cursor-pointer items-center gap-1 px-2" :disabled="disabled" :aria-label="t('providers.iconLabel', { name: label })">
      <ProviderIcon :icon="icon" :template="template" :size="20" />
      <ChevronDown :size="13" :stroke-width="1.75" class="text-ui-text-muted" :class="open && 'rotate-180'" aria-hidden="true" />
    </PopoverTrigger>
    <PopoverPortal>
    <PopoverContent align="start" :side-offset="6" :collision-padding="12" :aria-label="t('providers.iconChoices')" class="ui-menu z-60 w-[22rem] max-w-[calc(100vw-4rem)] p-2">
      <div class="relative mb-2">
        <Search :size="15" :stroke-width="1.75" class="pointer-events-none absolute left-2.5 top-2.5 text-ui-text-muted" aria-hidden="true" />
        <input v-model="query" type="search" name="provider-icon-search" class="ui-input pl-8 text-[13px]" :aria-label="t('providers.iconSearch')" :placeholder="t('providers.iconSearch')" :disabled="disabled" autocomplete="off" :spellcheck="false" @keydown.enter.prevent />
      </div>
      <button type="button" class="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-ui-hover disabled:cursor-default" :aria-pressed="!icon" :disabled="disabled" data-default-icon @click="select()">
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
      <p v-if="ready && !icons.length" role="status" class="m-0 px-2 py-4 text-center text-[13px] text-ui-text-muted">{{ t("providers.iconNoResults") }}</p>
    </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
