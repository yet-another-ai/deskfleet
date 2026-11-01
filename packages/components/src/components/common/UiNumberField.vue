<script setup lang="ts">
import { Minus, Plus } from "@lucide/vue"
import { NumberFieldDecrement, NumberFieldIncrement, NumberFieldInput, NumberFieldRoot } from "reka-ui"
import { useI18n } from "vue-i18n"
defineOptions({ inheritAttrs: false })
const props = defineProps<{ modelValue: number; name?: string; min?: number; max?: number; unit?: string; disabled?: boolean; required?: boolean }>()
const emit = defineEmits<{ "update:modelValue": [value: number] }>()
const { t } = useI18n()

function sanitize(event: Event): void {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  const cleaned = props.min !== undefined && props.min >= 0
    ? input.value.replace(/\D+/gu, "")
    : input.value.replace(/(?!^-)[^\d]/gu, "")
  if (cleaned !== input.value) input.value = cleaned
  if (!cleaned || cleaned === "-") return
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return
  if (props.min !== undefined && value < props.min) return
  if (props.max !== undefined && value > props.max) return
  if (value !== props.modelValue) emit("update:modelValue", value)
}
</script>

<template>
  <NumberFieldRoot :model-value="Number.isFinite(modelValue) ? modelValue : null" :min="min" :max="max" :disabled="disabled" :format-options="{ useGrouping: false, maximumFractionDigits: 0 }" disable-wheel-change class="ui-input flex w-auto items-center gap-1 px-1" @update:model-value="emit('update:modelValue', $event ?? Number.NaN)">
    <NumberFieldDecrement :aria-label="t('common.decrease')" class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-muted hover:bg-ui-hover disabled:cursor-default disabled:op-40"><Minus :size="13" aria-hidden="true" /></NumberFieldDecrement>
    <label class="flex min-w-14 cursor-text items-baseline justify-center gap-0.5 px-1" @input.capture="sanitize" @compositionend.capture="sanitize">
      <NumberFieldInput v-bind="$attrs" :name="name" :required="required" class="field-sizing-content min-w-1ch bg-transparent text-center tabular-nums !outline-none" />
      <span v-if="unit" class="select-none text-xs text-ui-text-muted">{{ unit }}</span>
    </label>
    <NumberFieldIncrement :aria-label="t('common.increase')" class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-muted hover:bg-ui-hover disabled:cursor-default disabled:op-40"><Plus :size="13" aria-hidden="true" /></NumberFieldIncrement>
  </NumberFieldRoot>
</template>
