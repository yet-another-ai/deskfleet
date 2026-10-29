<script setup lang="ts">
import { LoaderCircle } from "@lucide/vue"
import { useI18n } from "vue-i18n"

const { t } = useI18n()
</script>

<template>
  <span class="inline-flex shrink-0 items-center text-ui-text-muted" role="status" data-session-working>
    <LoaderCircle :size="14" :stroke-width="2" class="animate-spin" aria-hidden="true" />
    <span class="sr-only">{{ t("agent.working") }}</span>
  </span>
</template>
