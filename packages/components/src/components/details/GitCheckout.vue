<script setup lang="ts">
import { GitBranch } from "@lucide/vue"
import { useI18n } from "vue-i18n"

defineProps<{ root: string; branch: string | null; head: string | null }>()
const { t } = useI18n()
</script>

<template>
  <div class="min-w-0">
    <h3 class="m-0 truncate text-[13px] font-medium" :title="root">{{ root }}</h3>
    <div class="mb-2 mt-1 flex min-w-0 items-center gap-1 text-xs text-ui-text-muted">
      <GitBranch :size="13" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
      <span class="truncate font-mono" :title="head ?? undefined">{{ branch ?? t('panel.detachedHead') }}</span>
      <span v-if="!head" class="shrink-0">· {{ t('panel.noCommits') }}</span>
      <span v-else-if="!branch" class="shrink-0 font-mono">{{ head.slice(0, 8) }}</span>
    </div>
  </div>
</template>
