<script setup lang="ts">
defineProps<{
  label: string
  /** Lets the row's control reference its visible label and description. */
  labelId?: string
  descriptionId?: string
}>()
</script>

<template>
  <!-- One setting: its label and description on the left, its control on the right. -->
  <div class="flex min-h-12 items-center justify-between gap-6 py-2">
    <div class="min-w-0">
      <div :id="labelId" class="text-sm">{{ label }}</div>
      <div v-if="$slots.description" :id="descriptionId" class="mt-0.5 text-[13px] text-ui-text-muted">
        <slot name="description" />
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot />
    </div>
  </div>
</template>
