<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"

const { t } = useI18n()
const route = useRoute()
const title = computed(() => (route.meta.titleKey ? t(route.meta.titleKey) : ""))
</script>

<template>
  <PaneHeader>{{ title }}</PaneHeader>
  <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
    <h1 class="m-0 text-xl font-semibold">{{ title }}</h1>
    <p class="m-0 text-ui-text-muted">{{ t("common.notAvailable") }}</p>
  </div>
</template>
