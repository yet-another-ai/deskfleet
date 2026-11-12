<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui"
import { vSpring } from "../../directives/spring.ts"
defineProps<{ modelValue: boolean; name?: string; disabled?: boolean }>()
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>()
</script>

<template>
  <SwitchRoot :model-value="modelValue" :name="name" :disabled="disabled" class="ui-switch app-no-drag disabled:cursor-default" @update:model-value="emit('update:modelValue', $event)">
    <SwitchThumb as-child><span v-spring="{ translate: modelValue ? '16px 0px' : '0px 0px' }" class="ui-switch-thumb" /></SwitchThumb>
  </SwitchRoot>
</template>
