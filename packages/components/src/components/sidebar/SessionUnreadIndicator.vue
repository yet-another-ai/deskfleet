<script setup lang="ts">
import { useI18n } from "vue-i18n"

const { t } = useI18n()
</script>

<template>
  <span class="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" role="status" :title="t('agent.unread')" data-session-unread>
    <span class="h-1.5 w-1.5 rounded-full bg-ui-accent" aria-hidden="true" />
    <span class="sr-only">{{ t("agent.unread") }}</span>
  </span>
</template>
