<script setup lang="ts">
import { Info } from "@lucide/vue"
import { computed, useId } from "vue"
import { useI18n } from "vue-i18n"
import IconButton from "../common/IconButton.vue"

/**
 * One allowance row. `limit` is null for unlimited and 0 for not included; only
 * finite limits draw a bar, so neither state can read as zero usage.
 */
const props = defineProps<{ label: string; hint: string; used: number; limit: number | null; format(value: number): string; caption?: string }>()
const { t } = useI18n()
const id = useId()
const ratio = computed(() => props.limit ? Math.min(1, props.used / props.limit) : 0)
const fill = computed(() => ratio.value >= 1 ? "bg-ui-danger" : ratio.value >= 0.8 ? "bg-ui-warning" : "bg-ui-accent")
</script>

<template>
  <div class="px-4 py-3.5">
    <div class="flex min-h-7 items-center justify-between gap-4">
      <div class="flex min-w-0 items-center gap-1">
        <h3 :id="id" class="m-0 truncate text-sm font-normal">{{ label }}</h3>
        <IconButton :icon="Info" :label="hint" class="-my-1" />
      </div>
      <span v-if="limit === 0" class="ui-badge shrink-0">{{ t("billing.notIncluded") }}</span>
      <span v-else class="flex shrink-0 items-center gap-2 text-sm tabular-nums">
        <span data-team-usage-amount>{{ format(used) }}<template v-if="limit !== null"> / {{ format(limit) }}</template></span>
        <span v-if="limit === null" class="ui-badge">{{ t("team.unlimited") }}</span>
      </span>
    </div>
    <div
      v-if="limit"
      role="progressbar"
      :aria-labelledby="id"
      :aria-valuetext="`${format(used)} / ${format(limit)}`"
      :aria-valuenow="Math.round(ratio * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
      class="mt-2 h-1.5 overflow-hidden rounded-full bg-ui-hover"
    >
      <div class="h-full rounded-full transition-[width]" :class="fill" :style="{ width: `${ratio * 100}%` }" />
    </div>
    <p v-if="caption" class="m-0 mt-1.5 text-xs text-ui-text-muted">{{ caption }}</p>
  </div>
</template>
