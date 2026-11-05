<script setup lang="ts">
import { ChevronRight, Network } from "@lucide/vue"
import { useLocalStorage } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { RouterLink } from "vue-router"
import UiSwitch from "../common/UiSwitch.vue"
import SettingsRow from "./SettingsRow.vue"

const { t } = useI18n()
const developerMode = useLocalStorage("deskfleet.developer-mode", false)
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("developerSettings.title") }}</h1>
  <div class="ui-card mb-4">
    <SettingsRow :label="t('developerSettings.mode')" label-id="developer-mode-label" description-id="developer-mode-description">
      <template #description>{{ t("developerSettings.modeDescription") }}</template>
      <UiSwitch
        v-model="developerMode"
        aria-labelledby="developer-mode-label"
        aria-describedby="developer-mode-description"
        data-developer-mode
        class="ml-2"
      />
    </SettingsRow>
  </div>
  <RouterLink :to="{ name: 'settings-developer-nat' }" replace class="ui-card flex items-center gap-3 p-4 text-ui-text no-underline hover:bg-ui-hover">
    <Network :size="18" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <h2 class="m-0 text-sm font-medium">{{ t("developerSettings.natTitle") }}</h2>
      <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t("developerSettings.description") }}</p>
    </div>
    <ChevronRight :size="16" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
  </RouterLink>
</template>
