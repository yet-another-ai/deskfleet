<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import { useI18n } from "vue-i18n"
import LaunchAtStartupSettings from "./LaunchAtStartupSettings.vue"
import LocalAgentSettings from "./LocalAgentSettings.vue"

const { t } = useI18n()
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("settings.preferences") }}</h1>
  <section v-if="client.platform !== 'web'" aria-labelledby="this-computer-heading">
    <h2 id="this-computer-heading" class="ui-section-title mb-2">{{ t("settings.thisComputer") }}</h2>
    <div class="ui-card px-4">
      <LaunchAtStartupSettings />
      <LocalAgentSettings />
    </div>
  </section>
</template>
