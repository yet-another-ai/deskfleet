<script setup lang="ts">
defineProps<{
  metric: "cpu" | "memory" | "swap" | "battery"
  label: string
  value: string
  unit: string
  detail: string
  warning?: string
}>()
</script>

<template>
  <section :data-system-metric="metric" class="min-w-0 rounded-xl border border-ui-border bg-ui-surface px-5 py-4">
    <div class="flex items-center justify-between gap-2">
      <h3 class="m-0 text-xs font-medium text-ui-text-muted">{{ label }}</h3>
      <span v-if="warning" class="text-[11px] font-medium text-ui-warning">{{ warning }}</span>
    </div>
    <div class="mb-2 mt-3 flex items-baseline gap-1.5 tabular-nums" :data-system-cpu="metric === 'cpu' ? '' : undefined" :data-system-memory="metric === 'memory' ? '' : undefined">
      <span class="text-3xl font-semibold tracking-tight" :class="warning && 'text-ui-warning'">{{ value }}</span>
      <span class="text-sm text-ui-text-muted">{{ unit }}</span>
    </div>
    <p class="m-0 truncate text-xs text-ui-text-muted" :title="detail">{{ detail }}</p>
  </section>
</template>
