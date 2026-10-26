<script setup lang="ts">
import { Check } from "@lucide/vue"
import { CheckboxIndicator, CheckboxRoot } from "reka-ui"
defineProps<{ modelValue: boolean; name?: string; value?: string; disabled?: boolean; required?: boolean }>()
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>()
</script>

<template>
  <CheckboxRoot :model-value="modelValue" :name="name" :value="value" :disabled="disabled" :required="required" class="app-no-drag inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border border-ui-border-strong bg-ui-control text-ui-action-text transition-colors data-[state=checked]:border-ui-action data-[state=checked]:bg-ui-action disabled:cursor-default disabled:op-50" @update:model-value="emit('update:modelValue', $event === true)">
    <CheckboxIndicator><Check :size="12" :stroke-width="2.5" aria-hidden="true" /></CheckboxIndicator>
  </CheckboxRoot>
</template>
