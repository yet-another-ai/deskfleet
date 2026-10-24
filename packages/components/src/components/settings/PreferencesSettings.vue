<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import { useI18n } from "vue-i18n"
import LaunchAtStartupSettings from "./LaunchAtStartupSettings.vue"
import LocalAgentSettings from "./LocalAgentSettings.vue"

const { t } = useI18n()
</script>

<template>
  <h1 class="m-0 mb-6 text-lg font-semibold">{{ t("settings.preferences") }}</h1>
  <section v-if="client.platform !== 'web'" aria-labelledby="this-computer-heading">
    <h2 id="this-computer-heading" class="m-0 mb-2 text-sm font-normal">{{ t("settings.thisComputer") }}</h2>
    <LaunchAtStartupSettings />
    <LocalAgentSettings />
  </section>
</template>
