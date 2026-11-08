<script setup lang="ts">
import { CircleAlert, Info, X } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import type { AgentLiveNotice } from "@deskfleet/client/agent-live"

defineProps<{ notices: AgentLiveNotice[] }>()
const emit = defineEmits<{ dismiss: [id: string] }>()
const { t } = useI18n()
</script>

<template>
  <div v-if="notices.length" data-live-notices class="flex flex-col gap-2">
    <div v-for="notice in notices" :key="notice.id" :role="notice.severity === 'error' ? 'alert' : 'status'" class="flex items-start gap-2 rounded-lg border border-ui-border bg-ui-surface px-3 py-2 text-sm" :class="notice.severity === 'error' ? 'text-ui-danger' : notice.severity === 'warning' ? 'text-ui-warning' : 'text-ui-text'">
      <CircleAlert v-if="notice.severity === 'error' || notice.severity === 'warning'" :size="16" class="mt-0.5 shrink-0" aria-hidden="true" />
      <Info v-else :size="16" class="mt-0.5 shrink-0 text-ui-text-muted" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="m-0 font-medium">{{ notice.title }}</p>
        <p v-if="notice.description" class="m-0 mt-1 whitespace-pre-wrap text-ui-text-muted">{{ notice.description }}</p>
      </div>
      <button type="button" class="shrink-0 cursor-pointer rounded p-1 text-ui-text-muted hover:bg-ui-hover hover:text-ui-text" :aria-label="t('common.close')" @click="emit('dismiss', notice.id)"><X :size="14" aria-hidden="true" /></button>
    </div>
  </div>
</template>
