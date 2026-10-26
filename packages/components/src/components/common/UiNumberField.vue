<script setup lang="ts">
import { Minus, Plus } from "@lucide/vue"
import { NumberFieldDecrement, NumberFieldIncrement, NumberFieldInput, NumberFieldRoot } from "reka-ui"
import { useI18n } from "vue-i18n"
defineOptions({ inheritAttrs: false })
defineProps<{ modelValue: number; name?: string; min?: number; max?: number; disabled?: boolean; required?: boolean }>()
const emit = defineEmits<{ "update:modelValue": [value: number] }>()
const { t } = useI18n()
</script>

<template>
  <NumberFieldRoot :model-value="Number.isFinite(modelValue) ? modelValue : null" :min="min" :max="max" :disabled="disabled" :format-options="{ useGrouping: false }" disable-wheel-change class="ui-input flex w-auto items-center gap-1 px-1" @update:model-value="emit('update:modelValue', $event ?? Number.NaN)">
    <NumberFieldDecrement :aria-label="t('common.decrease')" class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-muted hover:bg-ui-hover disabled:cursor-default disabled:op-40"><Minus :size="13" aria-hidden="true" /></NumberFieldDecrement>
    <NumberFieldInput v-bind="$attrs" :name="name" :required="required" class="min-w-0 w-16 bg-transparent text-center tabular-nums outline-none" />
    <NumberFieldIncrement :aria-label="t('common.increase')" class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-muted hover:bg-ui-hover disabled:cursor-default disabled:op-40"><Plus :size="13" aria-hidden="true" /></NumberFieldIncrement>
  </NumberFieldRoot>
</template>
