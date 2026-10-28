<script setup lang="ts">
import { Archive } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { RouterLink } from "vue-router"
import UiTooltip from "../common/UiTooltip.vue"

const { t } = useI18n()
</script>

<template>
  <UiTooltip :text="t('archivedSessions.title')">
    <RouterLink
      :to="{ name: 'archived-sessions' }"
      :aria-label="t('archivedSessions.title')"
      class="ui-button-ghost h-7 w-7 shrink-0 p-0 no-underline"
      exact-active-class="ui-nav-active"
      data-archived-sessions
    >
      <Archive :size="16" :stroke-width="1.75" aria-hidden="true" />
    </RouterLink>
  </UiTooltip>
</template>
