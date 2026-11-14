<script lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui"
import { defineComponent } from "vue"
import { vSpring } from "../../directives/spring.ts"

// Keep Reka's thumb attributes and root directive forwarding in VDOM when the
// surrounding application uses Vapor, as UiButton does for its primitives.
export default defineComponent({
  components: { SwitchRoot, SwitchThumb },
  directives: { spring: vSpring },
  props: {
    modelValue: { type: Boolean, required: true },
    name: String,
    disabled: Boolean,
  },
  emits: { "update:modelValue": (_value: boolean) => true },
})
</script>

<template>
  <SwitchRoot :model-value="modelValue" :name="name" :disabled="disabled" class="ui-switch app-no-drag disabled:cursor-default" @update:model-value="$emit('update:modelValue', $event)">
    <SwitchThumb v-spring="{ translate: modelValue ? '16px 0px' : '0px 0px' }" class="ui-switch-thumb" />
  </SwitchRoot>
</template>
