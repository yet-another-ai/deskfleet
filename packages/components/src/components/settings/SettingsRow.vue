<script setup lang="ts">
defineProps<{
  label: string
  /** Lets the row's control reference its visible label and description. */
  labelId?: string
  descriptionId?: string
}>()
</script>

<template>
  <!-- Controls follow their description on narrow screens. -->
  <div class="ui-setting flex min-h-14 flex-col items-start gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
    <div class="min-w-0">
      <div :id="labelId" class="text-sm">{{ label }}</div>
      <div v-if="$slots.description" :id="descriptionId" class="mt-0.5 text-[13px] text-ui-text-muted">
        <slot name="description" />
      </div>
    </div>
    <div class="flex max-w-full shrink-0 flex-wrap items-center gap-2">
      <slot />
    </div>
  </div>
</template>
