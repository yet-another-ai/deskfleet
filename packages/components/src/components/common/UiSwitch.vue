<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui"
defineProps<{ modelValue: boolean; name?: string; disabled?: boolean }>()
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>()
</script>

<template>
  <SwitchRoot :model-value="modelValue" :name="name" :disabled="disabled" class="ui-switch app-no-drag disabled:cursor-default" @update:model-value="emit('update:modelValue', $event)">
    <SwitchThumb class="ui-switch-thumb data-[state=checked]:translate-x-4" />
  </SwitchRoot>
</template>
