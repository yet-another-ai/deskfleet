<script setup lang="ts">
import { Check, ChevronDown } from "@lucide/vue"
import { computed, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import {
  ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxPortal, ComboboxRoot, ComboboxTrigger, ComboboxViewport,
  SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectPortal, SelectRoot, SelectTrigger, SelectValue, SelectViewport,
} from "reka-ui"

defineOptions({ inheritAttrs: false })
const props = defineProps<{
  modelValue: string
  options: { value: string; label: string; disabled?: boolean }[]
  searchable?: boolean
  placeholder?: string
  disabled?: boolean
  required?: boolean
  name?: string
  portalTo?: HTMLElement
}>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()
const { t } = useI18n()
const input = useTemplateRef<InstanceType<typeof ComboboxInput>>("input")
const options = computed(() => props.options.filter(option => option.value !== ""))
const placeholder = computed(() => props.placeholder ?? props.options.find(option => option.value === "")?.label)
const label = (value: unknown) => props.options.find(option => option.value === value)?.label ?? String(value ?? "")
function focus(): void { (input.value?.$el as HTMLInputElement | undefined)?.focus() }
</script>

<template>
  <ComboboxRoot v-if="searchable" :model-value="modelValue" :disabled="disabled" open-on-click @update:model-value="emit('update:modelValue', String($event ?? ''))">
    <ComboboxAnchor v-bind="{ class: $attrs.class, style: $attrs.style }" :data-disabled="disabled ? '' : undefined" class="ui-input relative flex min-w-0 items-center pr-8 focus-within:border-ui-accent focus-within:ring-3 focus-within:ring-ui-accent/20 data-[disabled]:op-50">
      <ComboboxInput ref="input" v-bind="{ ...$attrs, class: undefined, style: undefined }" :display-value="label" :placeholder="placeholder" :aria-required="required || undefined" :data-control-name="name" class="w-full min-w-0 bg-transparent p-0 text-[13px] outline-none" />
      <ComboboxTrigger class="absolute right-1 flex h-7 w-7 items-center justify-center rounded-md text-ui-text-muted hover:text-ui-text" :disabled="disabled" :aria-label="String($attrs['aria-label'] ?? placeholder ?? label(modelValue))" tabindex="-1"><ChevronDown :size="14" aria-hidden="true" /></ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal :to="portalTo">
      <ComboboxContent position="popper" :side-offset="5" class="ui-menu z-100 max-h-[min(20rem,var(--reka-combobox-content-available-height))] min-w-[var(--reka-combobox-trigger-width)] overflow-hidden">
        <ComboboxViewport class="max-h-72 overflow-y-auto">
          <ComboboxEmpty class="px-3 py-5 text-center text-[13px] text-ui-text-muted">{{ t('common.noResults') }}</ComboboxEmpty>
          <ComboboxItem v-for="option in options" :key="option.value" :value="option.value" :text-value="option.label" :disabled="option.disabled" class="ui-menu-item relative pr-8 outline-none data-[highlighted]:bg-ui-hover data-[disabled]:pointer-events-none data-[disabled]:op-40">
            {{ option.label }}<ComboboxItemIndicator class="absolute right-2.5"><Check :size="14" aria-hidden="true" /></ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
    <!-- Validate the selected value, rather than arbitrary search text. -->
    <input v-if="name || required" class="sr-only" tabindex="-1" aria-hidden="true" :name="name" :value="modelValue" :required="required" :disabled="disabled" @focus="focus" />
  </ComboboxRoot>
  <SelectRoot v-else :model-value="modelValue || null" :name="name" :required="required" :disabled="disabled" @update:model-value="emit('update:modelValue', String($event ?? ''))">
    <SelectTrigger v-bind="$attrs" class="ui-input inline-flex items-center justify-between gap-2 text-left text-[13px]" :data-control-name="name">
      <SelectValue :placeholder="placeholder" class="min-w-0 truncate" /><SelectIcon class="shrink-0 text-ui-text-muted"><ChevronDown :size="14" aria-hidden="true" /></SelectIcon>
    </SelectTrigger>
    <SelectPortal :to="portalTo">
      <SelectContent position="popper" :side-offset="5" class="ui-menu z-100 max-h-[min(20rem,var(--reka-select-content-available-height))] min-w-[var(--reka-select-trigger-width)] overflow-hidden">
        <SelectViewport class="max-h-72 overflow-y-auto">
          <SelectItem v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled" class="ui-menu-item relative pr-8 outline-none data-[highlighted]:bg-ui-hover data-[disabled]:pointer-events-none data-[disabled]:op-40">
            <SelectItemText>{{ option.label }}</SelectItemText><SelectItemIndicator class="absolute right-2.5"><Check :size="14" aria-hidden="true" /></SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
