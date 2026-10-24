<script setup lang="ts">
import { CircleAlert, CircleX, Info, LoaderCircle } from "@lucide/vue"
import { computed } from "vue"
/** One line of Session state shown above the composer; the default slot holds its action. */
const props = defineProps<{ tone?: "info" | "progress" | "warning" | "danger"; text: string; detail?: string | null }>()
const icon = computed(() => ({ info: Info, progress: LoaderCircle, warning: CircleAlert, danger: CircleX })[props.tone ?? "info"])
</script>

<template>
  <div class="flex items-center gap-2 rounded-xl border border-ui-border bg-ui-surface px-3 py-2 text-[13px]" :role="tone === 'danger' ? 'alert' : 'status'">
    <component :is="icon" :size="15" :stroke-width="2" class="shrink-0" :class="[tone === 'progress' && 'animate-spin text-ui-text-muted', tone === 'warning' && 'text-ui-warning', tone === 'danger' && 'text-ui-danger', (!tone || tone === 'info') && 'text-ui-text-muted']" aria-hidden="true" />
    <p class="m-0 min-w-0 flex-1 break-words">{{ text }}<span v-if="detail" class="block text-xs text-ui-text-muted">{{ detail }}</span></p>
    <slot />
  </div>
</template>
