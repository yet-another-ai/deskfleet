<script setup lang="ts">
export interface DetailsRow {
  label: string
  value: string
  /** Paths and commits use the monospace face and can be selected. */
  code?: boolean
}

defineProps<{ rows: DetailsRow[] }>()
</script>

<template>
  <dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
    <template v-for="row in rows" :key="row.label">
      <dt class="text-ui-text-muted">{{ row.label }}</dt>
      <dd
        class="m-0 min-w-0"
        :class="row.code ? 'break-all font-mono text-xs leading-5 select-text' : 'break-words'"
      >
        {{ row.value }}
      </dd>
    </template>
  </dl>
</template>
